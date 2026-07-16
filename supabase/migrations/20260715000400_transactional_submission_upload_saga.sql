begin;

create table public.submission_upload_operations (
  id uuid primary key default gen_random_uuid(),
  discord_user_id text not null,
  cycle_id bigint not null
    references public.voting_cycles(id) on delete restrict,
  idempotency_key uuid not null,
  request_fingerprint text not null,
  content_sha256 text not null,
  storage_provider text not null default 'r2',
  storage_key text not null,
  media_type text not null,
  media_bytes integer not null,
  r2_etag text,
  status text not null default 'reserved',
  submission_id bigint unique
    references public.submissions(id) on delete set null,
  cleanup_required boolean not null default false,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_attempt_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint submission_upload_operations_user_id_not_blank_check
    check (btrim(discord_user_id) <> ''),
  constraint submission_upload_operations_fingerprint_check
    check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint submission_upload_operations_content_hash_check
    check (content_sha256 ~ '^[0-9a-f]{64}$'),
  constraint submission_upload_operations_storage_provider_check
    check (storage_provider = 'r2'),
  constraint submission_upload_operations_storage_key_check
    check (
      storage_key ~ ('^' || cycle_id::text || '/[0-9A-Fa-f-]{36}[.]webp$')
    ),
  constraint submission_upload_operations_media_type_check
    check (media_type = 'image/webp'),
  constraint submission_upload_operations_media_bytes_check
    check (media_bytes > 0 and media_bytes <= 16777216),
  constraint submission_upload_operations_etag_length_check
    check (r2_etag is null or length(r2_etag) <= 256),
  constraint submission_upload_operations_status_check
    check (status in (
      'reserved',
      'r2_uploaded',
      'cleanup_pending',
      'completed',
      'failed'
    )),
  constraint submission_upload_operations_error_length_check
    check (last_error_code is null or length(last_error_code) <= 120),
  constraint submission_upload_operations_state_check
    check (
      (
        status = 'completed'
        and submission_id is not null
        and cleanup_required = false
        and completed_at is not null
      )
      or (
        status <> 'completed'
        and submission_id is null
        and completed_at is null
      )
    ),
  constraint submission_upload_operations_cleanup_state_check
    check (
      (status = 'cleanup_pending' and cleanup_required = true)
      or (status <> 'cleanup_pending' and cleanup_required = false)
    ),
  constraint submission_upload_operations_user_idempotency_unique
    unique (discord_user_id, idempotency_key),
  constraint submission_upload_operations_storage_key_unique
    unique (storage_provider, storage_key)
);

comment on table public.submission_upload_operations is
  'Server-only durable upload intent and idempotency ledger bridging R2 and the atomic PostgreSQL submission commit.';
comment on column public.submission_upload_operations.idempotency_key is
  'Client-generated random UUID bound to one authenticated user and the operation cycle; it contains no user data.';
comment on column public.submission_upload_operations.request_fingerprint is
  'SHA-256 of canonical transformed media hash and normalized user-supplied payout metadata.';
comment on column public.submission_upload_operations.storage_key is
  'Canonical server-generated R2 key. The client never chooses a bucket, prefix, cycle, submission, or object key.';
comment on column public.submission_upload_operations.status is
  'reserved before R2, r2_uploaded after provider confirmation, completed only with the atomic submission commit, cleanup_pending while compensation is durable, and failed only after a non-public failed operation is safe to retry.';

create index submission_upload_operations_cycle_status_idx
  on public.submission_upload_operations (cycle_id, status, created_at);

create index submission_upload_operations_stale_idx
  on public.submission_upload_operations (updated_at, id)
  where status in ('reserved', 'r2_uploaded');

create unique index submission_upload_operations_one_active_user_cycle_idx
  on public.submission_upload_operations (discord_user_id, cycle_id)
  where status in ('reserved', 'r2_uploaded');

create unique index submission_private_data_submission_id_uidx
  on public.submission_private_data (submission_id);

create unique index submission_social_links_submission_source_uidx
  on public.submission_social_links (
    submission_id,
    source_user_social_link_id
  )
  where source_user_social_link_id is not null;

alter table public.submission_upload_operations enable row level security;

revoke all on table public.submission_upload_operations
  from public, anon, authenticated;
grant select, insert, update, delete
  on table public.submission_upload_operations to service_role;

create or replace function public.submission_upload_error_code(
  p_error_code text
)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select left(
    regexp_replace(
      coalesce(nullif(btrim(p_error_code), ''), 'UPLOAD_FAILED'),
      '[^A-Za-z0-9_.-]',
      '_',
      'g'
    ),
    120
  );
$$;

create or replace function public.reserve_submission_upload(
  p_session_id uuid,
  p_idempotency_key uuid,
  p_request_fingerprint text,
  p_content_sha256 text,
  p_media_type text,
  p_media_bytes integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := transaction_timestamp();
  v_discord_user_id text;
  v_operation public.submission_upload_operations%rowtype;
  v_cycle public.voting_cycles%rowtype;
  v_user public.user_logs%rowtype;
  v_membership public.discord_member_state%rowtype;
  v_rules_version integer;
  v_cleanup_status text;
  v_storage_key text;
begin
  if p_session_id is null then
    return jsonb_build_object('outcome', 'not_authenticated');
  end if;

  if p_idempotency_key is null
    or p_request_fingerprint is null
    or p_request_fingerprint !~ '^[0-9a-f]{64}$'
    or p_content_sha256 is null
    or p_content_sha256 !~ '^[0-9a-f]{64}$'
    or p_media_type is distinct from 'image/webp'
    or p_media_bytes is null
    or p_media_bytes <= 0
    or p_media_bytes > 16777216
  then
    return jsonb_build_object('outcome', 'invalid_request');
  end if;

  select session.discord_user_id
  into v_discord_user_id
  from public.sessions session
  where session.id = p_session_id
    and session.revoked_at is null;

  if not found then
    return jsonb_build_object('outcome', 'not_authenticated');
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'submission-upload-idempotency:' ||
      v_discord_user_id || ':' || p_idempotency_key::text,
      0
    )
  );

  select operation.*
  into v_operation
  from public.submission_upload_operations operation
  where operation.discord_user_id = v_discord_user_id
    and operation.idempotency_key = p_idempotency_key
  for update;

  if found then
    if v_operation.request_fingerprint <> p_request_fingerprint
      or v_operation.content_sha256 <> p_content_sha256
      or v_operation.media_type <> p_media_type
      or v_operation.media_bytes <> p_media_bytes
    then
      return jsonb_build_object(
        'outcome', 'idempotency_conflict',
        'cycleId', v_operation.cycle_id
      );
    end if;

    if v_operation.status = 'completed' then
      return jsonb_build_object(
        'outcome', 'already_completed',
        'operationId', v_operation.id,
        'cycleId', v_operation.cycle_id,
        'submissionId', v_operation.submission_id
      );
    end if;

    if v_operation.status in ('reserved', 'r2_uploaded') then
      return jsonb_build_object(
        'outcome', 'in_progress',
        'operationId', v_operation.id,
        'cycleId', v_operation.cycle_id
      );
    end if;

    if v_operation.status = 'cleanup_pending' then
      select queue.status
      into v_cleanup_status
      from public.media_cleanup_queue queue
      where queue.storage_provider = v_operation.storage_provider
        and queue.storage_key = v_operation.storage_key;

      if v_cleanup_status is distinct from 'completed' then
        return jsonb_build_object(
          'outcome', case
            when v_cleanup_status = 'dead' then 'cleanup_blocked'
            else 'cleanup_pending'
          end,
          'operationId', v_operation.id,
          'cycleId', v_operation.cycle_id
        );
      end if;
    end if;
  end if;

  select cycle.*
  into v_cycle
  from public.voting_cycles cycle
  where cycle.status in ('submission_open', 'active')
  order by cycle.id desc
  limit 1
  for update;

  if not found then
    return jsonb_build_object('outcome', 'cycle_not_open');
  end if;

  if v_operation.id is not null
    and v_operation.cycle_id <> v_cycle.id
  then
    return jsonb_build_object(
      'outcome', 'idempotency_cycle_conflict',
      'cycleId', v_operation.cycle_id
    );
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'submission-upload-user-cycle:' ||
      v_discord_user_id || ':' || v_cycle.id::text,
      0
    )
  );

  select users.*
  into v_user
  from public.user_logs users
  where users.discord_user_id = v_discord_user_id;

  if not found then
    return jsonb_build_object('outcome', 'dependency_unavailable');
  end if;

  if v_user.is_banned then
    return jsonb_build_object('outcome', 'banned');
  end if;

  if coalesce(v_user.upload_fail_count, 0) >= 5 then
    return jsonb_build_object('outcome', 'rate_limited');
  end if;

  select rules.current_version
  into v_rules_version
  from public.rules_meta rules
  where rules.id = 1;

  if not found then
    return jsonb_build_object('outcome', 'dependency_unavailable');
  end if;

  if v_user.accepted_rules_version is distinct from v_rules_version then
    return jsonb_build_object('outcome', 'rules_not_accepted');
  end if;

  select membership.*
  into v_membership
  from public.discord_member_state membership
  where membership.discord_user_id = v_discord_user_id;

  if not found or not coalesce(v_membership.is_in_discord, false) then
    return jsonb_build_object('outcome', 'not_in_discord');
  end if;

  if v_membership.discord_joined_at is null
    or v_membership.discord_joined_at > v_now - interval '10 minutes'
  then
    return jsonb_build_object('outcome', 'joined_too_recently');
  end if;

  if exists (
    select 1
    from public.submissions submission
    where submission.cycle_id = v_cycle.id
      and submission.discord_user_id = v_discord_user_id
  ) then
    return jsonb_build_object('outcome', 'upload_limit_reached');
  end if;

  if exists (
    select 1
    from public.submission_upload_operations other_operation
    where other_operation.discord_user_id = v_discord_user_id
      and other_operation.cycle_id = v_cycle.id
      and other_operation.status in ('reserved', 'r2_uploaded')
      and (
        v_operation.id is null
        or other_operation.id <> v_operation.id
      )
  ) then
    return jsonb_build_object('outcome', 'upload_in_progress');
  end if;

  v_storage_key :=
    v_cycle.id::text || '/' || gen_random_uuid()::text || '.webp';

  if v_operation.id is null then
    insert into public.submission_upload_operations (
      discord_user_id,
      cycle_id,
      idempotency_key,
      request_fingerprint,
      content_sha256,
      storage_key,
      media_type,
      media_bytes,
      status,
      created_at,
      updated_at,
      last_attempt_at
    ) values (
      v_discord_user_id,
      v_cycle.id,
      p_idempotency_key,
      p_request_fingerprint,
      p_content_sha256,
      v_storage_key,
      p_media_type,
      p_media_bytes,
      'reserved',
      v_now,
      v_now,
      v_now
    )
    returning * into v_operation;
  else
    update public.submission_upload_operations operation
    set
      storage_key = v_storage_key,
      status = 'reserved',
      r2_etag = null,
      cleanup_required = false,
      last_error_code = null,
      updated_at = v_now,
      last_attempt_at = v_now,
      completed_at = null,
      submission_id = null
    where operation.id = v_operation.id
    returning * into v_operation;
  end if;

  return jsonb_build_object(
    'outcome', 'reserved',
    'operationId', v_operation.id,
    'cycleId', v_operation.cycle_id,
    'storageKey', v_operation.storage_key
  );
end;
$$;

create or replace function public.mark_submission_upload_r2_uploaded(
  p_operation_id uuid,
  p_session_id uuid,
  p_r2_etag text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := transaction_timestamp();
  v_discord_user_id text;
  v_operation public.submission_upload_operations%rowtype;
begin
  if p_operation_id is null or p_session_id is null then
    return jsonb_build_object('outcome', 'invalid_request');
  end if;

  select session.discord_user_id
  into v_discord_user_id
  from public.sessions session
  where session.id = p_session_id
    and session.revoked_at is null;

  if not found then
    return jsonb_build_object('outcome', 'not_authenticated');
  end if;

  select operation.*
  into v_operation
  from public.submission_upload_operations operation
  where operation.id = p_operation_id
    and operation.discord_user_id = v_discord_user_id
  for update;

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_operation.status = 'completed' then
    return jsonb_build_object(
      'outcome', 'already_completed',
      'operationId', v_operation.id,
      'submissionId', v_operation.submission_id
    );
  end if;

  if v_operation.status = 'r2_uploaded' then
    return jsonb_build_object(
      'outcome', 'r2_uploaded',
      'operationId', v_operation.id
    );
  end if;

  if v_operation.status <> 'reserved' then
    return jsonb_build_object(
      'outcome', 'invalid_state',
      'status', v_operation.status
    );
  end if;

  update public.submission_upload_operations operation
  set
    status = 'r2_uploaded',
    r2_etag = case
      when p_r2_etag is null then null
      else left(p_r2_etag, 256)
    end,
    updated_at = v_now,
    last_attempt_at = v_now,
    last_error_code = null
  where operation.id = p_operation_id;

  return jsonb_build_object(
    'outcome', 'r2_uploaded',
    'operationId', p_operation_id
  );
end;
$$;

create or replace function public.commit_submission_upload(
  p_operation_id uuid,
  p_session_id uuid,
  p_wallet_address text,
  p_payout_choice text,
  p_split_percent integer,
  p_charity text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := transaction_timestamp();
  v_discord_user_id text;
  v_operation public.submission_upload_operations%rowtype;
  v_cycle public.voting_cycles%rowtype;
  v_user public.user_logs%rowtype;
  v_membership public.discord_member_state%rowtype;
  v_rules_version integer;
  v_submission_id bigint;
  v_social_snapshot_count integer := 0;
  v_wallet_address text := coalesce(btrim(p_wallet_address), '');
  v_charity text := nullif(btrim(p_charity), '');
begin
  if p_operation_id is null or p_session_id is null then
    return jsonb_build_object('outcome', 'invalid_request');
  end if;

  if p_payout_choice is null
    or p_payout_choice not in ('keep', 'donate', 'split')
    or length(v_wallet_address) > 512
    or length(coalesce(v_charity, '')) > 256
    or (
      p_payout_choice = 'keep'
      and (
        v_wallet_address = ''
        or p_split_percent is not null
        or v_charity is not null
      )
    )
    or (
      p_payout_choice = 'donate'
      and (
        v_wallet_address <> ''
        or p_split_percent is not null
        or v_charity is null
      )
    )
    or (
      p_payout_choice = 'split'
      and (
        v_wallet_address = ''
        or p_split_percent is null
        or p_split_percent <= 0
        or p_split_percent >= 100
        or v_charity is null
      )
    )
  then
    return jsonb_build_object('outcome', 'invalid_private_data');
  end if;

  select session.discord_user_id
  into v_discord_user_id
  from public.sessions session
  where session.id = p_session_id
    and session.revoked_at is null;

  if not found then
    return jsonb_build_object('outcome', 'not_authenticated');
  end if;

  select operation.*
  into v_operation
  from public.submission_upload_operations operation
  where operation.id = p_operation_id
    and operation.discord_user_id = v_discord_user_id
  for update;

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_operation.status = 'completed' then
    return jsonb_build_object(
      'outcome', 'already_completed',
      'operationId', v_operation.id,
      'cycleId', v_operation.cycle_id,
      'submissionId', v_operation.submission_id
    );
  end if;

  if v_operation.status <> 'r2_uploaded' then
    return jsonb_build_object(
      'outcome', 'invalid_state',
      'status', v_operation.status
    );
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'submission-upload-user-cycle:' ||
      v_discord_user_id || ':' || v_operation.cycle_id::text,
      0
    )
  );

  select cycle.*
  into v_cycle
  from public.voting_cycles cycle
  where cycle.id = v_operation.cycle_id
  for update;

  if not found or v_cycle.status::text not in ('submission_open', 'active') then
    return jsonb_build_object('outcome', 'cycle_not_open');
  end if;

  select users.*
  into v_user
  from public.user_logs users
  where users.discord_user_id = v_discord_user_id;

  if not found then
    return jsonb_build_object('outcome', 'dependency_unavailable');
  end if;

  if v_user.is_banned then
    return jsonb_build_object('outcome', 'banned');
  end if;

  if coalesce(v_user.upload_fail_count, 0) >= 5 then
    return jsonb_build_object('outcome', 'rate_limited');
  end if;

  select rules.current_version
  into v_rules_version
  from public.rules_meta rules
  where rules.id = 1;

  if not found then
    return jsonb_build_object('outcome', 'dependency_unavailable');
  end if;

  if v_user.accepted_rules_version is distinct from v_rules_version then
    return jsonb_build_object('outcome', 'rules_not_accepted');
  end if;

  select membership.*
  into v_membership
  from public.discord_member_state membership
  where membership.discord_user_id = v_discord_user_id;

  if not found or not coalesce(v_membership.is_in_discord, false) then
    return jsonb_build_object('outcome', 'not_in_discord');
  end if;

  if v_membership.discord_joined_at is null
    or v_membership.discord_joined_at > v_now - interval '10 minutes'
  then
    return jsonb_build_object('outcome', 'joined_too_recently');
  end if;

  if exists (
    select 1
    from public.submissions submission
    where submission.cycle_id = v_operation.cycle_id
      and submission.discord_user_id = v_discord_user_id
  ) then
    return jsonb_build_object('outcome', 'upload_limit_reached');
  end if;

  if v_operation.storage_provider <> 'r2'
    or v_operation.storage_key !~ (
      '^' || v_operation.cycle_id::text || '/[0-9A-Fa-f-]{36}[.]webp$'
    )
    or v_operation.media_type <> 'image/webp'
    or v_operation.media_bytes <= 0
    or v_operation.content_sha256 !~ '^[0-9a-f]{64}$'
  then
    return jsonb_build_object('outcome', 'invalid_media_metadata');
  end if;

  insert into public.submissions (
    cycle_id,
    discord_user_id,
    r2_key,
    discord_username_at_upload
  ) values (
    v_operation.cycle_id,
    v_discord_user_id,
    v_operation.storage_key,
    coalesce(v_user.current_discord_username, 'unknown')
  )
  returning id into v_submission_id;

  insert into public.submission_private_data (
    submission_id,
    x_username,
    wallet_address,
    payout_choice,
    split_percent,
    charity
  ) values (
    v_submission_id,
    null,
    v_wallet_address,
    p_payout_choice,
    case when p_payout_choice = 'split' then p_split_percent else null end,
    case when p_payout_choice in ('donate', 'split') then v_charity else null end
  );

  if v_user.show_socials_on_submissions then
    insert into public.submission_social_links (
      submission_id,
      discord_user_id,
      platform,
      display_label,
      profile_url,
      is_verified_snapshot,
      source_user_social_link_id
    )
    select
      v_submission_id,
      v_discord_user_id,
      social.platform,
      case
        when nullif(btrim(social.handle), '') is not null
          and not (
            social.platform = 'facebook'
            and social.handle like 'id:%'
          )
          then social.handle
        else social.profile_url
      end,
      social.profile_url,
      true,
      social.id
    from public.user_social_links social
    where social.discord_user_id = v_discord_user_id
      and social.is_verified = true
    order by social.created_at, social.id;

    get diagnostics v_social_snapshot_count = row_count;
  end if;

  insert into public.upload_logs (
    cycle_id,
    discord_user_id,
    submission_id,
    status,
    reason
  ) values (
    v_operation.cycle_id::text,
    v_discord_user_id,
    v_submission_id::text,
    'success',
    null
  );

  update public.submission_upload_operations operation
  set
    status = 'completed',
    submission_id = v_submission_id,
    cleanup_required = false,
    last_error_code = null,
    updated_at = v_now,
    last_attempt_at = v_now,
    completed_at = v_now
  where operation.id = v_operation.id;

  return jsonb_build_object(
    'outcome', 'completed',
    'operationId', v_operation.id,
    'cycleId', v_operation.cycle_id,
    'submissionId', v_submission_id,
    'socialSnapshotCount', v_social_snapshot_count
  );
end;
$$;

create or replace function public.enqueue_submission_upload_cleanup(
  p_operation_id uuid,
  p_session_id uuid,
  p_error_code text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := transaction_timestamp();
  v_discord_user_id text;
  v_operation public.submission_upload_operations%rowtype;
  v_error_code text;
  v_queue_id bigint;
  v_queue_status text;
begin
  if p_operation_id is null or p_session_id is null then
    return jsonb_build_object('outcome', 'invalid_request');
  end if;

  select session.discord_user_id
  into v_discord_user_id
  from public.sessions session
  where session.id = p_session_id;

  if not found then
    return jsonb_build_object('outcome', 'not_authenticated');
  end if;

  select operation.*
  into v_operation
  from public.submission_upload_operations operation
  where operation.id = p_operation_id
    and operation.discord_user_id = v_discord_user_id
  for update;

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_operation.status = 'completed' then
    return jsonb_build_object(
      'outcome', 'already_completed',
      'operationId', v_operation.id,
      'submissionId', v_operation.submission_id
    );
  end if;

  v_error_code := public.submission_upload_error_code(p_error_code);

  insert into public.media_cleanup_queue (
    storage_provider,
    storage_key,
    reason,
    status
  ) values (
    v_operation.storage_provider,
    v_operation.storage_key,
    'submission_upload_compensation:' || v_operation.id::text,
    'pending'
  )
  on conflict (storage_provider, storage_key) do nothing;

  select queue.id, queue.status
  into v_queue_id, v_queue_status
  from public.media_cleanup_queue queue
  where queue.storage_provider = v_operation.storage_provider
    and queue.storage_key = v_operation.storage_key;

  update public.submission_upload_operations operation
  set
    status = 'cleanup_pending',
    submission_id = null,
    cleanup_required = true,
    last_error_code = v_error_code,
    updated_at = v_now,
    last_attempt_at = v_now,
    completed_at = null
  where operation.id = v_operation.id;

  return jsonb_build_object(
    'outcome', 'cleanup_pending',
    'operationId', v_operation.id,
    'queueId', v_queue_id,
    'queueStatus', v_queue_status
  );
end;
$$;

create or replace function public.recover_stale_submission_uploads(
  p_limit integer default 100,
  p_stale_after_seconds integer default 900
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := transaction_timestamp();
  v_recovered integer := 0;
  v_queued integer := 0;
begin
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception using message = 'INVALID_UPLOAD_RECOVERY_BATCH_SIZE';
  end if;

  if p_stale_after_seconds is null
    or p_stale_after_seconds < 60
    or p_stale_after_seconds > 86400
  then
    raise exception using message = 'INVALID_UPLOAD_RECOVERY_STALE_SECONDS';
  end if;

  with stale_operations as (
    select operation.id
    from public.submission_upload_operations operation
    where operation.status in ('reserved', 'r2_uploaded')
      and operation.updated_at <=
        v_now - make_interval(secs => p_stale_after_seconds)
    order by operation.updated_at, operation.id
    for update skip locked
    limit p_limit
  ), inserted_queue as (
    insert into public.media_cleanup_queue (
      storage_provider,
      storage_key,
      reason,
      status
    )
    select
      operation.storage_provider,
      operation.storage_key,
      'submission_upload_recovery:' || operation.id::text,
      'pending'
    from public.submission_upload_operations operation
    join stale_operations stale on stale.id = operation.id
    on conflict (storage_provider, storage_key) do nothing
    returning id
  ), updated_operations as (
    update public.submission_upload_operations operation
    set
      status = 'cleanup_pending',
      cleanup_required = true,
      last_error_code = 'STALE_UPLOAD_RECOVERED',
      updated_at = v_now,
      last_attempt_at = v_now
    from stale_operations stale
    where operation.id = stale.id
    returning operation.id
  )
  select
    (select count(*)::integer from updated_operations),
    (select count(*)::integer from inserted_queue)
  into v_recovered, v_queued;

  return jsonb_build_object(
    'recovered', v_recovered,
    'queued', v_queued
  );
end;
$$;

create or replace function public.enqueue_deleted_submission_media()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.r2_key is not null and btrim(old.r2_key) <> '' then
    insert into public.media_cleanup_queue (
      storage_provider,
      storage_key,
      reason,
      status
    ) values (
      'r2',
      old.r2_key,
      'submission_deleted:' || old.id::text,
      'pending'
    )
    on conflict (storage_provider, storage_key) do nothing;
  end if;

  update public.submission_upload_operations operation
  set
    status = 'cleanup_pending',
    submission_id = null,
    cleanup_required = true,
    last_error_code = 'SUBMISSION_DELETED',
    updated_at = transaction_timestamp(),
    last_attempt_at = transaction_timestamp(),
    completed_at = null
  where operation.submission_id = old.id
    and operation.status = 'completed';

  return old;
end;
$$;

drop trigger if exists submissions_enqueue_deleted_media
  on public.submissions;
create trigger submissions_enqueue_deleted_media
before delete on public.submissions
for each row
execute function public.enqueue_deleted_submission_media();

revoke all on function public.submission_upload_error_code(text)
  from public, anon, authenticated;
revoke all on function public.reserve_submission_upload(uuid, uuid, text, text, text, integer)
  from public, anon, authenticated;
revoke all on function public.mark_submission_upload_r2_uploaded(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.commit_submission_upload(uuid, uuid, text, text, integer, text)
  from public, anon, authenticated;
revoke all on function public.enqueue_submission_upload_cleanup(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.recover_stale_submission_uploads(integer, integer)
  from public, anon, authenticated;
revoke all on function public.enqueue_deleted_submission_media()
  from public, anon, authenticated;

grant execute on function public.submission_upload_error_code(text)
  to service_role;
grant execute on function public.reserve_submission_upload(uuid, uuid, text, text, text, integer)
  to service_role;
grant execute on function public.mark_submission_upload_r2_uploaded(uuid, uuid, text)
  to service_role;
grant execute on function public.commit_submission_upload(uuid, uuid, text, text, integer, text)
  to service_role;
grant execute on function public.enqueue_submission_upload_cleanup(uuid, uuid, text)
  to service_role;
grant execute on function public.recover_stale_submission_uploads(integer, integer)
  to service_role;
grant execute on function public.enqueue_deleted_submission_media()
  to service_role;

comment on function public.reserve_submission_upload(uuid, uuid, text, text, text, integer) is
  'Validates the confirmed session and current upload eligibility, serializes one user/cycle intent, and returns a server-generated R2 key. Replays are conflict-safe and completed operations are stable.';
comment on function public.commit_submission_upload(uuid, uuid, text, text, integer, text) is
  'Revalidates session, membership, ban, rules, rate limit, cycle phase, and per-cycle upload limit under locks, then atomically creates the submission, private data, verified social snapshots, success audit, and completed operation.';
comment on function public.enqueue_submission_upload_cleanup(uuid, uuid, text) is
  'Atomically marks an unfinished upload as cleanup_pending and deduplicates its canonical R2 key into the shared media cleanup queue.';
comment on function public.recover_stale_submission_uploads(integer, integer) is
  'Recovers crashed upload intents by marking them cleanup_pending and enqueueing their possibly-present R2 keys. Missing objects remain successful idempotent cleanup.';

commit;
