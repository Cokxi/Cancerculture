begin;

do $preflight$
declare
  v_manage_function regprocedure := to_regprocedure(
    'public.manage_submission_report_case_v2(text,uuid,text,text,bigint,uuid,text,text,text,uuid)'
  );
  v_targets_function regprocedure := to_regprocedure(
    'public.list_submission_report_assignment_targets_v2(text,uuid)'
  );
begin
  if (select count(*) from public.capability_catalog) <> 38
    or (select count(*) from public.capability_catalog where is_active) <> 35
    or (
      select count(*) from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 35
    or not exists (
      select 1 from public.capability_catalog
      where key = 'submissions.reports.review'
        and is_active and assignable_to_non_admin
        and implementation_version = 2
        and definition_hash = '6bcece6a9daf17fe71f5136d6d209ab283a0489c09146fa7b4f614f2b26b7153'
    )
    or not exists (
      select 1 from public.capability_catalog
      where key = 'submissions.reports.assign'
        and is_active and assignable_to_non_admin
        and implementation_version = 1
        and definition_hash = 'cf3c1396e1e602aeaa628807427d219a93f3e06bef1f43971e9a61225d74ebe7'
    )
    or exists (
      select 1 from public.team_role_capabilities
      where capability_key = 'submissions.reports.assign'
    ) then
    raise exception using errcode = '55000',
      message = 'SUBMISSION_REPORT_RELEASE_SIMPLIFICATION_CAPABILITY_MISMATCH';
  end if;

  if v_manage_function is null
    or md5(pg_get_functiondef(v_manage_function)) <> '0f388a0f21be41033cbf4e18311a8e29'
    or v_targets_function is null
    or md5(pg_get_functiondef(v_targets_function)) <> '6a453413e69adcb33b62977aaacf655f'
    or md5(pg_get_functiondef(
      'public.list_submission_report_cases_v2(text,text,integer)'::regprocedure
    )) <> '9588d2d2463be9702a3611fa51dc302b'
    or md5(pg_get_functiondef(
      'public.get_submission_report_unread_counts_v2(text)'::regprocedure
    )) <> '162bdd7333873221782bb3eef932e2ff' then
    raise exception using errcode = '55000',
      message = 'SUBMISSION_REPORT_RELEASE_SIMPLIFICATION_BASELINE_MISMATCH';
  end if;
end;
$preflight$;

create temp table submission_report_release_simplification_preflight
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
set description =
      'Claim, voluntarily return, and close Submission Report Cases under the exact current-area View capability while Admin override release remains owner-only.',
    included_actions = array[
      'Atomically claim an unassigned Case.',
      'Return an owned Case to the open queue without a note, or close an owned Case with an allowlisted outcome and required note.',
      'Use expected status, row version, latest Report cursor, and idempotency on every workflow mutation.'
    ]::text[],
    excluded_actions = array[
      'Reading any Report queue or detail without the exact current-area View capability.',
      'Force-releasing another reviewer''s active claim; this remains Admin-only and is not delegable.',
      'Disqualifying, reinstating, hiding, deleting, banning, or otherwise sanctioning users or Submissions.'
    ]::text[],
    implementation_version = 3,
    definition_hash = '490f3168bf6cb0b162384ced36e2c3a3156d933d14603eb340255b9242bbdb0a'
where key = 'submissions.reports.review';

update public.capability_catalog
set display_name = 'Reassign Submission Report Cases (Legacy)',
    description =
      'Legacy direct reassignment and delegated force-release permission retained only as a deprecated tombstone.',
    included_actions = array['No active application actions.']::text[],
    excluded_actions = array[
      'Directly reassigning an actively claimed Report Case.',
      'Force-releasing another reviewer''s active claim; Admin-only override release uses the canonical owner context.',
      'Claiming, voluntarily returning, reviewing, or closing Report Cases.'
    ]::text[],
    risk_level = 'high',
    assignable_to_non_admin = false,
    is_active = false,
    implementation_version = 2,
    definition_hash = '7e8c8683353d35f1bc817a2967c64ff934cc1a905db8ab9beaf1a693713b3ea6',
    deprecated_at = transaction_timestamp()
where key = 'submissions.reports.assign';

create or replace function public.manage_submission_report_case_v2(
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
  v_new_status text;
  v_event_type text;
  v_result jsonb;
  v_now timestamptz := statement_timestamp();
begin
  if nullif(v_actor_id, '') is null
    or p_idempotency_key is null or p_case_id is null
    or p_expected_row_version is null or p_expected_row_version < 1
    or p_expected_latest_report_id is null
    or v_expected_status is null
    or v_expected_status not in ('open', 'in_review', 'closed')
    or nullif(v_operation, '') is null
    or v_operation not in ('claim', 'release', 'forced_release', 'close')
    or (v_operation in ('forced_release', 'close')
      and (v_note is null or char_length(v_note) not between 10 and 1000))
    or (v_operation in ('claim', 'release') and v_note is not null)
    or v_target_id is not null
    or (v_operation = 'close' and (
      v_disposition is null or v_disposition not in (
        'action_taken', 'no_action_current_rules', 'insufficient_information',
        'submission_unavailable', 'completed_other'
      )
    ))
    or (v_operation <> 'close' and v_disposition is not null) then
    raise exception using errcode = '22023', message = 'SUBMISSION_REPORT_WORKFLOW_INVALID';
  end if;

  v_area := public.submission_report_case_area(p_case_id);
  if v_area is null then
    raise exception using errcode = 'P0002', message = 'SUBMISSION_REPORT_CASE_NOT_FOUND';
  end if;
  v_view_capability := case v_area when 'live' then 'submissions.reports.live.view'
    else 'submissions.reports.finalized.view' end;
  perform public.authorize_submission_report_capability_v2(v_actor_id, v_view_capability);
  v_actor_role := public.authorize_submission_report_capability_v2(
    v_actor_id, 'submissions.reports.review'
  );
  if v_operation = 'forced_release' and v_actor_role <> 'admin' then
    raise exception using errcode = '42501',
      message = 'SUBMISSION_REPORT_ADMIN_OVERRIDE_REQUIRED';
  end if;
  select coalesce(
    nullif(btrim(current_display_name), ''),
    nullif(btrim(current_guild_nickname), ''),
    nullif(btrim(current_discord_username), ''),
    v_actor_id
  ) into v_actor_display
  from public.user_logs where discord_user_id = v_actor_id;
  v_actor_display := coalesce(v_actor_display, v_actor_id);

  v_request_payload := jsonb_build_object(
    'operation', v_operation, 'version', 3, 'actor', v_actor_id,
    'caseId', p_case_id, 'expectedStatus', v_expected_status,
    'expectedRowVersion', p_expected_row_version,
    'expectedLatestReportId', p_expected_latest_report_id,
    'target', v_target_id, 'disposition', v_disposition, 'note', v_note
  );
  v_request_hash := encode(
    extensions.digest(convert_to(v_request_payload::text, 'UTF8'), 'sha256'), 'hex'
  );
  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  select request_hash, result into v_existing_hash, v_existing_result
  from public.submission_report_requests where idempotency_key = p_idempotency_key;
  if found then
    if v_existing_hash = v_request_hash then
      return jsonb_set(v_existing_result, '{replayed}', 'true'::jsonb);
    end if;
    raise exception using errcode = 'PT409',
      message = 'SUBMISSION_REPORT_IDEMPOTENCY_CONFLICT';
  end if;

  select * into v_case from public.submission_report_cases
  where case_id = p_case_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'SUBMISSION_REPORT_CASE_NOT_FOUND';
  end if;
  if v_case.status <> v_expected_status
    or v_case.row_version <> p_expected_row_version
    or v_case.latest_report_id <> p_expected_latest_report_id then
    raise exception using errcode = 'PT409', message = 'SUBMISSION_REPORT_STALE';
  end if;

  if v_operation = 'claim' then
    if v_case.status <> 'open' or v_case.assigned_to_discord_user_id is not null then
      raise exception using errcode = 'PT409', message = 'SUBMISSION_REPORT_CLAIM_CONFLICT';
    end if;
    v_new_status := 'in_review';
    v_event_type := 'case_claimed';
  elsif v_operation = 'release' then
    if v_case.status <> 'in_review'
      or v_case.assigned_to_discord_user_id is distinct from v_actor_id then
      raise exception using errcode = '42501', message = 'SUBMISSION_REPORT_NOT_ASSIGNEE';
    end if;
    v_new_status := 'open';
    v_event_type := 'case_released';
  elsif v_operation = 'forced_release' then
    if v_case.status <> 'in_review' or v_case.assigned_to_discord_user_id is null then
      raise exception using errcode = 'PT409', message = 'SUBMISSION_REPORT_RELEASE_CONFLICT';
    end if;
    if v_case.assigned_to_discord_user_id = v_actor_id then
      raise exception using errcode = '22023',
        message = 'SUBMISSION_REPORT_USE_VOLUNTARY_RELEASE';
    end if;
    v_new_status := 'open';
    v_event_type := 'case_forced_released';
  else
    if v_case.status <> 'in_review'
      or v_case.assigned_to_discord_user_id is distinct from v_actor_id then
      raise exception using errcode = '42501', message = 'SUBMISSION_REPORT_NOT_ASSIGNEE';
    end if;
    v_new_status := 'closed';
    v_event_type := 'case_closed';
  end if;

  update public.submission_report_cases set
    status = v_new_status,
    row_version = row_version + 1,
    assigned_to_discord_user_id = case when v_operation = 'claim'
      then v_actor_id else null end,
    assigned_to_display_name = case when v_operation = 'claim'
      then v_actor_display else null end,
    assigned_at = case when v_operation = 'claim' then v_now else null end,
    review_started_at = case
      when v_operation = 'claim' then v_now
      when v_operation in ('release', 'forced_release') then null
      else review_started_at end,
    review_started_by_discord_user_id = case
      when v_operation = 'claim' then v_actor_id
      when v_operation in ('release', 'forced_release') then null
      else review_started_by_discord_user_id end,
    review_started_by_display_name = case
      when v_operation = 'claim' then v_actor_display
      when v_operation in ('release', 'forced_release') then null
      else review_started_by_display_name end,
    reviewed_through_report_id = case when v_operation = 'close'
      then latest_report_id else reviewed_through_report_id end,
    reviewed_through_report_at = case when v_operation = 'close'
      then latest_report_at else reviewed_through_report_at end,
    closed_at = case when v_operation = 'close' then v_now else null end,
    closed_by_discord_user_id = case when v_operation = 'close' then v_actor_id else null end,
    closed_by_display_name = case when v_operation = 'close' then v_actor_display else null end,
    close_disposition = case when v_operation = 'close' then v_disposition else null end,
    close_note = case when v_operation = 'close' then v_note else null end,
    updated_at = v_now
  where case_id = p_case_id;

  insert into public.submission_report_case_events(
    case_id, event_type, previous_status, new_status, actor_kind,
    actor_discord_user_id, actor_display_name, actor_role_key,
    authorization_capability_key, occurred_at, disposition, note,
    case_version, report_cursor_at, report_cursor_id,
    previous_assignee_discord_user_id, previous_assignee_display_name,
    new_assignee_discord_user_id, new_assignee_display_name
  ) values (
    p_case_id, v_event_type, v_case.status, v_new_status,
    case when v_actor_role = 'admin' then 'admin' else 'team' end,
    v_actor_id, v_actor_display, v_actor_role,
    'submissions.reports.review',
    v_now, v_disposition, v_note, v_case.row_version + 1,
    v_case.latest_report_at, v_case.latest_report_id,
    v_case.assigned_to_discord_user_id, v_case.assigned_to_display_name,
    case when v_operation = 'claim' then v_actor_id else null end,
    case when v_operation = 'claim' then v_actor_display else null end
  );

  if v_operation = 'close' then
    update public.submission_report_payloads payload
    set retention_due_at = v_now + interval '24 months'
    where exists (
      select 1 from public.submission_reports report
      where report.report_id = payload.report_id and report.case_id = p_case_id
    ) and payload.anonymized_at is null;
  end if;

  v_result := jsonb_build_object(
    'caseId', p_case_id, 'status', v_new_status,
    'rowVersion', v_case.row_version + 1,
    'latestReportId', v_case.latest_report_id,
    'assignedToDiscordUserId', case when v_operation = 'claim'
      then v_actor_id else null end,
    'replayed', false
  );
  insert into public.submission_report_requests(
    idempotency_key, operation, request_hash, result
  ) values (p_idempotency_key, v_operation, v_request_hash, v_result);
  return v_result;
end;
$function$;

alter function public.manage_submission_report_case_v2(
  text, uuid, text, text, bigint, uuid, text, text, text, uuid
) owner to postgres;
revoke all on function public.manage_submission_report_case_v2(
  text, uuid, text, text, bigint, uuid, text, text, text, uuid
) from public;
revoke execute on function public.manage_submission_report_case_v2(
  text, uuid, text, text, bigint, uuid, text, text, text, uuid
) from anon, authenticated, discord_bot;
grant execute on function public.manage_submission_report_case_v2(
  text, uuid, text, text, bigint, uuid, text, text, text, uuid
) to service_role;

revoke execute on function public.list_submission_report_assignment_targets_v2(
  text, uuid
) from service_role;

do $postflight$
declare
  v_preflight submission_report_release_simplification_preflight%rowtype;
  v_manage_function regprocedure :=
    'public.manage_submission_report_case_v2(text,uuid,text,text,bigint,uuid,text,text,text,uuid)'::regprocedure;
  v_targets_function regprocedure :=
    'public.list_submission_report_assignment_targets_v2(text,uuid)'::regprocedure;
  v_definition text := lower(pg_get_functiondef(v_manage_function));
begin
  select * into strict v_preflight
  from submission_report_release_simplification_preflight;

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
    or not exists (
      select 1 from public.capability_catalog
      where key = 'submissions.reports.assign'
        and not is_active and not assignable_to_non_admin
        and implementation_version = 2
        and definition_hash = '7e8c8683353d35f1bc817a2967c64ff934cc1a905db8ab9beaf1a693713b3ea6'
        and deprecated_at is not null
    )
    or exists (
      select 1 from public.team_role_capabilities
      where capability_key = 'submissions.reports.assign'
    ) then
    raise exception using errcode = '55000',
      message = 'SUBMISSION_REPORT_RELEASE_SIMPLIFICATION_CATALOG_POSTFLIGHT_MISMATCH';
  end if;

  if v_definition not like '%''claim'', ''release'', ''forced_release'', ''close''%'
    or v_definition like '%recover_claim%'
    or v_definition like '%''reassign''%'
    or v_definition like '%submissions.reports.assign%'
    or v_definition not like '%v_actor_role <> ''admin''%'
    or not (
      select function_row.prosecdef
        and function_row.proowner = (select oid from pg_roles where rolname = 'postgres')
        and function_row.proconfig = array['search_path=public, pg_temp']
      from pg_proc function_row where function_row.oid = v_manage_function
    )
    or (
      select count(*) from pg_proc function_row
      cross join lateral aclexplode(
        coalesce(function_row.proacl, acldefault('f', function_row.proowner))
      ) privilege_row
      where function_row.oid = v_manage_function
        and privilege_row.privilege_type = 'EXECUTE'
    ) <> 2
    or not has_function_privilege('service_role', v_manage_function, 'EXECUTE')
    or has_function_privilege('anon', v_manage_function, 'EXECUTE')
    or has_function_privilege('authenticated', v_manage_function, 'EXECUTE')
    or has_function_privilege('discord_bot', v_manage_function, 'EXECUTE')
    or has_function_privilege('service_role', v_targets_function, 'EXECUTE')
    or has_function_privilege('anon', v_targets_function, 'EXECUTE')
    or has_function_privilege('authenticated', v_targets_function, 'EXECUTE')
    or has_function_privilege('discord_bot', v_targets_function, 'EXECUTE') then
    raise exception using errcode = '55000',
      message = 'SUBMISSION_REPORT_RELEASE_SIMPLIFICATION_FUNCTION_POSTFLIGHT_MISMATCH';
  end if;

  if v_preflight.case_count <> (select count(*) from public.submission_report_cases)
    or v_preflight.report_count <> (select count(*) from public.submission_reports)
    or v_preflight.payload_count <> (select count(*) from public.submission_report_payloads)
    or v_preflight.event_count <> (select count(*) from public.submission_report_case_events)
    or v_preflight.request_count <> (select count(*) from public.submission_report_requests)
    or v_preflight.read_count <> (select count(*) from public.submission_report_reads)
    or v_preflight.grant_count <> (select count(*) from public.team_role_capabilities) then
    raise exception using errcode = '55000',
      message = 'SUBMISSION_REPORT_RELEASE_SIMPLIFICATION_DATA_POSTFLIGHT_MISMATCH';
  end if;
end;
$postflight$;

comment on function public.manage_submission_report_case_v2(
  text, uuid, text, text, bigint, uuid, text, text, text, uuid
) is 'Atomic Claim, note-free assignee Return to queue, Admin-only override release with required reason, and assignee-only Close. Direct reassignment and non-Admin recovery are rejected.';
comment on function public.list_submission_report_assignment_targets_v2(text, uuid)
  is 'Deprecated owner-only historical helper. Direct Case reassignment is no longer an application operation.';

commit;
