begin;

set local lock_timeout = '5s';
set local statement_timeout = '45s';

do $preflight$
declare
  v_has_function regprocedure :=
    to_regprocedure('public.has_submission_report_capability_v2(text,text)');
  v_manage_v2 regprocedure := to_regprocedure(
    'public.manage_submission_report_case_v2(text,uuid,text,text,bigint,uuid,text,text,text,uuid)'
  );
begin
  if (select count(*) from public.capability_catalog) <> 38
    or (select count(*) from public.capability_catalog where is_active) <> 34
    or (
      select count(*) from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 34
    or not exists (
      select 1 from public.capability_catalog
      where key = 'submissions.reports.review'
        and is_active and assignable_to_non_admin
        and implementation_version = 3
        and definition_hash = '490f3168bf6cb0b162384ced36e2c3a3156d933d14603eb340255b9242bbdb0a'
    )
    or to_regprocedure(
      'public.manage_submission_report_case_v3(text,uuid,text,text,bigint,uuid,text,text,text,uuid)'
    ) is not null then
    raise exception using errcode = '55000',
      message = 'SUBMISSION_REPORT_OPTIONAL_CLOSE_NOTE_CAPABILITY_MISMATCH';
  end if;

  if v_has_function is null
    or md5(pg_get_functiondef(v_has_function)) <> 'cfad8b6f20df6eb7a77a1a7ce56b5e07'
    or v_manage_v2 is null
    or md5(pg_get_functiondef(v_manage_v2)) <> 'fc1aff72e45b8bade234f1dfa92389ac'
    or (
      select md5(pg_get_constraintdef(oid))
      from pg_constraint
      where conrelid = 'public.submission_report_cases'::regclass
        and conname = 'submission_report_cases_close_note_check'
    ) <> '92f05e981ab316fd96a06dcfb2b665ea'
    or (
      select md5(pg_get_constraintdef(oid))
      from pg_constraint
      where conrelid = 'public.submission_report_cases'::regclass
        and conname = 'submission_report_cases_state_metadata_check'
    ) <> '1dc4d3cc884b2e3f0757ef779e5fd5e6' then
    raise exception using errcode = '55000',
      message = 'SUBMISSION_REPORT_OPTIONAL_CLOSE_NOTE_BASELINE_MISMATCH';
  end if;
end;
$preflight$;

create temp table submission_report_optional_close_note_preflight
on commit drop as
select
  (select count(*) from public.submission_report_cases) as case_count,
  (select count(*) from public.submission_reports) as report_count,
  (select count(*) from public.submission_report_payloads) as payload_count,
  (select count(*) from public.submission_report_case_events) as event_count,
  (select count(*) from public.submission_report_requests) as request_count,
  (select count(*) from public.submission_report_reads) as read_count,
  (select count(*) from public.team_role_capabilities) as grant_count;

update public.capability_catalog
set included_actions = array[
      'Atomically claim an unassigned Case.',
      'Return an owned Case to the open queue without a note, or close an owned Case with an allowlisted outcome and an optional note.',
      'Use expected status, row version, latest Report cursor, and idempotency on every workflow mutation.'
    ]::text[],
    implementation_version = 4,
    definition_hash = '106f2027e9ba597867aa4bafa80871f8432c3c27a3cae980061e09930b5b36e1'
where key = 'submissions.reports.review';

alter table public.submission_report_cases
  drop constraint submission_report_cases_state_metadata_check;

alter table public.submission_report_cases
  add constraint submission_report_cases_state_metadata_check check (
    (status = 'open'
      and closed_at is null
      and close_disposition is null
      and close_note is null)
    or (status = 'in_review'
      and review_started_at is not null
      and closed_at is null
      and close_disposition is null
      and close_note is null)
    or (status = 'closed'
      and review_started_at is not null
      and closed_at is not null
      and close_disposition is not null)
  );

create or replace function public.has_submission_report_capability_v2(
  p_actor_discord_user_id text,
  p_capability_key text
)
returns boolean language plpgsql stable security definer set search_path = public, pg_temp
as $function$
declare
  v_actor_id text := btrim(p_actor_discord_user_id);
  v_hash text;
  v_version integer;
  v_role text;
begin
  v_hash := case p_capability_key
    when 'submissions.reports.live.view' then 'a32d78f7a26954a5465cd1f1ba05e871d0cf62e69721a7fa4cd83353562fa4fa'
    when 'submissions.reports.finalized.view' then '878dc43e7c22ec06a968fd6c7fa069f936688ef5da82db1caf80b7bf9c462a4f'
    when 'logs.submission_reporters.view' then '854f3ddd41413b3223ed220d4f6a86d4f6f14436ce05de6d225dd255e6dc7846'
    when 'logs.submission_report_moderation.view' then '848b90d2b81ec364bd0c122cdd2e31ad68380d0e82d2f921c90467229e8108d7'
    when 'submissions.reports.review' then '106f2027e9ba597867aa4bafa80871f8432c3c27a3cae980061e09930b5b36e1'
    else null
  end;
  v_version := case p_capability_key
    when 'submissions.reports.review' then 4
    else 1
  end;
  if nullif(v_actor_id, '') is null or v_hash is null then return false; end if;
  if not exists (
    select 1 from public.capability_catalog
    where key = p_capability_key and is_active and assignable_to_non_admin
      and implementation_version = v_version and definition_hash = v_hash
  ) then return false; end if;
  select member.role into v_role
  from public.team_members member
  join public.team_roles role on role.key = member.role and role.is_active
  where member.discord_user_id = v_actor_id;
  if not found then return false; end if;
  return v_role = 'admin' or exists (
    select 1 from public.team_role_capabilities
    where role_key = v_role and capability_key = p_capability_key
  );
end;
$function$;

alter function public.has_submission_report_capability_v2(text, text)
  owner to postgres;
revoke all on function public.has_submission_report_capability_v2(text, text)
  from public, anon, authenticated, discord_bot, service_role;

create function public.manage_submission_report_case_v3(
  p_actor_discord_user_id text,
  p_case_id uuid,
  p_operation text,
  p_expected_status text,
  p_expected_row_version bigint,
  p_expected_latest_report_id uuid,
  p_target_discord_user_id text,
  p_disposition text,
  p_note text,
  p_idempotency_key uuid
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $function$
declare
  v_actor_id text := btrim(p_actor_discord_user_id);
  v_target_id text := nullif(btrim(p_target_discord_user_id), '');
  v_operation text := btrim(p_operation);
  v_expected_status text := nullif(btrim(p_expected_status), '');
  v_disposition text := nullif(btrim(p_disposition), '');
  v_note text := nullif(btrim(p_note), '');
  v_area text;
  v_view_capability text;
  v_actor_role text;
  v_actor_display text;
  v_request_payload jsonb;
  v_request_hash text;
  v_existing_hash text;
  v_existing_result jsonb;
  v_case public.submission_report_cases%rowtype;
  v_result jsonb;
  v_now timestamptz := statement_timestamp();
begin
  if v_operation <> 'close' or v_note is not null then
    return public.manage_submission_report_case_v2(
      p_actor_discord_user_id,
      p_case_id,
      p_operation,
      p_expected_status,
      p_expected_row_version,
      p_expected_latest_report_id,
      p_target_discord_user_id,
      p_disposition,
      p_note,
      p_idempotency_key
    );
  end if;

  if nullif(v_actor_id, '') is null
    or p_idempotency_key is null
    or p_case_id is null
    or p_expected_row_version is null
    or p_expected_row_version < 1
    or p_expected_latest_report_id is null
    or v_expected_status is null
    or v_expected_status not in ('open', 'in_review', 'closed')
    or v_target_id is not null
    or v_disposition is null
    or v_disposition not in (
      'action_taken', 'no_action_current_rules', 'insufficient_information',
      'submission_unavailable', 'completed_other'
    ) then
    raise exception using errcode = '22023',
      message = 'SUBMISSION_REPORT_WORKFLOW_INVALID';
  end if;

  v_area := public.submission_report_case_area(p_case_id);
  if v_area is null then
    raise exception using errcode = 'P0002',
      message = 'SUBMISSION_REPORT_CASE_NOT_FOUND';
  end if;
  v_view_capability := case v_area
    when 'live' then 'submissions.reports.live.view'
    else 'submissions.reports.finalized.view'
  end;
  perform public.authorize_submission_report_capability_v2(
    v_actor_id, v_view_capability
  );
  v_actor_role := public.authorize_submission_report_capability_v2(
    v_actor_id, 'submissions.reports.review'
  );

  select coalesce(
    nullif(btrim(current_display_name), ''),
    nullif(btrim(current_guild_nickname), ''),
    nullif(btrim(current_discord_username), ''),
    v_actor_id
  ) into v_actor_display
  from public.user_logs
  where discord_user_id = v_actor_id;
  v_actor_display := coalesce(v_actor_display, v_actor_id);

  v_request_payload := jsonb_build_object(
    'operation', v_operation,
    'version', 4,
    'actor', v_actor_id,
    'caseId', p_case_id,
    'expectedStatus', v_expected_status,
    'expectedRowVersion', p_expected_row_version,
    'expectedLatestReportId', p_expected_latest_report_id,
    'target', v_target_id,
    'disposition', v_disposition,
    'note', v_note
  );
  v_request_hash := encode(
    extensions.digest(
      convert_to(v_request_payload::text, 'UTF8'), 'sha256'
    ),
    'hex'
  );

  perform pg_advisory_xact_lock(
    hashtextextended(p_idempotency_key::text, 0)
  );
  select request_hash, result
    into v_existing_hash, v_existing_result
  from public.submission_report_requests
  where idempotency_key = p_idempotency_key;
  if found then
    if v_existing_hash = v_request_hash then
      return jsonb_set(v_existing_result, '{replayed}', 'true'::jsonb);
    end if;
    raise exception using errcode = 'PT409',
      message = 'SUBMISSION_REPORT_IDEMPOTENCY_CONFLICT';
  end if;

  select * into v_case
  from public.submission_report_cases
  where case_id = p_case_id
  for update;
  if not found then
    raise exception using errcode = 'P0002',
      message = 'SUBMISSION_REPORT_CASE_NOT_FOUND';
  end if;
  if v_case.status <> v_expected_status
    or v_case.row_version <> p_expected_row_version
    or v_case.latest_report_id <> p_expected_latest_report_id then
    raise exception using errcode = 'PT409', message = 'SUBMISSION_REPORT_STALE';
  end if;
  if v_case.status <> 'in_review'
    or v_case.assigned_to_discord_user_id is distinct from v_actor_id then
    raise exception using errcode = '42501',
      message = 'SUBMISSION_REPORT_NOT_ASSIGNEE';
  end if;

  update public.submission_report_cases
  set status = 'closed',
      row_version = row_version + 1,
      assigned_to_discord_user_id = null,
      assigned_to_display_name = null,
      assigned_at = null,
      reviewed_through_report_id = latest_report_id,
      reviewed_through_report_at = latest_report_at,
      closed_at = v_now,
      closed_by_discord_user_id = v_actor_id,
      closed_by_display_name = v_actor_display,
      close_disposition = v_disposition,
      close_note = null,
      updated_at = v_now
  where case_id = p_case_id;

  insert into public.submission_report_case_events(
    case_id,
    event_type,
    previous_status,
    new_status,
    actor_kind,
    actor_discord_user_id,
    actor_display_name,
    actor_role_key,
    authorization_capability_key,
    occurred_at,
    disposition,
    note,
    case_version,
    report_cursor_at,
    report_cursor_id,
    previous_assignee_discord_user_id,
    previous_assignee_display_name,
    new_assignee_discord_user_id,
    new_assignee_display_name
  ) values (
    p_case_id,
    'case_closed',
    v_case.status,
    'closed',
    case when v_actor_role = 'admin' then 'admin' else 'team' end,
    v_actor_id,
    v_actor_display,
    v_actor_role,
    'submissions.reports.review',
    v_now,
    v_disposition,
    null,
    v_case.row_version + 1,
    v_case.latest_report_at,
    v_case.latest_report_id,
    v_case.assigned_to_discord_user_id,
    v_case.assigned_to_display_name,
    null,
    null
  );

  update public.submission_report_payloads payload
  set retention_due_at = v_now + interval '24 months'
  where exists (
    select 1
    from public.submission_reports report
    where report.report_id = payload.report_id
      and report.case_id = p_case_id
  )
    and payload.anonymized_at is null;

  v_result := jsonb_build_object(
    'caseId', p_case_id,
    'status', 'closed',
    'rowVersion', v_case.row_version + 1,
    'latestReportId', v_case.latest_report_id,
    'assignedToDiscordUserId', null,
    'replayed', false
  );
  insert into public.submission_report_requests(
    idempotency_key, operation, request_hash, result
  ) values (
    p_idempotency_key, v_operation, v_request_hash, v_result
  );
  return v_result;
end;
$function$;

alter function public.manage_submission_report_case_v3(
  text, uuid, text, text, bigint, uuid, text, text, text, uuid
) owner to postgres;
revoke all on function public.manage_submission_report_case_v3(
  text, uuid, text, text, bigint, uuid, text, text, text, uuid
) from public, anon, authenticated, discord_bot, service_role;
grant execute on function public.manage_submission_report_case_v3(
  text, uuid, text, text, bigint, uuid, text, text, text, uuid
) to service_role;

do $postflight$
declare
  v_preflight submission_report_optional_close_note_preflight%rowtype;
  v_has_function regprocedure :=
    'public.has_submission_report_capability_v2(text,text)'::regprocedure;
  v_manage_v3 regprocedure :=
    'public.manage_submission_report_case_v3(text,uuid,text,text,bigint,uuid,text,text,text,uuid)'::regprocedure;
  v_has_definition text := lower(pg_get_functiondef(v_has_function));
  v_manage_definition text := lower(pg_get_functiondef(v_manage_v3));
  v_state_definition text;
begin
  select * into strict v_preflight
  from submission_report_optional_close_note_preflight;
  select lower(pg_get_constraintdef(oid)) into strict v_state_definition
  from pg_constraint
  where conrelid = 'public.submission_report_cases'::regclass
    and conname = 'submission_report_cases_state_metadata_check';

  if (select count(*) from public.capability_catalog) <> 38
    or (select count(*) from public.capability_catalog where is_active) <> 34
    or (
      select count(*) from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 34
    or not exists (
      select 1 from public.capability_catalog
      where key = 'submissions.reports.review'
        and is_active and assignable_to_non_admin
        and implementation_version = 4
        and definition_hash = '106f2027e9ba597867aa4bafa80871f8432c3c27a3cae980061e09930b5b36e1'
    ) then
    raise exception using errcode = '55000',
      message = 'SUBMISSION_REPORT_OPTIONAL_CLOSE_NOTE_CATALOG_POSTFLIGHT_MISMATCH';
  end if;

  if v_has_definition not like '%when ''submissions.reports.review'' then ''106f2027e9ba597867aa4bafa80871f8432c3c27a3cae980061e09930b5b36e1''%'
    or v_has_definition not like '%when ''submissions.reports.review'' then 4%'
    or v_manage_definition not like '%return public.manage_submission_report_case_v2(%'
    or v_manage_definition not like '%close_note = null%'
    or v_manage_definition not like '%''version'', 4%'
    or v_state_definition like '%(close_note is not null)%'
    or md5((
      select pg_get_constraintdef(oid)
      from pg_constraint
      where conrelid = 'public.submission_report_cases'::regclass
        and conname = 'submission_report_cases_close_note_check'
    )) <> '92f05e981ab316fd96a06dcfb2b665ea'
    or not (
      select function_row.prosecdef
        and function_row.proowner = (
          select oid from pg_roles where rolname = 'postgres'
        )
        and function_row.proconfig = array['search_path=public, pg_temp']
      from pg_proc function_row
      where function_row.oid = v_manage_v3
    )
    or not has_function_privilege('service_role', v_manage_v3, 'EXECUTE')
    or has_function_privilege('anon', v_manage_v3, 'EXECUTE')
    or has_function_privilege('authenticated', v_manage_v3, 'EXECUTE')
    or has_function_privilege('discord_bot', v_manage_v3, 'EXECUTE') then
    raise exception using errcode = '55000',
      message = 'SUBMISSION_REPORT_OPTIONAL_CLOSE_NOTE_FUNCTION_POSTFLIGHT_MISMATCH';
  end if;

  if v_preflight.case_count <> (select count(*) from public.submission_report_cases)
    or v_preflight.report_count <> (select count(*) from public.submission_reports)
    or v_preflight.payload_count <> (select count(*) from public.submission_report_payloads)
    or v_preflight.event_count <> (select count(*) from public.submission_report_case_events)
    or v_preflight.request_count <> (select count(*) from public.submission_report_requests)
    or v_preflight.read_count <> (select count(*) from public.submission_report_reads)
    or v_preflight.grant_count <> (select count(*) from public.team_role_capabilities) then
    raise exception using errcode = '55000',
      message = 'SUBMISSION_REPORT_OPTIONAL_CLOSE_NOTE_DATA_POSTFLIGHT_MISMATCH';
  end if;
end;
$postflight$;

comment on function public.has_submission_report_capability_v2(text, text)
  is 'Fail-closed exact Submission Report capability authorization for the V4 review workflow; the legacy assign tombstone is never authorizing.';

comment on function public.manage_submission_report_case_v3(
  text, uuid, text, text, bigint, uuid, text, text, text, uuid
) is 'V4 Submission Report workflow entry point: Close notes are optional, while Admin override reasons remain required through the hardened V2 path.';

commit;
