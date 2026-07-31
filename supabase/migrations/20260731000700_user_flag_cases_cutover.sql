begin;

set local lock_timeout = '5s';
set local statement_timeout = '45s';

do $preflight$
begin
  if to_regclass('public.user_logs') is null
    or to_regclass('public.team_members') is null
    or to_regclass('public.team_roles') is null
    or to_regclass('public.capability_catalog') is null
    or to_regclass('public.team_role_capabilities') is null then
    raise exception using
      errcode = '55000',
      message = 'USER_FLAG_CUTOVER_DEPENDENCY_UNAVAILABLE';
  end if;

  if not exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.user_logs'::regclass
      and tgname = 'trg_user_logs_updated_at'
      and tgenabled = 'O'
      and not tgisinternal
  ) then
    raise exception using
      errcode = '55000',
      message = 'USER_FLAG_CUTOVER_UPDATED_AT_TRIGGER_MISMATCH';
  end if;

  if to_regclass('public.user_flag_cases') is not null
    or to_regclass('public.user_flag_events') is not null
    or to_regclass('public.user_flag_requests') is not null then
    raise exception using
      errcode = '55000',
      message = 'USER_FLAG_CUTOVER_ALREADY_PRESENT';
  end if;

  if (select count(*) from public.capability_catalog) <> 7
    or (select count(*) from public.capability_catalog where is_active) <> 6
    or (
      select count(*)
      from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 6 then
    raise exception using
      errcode = '55000',
      message = 'USER_FLAG_CUTOVER_CATALOG_BASELINE_MISMATCH';
  end if;

  if not exists (
    select 1
    from public.capability_catalog
    where key = 'users.flag'
      and is_active
      and assignable_to_non_admin
      and implementation_version = 1
      and definition_hash =
        '802eb6c05cdeb7721a068262675b740f3208609eb0355632da09f607f5ec676b'
  ) then
    raise exception using
      errcode = '55000',
      message = 'USER_FLAG_CUTOVER_LEGACY_CAPABILITY_MISMATCH';
  end if;

  if exists (select 1 from public.team_role_capabilities) then
    raise exception using
      errcode = '55000',
      message = 'USER_FLAG_CUTOVER_REQUIRES_ZERO_GRANTS';
  end if;

  if exists (
    select 1
    from public.user_logs
    where flagged_for_review
      and flag_reason_code is not null
      and flag_reason_code not in (
        'trolling_low_effort',
        'suspicious_behavior',
        'other'
      )
  ) then
    raise exception using
      errcode = '55000',
      message = 'USER_FLAG_CUTOVER_UNKNOWN_LEGACY_CATEGORY';
  end if;
end
$preflight$;

create temporary table user_flag_user_logs_guard
on commit drop
as
select
  discord_user_id,
  md5(
    (
      to_jsonb(user_row)
      - array[
          'flagged_for_review',
          'flagged_at',
          'flagged_by_discord_user_id',
          'flagged_by_discord_username',
          'flag_reason_code',
          'flag_note',
          'unflag_reason',
          'unflagged_at',
          'unflagged_by_discord_user_id',
          'unflagged_by_discord_username'
        ]
    )::text
  ) as non_flag_hash
from public.user_logs as user_row;

create table public.user_flag_cases (
  case_id uuid primary key default gen_random_uuid(),
  discord_user_id text not null
    references public.user_logs(discord_user_id)
    on update restrict on delete restrict,
  status text not null default 'open',
  category text,
  reason text,
  comment text,
  submission_id bigint
    references public.submissions(id)
    on update restrict on delete restrict,
  created_at timestamptz,
  recorded_at timestamptz not null default now(),
  created_by_actor_kind text not null,
  created_by_discord_user_id text,
  created_by_display_name text,
  reviewed_at timestamptz,
  reviewed_by_discord_user_id text,
  reviewed_by_display_name text,
  review_reason text,
  row_version bigint not null default 1,
  legacy_source text,
  legacy_source_identifier text,
  constraint user_flag_cases_status_check
    check (status in ('open', 'resolved', 'dismissed')),
  constraint user_flag_cases_category_check
    check (
      category is null
      or category in (
        'trolling_low_effort',
        'suspicious_behavior',
        'other'
      )
    ),
  constraint user_flag_cases_reason_check
    check (
      reason is null
      or char_length(btrim(reason)) between 3 and 1000
    ),
  constraint user_flag_cases_comment_check
    check (comment is null or char_length(comment) <= 2000),
  constraint user_flag_cases_actor_kind_check
    check (created_by_actor_kind in ('user', 'legacy_system')),
  constraint user_flag_cases_actor_check
    check (
      (
        created_by_actor_kind = 'user'
        and nullif(btrim(created_by_discord_user_id), '') is not null
      )
      or (
        created_by_actor_kind = 'legacy_system'
        and created_by_discord_user_id is null
      )
    ),
  constraint user_flag_cases_new_case_metadata_check
    check (
      legacy_source is not null
      or (
        created_at is not null
        and category is not null
        and reason is not null
        and created_by_actor_kind = 'user'
      )
    ),
  constraint user_flag_cases_review_state_check
    check (
      (
        status = 'open'
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
      )
    ),
  constraint user_flag_cases_review_reason_check
    check (
      review_reason is null
      or char_length(btrim(review_reason)) between 3 and 1000
    ),
  constraint user_flag_cases_row_version_check
    check (row_version >= 1),
  constraint user_flag_cases_legacy_provenance_check
    check (
      (legacy_source is null and legacy_source_identifier is null)
      or (
        legacy_source = 'user_logs'
        and nullif(btrim(legacy_source_identifier), '') is not null
      )
    ),
  constraint user_flag_cases_legacy_source_identifier_key
    unique (legacy_source_identifier)
);

create unique index user_flag_cases_one_open_per_user_idx
  on public.user_flag_cases(discord_user_id)
  where status = 'open';

create index user_flag_cases_user_history_idx
  on public.user_flag_cases(discord_user_id, recorded_at desc);

create index user_flag_cases_status_recorded_idx
  on public.user_flag_cases(status, recorded_at desc);

create table public.user_flag_events (
  event_id uuid primary key default gen_random_uuid(),
  case_id uuid not null
    references public.user_flag_cases(case_id)
    on update restrict on delete restrict,
  event_type text not null,
  previous_status text,
  new_status text not null,
  actor_kind text not null,
  actor_discord_user_id text,
  actor_display_name text,
  occurred_at timestamptz,
  recorded_at timestamptz not null default now(),
  reason text,
  comment text,
  case_version bigint not null,
  legacy_provenance jsonb,
  constraint user_flag_events_type_check
    check (
      event_type in (
        'case_created',
        'legacy_case_migrated',
        'case_resolved',
        'case_dismissed'
      )
    ),
  constraint user_flag_events_status_check
    check (
      (previous_status is null or previous_status in ('open', 'resolved', 'dismissed'))
      and new_status in ('open', 'resolved', 'dismissed')
    ),
  constraint user_flag_events_transition_check
    check (
      (event_type in ('case_created', 'legacy_case_migrated')
        and previous_status is null and new_status = 'open')
      or (event_type = 'case_resolved'
        and previous_status = 'open' and new_status = 'resolved')
      or (event_type = 'case_dismissed'
        and previous_status = 'open' and new_status = 'dismissed')
    ),
  constraint user_flag_events_actor_kind_check
    check (actor_kind in ('user', 'legacy_system')),
  constraint user_flag_events_actor_check
    check (
      (actor_kind = 'user'
        and nullif(btrim(actor_discord_user_id), '') is not null)
      or (actor_kind = 'legacy_system' and actor_discord_user_id is null)
    ),
  constraint user_flag_events_reason_check
    check (reason is null or char_length(btrim(reason)) between 3 and 1000),
  constraint user_flag_events_comment_check
    check (comment is null or char_length(comment) <= 2000),
  constraint user_flag_events_version_check
    check (case_version >= 1),
  constraint user_flag_events_legacy_check
    check (
      (event_type = 'legacy_case_migrated' and legacy_provenance is not null)
      or (event_type <> 'legacy_case_migrated' and legacy_provenance is null)
    )
);

create index user_flag_events_case_history_idx
  on public.user_flag_events(case_id, recorded_at, event_id);

create table public.user_flag_requests (
  request_id uuid primary key default gen_random_uuid(),
  idempotency_key uuid not null unique,
  operation text not null,
  actor_discord_user_id text not null,
  request_hash text not null,
  request_payload jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  constraint user_flag_requests_operation_check
    check (operation in ('create', 'review')),
  constraint user_flag_requests_actor_check
    check (nullif(btrim(actor_discord_user_id), '') is not null),
  constraint user_flag_requests_hash_check
    check (request_hash ~ '^[0-9a-f]{64}$'),
  constraint user_flag_requests_payload_check
    check (jsonb_typeof(request_payload) = 'object'),
  constraint user_flag_requests_result_check
    check (jsonb_typeof(result) = 'object')
);

create index user_flag_requests_case_idx
  on public.user_flag_requests((result ->> 'caseId'));

alter table public.user_flag_cases owner to postgres;
alter table public.user_flag_events owner to postgres;
alter table public.user_flag_requests owner to postgres;

create function public.protect_user_flag_cases()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $function$
begin
  raise exception using
    errcode = '55000',
    message = 'USER_FLAG_CASE_DELETE_FORBIDDEN';
end;
$function$;

create function public.protect_user_flag_append_only()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $function$
begin
  raise exception using
    errcode = '55000',
    message = 'USER_FLAG_APPEND_ONLY_VIOLATION';
end;
$function$;

alter function public.protect_user_flag_cases() owner to postgres;
alter function public.protect_user_flag_append_only() owner to postgres;

create trigger protect_user_flag_cases_delete
before delete on public.user_flag_cases
for each row execute function public.protect_user_flag_cases();

create trigger protect_user_flag_events
before update or delete on public.user_flag_events
for each row execute function public.protect_user_flag_append_only();

create trigger protect_user_flag_requests
before update or delete on public.user_flag_requests
for each row execute function public.protect_user_flag_append_only();

alter table public.user_flag_cases enable row level security;
alter table public.user_flag_events enable row level security;
alter table public.user_flag_requests enable row level security;

revoke all on table public.user_flag_cases
  from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.user_flag_events
  from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.user_flag_requests
  from public, anon, authenticated, discord_bot, service_role;
grant select on table public.user_flag_cases to service_role;
grant select on table public.user_flag_events to service_role;
grant select on table public.user_flag_requests to service_role;

revoke all on function public.protect_user_flag_cases()
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.protect_user_flag_append_only()
  from public, anon, authenticated, discord_bot, service_role;

insert into public.capability_catalog (
  key,
  display_name,
  description,
  category,
  included_actions,
  excluded_actions,
  risk_level,
  assignable_to_non_admin,
  is_active,
  implementation_version,
  definition_hash
)
values
  (
    'users.flag.create',
    'Create User Flag Cases',
    'Create a new auditable user flag case for a known user when no other open case exists.',
    'User Moderation',
    array['Create a new auditable user flag case for a known user.']::text[],
    array[
      'Viewing flagged-user lists or history.',
      'Reviewing or closing flag cases.',
      'Website bans or other sanctions.'
    ]::text[],
    'moderate',
    false,
    false,
    1,
    'bf758cdf0fa93e88b27a40582916efbea56d5d25d708d02f9889ed3a3cbe5dbf'
  ),
  (
    'users.flag.view',
    'View User Flag Cases',
    'View flagged-user lists, case details, and complete user flag history without changing case state.',
    'User Moderation',
    array['View flagged-user lists, case details, and complete user flag history.']::text[],
    array[
      'Creating flag cases.',
      'Reviewing or closing flag cases.',
      'Website bans or other sanctions.'
    ]::text[],
    'moderate',
    false,
    false,
    1,
    '8cbde5054432fc6630bbec66c68ce98393f6c37744eb8452b28ea67dfdbc431c'
  ),
  (
    'users.flag.review',
    'Review User Flag Cases',
    'Load a specifically addressed user flag case and resolve or dismiss it without general list access.',
    'User Moderation',
    array[
      'Load and review a specifically addressed user flag case.',
      'Resolve or dismiss an open user flag case.'
    ]::text[],
    array[
      'General flagged-user lists or free history searches.',
      'Creating flag cases.',
      'Website bans or other sanctions.'
    ]::text[],
    'high',
    false,
    false,
    1,
    'd43a7db86453e3432b04b65bad4cb7b01555c77f18cd4c26bd58a626d5508dbe'
  );

do $legacy_migration$
declare
  v_source_count integer;
  v_case_count integer;
  v_event_count integer;
begin
  select count(*)
  into v_source_count
  from public.user_logs
  where flagged_for_review;

  insert into public.user_flag_cases (
    discord_user_id,
    status,
    category,
    reason,
    comment,
    created_at,
    created_by_actor_kind,
    created_by_discord_user_id,
    created_by_display_name,
    legacy_source,
    legacy_source_identifier
  )
  select
    legacy.discord_user_id,
    'open',
    legacy.flag_reason_code,
    null,
    nullif(btrim(legacy.flag_note), ''),
    legacy.flagged_at,
    case
      when nullif(btrim(legacy.flagged_by_discord_user_id), '') is null
        then 'legacy_system'
      else 'user'
    end,
    nullif(btrim(legacy.flagged_by_discord_user_id), ''),
    nullif(btrim(legacy.flagged_by_discord_username), ''),
    'user_logs',
    legacy.discord_user_id
  from public.user_logs as legacy
  where legacy.flagged_for_review;

  select count(*)
  into v_case_count
  from public.user_flag_cases
  where legacy_source = 'user_logs';

  if v_case_count <> v_source_count then
    raise exception using
      errcode = '55000',
      message = 'USER_FLAG_LEGACY_CASE_COUNT_MISMATCH';
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
    comment,
    case_version,
    legacy_provenance
  )
  select
    flag_case.case_id,
    'legacy_case_migrated',
    null,
    'open',
    flag_case.created_by_actor_kind,
    flag_case.created_by_discord_user_id,
    flag_case.created_by_display_name,
    flag_case.created_at,
    flag_case.reason,
    flag_case.comment,
    flag_case.row_version,
    jsonb_build_object(
      'source', 'user_logs',
      'actorKnown', flag_case.created_by_discord_user_id is not null,
      'categoryPresent', flag_case.category is not null,
      'reasonPresent', flag_case.reason is not null,
      'timestampPresent', flag_case.created_at is not null
    )
  from public.user_flag_cases as flag_case
  where flag_case.legacy_source = 'user_logs';

  select count(*)
  into v_event_count
  from public.user_flag_events
  where event_type = 'legacy_case_migrated';

  if v_event_count <> v_source_count then
    raise exception using
      errcode = '55000',
      message = 'USER_FLAG_LEGACY_EVENT_COUNT_MISMATCH';
  end if;

  alter table public.user_logs
    disable trigger trg_user_logs_updated_at;

  update public.user_logs
  set flagged_for_review = false,
      flagged_at = null,
      flagged_by_discord_user_id = null,
      flagged_by_discord_username = null,
      flag_reason_code = null,
      flag_note = null,
      unflag_reason = null,
      unflagged_at = null,
      unflagged_by_discord_user_id = null,
      unflagged_by_discord_username = null
  where flagged_for_review
     or flagged_at is not null
     or flagged_by_discord_user_id is not null
     or flagged_by_discord_username is not null
     or flag_reason_code is not null
     or flag_note is not null
     or unflag_reason is not null
     or unflagged_at is not null
     or unflagged_by_discord_user_id is not null
     or unflagged_by_discord_username is not null;

  alter table public.user_logs
    enable trigger trg_user_logs_updated_at;

  if exists (
    select 1
    from public.user_logs
    where flagged_for_review
       or flagged_at is not null
       or flagged_by_discord_user_id is not null
       or flagged_by_discord_username is not null
       or flag_reason_code is not null
       or flag_note is not null
       or unflag_reason is not null
       or unflagged_at is not null
       or unflagged_by_discord_user_id is not null
       or unflagged_by_discord_username is not null
  ) then
    raise exception using
      errcode = '55000',
      message = 'USER_FLAG_LEGACY_SOURCE_NOT_NEUTRALIZED';
  end if;

  if exists (
    select 1
    from user_flag_user_logs_guard as guard_row
    full join public.user_logs as current_row
      on current_row.discord_user_id = guard_row.discord_user_id
    where guard_row.discord_user_id is null
       or current_row.discord_user_id is null
       or guard_row.non_flag_hash <> md5(
         (
           to_jsonb(current_row)
           - array[
               'flagged_for_review',
               'flagged_at',
               'flagged_by_discord_user_id',
               'flagged_by_discord_username',
               'flag_reason_code',
               'flag_note',
               'unflag_reason',
               'unflagged_at',
               'unflagged_by_discord_user_id',
               'unflagged_by_discord_username'
             ]
         )::text
       )
  ) then
    raise exception using
      errcode = '55000',
      message = 'USER_FLAG_NON_FLAG_DATA_CHANGED';
  end if;
end
$legacy_migration$;

create function public.authorize_user_flag_capability(
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
      'bf758cdf0fa93e88b27a40582916efbea56d5d25d708d02f9889ed3a3cbe5dbf'
    when 'users.flag.view' then
      '8cbde5054432fc6630bbec66c68ce98393f6c37744eb8452b28ea67dfdbc431c'
    when 'users.flag.review' then
      'd43a7db86453e3432b04b65bad4cb7b01555c77f18cd4c26bd58a626d5508dbe'
    else null
  end;

  if nullif(v_actor_id, '') is null
    or v_expected_hash is null then
    raise exception using
      errcode = '42501',
      message = 'USER_FLAG_FORBIDDEN';
  end if;

  if not exists (
    select 1
    from public.capability_catalog
    where key = p_capability_key
      and is_active
      and assignable_to_non_admin
      and implementation_version = 1
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
    on role_row.key = member_row.role
   and role_row.is_active
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
    raise exception using
      errcode = '42501',
      message = 'USER_FLAG_FORBIDDEN';
  end if;

  return v_actor_role;
end;
$function$;

create function public.create_user_flag_case(
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
  v_actor_display text;
  v_request_payload jsonb;
  v_request_hash text;
  v_existing_hash text;
  v_existing_result jsonb;
  v_case_id uuid;
  v_result jsonb;
begin
  if p_idempotency_key is null
    or nullif(v_target_id, '') is null
    or char_length(v_target_id) > 100
    or v_category not in (
      'trolling_low_effort',
      'suspicious_behavior',
      'other'
    )
    or v_reason is null
    or char_length(v_reason) not between 3 and 1000
    or (v_comment is not null and char_length(v_comment) > 2000) then
    raise exception using
      errcode = '22023',
      message = 'INVALID_USER_FLAG_CREATE_REQUEST';
  end if;

  perform public.authorize_user_flag_capability(
    v_actor_id,
    'users.flag.create'
  );

  v_request_payload := jsonb_build_object(
    'operation', 'create',
    'operationVersion', 1,
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

  perform pg_advisory_xact_lock(
    hashtextextended(p_idempotency_key::text, 0)
  );

  select request_hash, result
  into v_existing_hash, v_existing_result
  from public.user_flag_requests
  where idempotency_key = p_idempotency_key;

  if found then
    if v_existing_hash = v_request_hash then
      return jsonb_set(v_existing_result, '{replayed}', 'true'::jsonb);
    end if;
    raise exception using
      errcode = 'PT409',
      message = 'USER_FLAG_IDEMPOTENCY_CONFLICT';
  end if;

  perform 1
  from public.user_logs
  where discord_user_id = v_target_id
  for update;
  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'USER_FLAG_TARGET_NOT_FOUND';
  end if;

  if p_submission_id is not null
    and not exists (
      select 1
      from public.submissions
      where id = p_submission_id
        and discord_user_id = v_target_id
    ) then
    raise exception using
      errcode = '22023',
      message = 'INVALID_USER_FLAG_SUBMISSION_REFERENCE';
  end if;

  if exists (
    select 1
    from public.user_flag_cases
    where discord_user_id = v_target_id
      and status = 'open'
  ) then
    raise exception using
      errcode = 'PT409',
      message = 'USER_FLAG_OPEN_CASE_CONFLICT';
  end if;

  select nullif(btrim(current_discord_username), '')
  into v_actor_display
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
    now(),
    'user',
    v_actor_id,
    v_actor_display
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
    v_actor_display,
    now(),
    v_reason,
    v_comment,
    1
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
    raise exception using
      errcode = 'PT409',
      message = 'USER_FLAG_OPEN_CASE_CONFLICT';
end;
$function$;

create function public.list_user_flag_cases(
  p_actor_discord_user_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor_id text := btrim(p_actor_discord_user_id);
  v_result jsonb;
begin
  perform public.authorize_user_flag_capability(
    v_actor_id,
    'users.flag.view'
  );

  select coalesce(
    jsonb_agg(case_payload order by is_open desc, recorded_at desc),
    '[]'::jsonb
  )
  into v_result
  from (
    select
      flag_case.status = 'open' as is_open,
      flag_case.recorded_at,
      jsonb_build_object(
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
        'reviewedAt', flag_case.reviewed_at,
        'reviewedByDiscordUserId', flag_case.reviewed_by_discord_user_id,
        'reviewedByDisplayName', flag_case.reviewed_by_display_name,
        'reviewReason', flag_case.review_reason,
        'rowVersion', flag_case.row_version,
        'events', (
          select coalesce(
            jsonb_agg(
              jsonb_build_object(
                'eventId', event_row.event_id,
                'eventType', event_row.event_type,
                'previousStatus', event_row.previous_status,
                'newStatus', event_row.new_status,
                'actorDiscordUserId', event_row.actor_discord_user_id,
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
          where event_row.case_id = flag_case.case_id
        )
      ) as case_payload
    from public.user_flag_cases as flag_case
    join public.user_logs as target
      on target.discord_user_id = flag_case.discord_user_id
  ) as cases;

  return v_result;
end;
$function$;

create function public.get_user_flag_case(
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
  v_result jsonb;
begin
  if p_case_id is null or nullif(v_actor_id, '') is null then
    raise exception using
      errcode = '22023',
      message = 'INVALID_USER_FLAG_CASE_REQUEST';
  end if;

  select member_row.role
  into v_actor_role
  from public.team_members as member_row
  join public.team_roles as role_row
    on role_row.key = member_row.role
   and role_row.is_active
  where member_row.discord_user_id = v_actor_id;

  if not found then
    raise exception using
      errcode = '42501',
      message = 'USER_FLAG_FORBIDDEN';
  end if;

  if v_actor_role <> 'admin' then
    if not exists (
      select 1
      from public.team_role_capabilities
      where role_key = v_actor_role
        and capability_key in ('users.flag.view', 'users.flag.review')
    ) then
      raise exception using
        errcode = '42501',
        message = 'USER_FLAG_FORBIDDEN';
    end if;

    if exists (
      select 1
      from public.team_role_capabilities
      where role_key = v_actor_role
        and capability_key = 'users.flag.review'
    ) then
      perform public.authorize_user_flag_capability(
        v_actor_id,
        'users.flag.review'
      );
    else
      perform public.authorize_user_flag_capability(
        v_actor_id,
        'users.flag.view'
      );
    end if;
  else
    perform public.authorize_user_flag_capability(
      v_actor_id,
      'users.flag.view'
    );
  end if;

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
    'reviewedAt', flag_case.reviewed_at,
    'reviewedByDiscordUserId', flag_case.reviewed_by_discord_user_id,
    'reviewedByDisplayName', flag_case.reviewed_by_display_name,
    'reviewReason', flag_case.review_reason,
    'rowVersion', flag_case.row_version,
    'events', (
      select coalesce(
        jsonb_agg(
          jsonb_build_object(
            'eventId', event_row.event_id,
            'eventType', event_row.event_type,
            'previousStatus', event_row.previous_status,
            'newStatus', event_row.new_status,
            'actorDiscordUserId', event_row.actor_discord_user_id,
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
      where event_row.case_id = flag_case.case_id
    )
  )
  into v_result
  from public.user_flag_cases as flag_case
  join public.user_logs as target
    on target.discord_user_id = flag_case.discord_user_id
  where flag_case.case_id = p_case_id;

  if v_result is null then
    raise exception using
      errcode = 'P0002',
      message = 'USER_FLAG_CASE_NOT_FOUND';
  end if;

  return v_result;
end;
$function$;

create function public.review_user_flag_case(
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
  v_status text := btrim(p_status);
  v_review_reason text := btrim(p_review_reason);
  v_actor_display text;
  v_request_payload jsonb;
  v_request_hash text;
  v_existing_hash text;
  v_existing_result jsonb;
  v_case public.user_flag_cases%rowtype;
  v_result jsonb;
begin
  if p_idempotency_key is null
    or p_case_id is null
    or p_expected_row_version is null
    or p_expected_row_version < 1
    or v_status not in ('resolved', 'dismissed')
    or v_review_reason is null
    or char_length(v_review_reason) not between 3 and 1000 then
    raise exception using
      errcode = '22023',
      message = 'INVALID_USER_FLAG_REVIEW_REQUEST';
  end if;

  perform public.authorize_user_flag_capability(
    v_actor_id,
    'users.flag.review'
  );

  v_request_payload := jsonb_build_object(
    'operation', 'review',
    'operationVersion', 1,
    'actorDiscordUserId', v_actor_id,
    'caseId', p_case_id,
    'expectedRowVersion', p_expected_row_version,
    'status', v_status,
    'reviewReason', v_review_reason
  );
  v_request_hash := encode(
    extensions.digest(convert_to(v_request_payload::text, 'UTF8'), 'sha256'),
    'hex'
  );

  perform pg_advisory_xact_lock(
    hashtextextended(p_idempotency_key::text, 0)
  );

  select request_hash, result
  into v_existing_hash, v_existing_result
  from public.user_flag_requests
  where idempotency_key = p_idempotency_key;

  if found then
    if v_existing_hash = v_request_hash then
      return jsonb_set(v_existing_result, '{replayed}', 'true'::jsonb);
    end if;
    raise exception using
      errcode = 'PT409',
      message = 'USER_FLAG_IDEMPOTENCY_CONFLICT';
  end if;

  select *
  into v_case
  from public.user_flag_cases
  where case_id = p_case_id
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'USER_FLAG_CASE_NOT_FOUND';
  end if;

  if v_case.status <> 'open' then
    raise exception using
      errcode = 'PT409',
      message = 'USER_FLAG_CASE_ALREADY_CLOSED';
  end if;

  if v_case.row_version <> p_expected_row_version then
    raise exception using
      errcode = 'PT409',
      message = 'USER_FLAG_STALE_VERSION';
  end if;

  select nullif(btrim(current_discord_username), '')
  into v_actor_display
  from public.user_logs
  where discord_user_id = v_actor_id;

  update public.user_flag_cases
  set status = v_status,
      reviewed_at = now(),
      reviewed_by_discord_user_id = v_actor_id,
      reviewed_by_display_name = v_actor_display,
      review_reason = v_review_reason,
      row_version = row_version + 1
  where case_id = p_case_id;

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
    case when v_status = 'resolved'
      then 'case_resolved'
      else 'case_dismissed'
    end,
    'open',
    v_status,
    'user',
    v_actor_id,
    v_actor_display,
    now(),
    v_review_reason,
    v_case.row_version + 1
  );

  v_result := jsonb_build_object(
    'caseId', p_case_id,
    'status', v_status,
    'rowVersion', v_case.row_version + 1,
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
    'review',
    v_actor_id,
    v_request_hash,
    v_request_payload,
    v_result
  );

  return v_result;
end;
$function$;

alter function public.authorize_user_flag_capability(text, text)
  owner to postgres;
alter function public.create_user_flag_case(
  text, text, text, text, text, bigint, uuid
) owner to postgres;
alter function public.list_user_flag_cases(text) owner to postgres;
alter function public.get_user_flag_case(text, uuid) owner to postgres;
alter function public.review_user_flag_case(
  text, uuid, bigint, text, text, uuid
) owner to postgres;

revoke all on function public.authorize_user_flag_capability(text, text)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.create_user_flag_case(
  text, text, text, text, text, bigint, uuid
) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.list_user_flag_cases(text)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_user_flag_case(text, uuid)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.review_user_flag_case(
  text, uuid, bigint, text, text, uuid
) from public, anon, authenticated, discord_bot, service_role;

grant execute on function public.create_user_flag_case(
  text, text, text, text, text, bigint, uuid
) to service_role;
grant execute on function public.list_user_flag_cases(text)
  to service_role;
grant execute on function public.get_user_flag_case(text, uuid)
  to service_role;
grant execute on function public.review_user_flag_case(
  text, uuid, bigint, text, text, uuid
) to service_role;

update public.capability_catalog
set display_name = 'Flag Users (Legacy)',
    description =
      'Legacy combined user-flag permission retained only as a deprecated tombstone.',
    included_actions = array['No active application actions.']::text[],
    excluded_actions = array[
      'Creating user flag cases.',
      'Viewing flagged-user lists or history.',
      'Reviewing or closing user flag cases.',
      'Website bans or other sanctions.'
    ]::text[],
    risk_level = 'moderate',
    assignable_to_non_admin = false,
    is_active = false,
    implementation_version = 2,
    definition_hash =
      '4ec252dadafc8d9e149df225825f850fd90666e444fff4edaca43bd5d02b553c',
    deprecated_at = coalesce(deprecated_at, now())
where key = 'users.flag';

update public.capability_catalog
set is_active = true,
    assignable_to_non_admin = true
where key in (
  'users.flag.create',
  'users.flag.view',
  'users.flag.review'
);

do $postflight$
begin
  if (select count(*) from public.capability_catalog) <> 10
    or (select count(*) from public.capability_catalog where is_active) <> 8
    or (
      select count(*)
      from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 8 then
    raise exception using
      errcode = '55000',
      message = 'USER_FLAG_CUTOVER_FINAL_CATALOG_MISMATCH';
  end if;

  if exists (select 1 from public.team_role_capabilities) then
    raise exception using
      errcode = '55000',
      message = 'USER_FLAG_CUTOVER_UNEXPECTED_GRANT';
  end if;

  if not exists (
    select 1
    from public.capability_catalog
    where key = 'users.flag'
      and not is_active
      and not assignable_to_non_admin
      and deprecated_at is not null
  ) then
    raise exception using
      errcode = '55000',
      message = 'USER_FLAG_CUTOVER_LEGACY_NOT_TOMBSTONED';
  end if;

  if (
    select count(*)
    from public.capability_catalog
    where key in (
      'users.flag.create',
      'users.flag.view',
      'users.flag.review'
    )
      and is_active
      and assignable_to_non_admin
  ) <> 3 then
    raise exception using
      errcode = '55000',
      message = 'USER_FLAG_CUTOVER_NEW_CAPABILITY_MISMATCH';
  end if;

  if exists (
    select discord_user_id
    from public.user_flag_cases
    where status = 'open'
    group by discord_user_id
    having count(*) > 1
  ) then
    raise exception using
      errcode = '55000',
      message = 'USER_FLAG_CUTOVER_OPEN_CASE_INVARIANT_FAILED';
  end if;
end
$postflight$;

comment on table public.user_flag_cases is
  'Canonical versioned user-flag cases. Cases are never hard-deleted by normal application paths.';
comment on table public.user_flag_events is
  'Append-only history for user-flag case creation, migration and review decisions.';
comment on table public.user_flag_requests is
  'Append-only idempotency ledger for canonical user-flag create and review mutations.';

commit;
