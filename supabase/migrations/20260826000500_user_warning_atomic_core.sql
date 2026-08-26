begin;

set local lock_timeout = '5s';
set local statement_timeout = '90s';

do $preflight$
begin
  if to_regclass('public.user_logs') is null
    or to_regclass('public.team_members') is null
    or to_regclass('public.team_roles') is null
    or to_regclass('public.capability_catalog') is null
    or to_regclass('public.team_role_capabilities') is null
    or to_regclass('public.community_comments') is null
    or to_regclass('public.community_comment_text_versions') is null
    or to_regclass('public.user_flag_cases') is null
    or to_regprocedure('public.is_community_comment_submission_eligible(bigint)') is null
  then
    raise exception using
      errcode = '55000',
      message = 'USER_WARNING_CORE_DEPENDENCY_UNAVAILABLE';
  end if;

  if (select count(*) from public.capability_catalog) <> 49
    or (select count(*) from public.capability_catalog where is_active) <> 45
    or (
      select count(*) from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 45
    or exists (
      select 1 from public.capability_catalog
      where key in ('users.warnings.issue', 'users.warnings.overrule')
    )
  then
    raise exception using
      errcode = '55000',
      message = 'USER_WARNING_CORE_CAPABILITY_BASELINE_MISMATCH';
  end if;

  if exists (
    select 1
    from public.team_role_capabilities
    where capability_key in ('users.warnings.issue', 'users.warnings.overrule')
  ) then
    raise exception using
      errcode = '55000',
      message = 'USER_WARNING_CORE_UNEXPECTED_GRANT';
  end if;

  if to_regclass('public.user_warnings') is not null
    or to_regclass('public.user_warning_current') is not null
    or to_regclass('public.user_warning_events') is not null
    or to_regclass('public.user_warning_requests') is not null
    or to_regclass('public.user_warning_auto_flag_cases') is not null
    or to_regclass('public.user_warning_auto_flag_events') is not null
  then
    raise exception using
      errcode = '55000',
      message = 'USER_WARNING_CORE_ALREADY_PRESENT';
  end if;
end;
$preflight$;

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
    'users.warnings.issue',
    'Issue Comment Warnings',
    'Issue one permanent source-Comment-bound Warning with automatic database-time progression and no automatic sanction.',
    'User Moderation',
    array[
      'Issue at most one Warning for a concrete Comment with immutable object and text evidence.',
      'Choose an allowlisted category and bounded reason while the database assigns the 1, 3, 7, or 14-day tier.',
      'Trigger only the dedicated automatic Warning Flag projection when canonical thresholds are met.'
    ]::text[],
    array[
      'Selecting or overriding the Warning duration.',
      'Overruling Warnings or viewing unrelated Warning history.',
      'Banning, holding participation, removing Comments, or applying any other sanction.',
      'Managing roles, grants, Team membership, or Owner access.'
    ]::text[],
    'critical', true, true, 1,
    '8910867c7eb547473efaf129089bf2e0098d6f471e2057358ddd77f90818811f'
  ),
  (
    'users.warnings.overrule',
    'Overrule Comment Warnings',
    'Correct one Warning through expected-version, idempotent Overrule and deterministic replay of every later effective Warning.',
    'User Moderation',
    array[
      'Overrule one exact Warning with a mandatory bounded correction reason.',
      'Deterministically recompute later non-overruled Warning tiers, recurrence windows, expiries, active count, and automatic Warning Flag state.',
      'Preserve original issue facts and every recalculation as immutable audit evidence.'
    ]::text[],
    array[
      'Issuing Warnings or selecting a Warning duration.',
      'Deleting or rewriting Warning requests, events, source evidence, or original assigned tiers.',
      'Banning, holding participation, removing Comments, or applying any other sanction.',
      'Managing roles, grants, Team membership, or Owner access.'
    ]::text[],
    'critical', true, true, 1,
    'ce5849bc151746eddf520ed960002a6f0c7e4a9c7b0c9eac58721d4c40603ece'
  );

create table public.user_warnings (
  warning_id uuid primary key default gen_random_uuid(),
  public_warning_id uuid not null unique default gen_random_uuid(),
  target_discord_user_id text not null
    references public.user_logs(discord_user_id)
    on update restrict on delete restrict,
  source_comment_id uuid not null unique
    references public.community_comments(id)
    on update restrict on delete restrict,
  source_public_comment_id uuid not null unique
    references public.community_comments(public_comment_id)
    on update restrict on delete restrict,
  source_submission_id bigint not null check (source_submission_id > 0),
  source_comment_object_version bigint not null
    check (source_comment_object_version > 0),
  source_comment_text_version bigint not null
    check (source_comment_text_version > 0),
  source_comment_body text not null,
  source_comment_body_digest text not null
    check (source_comment_body_digest ~ '^[0-9a-f]{64}$'),
  category text not null
    check (category in ('spam', 'hate_speech', 'other')),
  reason text not null
    check (char_length(btrim(reason)) between 3 and 1000),
  issued_at timestamptz not null,
  issued_by_discord_user_id text not null
    references public.user_logs(discord_user_id)
    on update restrict on delete restrict,
  issued_by_display_name text,
  issued_by_role_key text not null
    references public.team_roles(key)
    on update restrict on delete restrict,
  original_tier_days integer not null
    check (original_tier_days in (1, 3, 7, 14)),
  original_recurrence_until timestamptz not null,
  original_expires_at timestamptz not null,
  recorded_at timestamptz not null default transaction_timestamp(),
  unique (warning_id, target_discord_user_id),
  foreign key (source_comment_id, source_submission_id)
    references public.community_comments(id, submission_id)
    on update restrict on delete restrict,
  foreign key (source_comment_id, source_comment_text_version)
    references public.community_comment_text_versions(comment_id, version)
    on update restrict on delete restrict,
  constraint user_warnings_source_body_check check (
    char_length(source_comment_body) between 1 and 10000
    and octet_length(source_comment_body) <= 40000
    and source_comment_body = normalize(source_comment_body, NFC)
    and source_comment_body !~ E'[\\x00\\r]'
  ),
  constraint user_warnings_original_time_check check (
    original_expires_at = issued_at + make_interval(days => original_tier_days)
    and original_recurrence_until = issued_at + make_interval(
      days => case original_tier_days
        when 1 then 3
        else original_tier_days
      end
    )
  )
);

create index user_warnings_target_sequence_idx
  on public.user_warnings(target_discord_user_id, issued_at, warning_id);

create table public.user_warning_current (
  warning_id uuid primary key,
  target_discord_user_id text not null,
  effective_tier_days integer not null
    check (effective_tier_days in (1, 3, 7, 14)),
  recurrence_until timestamptz not null,
  expires_at timestamptz not null,
  state text not null check (state in ('active', 'expired', 'overruled')),
  sequence_position bigint not null check (sequence_position > 0),
  row_version bigint not null default 1 check (row_version > 0),
  recalculated_at timestamptz not null,
  foreign key (warning_id, target_discord_user_id)
    references public.user_warnings(warning_id, target_discord_user_id)
    on update restrict on delete restrict
);

create index user_warning_current_target_active_idx
  on public.user_warning_current(target_discord_user_id, expires_at)
  where state = 'active';

create table public.user_warning_events (
  event_id bigint generated always as identity primary key,
  warning_id uuid not null
    references public.user_warnings(warning_id)
    on update restrict on delete restrict,
  target_discord_user_id text not null,
  event_type text not null
    check (event_type in ('issued', 'overruled', 'recalculated', 'expired')),
  cause_warning_id uuid
    references public.user_warnings(warning_id)
    on update restrict on delete restrict,
  actor_kind text not null check (actor_kind in ('team', 'system')),
  actor_discord_user_id text,
  actor_display_name text,
  actor_role_key text,
  reason text,
  previous_state text
    check (previous_state is null or previous_state in ('active', 'expired', 'overruled')),
  new_state text not null
    check (new_state in ('active', 'expired', 'overruled')),
  previous_tier_days integer
    check (previous_tier_days is null or previous_tier_days in (1, 3, 7, 14)),
  new_tier_days integer not null
    check (new_tier_days in (1, 3, 7, 14)),
  previous_recurrence_until timestamptz,
  new_recurrence_until timestamptz not null,
  previous_expires_at timestamptz,
  new_expires_at timestamptz not null,
  warning_row_version bigint not null check (warning_row_version > 0),
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default transaction_timestamp(),
  foreign key (warning_id, target_discord_user_id)
    references public.user_warnings(warning_id, target_discord_user_id)
    on update restrict on delete restrict,
  constraint user_warning_events_actor_check check (
    (actor_kind = 'team'
      and nullif(btrim(actor_discord_user_id), '') is not null
      and nullif(btrim(actor_role_key), '') is not null)
    or (actor_kind = 'system'
      and actor_discord_user_id is null
      and actor_display_name is null
      and actor_role_key is null)
  ),
  constraint user_warning_events_reason_check check (
    reason is null or char_length(btrim(reason)) between 3 and 1000
  )
);

create index user_warning_events_warning_history_idx
  on public.user_warning_events(warning_id, event_id);
create index user_warning_events_target_history_idx
  on public.user_warning_events(target_discord_user_id, event_id);
create unique index user_warning_events_one_overrule_idx
  on public.user_warning_events(warning_id)
  where event_type = 'overruled';
create unique index user_warning_events_expiry_once_idx
  on public.user_warning_events(warning_id, new_expires_at)
  where event_type = 'expired';

create table public.user_warning_requests (
  request_id uuid primary key,
  operation text not null check (operation in ('issue', 'overrule')),
  actor_discord_user_id text not null
    references public.user_logs(discord_user_id)
    on update restrict on delete restrict,
  target_discord_user_id text not null
    references public.user_logs(discord_user_id)
    on update restrict on delete restrict,
  warning_id uuid not null
    references public.user_warnings(warning_id)
    on update restrict on delete restrict,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  request_payload jsonb not null check (jsonb_typeof(request_payload) = 'object'),
  receipt jsonb not null check (jsonb_typeof(receipt) = 'object'),
  created_at timestamptz not null default transaction_timestamp()
);

create index user_warning_requests_target_idx
  on public.user_warning_requests(target_discord_user_id, created_at);

create table public.user_warning_auto_flag_cases (
  case_id uuid primary key default gen_random_uuid(),
  target_discord_user_id text not null
    references public.user_logs(discord_user_id)
    on update restrict on delete restrict,
  generation bigint not null check (generation > 0),
  status text not null check (status in ('open', 'closed')),
  active_warning_count integer not null check (active_warning_count >= 0),
  triggered_by_active_count boolean not null,
  triggered_by_fourteen_day boolean not null,
  opened_at timestamptz not null,
  closed_at timestamptz,
  row_version bigint not null default 1 check (row_version > 0),
  unique (target_discord_user_id, generation),
  constraint user_warning_auto_flag_state_check check (
    (status = 'open'
      and closed_at is null
      and (triggered_by_active_count or triggered_by_fourteen_day))
    or (status = 'closed' and closed_at is not null)
  )
);

create unique index user_warning_auto_flag_one_open_idx
  on public.user_warning_auto_flag_cases(target_discord_user_id)
  where status = 'open';

create table public.user_warning_auto_flag_events (
  event_id bigint generated always as identity primary key,
  case_id uuid not null
    references public.user_warning_auto_flag_cases(case_id)
    on update restrict on delete restrict,
  event_type text not null check (event_type in ('opened', 'recomputed', 'closed')),
  cause_warning_id uuid
    references public.user_warnings(warning_id)
    on update restrict on delete restrict,
  active_warning_count integer not null check (active_warning_count >= 0),
  triggered_by_active_count boolean not null,
  triggered_by_fourteen_day boolean not null,
  reason text not null check (reason in ('threshold_met', 'threshold_changed', 'thresholds_cleared')),
  case_version bigint not null check (case_version > 0),
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default transaction_timestamp()
);

create index user_warning_auto_flag_events_case_idx
  on public.user_warning_auto_flag_events(case_id, event_id);

alter table public.user_warnings enable row level security;
alter table public.user_warning_current enable row level security;
alter table public.user_warning_events enable row level security;
alter table public.user_warning_requests enable row level security;
alter table public.user_warning_auto_flag_cases enable row level security;
alter table public.user_warning_auto_flag_events enable row level security;

create function public.protect_user_warning_append_only()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $function$
begin
  raise exception using
    errcode = '55000',
    message = 'USER_WARNING_HISTORY_IS_APPEND_ONLY';
end;
$function$;

create trigger protect_user_warnings
before update or delete on public.user_warnings
for each row execute function public.protect_user_warning_append_only();
create trigger protect_user_warning_events
before update or delete on public.user_warning_events
for each row execute function public.protect_user_warning_append_only();
create trigger protect_user_warning_requests
before update or delete on public.user_warning_requests
for each row execute function public.protect_user_warning_append_only();
create trigger protect_user_warning_auto_flag_events
before update or delete on public.user_warning_auto_flag_events
for each row execute function public.protect_user_warning_append_only();

create function public.protect_user_warning_projection_identity()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception using
      errcode = '55000',
      message = 'USER_WARNING_PROJECTION_DELETE_FORBIDDEN';
  end if;

  if tg_table_name = 'user_warning_current' then
    if (new.warning_id, new.target_discord_user_id)
      is distinct from (old.warning_id, old.target_discord_user_id)
    then
      raise exception using
        errcode = '55000',
        message = 'USER_WARNING_PROJECTION_IDENTITY_IMMUTABLE';
    end if;
  elsif tg_table_name = 'user_warning_auto_flag_cases' then
    if (new.case_id, new.target_discord_user_id, new.generation, new.opened_at)
      is distinct from (old.case_id, old.target_discord_user_id, old.generation, old.opened_at)
    then
      raise exception using
        errcode = '55000',
        message = 'USER_WARNING_AUTO_FLAG_IDENTITY_IMMUTABLE';
    end if;
  end if;

  return new;
end;
$function$;

create trigger protect_user_warning_current_identity
before update or delete on public.user_warning_current
for each row execute function public.protect_user_warning_projection_identity();
create trigger protect_user_warning_auto_flag_case_identity
before update or delete on public.user_warning_auto_flag_cases
for each row execute function public.protect_user_warning_projection_identity();

create function public.calculate_user_warning_tier(
  p_previous_tier_days integer,
  p_previous_recurrence_until timestamptz,
  p_issue_at timestamptz
)
returns integer
language plpgsql
immutable
set search_path = public, pg_temp
as $function$
begin
  if p_issue_at is null then
    raise exception using
      errcode = '22023',
      message = 'USER_WARNING_TIER_INPUT_INVALID';
  end if;

  if p_previous_tier_days is not null
    and p_previous_tier_days not in (1, 3, 7, 14)
  then
    raise exception using
      errcode = '22023',
      message = 'USER_WARNING_TIER_INPUT_INVALID';
  end if;

  if p_previous_tier_days is null
    or p_previous_recurrence_until is null
    or p_issue_at > p_previous_recurrence_until
  then
    return 1;
  end if;

  return case p_previous_tier_days
    when 1 then 3
    when 3 then 7
    when 7 then 14
    when 14 then 14
  end;
end;
$function$;

create function public.authorize_user_warning_capability(
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
  v_role_key text;
  v_expected_hash text;
begin
  v_expected_hash := case p_capability_key
    when 'users.warnings.issue' then
      '8910867c7eb547473efaf129089bf2e0098d6f471e2057358ddd77f90818811f'
    when 'users.warnings.overrule' then
      'ce5849bc151746eddf520ed960002a6f0c7e4a9c7b0c9eac58721d4c40603ece'
    else null
  end;

  if nullif(v_actor_id, '') is null or v_expected_hash is null then
    raise exception using errcode = '42501', message = 'USER_WARNING_FORBIDDEN';
  end if;

  if not exists (
    select 1
    from public.capability_catalog capability
    where capability.key = p_capability_key
      and capability.is_active
      and capability.assignable_to_non_admin
      and capability.implementation_version = 1
      and capability.definition_hash = v_expected_hash
  ) then
    raise exception using
      errcode = '55000',
      message = 'USER_WARNING_CAPABILITY_DEPENDENCY_UNAVAILABLE';
  end if;

  select member.role
  into v_role_key
  from public.team_members member
  join public.team_roles role
    on role.key = member.role
   and role.is_active
  where member.discord_user_id = v_actor_id;

  if not found
    or (
      v_role_key <> 'admin'
      and not exists (
        select 1
        from public.team_role_capabilities grant_row
        where grant_row.role_key = v_role_key
          and grant_row.capability_key = p_capability_key
      )
    )
  then
    raise exception using errcode = '42501', message = 'USER_WARNING_FORBIDDEN';
  end if;

  return v_role_key;
end;
$function$;

create function public.sync_user_warning_auto_flag(
  p_target_discord_user_id text,
  p_now timestamptz,
  p_cause_warning_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_active_count integer;
  v_active_count_trigger boolean;
  v_fourteen_day_trigger boolean;
  v_should_open boolean;
  v_case public.user_warning_auto_flag_cases%rowtype;
  v_generation bigint;
begin
  select
    count(*)::integer,
    count(*) >= 3,
    coalesce(bool_or(current_row.effective_tier_days = 14), false)
  into v_active_count, v_active_count_trigger, v_fourteen_day_trigger
  from public.user_warning_current current_row
  where current_row.target_discord_user_id = p_target_discord_user_id
    and current_row.state <> 'overruled'
    and current_row.expires_at > p_now;

  v_should_open := v_active_count_trigger or v_fourteen_day_trigger;

  select *
  into v_case
  from public.user_warning_auto_flag_cases flag_case
  where flag_case.target_discord_user_id = p_target_discord_user_id
    and flag_case.status = 'open'
  for update;

  if v_should_open and not found then
    select coalesce(max(flag_case.generation), 0) + 1
    into v_generation
    from public.user_warning_auto_flag_cases flag_case
    where flag_case.target_discord_user_id = p_target_discord_user_id;

    insert into public.user_warning_auto_flag_cases (
      target_discord_user_id,
      generation,
      status,
      active_warning_count,
      triggered_by_active_count,
      triggered_by_fourteen_day,
      opened_at
    ) values (
      p_target_discord_user_id,
      v_generation,
      'open',
      v_active_count,
      v_active_count_trigger,
      v_fourteen_day_trigger,
      p_now
    ) returning * into v_case;

    insert into public.user_warning_auto_flag_events (
      case_id,
      event_type,
      cause_warning_id,
      active_warning_count,
      triggered_by_active_count,
      triggered_by_fourteen_day,
      reason,
      case_version,
      occurred_at
    ) values (
      v_case.case_id,
      'opened',
      p_cause_warning_id,
      v_active_count,
      v_active_count_trigger,
      v_fourteen_day_trigger,
      'threshold_met',
      v_case.row_version,
      p_now
    );
  elsif v_should_open and found then
    if v_case.active_warning_count <> v_active_count
      or v_case.triggered_by_active_count <> v_active_count_trigger
      or v_case.triggered_by_fourteen_day <> v_fourteen_day_trigger
    then
      update public.user_warning_auto_flag_cases
      set active_warning_count = v_active_count,
          triggered_by_active_count = v_active_count_trigger,
          triggered_by_fourteen_day = v_fourteen_day_trigger,
          row_version = row_version + 1
      where case_id = v_case.case_id
      returning * into v_case;

      insert into public.user_warning_auto_flag_events (
        case_id,
        event_type,
        cause_warning_id,
        active_warning_count,
        triggered_by_active_count,
        triggered_by_fourteen_day,
        reason,
        case_version,
        occurred_at
      ) values (
        v_case.case_id,
        'recomputed',
        p_cause_warning_id,
        v_active_count,
        v_active_count_trigger,
        v_fourteen_day_trigger,
        'threshold_changed',
        v_case.row_version,
        p_now
      );
    end if;
  elsif not v_should_open and found then
    update public.user_warning_auto_flag_cases
    set status = 'closed',
        active_warning_count = v_active_count,
        triggered_by_active_count = false,
        triggered_by_fourteen_day = false,
        closed_at = p_now,
        row_version = row_version + 1
    where case_id = v_case.case_id
    returning * into v_case;

    insert into public.user_warning_auto_flag_events (
      case_id,
      event_type,
      cause_warning_id,
      active_warning_count,
      triggered_by_active_count,
      triggered_by_fourteen_day,
      reason,
      case_version,
      occurred_at
    ) values (
      v_case.case_id,
      'closed',
      p_cause_warning_id,
      v_active_count,
      false,
      false,
      'thresholds_cleared',
      v_case.row_version,
      p_now
    );
  end if;

  return jsonb_build_object(
    'activeWarningCount', v_active_count,
    'triggeredByActiveCount', v_active_count_trigger,
    'triggeredByFourteenDay', v_fourteen_day_trigger,
    'status', case when v_should_open then 'open' else 'closed' end,
    'caseId', case when v_should_open then v_case.case_id else null end
  );
end;
$function$;

create function public.recalculate_user_warning_target(
  p_target_discord_user_id text,
  p_now timestamptz,
  p_cause_warning_id uuid,
  p_actor_kind text,
  p_actor_discord_user_id text,
  p_actor_display_name text,
  p_actor_role_key text,
  p_reason text,
  p_record_recalculations boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_warning public.user_warnings%rowtype;
  v_projection public.user_warning_current%rowtype;
  v_previous_tier integer;
  v_previous_recurrence timestamptz;
  v_new_tier integer;
  v_new_recurrence timestamptz;
  v_new_expiry timestamptz;
  v_new_state text;
  v_sequence bigint := 0;
  v_row_version bigint;
  v_cause_issued_at timestamptz;
  v_recalculated_count integer := 0;
  v_expired_count integer := 0;
  v_auto_flag jsonb;
begin
  if nullif(btrim(p_target_discord_user_id), '') is null
    or p_now is null
    or p_actor_kind not in ('team', 'system')
    or p_record_recalculations is null
  then
    raise exception using
      errcode = '22023',
      message = 'USER_WARNING_RECALCULATION_INPUT_INVALID';
  end if;

  if p_actor_kind = 'team'
    and (nullif(btrim(p_actor_discord_user_id), '') is null
      or nullif(btrim(p_actor_role_key), '') is null)
  then
    raise exception using
      errcode = '22023',
      message = 'USER_WARNING_RECALCULATION_ACTOR_INVALID';
  elsif p_actor_kind = 'system'
    and (p_actor_discord_user_id is not null
      or p_actor_display_name is not null
      or p_actor_role_key is not null)
  then
    raise exception using
      errcode = '22023',
      message = 'USER_WARNING_RECALCULATION_ACTOR_INVALID';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('user-warning-target:' || p_target_discord_user_id, 0)
  );

  if p_cause_warning_id is not null then
    select warning_row.issued_at
    into v_cause_issued_at
    from public.user_warnings warning_row
    where warning_row.warning_id = p_cause_warning_id
      and warning_row.target_discord_user_id = p_target_discord_user_id;

    if not found then
      raise exception using
        errcode = '55000',
        message = 'USER_WARNING_RECALCULATION_CAUSE_MISMATCH';
    end if;
  end if;

  for v_warning in
    select warning_row.*
    from public.user_warnings warning_row
    where warning_row.target_discord_user_id = p_target_discord_user_id
    order by warning_row.issued_at, warning_row.warning_id
  loop
    select *
    into strict v_projection
    from public.user_warning_current current_row
    where current_row.warning_id = v_warning.warning_id
    for update;

    if exists (
      select 1
      from public.user_warning_events event_row
      where event_row.warning_id = v_warning.warning_id
        and event_row.event_type = 'overruled'
    ) then
      if v_projection.state <> 'overruled' then
        update public.user_warning_current
        set state = 'overruled',
            row_version = row_version + 1,
            recalculated_at = p_now
        where warning_id = v_warning.warning_id;
      end if;
      continue;
    end if;

    v_sequence := v_sequence + 1;
    v_new_tier := public.calculate_user_warning_tier(
      v_previous_tier,
      v_previous_recurrence,
      v_warning.issued_at
    );
    v_new_recurrence := v_warning.issued_at + make_interval(
      days => case v_new_tier when 1 then 3 else v_new_tier end
    );
    v_new_expiry := v_warning.issued_at + make_interval(days => v_new_tier);
    v_new_state := case when v_new_expiry > p_now then 'active' else 'expired' end;
    v_row_version := v_projection.row_version;

    if (v_projection.effective_tier_days,
        v_projection.recurrence_until,
        v_projection.expires_at,
        v_projection.state,
        v_projection.sequence_position)
      is distinct from
       (v_new_tier,
        v_new_recurrence,
        v_new_expiry,
        v_new_state,
        v_sequence)
    then
      update public.user_warning_current
      set effective_tier_days = v_new_tier,
          recurrence_until = v_new_recurrence,
          expires_at = v_new_expiry,
          state = v_new_state,
          sequence_position = v_sequence,
          row_version = row_version + 1,
          recalculated_at = p_now
      where warning_id = v_warning.warning_id
      returning row_version into v_row_version;
    end if;

    if p_record_recalculations
      and p_cause_warning_id is not null
      and (v_warning.issued_at, v_warning.warning_id)
        > (v_cause_issued_at, p_cause_warning_id)
    then
      insert into public.user_warning_events (
        warning_id,
        target_discord_user_id,
        event_type,
        cause_warning_id,
        actor_kind,
        actor_discord_user_id,
        actor_display_name,
        actor_role_key,
        reason,
        previous_state,
        new_state,
        previous_tier_days,
        new_tier_days,
        previous_recurrence_until,
        new_recurrence_until,
        previous_expires_at,
        new_expires_at,
        warning_row_version,
        occurred_at
      ) values (
        v_warning.warning_id,
        p_target_discord_user_id,
        'recalculated',
        p_cause_warning_id,
        p_actor_kind,
        p_actor_discord_user_id,
        p_actor_display_name,
        p_actor_role_key,
        p_reason,
        v_projection.state,
        v_new_state,
        v_projection.effective_tier_days,
        v_new_tier,
        v_projection.recurrence_until,
        v_new_recurrence,
        v_projection.expires_at,
        v_new_expiry,
        v_row_version,
        p_now
      );
      v_recalculated_count := v_recalculated_count + 1;
    end if;

    if v_projection.state = 'active'
      and v_new_state = 'expired'
      and not exists (
        select 1
        from public.user_warning_events event_row
        where event_row.warning_id = v_warning.warning_id
          and event_row.event_type = 'expired'
          and event_row.new_expires_at = v_new_expiry
      )
    then
      insert into public.user_warning_events (
        warning_id,
        target_discord_user_id,
        event_type,
        cause_warning_id,
        actor_kind,
        actor_discord_user_id,
        actor_display_name,
        actor_role_key,
        reason,
        previous_state,
        new_state,
        previous_tier_days,
        new_tier_days,
        previous_recurrence_until,
        new_recurrence_until,
        previous_expires_at,
        new_expires_at,
        warning_row_version,
        occurred_at
      ) values (
        v_warning.warning_id,
        p_target_discord_user_id,
        'expired',
        p_cause_warning_id,
        'system',
        null,
        null,
        null,
        null,
        v_projection.state,
        'expired',
        v_projection.effective_tier_days,
        v_new_tier,
        v_projection.recurrence_until,
        v_new_recurrence,
        v_projection.expires_at,
        v_new_expiry,
        v_row_version,
        p_now
      );
      v_expired_count := v_expired_count + 1;
    end if;

    v_previous_tier := v_new_tier;
    v_previous_recurrence := v_new_recurrence;
  end loop;

  v_auto_flag := public.sync_user_warning_auto_flag(
    p_target_discord_user_id,
    p_now,
    p_cause_warning_id
  );

  return jsonb_build_object(
    'recalculatedCount', v_recalculated_count,
    'expiredCount', v_expired_count,
    'activeWarningCount', v_auto_flag -> 'activeWarningCount',
    'autoFlag', v_auto_flag
  );
end;
$function$;

create function public.issue_user_warning(
  p_actor_discord_user_id text,
  p_source_public_comment_id uuid,
  p_expected_comment_object_version bigint,
  p_expected_comment_text_version bigint,
  p_category text,
  p_reason text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor_id text := btrim(p_actor_discord_user_id);
  v_category text := btrim(p_category);
  v_reason text := btrim(p_reason);
  v_role_key text;
  v_actor_display text;
  v_comment public.community_comments%rowtype;
  v_source_body text;
  v_now timestamptz;
  v_previous_tier integer;
  v_previous_recurrence timestamptz;
  v_tier integer;
  v_recurrence timestamptz;
  v_expiry timestamptz;
  v_warning_id uuid;
  v_public_warning_id uuid;
  v_request_payload jsonb;
  v_request_hash text;
  v_existing_hash text;
  v_existing_receipt jsonb;
  v_receipt jsonb;
  v_auto_flag jsonb;
begin
  if p_source_public_comment_id is null
    or p_expected_comment_object_version is null
    or p_expected_comment_object_version <= 0
    or p_expected_comment_text_version is null
    or p_expected_comment_text_version <= 0
    or v_category not in ('spam', 'hate_speech', 'other')
    or char_length(v_reason) not between 3 and 1000
    or p_request_id is null
  then
    raise exception using
      errcode = '22023',
      message = 'USER_WARNING_ISSUE_INPUT_INVALID';
  end if;

  v_role_key := public.authorize_user_warning_capability(
    v_actor_id,
    'users.warnings.issue'
  );

  v_request_payload := jsonb_build_object(
    'operation', 'issue',
    'operationVersion', 1,
    'actorDiscordUserId', v_actor_id,
    'sourcePublicCommentId', p_source_public_comment_id,
    'expectedCommentObjectVersion', p_expected_comment_object_version,
    'expectedCommentTextVersion', p_expected_comment_text_version,
    'category', v_category,
    'reason', v_reason
  );
  v_request_hash := encode(
    extensions.digest(convert_to(v_request_payload::text, 'UTF8'), 'sha256'),
    'hex'
  );

  perform pg_advisory_xact_lock(
    hashtextextended('user-warning-request:' || p_request_id::text, 0)
  );

  select request_hash, receipt
  into v_existing_hash, v_existing_receipt
  from public.user_warning_requests request_row
  where request_row.request_id = p_request_id;

  if found then
    if v_existing_hash = v_request_hash then
      return jsonb_set(v_existing_receipt, '{replayed}', 'true'::jsonb);
    end if;
    raise exception using
      errcode = 'PT409',
      message = 'USER_WARNING_IDEMPOTENCY_CONFLICT';
  end if;

  select comment_row.*
  into v_comment
  from public.community_comments comment_row
  where comment_row.public_comment_id = p_source_public_comment_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'USER_WARNING_SOURCE_NOT_FOUND';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('user-warning-target:' || v_comment.author_discord_user_id, 0)
  );
  v_now := clock_timestamp();

  perform public.recalculate_user_warning_target(
    v_comment.author_discord_user_id,
    v_now,
    null,
    'system',
    null,
    null,
    null,
    null,
    false
  );

  select comment_row.*
  into v_comment
  from public.community_comments comment_row
  where comment_row.public_comment_id = p_source_public_comment_id
  for update;

  if not found
    or v_comment.author_deleted_at is not null
    or not public.is_community_comment_submission_eligible(v_comment.submission_id)
  then
    raise exception using
      errcode = 'PT409',
      message = 'USER_WARNING_SOURCE_UNAVAILABLE';
  end if;

  select text_version.normalized_body
  into v_source_body
  from public.community_comment_text_versions text_version
  where text_version.comment_id = v_comment.id
    and text_version.version = v_comment.current_text_version;

  if not found or v_source_body is null then
    raise exception using
      errcode = 'PT409',
      message = 'USER_WARNING_SOURCE_UNAVAILABLE';
  end if;

  if v_comment.object_version <> p_expected_comment_object_version
    or v_comment.current_text_version <> p_expected_comment_text_version
  then
    raise exception using
      errcode = 'PT409',
      message = 'USER_WARNING_STALE_SOURCE_VERSION';
  end if;

  if exists (
    select 1
    from public.user_warnings warning_row
    where warning_row.source_comment_id = v_comment.id
  ) then
    raise exception using
      errcode = 'PT409',
      message = 'USER_WARNING_SOURCE_ALREADY_USED';
  end if;

  select current_row.effective_tier_days, current_row.recurrence_until
  into v_previous_tier, v_previous_recurrence
  from public.user_warnings warning_row
  join public.user_warning_current current_row
    on current_row.warning_id = warning_row.warning_id
  where warning_row.target_discord_user_id = v_comment.author_discord_user_id
    and not exists (
      select 1 from public.user_warning_events event_row
      where event_row.warning_id = warning_row.warning_id
        and event_row.event_type = 'overruled'
    )
  order by warning_row.issued_at desc, warning_row.warning_id desc
  limit 1;

  v_tier := public.calculate_user_warning_tier(
    v_previous_tier,
    v_previous_recurrence,
    v_now
  );
  v_recurrence := v_now + make_interval(
    days => case v_tier when 1 then 3 else v_tier end
  );
  v_expiry := v_now + make_interval(days => v_tier);

  select nullif(btrim(current_discord_username), '')
  into v_actor_display
  from public.user_logs user_row
  where user_row.discord_user_id = v_actor_id;

  insert into public.user_warnings (
    target_discord_user_id,
    source_comment_id,
    source_public_comment_id,
    source_submission_id,
    source_comment_object_version,
    source_comment_text_version,
    source_comment_body,
    source_comment_body_digest,
    category,
    reason,
    issued_at,
    issued_by_discord_user_id,
    issued_by_display_name,
    issued_by_role_key,
    original_tier_days,
    original_recurrence_until,
    original_expires_at
  ) values (
    v_comment.author_discord_user_id,
    v_comment.id,
    v_comment.public_comment_id,
    v_comment.submission_id,
    v_comment.object_version,
    v_comment.current_text_version,
    v_source_body,
    encode(extensions.digest(convert_to(v_source_body, 'UTF8'), 'sha256'), 'hex'),
    v_category,
    v_reason,
    v_now,
    v_actor_id,
    v_actor_display,
    v_role_key,
    v_tier,
    v_recurrence,
    v_expiry
  ) returning warning_id, public_warning_id
    into v_warning_id, v_public_warning_id;

  insert into public.user_warning_current (
    warning_id,
    target_discord_user_id,
    effective_tier_days,
    recurrence_until,
    expires_at,
    state,
    sequence_position,
    recalculated_at
  ) values (
    v_warning_id,
    v_comment.author_discord_user_id,
    v_tier,
    v_recurrence,
    v_expiry,
    'active',
    (
      select count(*)
      from public.user_warnings warning_row
      where warning_row.target_discord_user_id = v_comment.author_discord_user_id
        and not exists (
          select 1 from public.user_warning_events event_row
          where event_row.warning_id = warning_row.warning_id
            and event_row.event_type = 'overruled'
        )
    ),
    v_now
  );

  insert into public.user_warning_events (
    warning_id,
    target_discord_user_id,
    event_type,
    cause_warning_id,
    actor_kind,
    actor_discord_user_id,
    actor_display_name,
    actor_role_key,
    reason,
    previous_state,
    new_state,
    previous_tier_days,
    new_tier_days,
    previous_recurrence_until,
    new_recurrence_until,
    previous_expires_at,
    new_expires_at,
    warning_row_version,
    occurred_at
  ) values (
    v_warning_id,
    v_comment.author_discord_user_id,
    'issued',
    null,
    'team',
    v_actor_id,
    v_actor_display,
    v_role_key,
    v_reason,
    null,
    'active',
    null,
    v_tier,
    null,
    v_recurrence,
    null,
    v_expiry,
    1,
    v_now
  );

  v_auto_flag := public.sync_user_warning_auto_flag(
    v_comment.author_discord_user_id,
    v_now,
    v_warning_id
  );

  v_receipt := jsonb_build_object(
    'warningId', v_public_warning_id,
    'sourcePublicCommentId', v_comment.public_comment_id,
    'targetDiscordUserId', v_comment.author_discord_user_id,
    'category', v_category,
    'tierDays', v_tier,
    'issuedAt', v_now,
    'recurrenceUntil', v_recurrence,
    'expiresAt', v_expiry,
    'state', 'active',
    'rowVersion', 1,
    'activeWarningCount', v_auto_flag -> 'activeWarningCount',
    'autoFlag', v_auto_flag,
    'replayed', false
  );

  insert into public.user_warning_requests (
    request_id,
    operation,
    actor_discord_user_id,
    target_discord_user_id,
    warning_id,
    request_hash,
    request_payload,
    receipt
  ) values (
    p_request_id,
    'issue',
    v_actor_id,
    v_comment.author_discord_user_id,
    v_warning_id,
    v_request_hash,
    v_request_payload,
    v_receipt
  );

  return v_receipt;
exception
  when unique_violation then
    raise exception using
      errcode = 'PT409',
      message = 'USER_WARNING_SOURCE_ALREADY_USED';
end;
$function$;

create function public.overrule_user_warning(
  p_actor_discord_user_id text,
  p_public_warning_id uuid,
  p_expected_row_version bigint,
  p_reason text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor_id text := btrim(p_actor_discord_user_id);
  v_reason text := btrim(p_reason);
  v_role_key text;
  v_actor_display text;
  v_warning public.user_warnings%rowtype;
  v_projection public.user_warning_current%rowtype;
  v_now timestamptz;
  v_request_payload jsonb;
  v_request_hash text;
  v_existing_hash text;
  v_existing_receipt jsonb;
  v_recalculation jsonb;
  v_receipt jsonb;
  v_new_row_version bigint;
begin
  if p_public_warning_id is null
    or p_expected_row_version is null
    or p_expected_row_version <= 0
    or char_length(v_reason) not between 3 and 1000
    or p_request_id is null
  then
    raise exception using
      errcode = '22023',
      message = 'USER_WARNING_OVERRULE_INPUT_INVALID';
  end if;

  v_role_key := public.authorize_user_warning_capability(
    v_actor_id,
    'users.warnings.overrule'
  );

  v_request_payload := jsonb_build_object(
    'operation', 'overrule',
    'operationVersion', 1,
    'actorDiscordUserId', v_actor_id,
    'warningId', p_public_warning_id,
    'expectedRowVersion', p_expected_row_version,
    'reason', v_reason
  );
  v_request_hash := encode(
    extensions.digest(convert_to(v_request_payload::text, 'UTF8'), 'sha256'),
    'hex'
  );

  perform pg_advisory_xact_lock(
    hashtextextended('user-warning-request:' || p_request_id::text, 0)
  );

  select request_hash, receipt
  into v_existing_hash, v_existing_receipt
  from public.user_warning_requests request_row
  where request_row.request_id = p_request_id;

  if found then
    if v_existing_hash = v_request_hash then
      return jsonb_set(v_existing_receipt, '{replayed}', 'true'::jsonb);
    end if;
    raise exception using
      errcode = 'PT409',
      message = 'USER_WARNING_IDEMPOTENCY_CONFLICT';
  end if;

  select warning_row.*
  into v_warning
  from public.user_warnings warning_row
  where warning_row.public_warning_id = p_public_warning_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'USER_WARNING_NOT_FOUND';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('user-warning-target:' || v_warning.target_discord_user_id, 0)
  );
  v_now := clock_timestamp();

  select current_row.*
  into v_projection
  from public.user_warning_current current_row
  where current_row.warning_id = v_warning.warning_id
  for update;

  if not found then
    raise exception using
      errcode = '55000',
      message = 'USER_WARNING_CURRENT_PROJECTION_UNAVAILABLE';
  end if;

  if v_projection.state = 'overruled'
    or exists (
      select 1 from public.user_warning_events event_row
      where event_row.warning_id = v_warning.warning_id
        and event_row.event_type = 'overruled'
    )
  then
    raise exception using
      errcode = 'PT409',
      message = 'USER_WARNING_ALREADY_OVERRULED';
  end if;

  if v_projection.row_version <> p_expected_row_version then
    raise exception using
      errcode = 'PT409',
      message = 'USER_WARNING_STALE_VERSION';
  end if;

  select nullif(btrim(current_discord_username), '')
  into v_actor_display
  from public.user_logs user_row
  where user_row.discord_user_id = v_actor_id;

  update public.user_warning_current
  set state = 'overruled',
      row_version = row_version + 1,
      recalculated_at = v_now
  where warning_id = v_warning.warning_id
  returning row_version into v_new_row_version;

  insert into public.user_warning_events (
    warning_id,
    target_discord_user_id,
    event_type,
    cause_warning_id,
    actor_kind,
    actor_discord_user_id,
    actor_display_name,
    actor_role_key,
    reason,
    previous_state,
    new_state,
    previous_tier_days,
    new_tier_days,
    previous_recurrence_until,
    new_recurrence_until,
    previous_expires_at,
    new_expires_at,
    warning_row_version,
    occurred_at
  ) values (
    v_warning.warning_id,
    v_warning.target_discord_user_id,
    'overruled',
    v_warning.warning_id,
    'team',
    v_actor_id,
    v_actor_display,
    v_role_key,
    v_reason,
    v_projection.state,
    'overruled',
    v_projection.effective_tier_days,
    v_projection.effective_tier_days,
    v_projection.recurrence_until,
    v_projection.recurrence_until,
    v_projection.expires_at,
    v_projection.expires_at,
    v_new_row_version,
    v_now
  );

  v_recalculation := public.recalculate_user_warning_target(
    v_warning.target_discord_user_id,
    v_now,
    v_warning.warning_id,
    'team',
    v_actor_id,
    v_actor_display,
    v_role_key,
    v_reason,
    true
  );

  v_receipt := jsonb_build_object(
    'warningId', v_warning.public_warning_id,
    'state', 'overruled',
    'rowVersion', v_new_row_version,
    'recalculatedCount', v_recalculation -> 'recalculatedCount',
    'expiredCount', v_recalculation -> 'expiredCount',
    'activeWarningCount', v_recalculation -> 'activeWarningCount',
    'autoFlag', v_recalculation -> 'autoFlag',
    'replayed', false
  );

  insert into public.user_warning_requests (
    request_id,
    operation,
    actor_discord_user_id,
    target_discord_user_id,
    warning_id,
    request_hash,
    request_payload,
    receipt
  ) values (
    p_request_id,
    'overrule',
    v_actor_id,
    v_warning.target_discord_user_id,
    v_warning.warning_id,
    v_request_hash,
    v_request_payload,
    v_receipt
  );

  return v_receipt;
end;
$function$;

create function public.process_due_user_warning_expiries(
  p_limit integer default 100
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_target text;
  v_now timestamptz;
  v_result jsonb;
  v_processed integer := 0;
  v_expired integer := 0;
begin
  if p_limit is null or p_limit not between 1 and 500 then
    raise exception using
      errcode = '22023',
      message = 'USER_WARNING_EXPIRY_INPUT_INVALID';
  end if;

  for v_target in
    select due.target_discord_user_id
    from (
      select distinct current_row.target_discord_user_id
      from public.user_warning_current current_row
      where current_row.state = 'active'
        and current_row.expires_at <= clock_timestamp()
      order by current_row.target_discord_user_id
      limit p_limit
    ) due
  loop
    perform pg_advisory_xact_lock(
      hashtextextended('user-warning-target:' || v_target, 0)
    );
    v_now := clock_timestamp();
    v_result := public.recalculate_user_warning_target(
      v_target,
      v_now,
      null,
      'system',
      null,
      null,
      null,
      null,
      false
    );
    v_processed := v_processed + 1;
    v_expired := v_expired + coalesce((v_result ->> 'expiredCount')::integer, 0);
  end loop;

  return jsonb_build_object(
    'processedTargets', v_processed,
    'expiredWarnings', v_expired
  );
end;
$function$;

alter table public.user_warnings owner to postgres;
alter table public.user_warning_current owner to postgres;
alter table public.user_warning_events owner to postgres;
alter table public.user_warning_requests owner to postgres;
alter table public.user_warning_auto_flag_cases owner to postgres;
alter table public.user_warning_auto_flag_events owner to postgres;
alter sequence public.user_warning_events_event_id_seq owner to postgres;
alter sequence public.user_warning_auto_flag_events_event_id_seq owner to postgres;

alter function public.protect_user_warning_append_only() owner to postgres;
alter function public.protect_user_warning_projection_identity() owner to postgres;
alter function public.calculate_user_warning_tier(integer,timestamptz,timestamptz) owner to postgres;
alter function public.authorize_user_warning_capability(text,text) owner to postgres;
alter function public.sync_user_warning_auto_flag(text,timestamptz,uuid) owner to postgres;
alter function public.recalculate_user_warning_target(text,timestamptz,uuid,text,text,text,text,text,boolean) owner to postgres;
alter function public.issue_user_warning(text,uuid,bigint,bigint,text,text,uuid) owner to postgres;
alter function public.overrule_user_warning(text,uuid,bigint,text,uuid) owner to postgres;
alter function public.process_due_user_warning_expiries(integer) owner to postgres;

revoke all on table public.user_warnings
  from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.user_warning_current
  from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.user_warning_events
  from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.user_warning_requests
  from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.user_warning_auto_flag_cases
  from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.user_warning_auto_flag_events
  from public, anon, authenticated, discord_bot, service_role;
revoke all on sequence public.user_warning_events_event_id_seq
  from public, anon, authenticated, discord_bot, service_role;
revoke all on sequence public.user_warning_auto_flag_events_event_id_seq
  from public, anon, authenticated, discord_bot, service_role;

revoke all on function public.protect_user_warning_append_only()
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.protect_user_warning_projection_identity()
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.calculate_user_warning_tier(integer,timestamptz,timestamptz)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.authorize_user_warning_capability(text,text)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.sync_user_warning_auto_flag(text,timestamptz,uuid)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.recalculate_user_warning_target(text,timestamptz,uuid,text,text,text,text,text,boolean)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.issue_user_warning(text,uuid,bigint,bigint,text,text,uuid)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.overrule_user_warning(text,uuid,bigint,text,uuid)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.process_due_user_warning_expiries(integer)
  from public, anon, authenticated, discord_bot, service_role;

grant execute on function public.issue_user_warning(text,uuid,bigint,bigint,text,text,uuid)
  to service_role;
grant execute on function public.overrule_user_warning(text,uuid,bigint,text,uuid)
  to service_role;
grant execute on function public.process_due_user_warning_expiries(integer)
  to service_role;

do $security_postflight$
declare
  v_signature text;
  v_table text;
  v_service_signatures text[] := array[
    'public.issue_user_warning(text,uuid,bigint,bigint,text,text,uuid)',
    'public.overrule_user_warning(text,uuid,bigint,text,uuid)',
    'public.process_due_user_warning_expiries(integer)'
  ];
  v_internal_definer_signatures text[] := array[
    'public.authorize_user_warning_capability(text,text)',
    'public.sync_user_warning_auto_flag(text,timestamp with time zone,uuid)',
    'public.recalculate_user_warning_target(text,timestamp with time zone,uuid,text,text,text,text,text,boolean)'
  ];
  v_internal_invoker_signatures text[] := array[
    'public.protect_user_warning_append_only()',
    'public.protect_user_warning_projection_identity()',
    'public.calculate_user_warning_tier(integer,timestamp with time zone,timestamp with time zone)'
  ];
  v_tables text[] := array[
    'user_warnings',
    'user_warning_current',
    'user_warning_events',
    'user_warning_requests',
    'user_warning_auto_flag_cases',
    'user_warning_auto_flag_events'
  ];
begin
  foreach v_signature in array v_service_signatures loop
    if to_regprocedure(v_signature) is null
      or not exists (
        select 1
        from pg_proc function_row
        where function_row.oid = to_regprocedure(v_signature)
          and pg_get_userbyid(function_row.proowner) = 'postgres'
          and function_row.prosecdef
          and function_row.proconfig @> array['search_path=public, pg_temp']
      )
      or has_function_privilege('anon', v_signature, 'EXECUTE')
      or has_function_privilege('authenticated', v_signature, 'EXECUTE')
      or has_function_privilege('discord_bot', v_signature, 'EXECUTE')
      or not has_function_privilege('service_role', v_signature, 'EXECUTE')
    then
      raise exception using
        errcode = '55000',
        message = 'USER_WARNING_SERVICE_FUNCTION_SECURITY_MISMATCH',
        detail = v_signature;
    end if;
  end loop;

  foreach v_signature in array v_internal_definer_signatures loop
    if to_regprocedure(v_signature) is null
      or not exists (
        select 1
        from pg_proc function_row
        where function_row.oid = to_regprocedure(v_signature)
          and pg_get_userbyid(function_row.proowner) = 'postgres'
          and function_row.prosecdef
          and function_row.proconfig @> array['search_path=public, pg_temp']
      )
      or has_function_privilege('anon', v_signature, 'EXECUTE')
      or has_function_privilege('authenticated', v_signature, 'EXECUTE')
      or has_function_privilege('discord_bot', v_signature, 'EXECUTE')
      or has_function_privilege('service_role', v_signature, 'EXECUTE')
    then
      raise exception using
        errcode = '55000',
        message = 'USER_WARNING_INTERNAL_FUNCTION_SECURITY_MISMATCH',
        detail = v_signature;
    end if;
  end loop;

  foreach v_signature in array v_internal_invoker_signatures loop
    if to_regprocedure(v_signature) is null
      or not exists (
        select 1
        from pg_proc function_row
        where function_row.oid = to_regprocedure(v_signature)
          and pg_get_userbyid(function_row.proowner) = 'postgres'
          and not function_row.prosecdef
          and function_row.proconfig @> array['search_path=public, pg_temp']
      )
      or has_function_privilege('anon', v_signature, 'EXECUTE')
      or has_function_privilege('authenticated', v_signature, 'EXECUTE')
      or has_function_privilege('discord_bot', v_signature, 'EXECUTE')
      or has_function_privilege('service_role', v_signature, 'EXECUTE')
    then
      raise exception using
        errcode = '55000',
        message = 'USER_WARNING_INVOKER_FUNCTION_SECURITY_MISMATCH',
        detail = v_signature;
    end if;
  end loop;

  if exists (
    select 1
    from pg_proc function_row
    join pg_namespace namespace_row
      on namespace_row.oid = function_row.pronamespace
    where namespace_row.nspname = 'public'
      and function_row.proname like '%user_warning%'
      and function_row.oid <> all(
        (
          v_service_signatures
          || v_internal_definer_signatures
          || v_internal_invoker_signatures
        )::regprocedure[]
      )
  ) then
    raise exception using
      errcode = '55000',
      message = 'USER_WARNING_FUNCTION_OVERLOAD_MISMATCH';
  end if;

  foreach v_table in array v_tables loop
    if not exists (
      select 1
      from pg_class table_row
      where table_row.oid = format('public.%I', v_table)::regclass
        and table_row.relrowsecurity
        and pg_get_userbyid(table_row.relowner) = 'postgres'
    )
      or exists (
        select 1 from pg_policy policy_row
        where policy_row.polrelid = format('public.%I', v_table)::regclass
      )
      or has_table_privilege('anon', format('public.%I', v_table), 'SELECT')
      or has_table_privilege('authenticated', format('public.%I', v_table), 'SELECT')
      or has_table_privilege('discord_bot', format('public.%I', v_table), 'SELECT')
      or has_table_privilege('service_role', format('public.%I', v_table), 'SELECT')
      or has_table_privilege('service_role', format('public.%I', v_table), 'INSERT')
      or has_table_privilege('service_role', format('public.%I', v_table), 'UPDATE')
      or has_table_privilege('service_role', format('public.%I', v_table), 'DELETE')
    then
      raise exception using
        errcode = '55000',
        message = 'USER_WARNING_TABLE_SECURITY_MISMATCH',
        detail = v_table;
    end if;
  end loop;

  if (select count(*) from public.capability_catalog) <> 51
    or (select count(*) from public.capability_catalog where is_active) <> 47
    or (
      select count(*) from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 47
    or (
      select count(*)
      from public.capability_catalog
      where key in ('users.warnings.issue', 'users.warnings.overrule')
        and is_active
        and assignable_to_non_admin
        and implementation_version = 1
    ) <> 2
    or exists (
      select 1
      from public.team_role_capabilities
      where capability_key in ('users.warnings.issue', 'users.warnings.overrule')
    )
    or exists (select 1 from public.user_warnings)
    or exists (select 1 from public.user_warning_auto_flag_cases)
    or has_sequence_privilege(
      'service_role', 'public.user_warning_events_event_id_seq', 'USAGE'
    )
    or has_sequence_privilege(
      'service_role', 'public.user_warning_auto_flag_events_event_id_seq', 'USAGE'
    )
  then
    raise exception using
      errcode = '55000',
      message = 'USER_WARNING_CORE_POSTFLIGHT_MISMATCH';
  end if;
end;
$security_postflight$;

comment on table public.user_warnings is
  'Immutable canonical Comment-bound Warning issue facts and exact source object/text evidence. One source Comment can create at most one Warning for all time.';
comment on table public.user_warning_current is
  'Mutable current projection rebuilt from immutable non-overruled Warning history; it is not the audit source.';
comment on table public.user_warning_events is
  'Append-only Warning issue, Overrule, deterministic recalculation and database-time expiry history.';
comment on table public.user_warning_requests is
  'Append-only global request-id ledger for idempotent Warning Issue and Overrule RPCs.';
comment on table public.user_warning_auto_flag_cases is
  'Dedicated automatic Warning-threshold Flag Case generations. They never create a Ban, Participation Hold or other sanction and remain separate from manual user_flag_cases.';
comment on table public.user_warning_auto_flag_events is
  'Append-only threshold history for automatic Warning Flag Case open, recompute and close transitions.';
comment on function public.issue_user_warning(text,uuid,bigint,bigint,text,text,uuid) is
  'Issues one Comment-bound Warning. The caller supplies category and reason, never duration; PostgreSQL assigns 1, 3, 7 or 14 days from database time.';
comment on function public.overrule_user_warning(text,uuid,bigint,text,uuid) is
  'Overrules one exact Warning and deterministically replays every later non-overruled Warning without rewriting original evidence.';
comment on function public.process_due_user_warning_expiries(integer) is
  'Bounded provider-neutral processor that records due database-time expiries and closes automatic Warning Flag Cases when neither trigger remains.';

commit;
