begin;

set local lock_timeout = '10s';
set local statement_timeout = '60s';

create temporary table post_voting_report_lock_preflight on commit drop as
select
  (select count(*) from public.submission_reporter_identities) as identity_count,
  (select count(*) from public.submission_report_cases) as case_count,
  (select count(*) from public.submission_reports) as report_count,
  (select count(*) from public.submission_report_payloads) as payload_count,
  (select count(*) from public.submission_report_case_events) as event_count,
  (select count(*) from public.submission_report_requests) as request_count,
  (select count(*) from public.submission_report_reads) as read_count;

do $preflight$
declare
  v_eligibility_definition text;
begin
  if to_regprocedure(
      'public.get_submission_report_eligibility(text,integer,text,bigint)'
    ) is null
    or to_regprocedure(
      'public.create_submission_report(text,integer,text,bigint,integer,text,text,text,uuid)'
    ) is null
    or to_regprocedure(
      'public.create_submission_report_v2(text,integer,text,bigint,integer,text,text,text,uuid)'
    ) is null
    or to_regclass('public.submission_report_reads') is null
    or exists (
      select 1
      from pg_proc function_row
      join pg_namespace namespace_row
        on namespace_row.oid = function_row.pronamespace
      where namespace_row.nspname = 'public'
        and function_row.proname = 'enforce_submission_report_creation_phase'
    )
    or exists (
      select 1
      from pg_trigger
      where tgrelid = 'public.submission_reports'::regclass
        and tgname = 'enforce_submission_report_creation_phase'
        and not tgisinternal
    )
    or not exists (
      select 1
      from pg_enum enum_value
      join pg_type enum_type on enum_type.oid = enum_value.enumtypid
      join pg_namespace namespace_row on namespace_row.oid = enum_type.typnamespace
      where namespace_row.nspname = 'public'
        and enum_type.typname = 'voting_cycle_status'
        and enum_value.enumlabel = 'voting_closed'
    )
    or not exists (
      select 1
      from pg_enum enum_value
      join pg_type enum_type on enum_type.oid = enum_value.enumtypid
      join pg_namespace namespace_row on namespace_row.oid = enum_type.typnamespace
      where namespace_row.nspname = 'public'
        and enum_type.typname = 'voting_cycle_status'
        and enum_value.enumlabel = 'finalizing'
    )
    or not exists (
      select 1
      from pg_enum enum_value
      join pg_type enum_type on enum_type.oid = enum_value.enumtypid
      join pg_namespace namespace_row on namespace_row.oid = enum_type.typnamespace
      where namespace_row.nspname = 'public'
        and enum_type.typname = 'voting_cycle_status'
        and enum_value.enumlabel = 'finished'
    ) then
    raise exception 'POST_VOTING_REPORT_LOCK_PREFLIGHT_MISMATCH';
  end if;

  select pg_get_functiondef(
    'public.get_submission_report_eligibility(text,integer,text,bigint)'::regprocedure
  ) into v_eligibility_definition;

  if position('voting_closed' in v_eligibility_definition) = 0
    or not exists (
      select 1
      from pg_proc function_row
      where function_row.oid =
        'public.get_submission_report_eligibility(text,integer,text,bigint)'::regprocedure
        and function_row.proowner = 'postgres'::regrole
        and function_row.prosecdef
        and function_row.proconfig = array['search_path=public, pg_temp']
    )
    or not exists (
      select 1
      from pg_proc function_row
      where function_row.oid =
        'public.create_submission_report_v2(text,integer,text,bigint,integer,text,text,text,uuid)'::regprocedure
        and function_row.proowner = 'postgres'::regrole
        and function_row.prosecdef
        and function_row.proconfig = array['search_path=public, pg_temp']
    )
    or not has_function_privilege(
      'service_role',
      'public.get_submission_report_eligibility(text,integer,text,bigint)',
      'EXECUTE'
    )
    or not has_function_privilege(
      'service_role',
      'public.create_submission_report_v2(text,integer,text,bigint,integer,text,text,text,uuid)',
      'EXECUTE'
    ) then
    raise exception 'POST_VOTING_REPORT_LOCK_STARTING_CONTRACT_MISMATCH';
  end if;
end;
$preflight$;

create or replace function public.get_submission_report_eligibility(
  p_reporter_discord_user_id text,
  p_reporter_dedupe_version integer,
  p_reporter_dedupe_hash text,
  p_submission_id bigint
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_cycle_status text;
  v_paused_from_status text;
  v_reportable boolean := false;
  v_already boolean := false;
  v_multiple boolean := false;
  v_blocked_reason text := null;
begin
  if nullif(btrim(p_reporter_discord_user_id), '') is null
    or p_reporter_dedupe_version is null
    or p_reporter_dedupe_version < 1
    or p_reporter_dedupe_hash is null
    or p_reporter_dedupe_hash !~ '^[0-9a-f]{64}$'
    or p_submission_id is null
    or p_submission_id < 1 then
    raise exception using
      errcode = '22023',
      message = 'SUBMISSION_REPORT_INVALID';
  end if;

  select cycle.status::text, cycle.paused_from_status::text
  into v_cycle_status, v_paused_from_status
  from public.submissions submission
  join public.voting_cycles cycle on cycle.id = submission.cycle_id
  where submission.id = p_submission_id
    and not coalesce(submission.is_disqualified, false)
    and submission.public_visibility_status in ('visible', 'legal_review');

  if found then
    if v_cycle_status in ('voting_closed', 'finalizing') then
      v_blocked_reason := 'cycle_wrapping_up';
    else
      v_reportable :=
        v_cycle_status in (
          'submission_open',
          'voting_open',
          'active',
          'finished'
        )
        or (
          v_cycle_status = 'paused'
          and v_paused_from_status in ('submission_open', 'voting_open')
        );
    end if;
  end if;

  select exists (
    select 1
    from public.submission_reports report
    join public.submission_reporter_identities identity
      on identity.identity_id = report.reporter_identity_id
    where report.submission_id = p_submission_id
      and (
        (
          report.reporter_dedupe_version = p_reporter_dedupe_version
          and report.reporter_dedupe_hash = p_reporter_dedupe_hash
        )
        or identity.discord_user_id = btrim(p_reporter_discord_user_id)
      )
  ) into v_already;

  select count(*) >= 3
  into v_multiple
  from public.submission_reports report
  where report.submission_id = p_submission_id;

  return jsonb_build_object(
    'canReport', v_reportable and not v_already,
    'alreadyReported', v_already,
    'hasMultipleExistingReports', v_multiple,
    'blockedReason', v_blocked_reason
  );
end;
$function$;

alter function public.get_submission_report_eligibility(
  text, integer, text, bigint
) owner to postgres;
revoke all on function public.get_submission_report_eligibility(
  text, integer, text, bigint
) from public, anon, authenticated, discord_bot, service_role;
grant execute on function public.get_submission_report_eligibility(
  text, integer, text, bigint
) to service_role;

create function public.enforce_submission_report_creation_phase()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_cycle_status text;
  v_paused_from_status text;
begin
  select cycle.status::text, cycle.paused_from_status::text
  into v_cycle_status, v_paused_from_status
  from public.voting_cycles cycle
  where cycle.id = new.cycle_id
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'SUBMISSION_REPORT_NOT_REPORTABLE';
  end if;

  if v_cycle_status in ('voting_closed', 'finalizing') then
    raise exception using
      errcode = 'PT409',
      message = 'SUBMISSION_REPORT_PHASE_CLOSED';
  end if;

  if not (
    v_cycle_status in (
      'submission_open',
      'voting_open',
      'active',
      'finished'
    )
    or (
      v_cycle_status = 'paused'
      and v_paused_from_status in ('submission_open', 'voting_open')
    )
  ) then
    raise exception using
      errcode = 'P0002',
      message = 'SUBMISSION_REPORT_NOT_REPORTABLE';
  end if;

  return new;
end;
$function$;

alter function public.enforce_submission_report_creation_phase()
  owner to postgres;
revoke all on function public.enforce_submission_report_creation_phase()
  from public, anon, authenticated, discord_bot, service_role;

create trigger enforce_submission_report_creation_phase
before insert on public.submission_reports
for each row
execute function public.enforce_submission_report_creation_phase();

comment on function public.enforce_submission_report_creation_phase() is
  'Serializes every Submission Report insert against the canonical Cycle row and rejects post-Voting wrapping-up before any report fact can be committed.';

do $postflight$
declare
  v_preflight post_voting_report_lock_preflight%rowtype;
  v_eligibility_definition text;
  v_guard_definition text;
begin
  select * into strict v_preflight
  from post_voting_report_lock_preflight;

  select pg_get_functiondef(
    'public.get_submission_report_eligibility(text,integer,text,bigint)'::regprocedure
  ) into v_eligibility_definition;
  select pg_get_functiondef(
    'public.enforce_submission_report_creation_phase()'::regprocedure
  ) into v_guard_definition;

  if position('cycle_wrapping_up' in v_eligibility_definition) = 0
    or position(
      'v_cycle_status in (''voting_closed'', ''finalizing'')'
      in v_guard_definition
    ) = 0
    or position('for update' in lower(v_guard_definition)) = 0
    or not exists (
      select 1
      from pg_trigger
      where tgrelid = 'public.submission_reports'::regclass
        and tgname = 'enforce_submission_report_creation_phase'
        and tgenabled = 'O'
        and not tgisinternal
    )
    or not exists (
      select 1
      from pg_proc function_row
      where function_row.oid =
        'public.get_submission_report_eligibility(text,integer,text,bigint)'::regprocedure
        and function_row.proowner = 'postgres'::regrole
        and function_row.prosecdef
        and function_row.proconfig = array['search_path=public, pg_temp']
    )
    or not exists (
      select 1
      from pg_proc function_row
      where function_row.oid =
        'public.enforce_submission_report_creation_phase()'::regprocedure
        and function_row.proowner = 'postgres'::regrole
        and function_row.prosecdef
        and function_row.proconfig = array['search_path=public, pg_temp']
    )
    or has_function_privilege(
      'anon',
      'public.get_submission_report_eligibility(text,integer,text,bigint)',
      'EXECUTE'
    )
    or has_function_privilege(
      'authenticated',
      'public.get_submission_report_eligibility(text,integer,text,bigint)',
      'EXECUTE'
    )
    or has_function_privilege(
      'discord_bot',
      'public.get_submission_report_eligibility(text,integer,text,bigint)',
      'EXECUTE'
    )
    or not has_function_privilege(
      'service_role',
      'public.get_submission_report_eligibility(text,integer,text,bigint)',
      'EXECUTE'
    )
    or has_function_privilege(
      'service_role',
      'public.enforce_submission_report_creation_phase()',
      'EXECUTE'
    )
    or (
      select count(*)
      from pg_proc function_row
      join pg_namespace namespace_row
        on namespace_row.oid = function_row.pronamespace
      where namespace_row.nspname = 'public'
        and function_row.proname = 'get_submission_report_eligibility'
    ) <> 1
    or (
      select count(*)
      from pg_proc function_row
      join pg_namespace namespace_row
        on namespace_row.oid = function_row.pronamespace
      where namespace_row.nspname = 'public'
        and function_row.proname = 'enforce_submission_report_creation_phase'
    ) <> 1
    or v_preflight.identity_count <>
      (select count(*) from public.submission_reporter_identities)
    or v_preflight.case_count <>
      (select count(*) from public.submission_report_cases)
    or v_preflight.report_count <>
      (select count(*) from public.submission_reports)
    or v_preflight.payload_count <>
      (select count(*) from public.submission_report_payloads)
    or v_preflight.event_count <>
      (select count(*) from public.submission_report_case_events)
    or v_preflight.request_count <>
      (select count(*) from public.submission_report_requests)
    or v_preflight.read_count <>
      (select count(*) from public.submission_report_reads) then
    raise exception 'POST_VOTING_REPORT_LOCK_POSTFLIGHT_MISMATCH';
  end if;
end;
$postflight$;

commit;
