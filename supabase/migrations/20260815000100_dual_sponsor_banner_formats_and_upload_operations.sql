begin;

do $preflight$
begin
  if to_regclass('public.cycle_sponsorships') is null
    or to_regclass('public.app_config') is null
    or to_regclass('public.media_cleanup_queue') is null
    or to_regclass('public.sponsor_tracking_events') is null
    or to_regclass('public.sponsor_tracking_aggregates') is null
    or to_regprocedure('public.start_cycle_managed(bigint,text,jsonb)') is null
    or to_regprocedure('public.reset_cycle_managed(bigint,text,text)') is null
    or to_regprocedure('public.assert_cycle_manager(text)') is null
    or to_regprocedure('public.record_sponsor_event_v2(bigint,text,text,text,text)') is null
  then
    raise exception using
      errcode = '55000',
      message = 'DUAL_SPONSOR_BANNER_BASELINE_MISMATCH';
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'cycle_sponsorships'
      and column_name = 'feed_banner_r2_key'
  ) or to_regclass('public.sponsor_media_upload_operations') is not null then
    raise exception using
      errcode = '42701',
      message = 'DUAL_SPONSOR_BANNER_ALREADY_PRESENT';
  end if;
end;
$preflight$;

alter table public.cycle_sponsorships
  add column feed_banner_r2_key text;

alter table public.cycle_sponsorships
  add constraint cycle_sponsorships_detail_banner_key_check
    check (
      banner_r2_key is null
      or banner_r2_key ~ '^sponsored-cycles/drafts/[0-9A-Fa-f-]{36}[.]webp$'
      or banner_r2_key ~ '^sponsored-cycles/drafts/detail/[0-9A-Fa-f-]{36}[.]webp$'
    ),
  add constraint cycle_sponsorships_feed_banner_key_check
    check (
      feed_banner_r2_key is null
      or feed_banner_r2_key ~ '^sponsored-cycles/drafts/feed/[0-9A-Fa-f-]{36}[.]webp$'
    );

comment on column public.cycle_sponsorships.banner_r2_key is
  'Server-only 2:1 detail banner storage key. Historical single-banner rows remain readable.';
comment on column public.cycle_sponsorships.feed_banner_r2_key is
  'Server-only 6:1 Feed strip storage key. Null on historical incomplete sponsorships, which must not render or measure in The Spread.';

alter table public.sponsor_tracking_events
  drop constraint sponsor_tracking_events_surface_check,
  drop constraint sponsor_tracking_events_feed_kind_check,
  add constraint sponsor_tracking_events_surface_check
    check (surface = any (array[
      'home_hud'::text,
      'vote_modal'::text,
      'history_modal'::text,
      'fame_modal'::text,
      'shame_modal'::text,
      'spread_detail'::text,
      'spread'::text
    ])),
  add constraint sponsor_tracking_events_feed_kind_check
    check (
      (surface = 'spread' and feed_kind = any (array[
        'live'::text, 'top10'::text, 'all'::text, 'trash'::text
      ]))
      or (surface <> 'spread' and feed_kind is null)
    );

alter table public.sponsor_tracking_aggregates
  drop constraint sponsor_tracking_aggregates_surface_check,
  drop constraint sponsor_tracking_aggregates_feed_kind_check,
  add constraint sponsor_tracking_aggregates_surface_check
    check (surface = any (array[
      'home_hud'::text,
      'vote_modal'::text,
      'history_modal'::text,
      'fame_modal'::text,
      'shame_modal'::text,
      'spread_detail'::text,
      'spread'::text
    ])),
  add constraint sponsor_tracking_aggregates_feed_kind_check
    check (
      (surface = 'spread' and feed_kind = any (array[
        'live'::text, 'top10'::text, 'all'::text, 'trash'::text
      ]))
      or (surface <> 'spread' and feed_kind is null)
    );

create or replace function public.record_sponsor_event_v2(
  p_sponsorship_id bigint,
  p_event_type text,
  p_surface text,
  p_feed_kind text,
  p_viewer_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_now timestamptz := transaction_timestamp();
  v_window_start timestamptz;
  v_inserted boolean := false;
begin
  if p_sponsorship_id is null or p_sponsorship_id <= 0
    or p_event_type is null
    or p_event_type not in ('impression', 'click')
    or p_surface is null
    or p_surface not in (
      'home_hud', 'vote_modal', 'history_modal',
      'fame_modal', 'shame_modal', 'spread_detail', 'spread'
    )
    or p_viewer_hash is null
    or p_viewer_hash !~ '^[0-9a-f]{64}$'
    or (
      p_surface = 'spread'
      and (p_feed_kind is null or p_feed_kind not in ('live', 'top10', 'all', 'trash'))
    )
    or (p_surface <> 'spread' and p_feed_kind is not null)
    or not exists (
      select 1
      from public.cycle_sponsorships
      where id = p_sponsorship_id
    ) then
    raise exception using
      errcode = '22023',
      message = 'SPONSOR_MEASUREMENT_INPUT_INVALID';
  end if;

  v_window_start := date_bin(
    interval '30 minutes',
    v_now,
    timestamptz '2000-01-01 00:00:00+00'
  );

  insert into public.sponsor_tracking_events (
    sponsorship_id,
    event_type,
    surface,
    feed_kind,
    viewer_hash,
    measurement_window_start,
    created_at
  ) values (
    p_sponsorship_id,
    p_event_type,
    p_surface,
    p_feed_kind,
    p_viewer_hash,
    v_window_start,
    v_now
  )
  on conflict do nothing
  returning true into v_inserted;

  if coalesce(v_inserted, false) then
    insert into public.sponsor_tracking_aggregates (
      sponsorship_id,
      event_day,
      event_type,
      surface,
      feed_kind,
      event_count,
      updated_at
    ) values (
      p_sponsorship_id,
      (v_now at time zone 'UTC')::date,
      p_event_type,
      p_surface,
      p_feed_kind,
      1,
      v_now
    )
    on conflict (
      sponsorship_id,
      event_day,
      event_type,
      surface,
      (coalesce(feed_kind, ''))
    ) do update
      set event_count = public.sponsor_tracking_aggregates.event_count + 1,
          updated_at = excluded.updated_at;

    return jsonb_build_object('outcome', 'tracked');
  end if;

  return jsonb_build_object('outcome', 'deduped');
end;
$function$;

alter function public.record_sponsor_event_v2(bigint, text, text, text, text)
  owner to postgres;
revoke all on function public.record_sponsor_event_v2(bigint, text, text, text, text)
  from public, anon, authenticated, discord_bot;
grant execute on function public.record_sponsor_event_v2(bigint, text, text, text, text)
  to service_role;

create table public.sponsor_media_upload_operations (
  idempotency_key uuid primary key,
  actor_discord_user_id text not null,
  request_fingerprint text not null,
  expected_draft_revision bigint not null,
  detail_candidate_r2_key text,
  feed_candidate_r2_key text,
  status text not null default 'reserved',
  result jsonb,
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  expires_at timestamptz not null default transaction_timestamp() + interval '1 hour',
  constraint sponsor_media_upload_actor_check
    check (btrim(actor_discord_user_id) <> '' and char_length(actor_discord_user_id) <= 100),
  constraint sponsor_media_upload_fingerprint_check
    check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint sponsor_media_upload_revision_check
    check (expected_draft_revision >= 0),
  constraint sponsor_media_upload_detail_key_check
    check (
      detail_candidate_r2_key is null
      or detail_candidate_r2_key ~ '^sponsored-cycles/drafts/detail/[0-9A-Fa-f-]{36}[.]webp$'
    ),
  constraint sponsor_media_upload_feed_key_check
    check (
      feed_candidate_r2_key is null
      or feed_candidate_r2_key ~ '^sponsored-cycles/drafts/feed/[0-9A-Fa-f-]{36}[.]webp$'
    ),
  constraint sponsor_media_upload_status_check
    check (status in ('reserved', 'committed', 'aborted')),
  constraint sponsor_media_upload_result_check
    check ((status = 'committed') = (result is not null)),
  constraint sponsor_media_upload_expiry_check
    check (expires_at >= created_at)
);

create index sponsor_media_upload_operations_stale_idx
  on public.sponsor_media_upload_operations (expires_at, idempotency_key)
  where status = 'reserved';

alter table public.sponsor_media_upload_operations enable row level security;
revoke all on table public.sponsor_media_upload_operations
  from public, anon, authenticated, service_role, discord_bot;

comment on table public.sponsor_media_upload_operations is
  'Server-only idempotent saga state for the two purpose-built Sponsor banner uploads. Candidate keys are never browser DTO fields.';

insert into public.app_config (key, value)
values
  ('next_cycle_sponsor_feed_banner_r2_key', null),
  ('next_cycle_sponsor_draft_revision', '0')
on conflict (key) do nothing;

create or replace function public.queue_sponsor_media_key_if_unreferenced(
  p_storage_key text,
  p_reason text
)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_queue_id bigint;
begin
  if p_storage_key is null
    or btrim(p_storage_key) = ''
    or p_reason is null
    or btrim(p_reason) = ''
  then
    return null;
  end if;

  if exists (
    select 1
    from public.cycle_sponsorships sponsorship
    where sponsorship.banner_r2_key = p_storage_key
       or sponsorship.feed_banner_r2_key = p_storage_key
  ) or exists (
    select 1
    from public.voting_cycles cycle
    where cycle.sponsor_banner_key = p_storage_key
  ) or exists (
    select 1
    from public.app_config config
    where config.key in (
      'next_cycle_sponsor_banner_r2_key',
      'next_cycle_sponsor_banner_key',
      'next_cycle_sponsor_feed_banner_r2_key'
    )
      and config.value = p_storage_key
  ) or exists (
    select 1
    from public.sponsor_media_upload_operations operation
    where operation.status = 'reserved'
      and (
        operation.detail_candidate_r2_key = p_storage_key
        or operation.feed_candidate_r2_key = p_storage_key
      )
  ) then
    return null;
  end if;

  insert into public.media_cleanup_queue (
    storage_provider,
    storage_key,
    reason,
    status
  ) values (
    'r2',
    p_storage_key,
    btrim(p_reason),
    'pending'
  )
  on conflict (storage_provider, storage_key) do update
  set reason = excluded.reason
  returning id into v_queue_id;

  return v_queue_id;
end;
$function$;

alter function public.queue_sponsor_media_key_if_unreferenced(text, text)
  owner to postgres;
revoke all on function public.queue_sponsor_media_key_if_unreferenced(text, text)
  from public, anon, authenticated, service_role, discord_bot;

create or replace function public.reserve_sponsor_media_upload(
  p_actor_discord_user_id text,
  p_idempotency_key uuid,
  p_request_fingerprint text,
  p_expected_draft_revision bigint,
  p_detail_candidate_r2_key text,
  p_feed_candidate_r2_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor_id text := btrim(p_actor_discord_user_id);
  v_current_revision bigint;
  v_existing public.sponsor_media_upload_operations%rowtype;
begin
  perform public.assert_cycle_manager(v_actor_id);

  if p_idempotency_key is null
    or p_request_fingerprint !~ '^[0-9a-f]{64}$'
    or p_expected_draft_revision is null
    or p_expected_draft_revision < 0
    or (
      p_detail_candidate_r2_key is not null
      and p_detail_candidate_r2_key !~ '^sponsored-cycles/drafts/detail/[0-9A-Fa-f-]{36}[.]webp$'
    )
    or (
      p_feed_candidate_r2_key is not null
      and p_feed_candidate_r2_key !~ '^sponsored-cycles/drafts/feed/[0-9A-Fa-f-]{36}[.]webp$'
    )
  then
    raise exception using errcode = '22023', message = 'INVALID_SPONSOR_UPLOAD_RESERVATION';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('sponsor-draft', 0));

  select *
  into v_existing
  from public.sponsor_media_upload_operations operation
  where operation.idempotency_key = p_idempotency_key
  for update;

  if found then
    if v_existing.actor_discord_user_id <> v_actor_id
      or v_existing.request_fingerprint <> p_request_fingerprint
      or v_existing.expected_draft_revision <> p_expected_draft_revision
      or v_existing.detail_candidate_r2_key is distinct from p_detail_candidate_r2_key
      or v_existing.feed_candidate_r2_key is distinct from p_feed_candidate_r2_key
    then
      raise exception using errcode = '22023', message = 'SPONSOR_UPLOAD_IDEMPOTENCY_MISMATCH';
    end if;

    return jsonb_build_object(
      'state', v_existing.status,
      'revision', coalesce((v_existing.result ->> 'revision')::bigint, p_expected_draft_revision)
    );
  end if;

  select coalesce(nullif(config.value, '')::bigint, 0)
  into v_current_revision
  from public.app_config config
  where config.key = 'next_cycle_sponsor_draft_revision'
  for update;

  if coalesce(v_current_revision, 0) <> p_expected_draft_revision then
    raise exception using errcode = '40001', message = 'SPONSOR_DRAFT_STALE';
  end if;

  insert into public.sponsor_media_upload_operations (
    idempotency_key,
    actor_discord_user_id,
    request_fingerprint,
    expected_draft_revision,
    detail_candidate_r2_key,
    feed_candidate_r2_key
  ) values (
    p_idempotency_key,
    v_actor_id,
    p_request_fingerprint,
    p_expected_draft_revision,
    p_detail_candidate_r2_key,
    p_feed_candidate_r2_key
  );

  return jsonb_build_object('state', 'reserved', 'revision', p_expected_draft_revision);
end;
$function$;

alter function public.reserve_sponsor_media_upload(text, uuid, text, bigint, text, text)
  owner to postgres;
revoke all on function public.reserve_sponsor_media_upload(text, uuid, text, bigint, text, text)
  from public, anon, authenticated, service_role, discord_bot;
grant execute on function public.reserve_sponsor_media_upload(text, uuid, text, bigint, text, text)
  to service_role;

create or replace function public.commit_sponsor_media_upload(
  p_actor_discord_user_id text,
  p_idempotency_key uuid,
  p_request_fingerprint text,
  p_enabled boolean,
  p_company_name text,
  p_replace_sponsor_link boolean,
  p_sponsor_link text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor_id text := btrim(p_actor_discord_user_id);
  v_operation public.sponsor_media_upload_operations%rowtype;
  v_current_revision bigint;
  v_company_name text := coalesce(btrim(p_company_name), '');
  v_current_sponsor_link text;
  v_sponsor_link text;
  v_old_detail_key text;
  v_old_feed_key text;
  v_detail_key text;
  v_feed_key text;
  v_result jsonb;
begin
  perform public.assert_cycle_manager(v_actor_id);
  perform pg_advisory_xact_lock(hashtextextended('sponsor-draft', 0));

  select *
  into v_operation
  from public.sponsor_media_upload_operations operation
  where operation.idempotency_key = p_idempotency_key
  for update;

  if not found
    or v_operation.actor_discord_user_id <> v_actor_id
    or v_operation.request_fingerprint <> p_request_fingerprint
  then
    raise exception using errcode = '22023', message = 'SPONSOR_UPLOAD_RESERVATION_NOT_FOUND';
  end if;

  if v_operation.status = 'committed' then
    return v_operation.result;
  end if;

  if v_operation.status <> 'reserved' then
    raise exception using errcode = '40001', message = 'SPONSOR_UPLOAD_NOT_COMMITTABLE';
  end if;

  select coalesce(nullif(config.value, '')::bigint, 0)
  into v_current_revision
  from public.app_config config
  where config.key = 'next_cycle_sponsor_draft_revision'
  for update;

  if coalesce(v_current_revision, 0) <> v_operation.expected_draft_revision then
    raise exception using errcode = '40001', message = 'SPONSOR_DRAFT_STALE';
  end if;

  select nullif(btrim(config.value), '')
  into v_current_sponsor_link
  from public.app_config config
  where config.key = 'next_cycle_sponsor_link';

  v_sponsor_link := case
    when p_replace_sponsor_link then nullif(btrim(p_sponsor_link), '')
    else v_current_sponsor_link
  end;

  select nullif(btrim(config.value), '')
  into v_old_detail_key
  from public.app_config config
  where config.key = 'next_cycle_sponsor_banner_r2_key';

  select nullif(btrim(config.value), '')
  into v_old_feed_key
  from public.app_config config
  where config.key = 'next_cycle_sponsor_feed_banner_r2_key';

  v_detail_key := coalesce(v_operation.detail_candidate_r2_key, v_old_detail_key);
  v_feed_key := coalesce(v_operation.feed_candidate_r2_key, v_old_feed_key);

  if p_enabled is null
    or char_length(v_company_name) > 120
    or (
      v_sponsor_link is not null
      and (
        char_length(v_sponsor_link) > 2048
        or v_sponsor_link !~* '^https://[^[:space:]]+$'
      )
    )
    or (
      p_enabled
      and (
        v_company_name = ''
        or v_sponsor_link is null
        or v_detail_key is null
        or v_feed_key is null
      )
    )
  then
    raise exception using errcode = '22023', message = 'INCOMPLETE_SPONSOR_SETTINGS';
  end if;

  insert into public.app_config (key, value)
  values
    ('next_cycle_sponsored_enabled', case when p_enabled then 'true' else 'false' end),
    ('next_cycle_sponsor_name', nullif(v_company_name, '')),
    ('next_cycle_sponsor_link', v_sponsor_link),
    ('next_cycle_sponsor_banner_r2_key', v_detail_key),
    ('next_cycle_sponsor_feed_banner_r2_key', v_feed_key),
    ('next_cycle_sponsor_draft_revision', (v_current_revision + 1)::text)
  on conflict (key) do update set value = excluded.value;

  v_result := jsonb_build_object('revision', v_current_revision + 1);

  update public.sponsor_media_upload_operations
  set status = 'committed',
      result = v_result,
      updated_at = transaction_timestamp()
  where idempotency_key = p_idempotency_key;

  if v_old_detail_key is distinct from v_detail_key then
    perform public.queue_sponsor_media_key_if_unreferenced(
      v_old_detail_key,
      'sponsor_draft_replaced:detail'
    );
  end if;

  if v_old_feed_key is distinct from v_feed_key then
    perform public.queue_sponsor_media_key_if_unreferenced(
      v_old_feed_key,
      'sponsor_draft_replaced:feed'
    );
  end if;

  insert into public.admin_action_logs (
    actor_type,
    actor_id,
    action,
    target_type,
    target_id,
    meta
  ) values (
    case when public.assert_cycle_manager(v_actor_id) = 'admin' then 'admin' else 'moderator' end,
    v_actor_id,
    'sponsor_draft_saved',
    'sponsor_draft',
    'next_cycle',
    jsonb_build_object(
      'authorization_capability', 'cycles.manage',
      'enabled', p_enabled,
      'detail_banner_ready', v_detail_key is not null,
      'feed_banner_ready', v_feed_key is not null,
      'revision', v_current_revision + 1
    )
  );

  return v_result;
end;
$function$;

alter function public.commit_sponsor_media_upload(text, uuid, text, boolean, text, boolean, text)
  owner to postgres;
revoke all on function public.commit_sponsor_media_upload(text, uuid, text, boolean, text, boolean, text)
  from public, anon, authenticated, service_role, discord_bot;
grant execute on function public.commit_sponsor_media_upload(text, uuid, text, boolean, text, boolean, text)
  to service_role;

create or replace function public.abort_sponsor_media_upload(
  p_actor_discord_user_id text,
  p_idempotency_key uuid,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor_id text := btrim(p_actor_discord_user_id);
  v_operation public.sponsor_media_upload_operations%rowtype;
  v_queued integer := 0;
begin
  perform public.assert_cycle_manager(v_actor_id);
  perform pg_advisory_xact_lock(hashtextextended('sponsor-draft', 0));

  select *
  into v_operation
  from public.sponsor_media_upload_operations operation
  where operation.idempotency_key = p_idempotency_key
  for update;

  if not found
    or v_operation.actor_discord_user_id <> v_actor_id
    or v_operation.request_fingerprint <> p_request_fingerprint
  then
    return jsonb_build_object('aborted', false, 'queued', 0);
  end if;

  if v_operation.status = 'committed' then
    return jsonb_build_object('aborted', false, 'queued', 0);
  end if;

  update public.sponsor_media_upload_operations
  set status = 'aborted',
      updated_at = transaction_timestamp()
  where idempotency_key = p_idempotency_key;

  if public.queue_sponsor_media_key_if_unreferenced(
    v_operation.detail_candidate_r2_key,
    'sponsor_upload_aborted:detail'
  ) is not null then
    v_queued := v_queued + 1;
  end if;

  if public.queue_sponsor_media_key_if_unreferenced(
    v_operation.feed_candidate_r2_key,
    'sponsor_upload_aborted:feed'
  ) is not null then
    v_queued := v_queued + 1;
  end if;

  return jsonb_build_object('aborted', true, 'queued', v_queued);
end;
$function$;

alter function public.abort_sponsor_media_upload(text, uuid, text)
  owner to postgres;
revoke all on function public.abort_sponsor_media_upload(text, uuid, text)
  from public, anon, authenticated, service_role, discord_bot;
grant execute on function public.abort_sponsor_media_upload(text, uuid, text)
  to service_role;

create or replace function public.recover_stale_sponsor_media_uploads(
  p_limit integer default 100
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_operation record;
  v_recovered integer := 0;
  v_queued integer := 0;
begin
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception using errcode = '22023', message = 'INVALID_SPONSOR_UPLOAD_RECOVERY_LIMIT';
  end if;

  for v_operation in
    select operation.*
    from public.sponsor_media_upload_operations operation
    where operation.status = 'reserved'
      and operation.expires_at <= transaction_timestamp()
    order by operation.expires_at, operation.idempotency_key
    limit p_limit
    for update skip locked
  loop
    update public.sponsor_media_upload_operations
    set status = 'aborted',
        updated_at = transaction_timestamp()
    where idempotency_key = v_operation.idempotency_key;

    v_recovered := v_recovered + 1;
    if public.queue_sponsor_media_key_if_unreferenced(
      v_operation.detail_candidate_r2_key,
      'sponsor_upload_stale:detail'
    ) is not null then
      v_queued := v_queued + 1;
    end if;
    if public.queue_sponsor_media_key_if_unreferenced(
      v_operation.feed_candidate_r2_key,
      'sponsor_upload_stale:feed'
    ) is not null then
      v_queued := v_queued + 1;
    end if;
  end loop;

  return jsonb_build_object('recovered', v_recovered, 'queued', v_queued);
end;
$function$;

alter function public.recover_stale_sponsor_media_uploads(integer)
  owner to postgres;
revoke all on function public.recover_stale_sponsor_media_uploads(integer)
  from public, anon, authenticated, service_role, discord_bot;
grant execute on function public.recover_stale_sponsor_media_uploads(integer)
  to service_role;

create or replace function public.resolve_community_feed_sponsor_placement(
  p_feed_kind text,
  p_submission_id bigint,
  p_cycle_number bigint default null
)
returns table (
  sponsorship_id bigint,
  cycle_id bigint,
  sponsor_name text,
  sponsor_link text,
  feed_banner_r2_key text,
  placement_ordinal bigint
)
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  if p_feed_kind not in ('live', 'top10', 'all', 'trash')
    or p_submission_id is null
    or p_submission_id <= 0
    or (p_cycle_number is not null and p_cycle_number <= 0)
    or (p_feed_kind = 'live' and p_cycle_number is not null)
  then
    return;
  end if;

  if p_feed_kind = 'live' then
    return query
    select
      sponsorship.id,
      cycle.id,
      sponsorship.sponsor_name,
      sponsorship.sponsor_link,
      sponsorship.feed_banner_r2_key,
      1::bigint
    from public.submissions submission
    join public.voting_cycles cycle on cycle.id = submission.cycle_id
    join public.cycle_sponsorships sponsorship on sponsorship.cycle_id = cycle.id
    where submission.id = p_submission_id
      and submission.public_visibility_status = 'visible'
      and coalesce(submission.is_disqualified, false) = false
      and cycle.status in (
        'active', 'submission_open', 'submission_closed', 'voting_open',
        'voting_closed', 'paused', 'finalizing'
      )
      and cycle.public_number is not null
      and sponsorship.is_active = true
      and nullif(btrim(sponsorship.sponsor_name), '') is not null
      and sponsorship.sponsor_link ~* '^https://[^[:space:]]+$'
      and sponsorship.feed_banner_r2_key ~ '^sponsored-cycles/drafts/feed/[0-9A-Fa-f-]{36}[.]webp$'
    order by cycle.id desc, sponsorship.id desc
    limit 1;
    return;
  end if;

  return query
  with eligible as (
    select
      result.submission_id,
      result.cycle_id,
      sponsorship.id as sponsorship_id,
      sponsorship.sponsor_name,
      sponsorship.sponsor_link,
      sponsorship.feed_banner_r2_key,
      row_number() over (
        order by
          result.finalized_at desc,
          result.cycle_id desc,
          result.rank_in_cycle asc,
          result.submission_id asc
      ) as placement_ordinal
    from public.cycle_results result
    join public.submissions submission on submission.id = result.submission_id
      and submission.cycle_id = result.cycle_id
    join public.voting_cycles cycle on cycle.id = result.cycle_id
    join public.cycle_sponsorships sponsorship on sponsorship.cycle_id = result.cycle_id
    where result.feed_classification_version = 1
      and result.feed_eligible = true
      and result.final_vote_count > 0
      and result.finalized_at is not null
      and result.rank_in_cycle is not null
      and submission.public_visibility_status = 'visible'
      and coalesce(submission.is_disqualified, false) = false
      and cycle.status = 'finished'
      and cycle.public_number is not null
      and (p_cycle_number is null or cycle.public_number = p_cycle_number)
      and (
        (p_feed_kind = 'top10' and result.rank_in_cycle <= 10)
        or (p_feed_kind = 'all' and result.feed_trash = false)
        or (p_feed_kind = 'trash' and result.feed_trash = true)
      )
      and nullif(btrim(sponsorship.sponsor_name), '') is not null
      and sponsorship.sponsor_link ~* '^https://[^[:space:]]+$'
      and sponsorship.feed_banner_r2_key ~ '^sponsored-cycles/drafts/feed/[0-9A-Fa-f-]{36}[.]webp$'
  )
  select
    eligible.sponsorship_id,
    eligible.cycle_id,
    eligible.sponsor_name,
    eligible.sponsor_link,
    eligible.feed_banner_r2_key,
    eligible.placement_ordinal
  from eligible
  where eligible.submission_id = p_submission_id
    and mod(eligible.placement_ordinal - 1, 7) = 0;
end;
$function$;

alter function public.resolve_community_feed_sponsor_placement(text, bigint, bigint)
  owner to postgres;
revoke all on function public.resolve_community_feed_sponsor_placement(text, bigint, bigint)
  from public, anon, authenticated, service_role, discord_bot;
grant execute on function public.resolve_community_feed_sponsor_placement(text, bigint, bigint)
  to service_role;

create or replace function public.start_cycle_managed(
  p_cycle_id bigint,
  p_actor_discord_user_id text,
  p_settings jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor_id text := btrim(p_actor_discord_user_id);
  v_actor_role text;
  v_actor_type text;
  v_started_at timestamptz := transaction_timestamp();
  v_result jsonb;
  v_result_cycle_id bigint;
  v_sponsor_link text;
  v_detail_banner_key text;
  v_feed_banner_key text;
begin
  v_actor_role := public.assert_cycle_manager(v_actor_id);
  v_actor_type := case when v_actor_role = 'admin' then 'admin' else 'moderator' end;

  perform pg_advisory_xact_lock(hashtextextended('sponsor-draft', 0));

  if exists (
    select 1
    from public.sponsor_media_upload_operations operation
    where operation.status = 'reserved'
      and operation.expires_at > transaction_timestamp()
  ) then
    raise exception using errcode = '40001', message = 'SPONSOR_DRAFT_UPLOAD_IN_PROGRESS';
  end if;

  if coalesce((p_settings #>> '{sponsored,enabled}')::boolean, false) then
    v_sponsor_link := nullif(btrim(p_settings #>> '{sponsored,sponsorLink}'), '');
    v_detail_banner_key := nullif(btrim(p_settings #>> '{sponsored,bannerR2Key}'), '');
    v_feed_banner_key := nullif(btrim(p_settings #>> '{sponsored,feedBannerR2Key}'), '');

    if v_sponsor_link is null
      or v_sponsor_link !~* '^https://[^[:space:]]+$'
      or v_detail_banner_key is null
      or (
        v_detail_banner_key !~ '^sponsored-cycles/drafts/[0-9A-Fa-f-]{36}[.]webp$'
        and v_detail_banner_key !~ '^sponsored-cycles/drafts/detail/[0-9A-Fa-f-]{36}[.]webp$'
      )
      or v_feed_banner_key is null
      or v_feed_banner_key !~ '^sponsored-cycles/drafts/feed/[0-9A-Fa-f-]{36}[.]webp$'
    then
      raise exception using errcode = '22023', message = 'INVALID_SPONSOR_SETTINGS';
    end if;
  end if;

  v_result := public.start_cycle(p_cycle_id, v_actor_id, p_settings);
  v_result_cycle_id := (v_result ->> 'cycleId')::bigint;

  if coalesce((p_settings #>> '{sponsored,enabled}')::boolean, false) then
    update public.cycle_sponsorships
    set feed_banner_r2_key = v_feed_banner_key,
        updated_at = transaction_timestamp()
    where cycle_id = v_result_cycle_id;
  end if;

  insert into public.app_config (key, value)
  values
    ('next_cycle_sponsor_feed_banner_r2_key', null),
    (
      'next_cycle_sponsor_draft_revision',
      (
        coalesce((
          select nullif(config.value, '')::bigint
          from public.app_config config
          where config.key = 'next_cycle_sponsor_draft_revision'
        ), 0) + 1
      )::text
    )
  on conflict (key) do update set value = excluded.value;

  update public.cycle_events
  set actor_type = v_actor_type,
      payload = (payload #- '{sponsored_cycle,banner_r2_key}') || jsonb_build_object(
        'authorizationCapability', 'cycles.manage',
        'authorizationRole', v_actor_role
      )
  where cycle_id = v_result_cycle_id
    and actor_discord_user_id = v_actor_id
    and created_at = v_started_at
    and event_type = 'submission_phase_opened';

  update public.admin_action_logs
  set actor_type = v_actor_type,
      meta = (meta #- '{sponsored_cycle,banner_r2_key}') || jsonb_build_object(
        'authorization_capability', 'cycles.manage',
        'authorization_role', v_actor_role
      )
  where actor_id = v_actor_id
    and target_type = 'cycle'
    and target_id = v_result_cycle_id::text
    and action = 'cycle_started'
    and created_at = v_started_at;

  return v_result || jsonb_build_object(
    'cycleNumber', (
      select cycle.public_number
      from public.voting_cycles cycle
      where cycle.id = v_result_cycle_id
    )
  );
end;
$function$;

alter function public.start_cycle_managed(bigint, text, jsonb) owner to postgres;
revoke all on function public.start_cycle_managed(bigint, text, jsonb)
  from public, anon, authenticated, service_role, discord_bot;
grant execute on function public.start_cycle_managed(bigint, text, jsonb) to service_role;

create or replace function public.reset_cycle_managed(
  p_cycle_id bigint,
  p_actor_discord_user_id text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor_id text := btrim(p_actor_discord_user_id);
  v_actor_role text;
  v_actor_type text;
  v_started_at timestamptz := transaction_timestamp();
  v_result jsonb;
  v_detail_key text;
  v_feed_key text;
  v_queue_ids bigint[] := '{}'::bigint[];
begin
  v_actor_role := public.assert_cycle_manager(v_actor_id);
  v_actor_type := case when v_actor_role = 'admin' then 'admin' else 'moderator' end;

  select sponsorship.banner_r2_key, sponsorship.feed_banner_r2_key
  into v_detail_key, v_feed_key
  from public.cycle_sponsorships sponsorship
  where sponsorship.cycle_id = p_cycle_id
  limit 1;

  v_result := public.reset_cycle(p_cycle_id, v_actor_id, p_reason);

  perform public.queue_sponsor_media_key_if_unreferenced(
    v_detail_key,
    'cycle_reset:' || p_cycle_id::text || ':detail'
  );
  perform public.queue_sponsor_media_key_if_unreferenced(
    v_feed_key,
    'cycle_reset:' || p_cycle_id::text || ':feed'
  );

  select coalesce(array_agg(queue.id order by queue.id), '{}'::bigint[])
  into v_queue_ids
  from public.media_cleanup_queue queue
  where queue.storage_provider = 'r2'
    and queue.storage_key in (v_detail_key, v_feed_key)
    and queue.status in ('pending', 'failed');

  select array_agg(distinct queue_id order by queue_id)
  into v_queue_ids
  from unnest(
    coalesce(array(
      select jsonb_array_elements_text(v_result -> 'r2CleanupQueueIds')::bigint
    ), '{}'::bigint[]) || coalesce(v_queue_ids, '{}'::bigint[])
  ) as merged(queue_id);

  v_result := v_result || jsonb_build_object(
    'cycleNumber', (
      select cycle.public_number from public.voting_cycles cycle where cycle.id = p_cycle_id
    ),
    'r2KeysPendingCleanup', cardinality(coalesce(v_queue_ids, '{}'::bigint[])),
    'r2CleanupQueueIds', to_jsonb(coalesce(v_queue_ids, '{}'::bigint[]))
  );

  update public.admin_action_logs
  set actor_type = v_actor_type,
      meta = meta || jsonb_build_object(
        'authorization_capability', 'cycles.manage',
        'authorization_role', v_actor_role,
        'r2_keys_pending_cleanup', cardinality(coalesce(v_queue_ids, '{}'::bigint[]))
      )
  where actor_id = v_actor_id
    and target_type = 'cycle'
    and target_id = p_cycle_id::text
    and action = 'cycle_reset'
    and created_at = v_started_at;

  return v_result;
end;
$function$;

alter function public.reset_cycle_managed(bigint, text, text) owner to postgres;
revoke all on function public.reset_cycle_managed(bigint, text, text)
  from public, anon, authenticated, service_role, discord_bot;
grant execute on function public.reset_cycle_managed(bigint, text, text) to service_role;

revoke insert, update, delete on table public.cycle_sponsorships from service_role;

do $postflight$
declare
  v_signature regprocedure;
begin
  foreach v_signature in array array[
    'public.reserve_sponsor_media_upload(text,uuid,text,bigint,text,text)'::regprocedure,
    'public.commit_sponsor_media_upload(text,uuid,text,boolean,text,boolean,text)'::regprocedure,
    'public.abort_sponsor_media_upload(text,uuid,text)'::regprocedure,
    'public.recover_stale_sponsor_media_uploads(integer)'::regprocedure,
    'public.resolve_community_feed_sponsor_placement(text,bigint,bigint)'::regprocedure,
    'public.record_sponsor_event_v2(bigint,text,text,text,text)'::regprocedure,
    'public.start_cycle_managed(bigint,text,jsonb)'::regprocedure,
    'public.reset_cycle_managed(bigint,text,text)'::regprocedure
  ] loop
    if not exists (
      select 1
      from pg_proc procedure
      join pg_namespace namespace on namespace.oid = procedure.pronamespace
      where procedure.oid = v_signature
        and namespace.nspname = 'public'
        and procedure.proowner = 'postgres'::regrole
        and procedure.prosecdef
        and procedure.proconfig @> array['search_path=public, pg_temp']
    ) then
      raise exception using
        errcode = '55000',
        message = 'DUAL_SPONSOR_BANNER_FUNCTION_HARDENING_FAILED',
        detail = v_signature::text;
    end if;
  end loop;

  if exists (
    select 1
    from pg_proc procedure
    join pg_namespace namespace on namespace.oid = procedure.pronamespace
    cross join lateral aclexplode(
      coalesce(procedure.proacl, acldefault('f', procedure.proowner))
    ) privilege
    where namespace.nspname = 'public'
      and procedure.proname in (
        'reserve_sponsor_media_upload',
        'commit_sponsor_media_upload',
        'abort_sponsor_media_upload',
        'recover_stale_sponsor_media_uploads',
        'resolve_community_feed_sponsor_placement',
        'record_sponsor_event_v2'
      )
      and privilege.privilege_type = 'EXECUTE'
      and privilege.grantee not in (
        'postgres'::regrole,
        'service_role'::regrole
      )
  ) then
    raise exception using
      errcode = '55000',
      message = 'DUAL_SPONSOR_BANNER_EXECUTE_ACL_FAILED';
  end if;
end;
$postflight$;

commit;
