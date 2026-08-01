begin;

create temporary table user_flag_5c2_guard
on commit drop
as
select
  (select count(*) from public.user_flag_cases) as case_count,
  (select count(*) from public.user_flag_events) as event_count,
  (select count(*) from public.user_flag_requests) as request_count,
  (
    select md5(coalesce(string_agg(md5(to_jsonb(event_row)::text), '' order by event_id), ''))
    from public.user_flag_events as event_row
  ) as event_hash;

do $preflight$
begin
  if exists (
    select 1
    from public.user_flag_cases
    group by discord_user_id
    having count(*) filter (where status = 'open') > 1
  ) then
    raise exception using
      errcode = '55000',
      message = 'USER_FLAG_5C2_ACTIVE_CASE_PREFLIGHT_CONFLICT';
  end if;

  if not exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.user_logs'::regclass
      and tgname = 'user_logs_website_ban_session_revocation_trigger'
      and tgenabled <> 'D'
  ) then
    raise exception using
      errcode = '55000',
      message = 'USER_FLAG_5C2_WEBSITE_BAN_REVOCATION_UNAVAILABLE';
  end if;
end
$preflight$;

alter table public.user_flag_cases
  add column escalated_at timestamptz,
  add column escalated_by_discord_user_id text,
  add column escalated_by_display_name text,
  add column escalation_reason text;

alter table public.user_flag_cases
  drop constraint user_flag_cases_status_check,
  drop constraint user_flag_cases_review_state_check;

alter table public.user_flag_cases
  add constraint user_flag_cases_status_check
    check (status in ('open', 'escalated', 'resolved', 'dismissed')),
  add constraint user_flag_cases_escalation_reason_check
    check (
      escalation_reason is null
      or char_length(btrim(escalation_reason)) between 3 and 1000
    ),
  add constraint user_flag_cases_review_state_check
    check (
      (
        status = 'open'
        and escalated_at is null
        and escalated_by_discord_user_id is null
        and escalated_by_display_name is null
        and escalation_reason is null
        and reviewed_at is null
        and reviewed_by_discord_user_id is null
        and reviewed_by_display_name is null
        and review_reason is null
      )
      or (
        status = 'escalated'
        and escalated_at is not null
        and nullif(btrim(escalated_by_discord_user_id), '') is not null
        and escalation_reason is not null
        and reviewed_at is null
        and reviewed_by_discord_user_id is null
        and reviewed_by_display_name is null
        and review_reason is null
      )
      or (
        status in ('resolved', 'dismissed')
        and reviewed_at is not null
        and nullif(btrim(reviewed_by_discord_user_id), '') is not null
        and review_reason is not null
        and (
          (escalated_at is null
            and escalated_by_discord_user_id is null
            and escalated_by_display_name is null
            and escalation_reason is null)
          or
          (escalated_at is not null
            and nullif(btrim(escalated_by_discord_user_id), '') is not null
            and escalation_reason is not null)
        )
      )
    );

drop index public.user_flag_cases_one_open_per_user_idx;

create unique index user_flag_cases_one_active_per_user_idx
  on public.user_flag_cases(discord_user_id)
  where status in ('open', 'escalated');

alter table public.user_flag_events
  drop constraint user_flag_events_type_check,
  drop constraint user_flag_events_status_check,
  drop constraint user_flag_events_transition_check;

alter table public.user_flag_events
  add constraint user_flag_events_type_check
    check (
      event_type in (
        'case_created',
        'legacy_case_migrated',
        'case_escalated',
        'case_resolved',
        'case_dismissed',
        'case_banned_and_resolved'
      )
    ),
  add constraint user_flag_events_status_check
    check (
      (
        previous_status is null
        or previous_status in ('open', 'escalated', 'resolved', 'dismissed')
      )
      and new_status in ('open', 'escalated', 'resolved', 'dismissed')
    ),
  add constraint user_flag_events_transition_check
    check (
      (event_type in ('case_created', 'legacy_case_migrated')
        and previous_status is null and new_status = 'open')
      or (event_type = 'case_escalated'
        and previous_status = 'open' and new_status = 'escalated')
      or (event_type = 'case_resolved'
        and previous_status in ('open', 'escalated') and new_status = 'resolved')
      or (event_type = 'case_dismissed'
        and previous_status in ('open', 'escalated') and new_status = 'dismissed')
      or (event_type = 'case_banned_and_resolved'
        and previous_status = 'escalated' and new_status = 'resolved')
    );

create table public.user_flag_actor_snapshots (
  event_id uuid primary key
    references public.user_flag_events(event_id)
    on update restrict on delete restrict,
  actor_account_id text,
  actor_discord_user_id text,
  actor_username text,
  captured_at timestamptz,
  recorded_at timestamptz not null default now(),
  constraint user_flag_actor_snapshots_identity_check
    check (
      (actor_account_id is null and actor_discord_user_id is null)
      or (
        nullif(btrim(actor_account_id), '') is not null
        and nullif(btrim(actor_discord_user_id), '') is not null
      )
    )
);

alter table public.user_flag_actor_snapshots owner to postgres;
alter table public.user_flag_actor_snapshots enable row level security;
revoke all on table public.user_flag_actor_snapshots
  from public, anon, authenticated, discord_bot, service_role;
grant select on table public.user_flag_actor_snapshots to service_role;

create trigger protect_user_flag_actor_snapshots
before update or delete on public.user_flag_actor_snapshots
for each row execute function public.protect_user_flag_append_only();

insert into public.user_flag_actor_snapshots (
  event_id,
  actor_account_id,
  actor_discord_user_id,
  actor_username,
  captured_at,
  recorded_at
)
select
  event_row.event_id,
  event_row.actor_discord_user_id,
  event_row.actor_discord_user_id,
  event_row.actor_display_name,
  event_row.occurred_at,
  event_row.recorded_at
from public.user_flag_events as event_row;

create or replace function public.capture_user_flag_actor_snapshot(
  p_event_id uuid,
  p_actor_discord_user_id text,
  p_actor_username text,
  p_captured_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  insert into public.user_flag_actor_snapshots (
    event_id,
    actor_account_id,
    actor_discord_user_id,
    actor_username,
    captured_at
  )
  values (
    p_event_id,
    nullif(btrim(p_actor_discord_user_id), ''),
    nullif(btrim(p_actor_discord_user_id), ''),
    nullif(btrim(p_actor_username), ''),
    p_captured_at
  );
end;
$function$;

create or replace function public.authorize_user_flag_capability(
  p_actor_discord_user_id text,
  p_capability_key text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor_id text := btrim(p_actor_discord_user_id);
  v_actor_role text;
  v_expected_hash text;
begin
  v_expected_hash := case p_capability_key
    when 'users.flag.create' then
      '284ad15bb26a61110b34d96f51b199ed0223d66bbe81462e7e89fd534972231b'
    when 'users.flag.view' then
      '20f04bf3dc07ce7b0f77a31633f6a90b4ce003ad8e03618d078228236dd4699e'
    when 'users.flag.review' then
      '8ec44455bd08212cab4cacc64dfcd96b139edd9753862255d68150e702b26869'
    else null
  end;

  if nullif(v_actor_id, '') is null or v_expected_hash is null then
    raise exception using errcode = '42501', message = 'USER_FLAG_FORBIDDEN';
  end if;

  if not exists (
    select 1
    from public.capability_catalog
    where key = p_capability_key
      and is_active
      and assignable_to_non_admin
      and implementation_version = 2
      and definition_hash = v_expected_hash
  ) then
    raise exception using
      errcode = '55000',
      message = 'USER_FLAG_AUTHORIZATION_DEPENDENCY_UNAVAILABLE';
  end if;

  select member_row.role
  into v_actor_role
  from public.team_members as member_row
  join public.team_roles as role_row
    on role_row.key = member_row.role and role_row.is_active
  where member_row.discord_user_id = v_actor_id;

  if not found
    or (
      v_actor_role <> 'admin'
      and not exists (
        select 1
        from public.team_role_capabilities
        where role_key = v_actor_role
          and capability_key = p_capability_key
      )
    ) then
    raise exception using errcode = '42501', message = 'USER_FLAG_FORBIDDEN';
  end if;

  return v_actor_role;
end;
$function$;

create or replace function public.apply_website_ban_contract(
  p_actor_discord_user_id text,
  p_target_discord_user_id text,
  p_reason text,
  p_source text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor_id text := btrim(p_actor_discord_user_id);
  v_target_id text := btrim(p_target_discord_user_id);
  v_reason text := btrim(p_reason);
  v_source text := coalesce(nullif(btrim(p_source), ''), 'admin_manual');
  v_actor_username text;
  v_target_banned boolean;
begin
  if nullif(v_actor_id, '') is null
    or nullif(v_target_id, '') is null
    or char_length(v_reason) not between 3 and 1000
    or v_source not in ('admin_manual', 'illegal_submission') then
    raise exception using errcode = '22023', message = 'INVALID_WEBSITE_BAN_REQUEST';
  end if;

  if not exists (
    select 1
    from public.team_members as member_row
    join public.team_roles as role_row
      on role_row.key = member_row.role and role_row.is_active
    where member_row.discord_user_id = v_actor_id
      and member_row.role = 'admin'
  ) then
    raise exception using errcode = '42501', message = 'WEBSITE_BAN_FORBIDDEN';
  end if;

  select nullif(btrim(current_discord_username), '')
  into v_actor_username
  from public.user_logs
  where discord_user_id = v_actor_id;

  select is_banned
  into v_target_banned
  from public.user_logs
  where discord_user_id = v_target_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'WEBSITE_BAN_TARGET_NOT_FOUND';
  end if;
  if v_target_banned then
    raise exception using errcode = 'PT409', message = 'WEBSITE_BAN_ALREADY_ACTIVE';
  end if;

  update public.user_logs
  set is_banned = true,
      ban_reason = v_reason,
      ban_source = v_source,
      banned_at = now(),
      banned_by_discord_user_id = v_actor_id,
      banned_by_discord_username = v_actor_username
  where discord_user_id = v_target_id;
end;
$function$;

create or replace function public.ban_website_user(
  p_actor_discord_user_id text,
  p_target_discord_user_id text,
  p_reason text,
  p_source text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  perform public.apply_website_ban_contract(
    p_actor_discord_user_id,
    p_target_discord_user_id,
    p_reason,
    p_source
  );
  return jsonb_build_object('success', true);
end;
$function$;

create or replace function public.get_user_flag_active_status(
  p_actor_discord_user_id text,
  p_target_discord_user_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_target_id text := btrim(p_target_discord_user_id);
  v_status text;
begin
  if nullif(v_target_id, '') is null or char_length(v_target_id) > 100 then
    raise exception using errcode = '22023', message = 'INVALID_USER_FLAG_STATUS_REQUEST';
  end if;

  perform public.authorize_user_flag_capability(
    p_actor_discord_user_id,
    'users.flag.create'
  );

  if not exists (
    select 1 from public.user_logs where discord_user_id = v_target_id
  ) then
    raise exception using errcode = 'P0002', message = 'USER_FLAG_TARGET_NOT_FOUND';
  end if;

  select status
  into v_status
  from public.user_flag_cases
  where discord_user_id = v_target_id
    and status in ('open', 'escalated');

  return jsonb_build_object(
    'active', v_status is not null,
    'status', v_status
  );
end;
$function$;

create or replace function public.create_user_flag_case(
  p_actor_discord_user_id text,
  p_target_discord_user_id text,
  p_category text,
  p_reason text,
  p_comment text,
  p_submission_id bigint,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor_id text := btrim(p_actor_discord_user_id);
  v_target_id text := btrim(p_target_discord_user_id);
  v_category text := btrim(p_category);
  v_reason text := btrim(p_reason);
  v_comment text := nullif(btrim(p_comment), '');
  v_actor_username text;
  v_request_payload jsonb;
  v_request_hash text;
  v_existing_hash text;
  v_existing_result jsonb;
  v_case_id uuid;
  v_event_id uuid;
  v_now timestamptz := now();
  v_result jsonb;
begin
  if p_idempotency_key is null
    or nullif(v_target_id, '') is null
    or char_length(v_target_id) > 100
    or v_category not in ('trolling_low_effort', 'suspicious_behavior', 'other')
    or v_reason is null
    or char_length(v_reason) not between 3 and 1000
    or (v_comment is not null and char_length(v_comment) > 2000) then
    raise exception using errcode = '22023', message = 'INVALID_USER_FLAG_CREATE_REQUEST';
  end if;

  perform public.authorize_user_flag_capability(v_actor_id, 'users.flag.create');

  v_request_payload := jsonb_build_object(
    'operation', 'create',
    'operationVersion', 2,
    'actorDiscordUserId', v_actor_id,
    'targetDiscordUserId', v_target_id,
    'category', v_category,
    'reason', v_reason,
    'comment', v_comment,
    'submissionId', p_submission_id
  );
  v_request_hash := encode(
    extensions.digest(convert_to(v_request_payload::text, 'UTF8'), 'sha256'),
    'hex'
  );

  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));

  select request_hash, result
  into v_existing_hash, v_existing_result
  from public.user_flag_requests
  where idempotency_key = p_idempotency_key;

  if found then
    if v_existing_hash = v_request_hash then
      return jsonb_set(v_existing_result, '{replayed}', 'true'::jsonb);
    end if;
    raise exception using errcode = 'PT409', message = 'USER_FLAG_IDEMPOTENCY_CONFLICT';
  end if;

  perform 1
  from public.user_logs
  where discord_user_id = v_target_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'USER_FLAG_TARGET_NOT_FOUND';
  end if;

  if p_submission_id is not null
    and not exists (
      select 1
      from public.submissions
      where id = p_submission_id and discord_user_id = v_target_id
    ) then
    raise exception using
      errcode = '22023',
      message = 'INVALID_USER_FLAG_SUBMISSION_REFERENCE';
  end if;

  if exists (
    select 1
    from public.user_flag_cases
    where discord_user_id = v_target_id
      and status in ('open', 'escalated')
  ) then
    raise exception using errcode = 'PT409', message = 'USER_FLAG_ACTIVE_CASE_CONFLICT';
  end if;

  select nullif(btrim(current_discord_username), '')
  into v_actor_username
  from public.user_logs
  where discord_user_id = v_actor_id;

  insert into public.user_flag_cases (
    discord_user_id,
    category,
    reason,
    comment,
    submission_id,
    created_at,
    created_by_actor_kind,
    created_by_discord_user_id,
    created_by_display_name
  )
  values (
    v_target_id,
    v_category,
    v_reason,
    v_comment,
    p_submission_id,
    v_now,
    'user',
    v_actor_id,
    v_actor_username
  )
  returning case_id into v_case_id;

  insert into public.user_flag_events (
    case_id,
    event_type,
    previous_status,
    new_status,
    actor_kind,
    actor_discord_user_id,
    actor_display_name,
    occurred_at,
    reason,
    comment,
    case_version
  )
  values (
    v_case_id,
    'case_created',
    null,
    'open',
    'user',
    v_actor_id,
    v_actor_username,
    v_now,
    v_reason,
    v_comment,
    1
  )
  returning event_id into v_event_id;

  perform public.capture_user_flag_actor_snapshot(
    v_event_id,
    v_actor_id,
    v_actor_username,
    v_now
  );

  v_result := jsonb_build_object(
    'caseId', v_case_id,
    'status', 'open',
    'rowVersion', 1,
    'replayed', false
  );

  insert into public.user_flag_requests (
    idempotency_key,
    operation,
    actor_discord_user_id,
    request_hash,
    request_payload,
    result
  )
  values (
    p_idempotency_key,
    'create',
    v_actor_id,
    v_request_hash,
    v_request_payload,
    v_result
  );

  return v_result;
exception
  when unique_violation then
    raise exception using errcode = 'PT409', message = 'USER_FLAG_ACTIVE_CASE_CONFLICT';
end;
$function$;

create or replace function public.build_user_flag_case_payload(
  p_case_id uuid,
  p_include_events boolean
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select jsonb_build_object(
    'caseId', flag_case.case_id,
    'discordUserId', flag_case.discord_user_id,
    'userDisplayName', coalesce(
      nullif(btrim(target.current_display_name), ''),
      nullif(btrim(target.current_guild_nickname), ''),
      nullif(btrim(target.current_discord_username), ''),
      flag_case.discord_user_id
    ),
    'status', flag_case.status,
    'category', flag_case.category,
    'reason', flag_case.reason,
    'comment', flag_case.comment,
    'submissionId', flag_case.submission_id,
    'createdAt', flag_case.created_at,
    'recordedAt', flag_case.recorded_at,
    'createdByDiscordUserId', flag_case.created_by_discord_user_id,
    'createdByDisplayName', flag_case.created_by_display_name,
    'escalatedAt', flag_case.escalated_at,
    'escalatedByDiscordUserId', flag_case.escalated_by_discord_user_id,
    'escalatedByDisplayName', flag_case.escalated_by_display_name,
    'escalationReason', flag_case.escalation_reason,
    'reviewedAt', flag_case.reviewed_at,
    'reviewedByDiscordUserId', flag_case.reviewed_by_discord_user_id,
    'reviewedByDisplayName', flag_case.reviewed_by_display_name,
    'reviewReason', flag_case.review_reason,
    'rowVersion', flag_case.row_version,
    'events', case when p_include_events then (
      select coalesce(
        jsonb_agg(
          jsonb_build_object(
            'eventId', event_row.event_id,
            'eventType', event_row.event_type,
            'previousStatus', event_row.previous_status,
            'newStatus', event_row.new_status,
            'actorAccountId', actor_snapshot.actor_account_id,
            'actorDiscordUserId', actor_snapshot.actor_discord_user_id,
            'actorUsername', actor_snapshot.actor_username,
            'actorDisplayName', event_row.actor_display_name,
            'occurredAt', event_row.occurred_at,
            'recordedAt', event_row.recorded_at,
            'reason', event_row.reason,
            'comment', event_row.comment,
            'caseVersion', event_row.case_version
          )
          order by event_row.recorded_at, event_row.event_id
        ),
        '[]'::jsonb
      )
      from public.user_flag_events as event_row
      left join public.user_flag_actor_snapshots as actor_snapshot
        on actor_snapshot.event_id = event_row.event_id
      where event_row.case_id = flag_case.case_id
    ) else '[]'::jsonb end
  )
  from public.user_flag_cases as flag_case
  join public.user_logs as target
    on target.discord_user_id = flag_case.discord_user_id
  where flag_case.case_id = p_case_id;
$function$;

drop function public.list_user_flag_cases(text);

create function public.list_user_flag_cases(
  p_actor_discord_user_id text,
  p_section text,
  p_query text,
  p_limit integer,
  p_offset integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_section text := btrim(p_section);
  v_query text := nullif(lower(btrim(p_query)), '');
  v_limit integer := p_limit;
  v_offset integer := p_offset;
  v_items jsonb;
  v_total bigint;
begin
  if v_section not in ('active', 'history')
    or v_limit is null or v_limit not between 1 and 100
    or v_offset is null or v_offset < 0
    or (v_query is not null and char_length(v_query) > 100) then
    raise exception using errcode = '22023', message = 'INVALID_USER_FLAG_LIST_REQUEST';
  end if;

  perform public.authorize_user_flag_capability(
    p_actor_discord_user_id,
    'users.flag.view'
  );

  with filtered as (
    select flag_case.case_id, flag_case.recorded_at
    from public.user_flag_cases as flag_case
    join public.user_logs as target
      on target.discord_user_id = flag_case.discord_user_id
    where (
      (v_section = 'active' and flag_case.status in ('open', 'escalated'))
      or (v_section = 'history' and flag_case.status in ('resolved', 'dismissed'))
    )
    and (
      v_section = 'active'
      or v_query is null
      or lower(flag_case.discord_user_id) like '%' || v_query || '%'
      or lower(coalesce(target.current_discord_username, '')) like '%' || v_query || '%'
      or lower(coalesce(target.current_display_name, '')) like '%' || v_query || '%'
      or lower(coalesce(target.current_guild_nickname, '')) like '%' || v_query || '%'
      or exists (
        select 1
        from unnest(coalesce(target.known_discord_usernames, array[]::text[])) as known_name
        where lower(known_name) like '%' || v_query || '%'
      )
    )
  ), page as (
    select case_id, recorded_at
    from filtered
    order by recorded_at desc, case_id
    limit v_limit offset v_offset
  )
  select
    (select count(*) from filtered),
    coalesce(
      (
        select jsonb_agg(
          public.build_user_flag_case_payload(page.case_id, true)
          order by page.recorded_at desc, page.case_id
        )
        from page
      ),
      '[]'::jsonb
    )
  into v_total, v_items;

  return jsonb_build_object(
    'items', v_items,
    'total', v_total,
    'limit', v_limit,
    'offset', v_offset
  );
end;
$function$;

create or replace function public.list_user_flag_review_worklist(
  p_actor_discord_user_id text,
  p_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_limit integer := p_limit;
  v_items jsonb;
begin
  if v_limit is null or v_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'INVALID_USER_FLAG_WORKLIST_REQUEST';
  end if;

  perform public.authorize_user_flag_capability(
    p_actor_discord_user_id,
    'users.flag.review'
  );

  select coalesce(
    jsonb_agg(
      public.build_user_flag_case_payload(flag_case.case_id, false)
      order by flag_case.recorded_at, flag_case.case_id
    ),
    '[]'::jsonb
  )
  into v_items
  from (
    select case_id, recorded_at
    from public.user_flag_cases
    where status = 'open'
    order by recorded_at, case_id
    limit v_limit
  ) as flag_case;

  return v_items;
end;
$function$;

create or replace function public.get_user_flag_case(
  p_actor_discord_user_id text,
  p_case_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor_id text := btrim(p_actor_discord_user_id);
  v_actor_role text;
  v_can_view boolean := false;
  v_can_review boolean := false;
  v_case_status text;
  v_result jsonb;
begin
  if p_case_id is null or nullif(v_actor_id, '') is null then
    raise exception using errcode = '22023', message = 'INVALID_USER_FLAG_CASE_REQUEST';
  end if;

  select member_row.role
  into v_actor_role
  from public.team_members as member_row
  join public.team_roles as role_row
    on role_row.key = member_row.role and role_row.is_active
  where member_row.discord_user_id = v_actor_id;

  if not found then
    raise exception using errcode = '42501', message = 'USER_FLAG_FORBIDDEN';
  end if;

  v_can_view := v_actor_role = 'admin' or exists (
    select 1 from public.team_role_capabilities
    where role_key = v_actor_role and capability_key = 'users.flag.view'
  );
  v_can_review := v_actor_role = 'admin' or exists (
    select 1 from public.team_role_capabilities
    where role_key = v_actor_role and capability_key = 'users.flag.review'
  );

  if v_can_view then
    perform public.authorize_user_flag_capability(v_actor_id, 'users.flag.view');
  elsif v_can_review then
    perform public.authorize_user_flag_capability(v_actor_id, 'users.flag.review');
  else
    raise exception using errcode = '42501', message = 'USER_FLAG_FORBIDDEN';
  end if;

  select status into v_case_status
  from public.user_flag_cases
  where case_id = p_case_id;

  if not found or (not v_can_view and v_case_status <> 'open') then
    raise exception using errcode = 'P0002', message = 'USER_FLAG_CASE_NOT_FOUND';
  end if;

  v_result := public.build_user_flag_case_payload(p_case_id, v_can_view);
  if v_result is null then
    raise exception using errcode = 'P0002', message = 'USER_FLAG_CASE_NOT_FOUND';
  end if;
  return v_result;
end;
$function$;

create or replace function public.review_user_flag_case(
  p_actor_discord_user_id text,
  p_case_id uuid,
  p_expected_row_version bigint,
  p_status text,
  p_review_reason text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor_id text := btrim(p_actor_discord_user_id);
  v_action text := btrim(p_status);
  v_reason text := btrim(p_review_reason);
  v_actor_role text;
  v_actor_username text;
  v_request_payload jsonb;
  v_request_hash text;
  v_existing_hash text;
  v_existing_result jsonb;
  v_case public.user_flag_cases%rowtype;
  v_new_status text;
  v_event_type text;
  v_event_id uuid;
  v_now timestamptz := now();
  v_result jsonb;
begin
  if p_idempotency_key is null
    or p_case_id is null
    or p_expected_row_version is null
    or p_expected_row_version < 1
    or v_action not in ('resolved', 'dismissed', 'escalated', 'banned_resolved')
    or v_reason is null
    or char_length(v_reason) not between 3 and 1000 then
    raise exception using errcode = '22023', message = 'INVALID_USER_FLAG_REVIEW_REQUEST';
  end if;

  v_actor_role := public.authorize_user_flag_capability(
    v_actor_id,
    'users.flag.review'
  );

  v_request_payload := jsonb_build_object(
    'operation', 'review',
    'operationVersion', 2,
    'actorDiscordUserId', v_actor_id,
    'caseId', p_case_id,
    'expectedRowVersion', p_expected_row_version,
    'action', v_action,
    'reviewReason', v_reason
  );
  v_request_hash := encode(
    extensions.digest(convert_to(v_request_payload::text, 'UTF8'), 'sha256'),
    'hex'
  );

  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));

  select request_hash, result
  into v_existing_hash, v_existing_result
  from public.user_flag_requests
  where idempotency_key = p_idempotency_key;
  if found then
    if v_existing_hash = v_request_hash then
      return jsonb_set(v_existing_result, '{replayed}', 'true'::jsonb);
    end if;
    raise exception using errcode = 'PT409', message = 'USER_FLAG_IDEMPOTENCY_CONFLICT';
  end if;

  select * into v_case
  from public.user_flag_cases
  where case_id = p_case_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'USER_FLAG_CASE_NOT_FOUND';
  end if;
  if v_case.row_version <> p_expected_row_version then
    raise exception using errcode = 'PT409', message = 'USER_FLAG_STALE_VERSION';
  end if;

  if v_case.status = 'open' then
    if v_action = 'banned_resolved' then
      raise exception using errcode = 'PT409', message = 'USER_FLAG_ESCALATION_REQUIRED';
    end if;
    v_new_status := v_action;
  elsif v_case.status = 'escalated' then
    if v_actor_role <> 'admin' then
      raise exception using errcode = 'PT409', message = 'USER_FLAG_ESCALATED_ADMIN_ONLY';
    end if;
    if v_action not in ('resolved', 'dismissed', 'banned_resolved') then
      raise exception using errcode = 'PT409', message = 'USER_FLAG_INVALID_TRANSITION';
    end if;
    v_new_status := case when v_action = 'banned_resolved' then 'resolved' else v_action end;
  else
    raise exception using errcode = 'PT409', message = 'USER_FLAG_CASE_ALREADY_CLOSED';
  end if;

  select nullif(btrim(current_discord_username), '')
  into v_actor_username
  from public.user_logs
  where discord_user_id = v_actor_id;

  if v_action = 'banned_resolved' then
    perform public.apply_website_ban_contract(
      v_actor_id,
      v_case.discord_user_id,
      v_reason,
      'admin_manual'
    );
  end if;

  if v_new_status = 'escalated' then
    update public.user_flag_cases
    set status = 'escalated',
        escalated_at = v_now,
        escalated_by_discord_user_id = v_actor_id,
        escalated_by_display_name = v_actor_username,
        escalation_reason = v_reason,
        row_version = row_version + 1
    where case_id = p_case_id;
    v_event_type := 'case_escalated';
  else
    update public.user_flag_cases
    set status = v_new_status,
        reviewed_at = v_now,
        reviewed_by_discord_user_id = v_actor_id,
        reviewed_by_display_name = v_actor_username,
        review_reason = v_reason,
        row_version = row_version + 1
    where case_id = p_case_id;
    v_event_type := case
      when v_action = 'banned_resolved' then 'case_banned_and_resolved'
      when v_new_status = 'resolved' then 'case_resolved'
      else 'case_dismissed'
    end;
  end if;

  insert into public.user_flag_events (
    case_id,
    event_type,
    previous_status,
    new_status,
    actor_kind,
    actor_discord_user_id,
    actor_display_name,
    occurred_at,
    reason,
    case_version
  )
  values (
    p_case_id,
    v_event_type,
    v_case.status,
    v_new_status,
    'user',
    v_actor_id,
    v_actor_username,
    v_now,
    v_reason,
    v_case.row_version + 1
  )
  returning event_id into v_event_id;

  perform public.capture_user_flag_actor_snapshot(
    v_event_id,
    v_actor_id,
    v_actor_username,
    v_now
  );

  v_result := jsonb_build_object(
    'caseId', p_case_id,
    'status', v_new_status,
    'rowVersion', v_case.row_version + 1,
    'replayed', false,
    'websiteBanApplied', v_action = 'banned_resolved'
  );

  insert into public.user_flag_requests (
    idempotency_key,
    operation,
    actor_discord_user_id,
    request_hash,
    request_payload,
    result
  )
  values (
    p_idempotency_key,
    'review',
    v_actor_id,
    v_request_hash,
    v_request_payload,
    v_result
  );

  return v_result;
end;
$function$;

create or replace function public.is_user_participation_held(
  p_discord_user_id text
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select exists (
    select 1
    from public.user_flag_cases
    where discord_user_id = btrim(p_discord_user_id)
      and status = 'escalated'
  );
$function$;

create or replace function public.get_user_participation_hold(
  p_discord_user_id text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_discord_user_id text := btrim(p_discord_user_id);
begin
  if nullif(v_discord_user_id, '') is null
    or char_length(v_discord_user_id) > 100 then
    raise exception using errcode = '22023', message = 'INVALID_PARTICIPATION_REQUEST';
  end if;

  return jsonb_build_object(
    'held', public.is_user_participation_held(v_discord_user_id)
  );
end;
$function$;

create or replace function public.enforce_user_flag_participation_hold()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_should_check boolean := true;
begin
  if tg_table_name = 'submission_upload_operations' then
    v_should_check :=
      (tg_op = 'INSERT' and new.status = 'reserved')
      or (
        tg_op = 'UPDATE'
        and new.status in ('r2_uploaded', 'completed')
        and new.status is distinct from old.status
      );
  end if;

  if v_should_check
    and public.is_user_participation_held(new.discord_user_id) then
    raise exception using
      errcode = '42501',
      message = 'PARTICIPATION_UNAVAILABLE';
  end if;

  return new;
end;
$function$;

create trigger user_flag_hold_submission_upload_operations
before insert or update on public.submission_upload_operations
for each row execute function public.enforce_user_flag_participation_hold();

create trigger user_flag_hold_submission_create
before insert on public.submissions
for each row execute function public.enforce_user_flag_participation_hold();

create trigger user_flag_hold_vote_create_or_change
before insert or update on public.votes
for each row execute function public.enforce_user_flag_participation_hold();

update public.capability_catalog
set description =
      'Create a new auditable user flag case for a known user only when no open or escalated case exists.',
    included_actions = array[
      'Create a new auditable user flag case for a known user when no active case exists.',
      'Read only whether the selected user has an active case and its status.'
    ]::text[],
    excluded_actions = array[
      'Viewing flagged-user lists or history.',
      'Reviewing or closing flag cases.',
      'Website bans or other sanctions.'
    ]::text[],
    implementation_version = 2,
    definition_hash =
      '284ad15bb26a61110b34d96f51b199ed0223d66bbe81462e7e89fd534972231b'
where key = 'users.flag.create';

update public.capability_catalog
set description =
      'View active user flag cases and bounded searchable closed-case history without changing case state.',
    included_actions = array[
      'View open and escalated user flag cases and their details.',
      'Search bounded closed-case history by Discord ID or username.',
      'View immutable actor snapshots and complete case event history.'
    ]::text[],
    excluded_actions = array[
      'Creating flag cases.',
      'Reviewing or closing flag cases.',
      'Website bans or other sanctions.'
    ]::text[],
    implementation_version = 2,
    definition_hash =
      '20f04bf3dc07ce7b0f77a31633f6a90b4ce003ad8e03618d078228236dd4699e'
where key = 'users.flag.view';

update public.capability_catalog
set description =
      'Work open user flag cases and resolve, dismiss, or escalate them without access to escalated cases or history.',
    included_actions = array[
      'Load a narrow worklist containing only open user flag cases.',
      'Resolve, dismiss, or escalate an open user flag case.'
    ]::text[],
    excluded_actions = array[
      'General flagged-user lists or free history searches.',
      'Creating flag cases.',
      'Viewing or changing escalated cases.',
      'Website bans or other sanctions.'
    ]::text[],
    implementation_version = 2,
    definition_hash =
      '8ec44455bd08212cab4cacc64dfcd96b139edd9753862255d68150e702b26869'
where key = 'users.flag.review';

alter function public.capture_user_flag_actor_snapshot(uuid, text, text, timestamptz)
  owner to postgres;
alter function public.authorize_user_flag_capability(text, text) owner to postgres;
alter function public.apply_website_ban_contract(text, text, text, text) owner to postgres;
alter function public.ban_website_user(text, text, text, text) owner to postgres;
alter function public.get_user_flag_active_status(text, text) owner to postgres;
alter function public.create_user_flag_case(text, text, text, text, text, bigint, uuid)
  owner to postgres;
alter function public.build_user_flag_case_payload(uuid, boolean) owner to postgres;
alter function public.list_user_flag_cases(text, text, text, integer, integer)
  owner to postgres;
alter function public.list_user_flag_review_worklist(text, integer) owner to postgres;
alter function public.get_user_flag_case(text, uuid) owner to postgres;
alter function public.review_user_flag_case(text, uuid, bigint, text, text, uuid)
  owner to postgres;
alter function public.is_user_participation_held(text) owner to postgres;
alter function public.get_user_participation_hold(text) owner to postgres;
alter function public.enforce_user_flag_participation_hold() owner to postgres;

revoke all on function public.capture_user_flag_actor_snapshot(uuid, text, text, timestamptz)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.authorize_user_flag_capability(text, text)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.apply_website_ban_contract(text, text, text, text)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.build_user_flag_case_payload(uuid, boolean)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.is_user_participation_held(text)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.enforce_user_flag_participation_hold()
  from public, anon, authenticated, discord_bot, service_role;

revoke all on function public.ban_website_user(text, text, text, text)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_user_flag_active_status(text, text)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.create_user_flag_case(text, text, text, text, text, bigint, uuid)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.list_user_flag_cases(text, text, text, integer, integer)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.list_user_flag_review_worklist(text, integer)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_user_flag_case(text, uuid)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.review_user_flag_case(text, uuid, bigint, text, text, uuid)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_user_participation_hold(text)
  from public, anon, authenticated, discord_bot, service_role;

grant execute on function public.ban_website_user(text, text, text, text)
  to service_role;
grant execute on function public.get_user_flag_active_status(text, text)
  to service_role;
grant execute on function public.create_user_flag_case(text, text, text, text, text, bigint, uuid)
  to service_role;
grant execute on function public.list_user_flag_cases(text, text, text, integer, integer)
  to service_role;
grant execute on function public.list_user_flag_review_worklist(text, integer)
  to service_role;
grant execute on function public.get_user_flag_case(text, uuid)
  to service_role;
grant execute on function public.review_user_flag_case(text, uuid, bigint, text, text, uuid)
  to service_role;
grant execute on function public.get_user_participation_hold(text)
  to service_role;

do $postflight$
declare
  v_guard user_flag_5c2_guard%rowtype;
begin
  select * into v_guard from user_flag_5c2_guard;

  if (select count(*) from public.user_flag_cases) <> v_guard.case_count
    or (select count(*) from public.user_flag_events) <> v_guard.event_count
    or (select count(*) from public.user_flag_requests) <> v_guard.request_count then
    raise exception using errcode = '55000', message = 'USER_FLAG_5C2_HISTORY_COUNT_CHANGED';
  end if;

  if (
    select md5(coalesce(string_agg(md5(to_jsonb(event_row)::text), '' order by event_id), ''))
    from public.user_flag_events as event_row
  ) <> v_guard.event_hash then
    raise exception using errcode = '55000', message = 'USER_FLAG_5C2_EVENT_HISTORY_CHANGED';
  end if;

  if (select count(*) from public.user_flag_actor_snapshots) <> v_guard.event_count then
    raise exception using errcode = '55000', message = 'USER_FLAG_5C2_SNAPSHOT_BACKFILL_MISMATCH';
  end if;

  if exists (
    select 1
    from public.user_flag_cases
    where status in ('open', 'escalated')
    group by discord_user_id
    having count(*) > 1
  ) then
    raise exception using errcode = '55000', message = 'USER_FLAG_5C2_ACTIVE_CASE_INVARIANT_FAILED';
  end if;

  if (
    select count(*)
    from public.capability_catalog
    where key in ('users.flag.create', 'users.flag.view', 'users.flag.review')
      and is_active
      and assignable_to_non_admin
      and implementation_version = 2
      and definition_hash in (
        '284ad15bb26a61110b34d96f51b199ed0223d66bbe81462e7e89fd534972231b',
        '20f04bf3dc07ce7b0f77a31633f6a90b4ce003ad8e03618d078228236dd4699e',
        '8ec44455bd08212cab4cacc64dfcd96b139edd9753862255d68150e702b26869'
      )
  ) <> 3 then
    raise exception using errcode = '55000', message = 'USER_FLAG_5C2_CAPABILITY_MISMATCH';
  end if;
end
$postflight$;

commit;
