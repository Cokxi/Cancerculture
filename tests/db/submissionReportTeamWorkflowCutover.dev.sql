\set ON_ERROR_STOP on

begin;

do $test$
declare
  v_cycle_id bigint;
  v_submission_id bigint;
  v_created jsonb;
  v_case_id uuid;
  v_report_id uuid;
  v_case public.submission_report_cases%rowtype;
  v_page jsonb;
  v_target_page jsonb;
  v_summary jsonb;
  v_claim jsonb;
  v_release jsonb;
  v_forced_release jsonb;
  v_final_claim jsonb;
  v_close jsonb;
  v_admin_log jsonb;
  v_delegated_log jsonb;
  v_unread_before integer;
  v_unread_after integer;
  v_forbidden_accepted boolean := false;
  v_reassign_accepted boolean := false;
  v_recover_accepted boolean := false;
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
    or not exists (
      select 1 from public.capability_catalog
      where key = 'submissions.reports.assign'
        and not is_active and not assignable_to_non_admin
        and implementation_version = 2
        and definition_hash = '7e8c8683353d35f1bc817a2967c64ff934cc1a905db8ab9beaf1a693713b3ea6'
    )
    or exists (
      select 1 from public.team_role_capabilities
      where capability_key in (
        'submissions.reports.view',
        'submissions.reports.review',
        'submissions.reports.live.view',
        'submissions.reports.finalized.view',
        'submissions.reports.assign',
        'logs.submission_reporters.view',
        'logs.submission_report_moderation.view'
      )
    ) then
    raise exception 'SUBMISSION_REPORT_TEAM_CUTOVER_DEV_BASELINE_MISMATCH';
  end if;

  if has_function_privilege(
      'service_role', 'public.list_submission_report_cases(text,integer)', 'EXECUTE'
    ) or has_function_privilege(
      'service_role', 'public.get_submission_report_case(text,uuid)', 'EXECUTE'
    ) or has_function_privilege(
      'service_role',
      'public.review_submission_report_case(text,uuid,text,text,bigint,uuid,text,text,uuid)',
      'EXECUTE'
    ) or not has_function_privilege(
      'service_role',
      'public.list_submission_report_moderation_events_v2(text,timestamptz,uuid,integer)',
      'EXECUTE'
    ) or has_function_privilege(
      'service_role',
      'public.list_submission_report_assignment_targets_v2(text,uuid)',
      'EXECUTE'
    ) then
    raise exception 'SUBMISSION_REPORT_TEAM_CUTOVER_DEV_ACL_MISMATCH';
  end if;

  if exists (
      select 1 from public.user_logs
      where discord_user_id like 'report-cutover-test-%'
    ) or exists (
      select 1 from public.team_roles where key = 'report_cutover_log_reader'
    ) then
    raise exception 'SUBMISSION_REPORT_TEAM_CUTOVER_DEV_SYNTHETIC_COLLISION';
  end if;

  insert into public.user_logs(discord_user_id, current_discord_username)
  values
    ('report-cutover-test-admin', 'report-cutover-test-admin'),
    ('report-cutover-test-target', 'report-cutover-test-target'),
    ('report-cutover-test-log-reader', 'report-cutover-test-log-reader'),
    ('report-cutover-test-subject', 'report-cutover-test-subject'),
    ('report-cutover-test-reporter', 'report-cutover-test-reporter');

  insert into public.team_roles(
    key, display_name, description, is_system, is_active, sort_order
  ) values (
    'report_cutover_log_reader',
    'Rollback Report Log Reader',
    'Rollback-only exact Submission Report workflow log reader.',
    false,
    true,
    9800
  );

  insert into public.team_role_capabilities(
    role_key, capability_key, grant_reason
  )
  values (
    'report_cutover_log_reader',
    'logs.submission_report_moderation.view',
    'Rollback-only delegated redaction contract.'
  );

  insert into public.team_members(discord_user_id, role, discord_username)
  values
    ('report-cutover-test-admin', 'admin', 'report-cutover-test-admin'),
    ('report-cutover-test-target', 'admin', 'report-cutover-test-target'),
    (
      'report-cutover-test-log-reader',
      'report_cutover_log_reader',
      'report-cutover-test-log-reader'
    );

  insert into public.voting_cycles(status, theme, title)
  values ('finished', 'Report cutover test', 'Report cutover test')
  returning id into v_cycle_id;

  insert into public.submissions(
    cycle_id, discord_user_id, r2_key, public_visibility_status
  ) values (
    v_cycle_id,
    'report-cutover-test-subject',
    v_cycle_id::text || '/00000000-0000-4000-8000-000000000010.webp',
    'visible'
  ) returning id into v_submission_id;

  v_created := public.create_submission_report_v2(
    'report-cutover-test-reporter', 1, repeat('a', 64), v_submission_id, 2,
    'rights_or_ownership', 'copyright_or_unlicensed_use',
    'Rollback-only cutover workflow contract context.',
    '91000000-0000-4000-8000-000000000001'::uuid
  );
  v_case_id := (v_created ->> 'caseId')::uuid;
  v_report_id := (v_created ->> 'reportId')::uuid;

  v_page := public.list_submission_report_cases_v2(
    'report-cutover-test-admin', 'finalized', 50
  );
  if not exists (
      select 1 from jsonb_array_elements(v_page) item
      where (item ->> 'caseId')::uuid = v_case_id
        and (item ->> 'unreadReportCount')::integer = 1
    ) then
    raise exception 'SUBMISSION_REPORT_TEAM_CUTOVER_DEV_QUEUE_MISMATCH';
  end if;

  v_target_page := public.list_submission_report_cases_v2(
    'report-cutover-test-target', 'finalized', 50
  );
  if not exists (
      select 1 from jsonb_array_elements(v_target_page) item
      where (item ->> 'caseId')::uuid = v_case_id
        and (item ->> 'unreadReportCount')::integer = 1
    ) then
    raise exception 'SUBMISSION_REPORT_TEAM_CUTOVER_DEV_TARGET_QUEUE_MISMATCH';
  end if;
  v_unread_before := (
    public.get_submission_report_unread_counts_v2(
      'report-cutover-test-target'
    ) ->> 'finalized'
  )::integer;

  v_summary := public.get_submission_report_case_summary_v2(
    'report-cutover-test-admin', v_case_id
  );
  if exists (
      select 1 from public.submission_report_reads
      where viewer_discord_user_id = 'report-cutover-test-admin'
        and report_id = v_report_id
    ) or v_summary ? 'events' or v_summary ? 'closeNote' then
    raise exception 'SUBMISSION_REPORT_TEAM_CUTOVER_DEV_SUMMARY_READ_MISMATCH';
  end if;

  perform public.get_submission_report_detail_v2(
    'report-cutover-test-admin', v_report_id
  );
  perform public.get_submission_report_detail_v2(
    'report-cutover-test-admin', v_report_id
  );
  if (
      select count(*) from public.submission_report_reads
      where viewer_discord_user_id = 'report-cutover-test-admin'
        and report_id = v_report_id
    ) <> 1 then
    raise exception 'SUBMISSION_REPORT_TEAM_CUTOVER_DEV_READ_RECEIPT_MISMATCH';
  end if;

  select * into strict v_case from public.submission_report_cases
  where case_id = v_case_id;
  v_claim := public.manage_submission_report_case_v2(
    'report-cutover-test-admin', v_case_id, 'claim', v_case.status,
    v_case.row_version, v_case.latest_report_id, null, null, null,
    '91000000-0000-4000-8000-000000000002'::uuid
  );

  select * into strict v_case from public.submission_report_cases
  where case_id = v_case_id;
  v_release := public.manage_submission_report_case_v2(
    'report-cutover-test-admin', v_case_id, 'release', v_case.status,
    v_case.row_version, v_case.latest_report_id, null, null, null,
    '91000000-0000-4000-8000-000000000003'::uuid
  );
  if v_release ->> 'status' <> 'open'
    or v_release ->> 'assignedToDiscordUserId' is not null
    or not exists (
      select 1 from public.submission_report_case_events
      where case_id = v_case_id and event_type = 'case_released'
        and actor_discord_user_id = 'report-cutover-test-admin'
        and note is null
    ) then
    raise exception 'SUBMISSION_REPORT_TEAM_CUTOVER_DEV_VOLUNTARY_RELEASE_MISMATCH';
  end if;

  select * into strict v_case from public.submission_report_cases
  where case_id = v_case_id;
  v_claim := public.manage_submission_report_case_v2(
    'report-cutover-test-admin', v_case_id, 'claim', v_case.status,
    v_case.row_version, v_case.latest_report_id, null, null, null,
    '91000000-0000-4000-8000-000000000004'::uuid
  );

  select * into strict v_case from public.submission_report_cases
  where case_id = v_case_id;
  v_forced_release := public.manage_submission_report_case_v2(
    'report-cutover-test-target', v_case_id, 'forced_release', v_case.status,
    v_case.row_version, v_case.latest_report_id, null, null,
    'Admin override because the original reviewer is unavailable.',
    '91000000-0000-4000-8000-000000000005'::uuid
  );
  if v_forced_release ->> 'status' <> 'open'
    or v_forced_release ->> 'assignedToDiscordUserId' is not null
    or not exists (
      select 1 from public.submission_report_case_events
      where case_id = v_case_id and event_type = 'case_forced_released'
        and actor_discord_user_id = 'report-cutover-test-target'
        and note = 'Admin override because the original reviewer is unavailable.'
    ) then
    raise exception 'SUBMISSION_REPORT_TEAM_CUTOVER_DEV_ADMIN_OVERRIDE_MISMATCH';
  end if;

  select * into strict v_case from public.submission_report_cases
  where case_id = v_case_id;
  begin
    perform public.manage_submission_report_case_v2(
      'report-cutover-test-admin', v_case_id, 'reassign', v_case.status,
      v_case.row_version, v_case.latest_report_id,
      'report-cutover-test-target', null, 'Legacy reassignment must fail.',
      '91000000-0000-4000-8000-000000000006'::uuid
    );
    v_reassign_accepted := true;
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.manage_submission_report_case_v2(
      'report-cutover-test-admin', v_case_id, 'recover_claim', v_case.status,
      v_case.row_version, v_case.latest_report_id, null, null,
      'Legacy recovery must fail.',
      '91000000-0000-4000-8000-000000000007'::uuid
    );
    v_recover_accepted := true;
  exception when sqlstate '22023' then null;
  end;
  if v_reassign_accepted or v_recover_accepted then
    raise exception 'SUBMISSION_REPORT_TEAM_CUTOVER_DEV_LEGACY_OPERATION_ACCEPTED';
  end if;

  select * into strict v_case from public.submission_report_cases
  where case_id = v_case_id;
  v_final_claim := public.manage_submission_report_case_v2(
    'report-cutover-test-target', v_case_id, 'claim', v_case.status,
    v_case.row_version, v_case.latest_report_id, null, null, null,
    '91000000-0000-4000-8000-000000000008'::uuid
  );

  select * into strict v_case from public.submission_report_cases
  where case_id = v_case_id;
  v_close := public.manage_submission_report_case_v2(
    'report-cutover-test-target', v_case_id, 'close', v_case.status,
    v_case.row_version, v_case.latest_report_id, null,
    'no_action_current_rules',
    'Reviewed under current rules in a rollback-only cutover test.',
    '91000000-0000-4000-8000-000000000009'::uuid
  );
  if v_claim ->> 'status' <> 'in_review'
    or v_final_claim ->> 'assignedToDiscordUserId' <> 'report-cutover-test-target'
    or v_close ->> 'status' <> 'closed' then
    raise exception 'SUBMISSION_REPORT_TEAM_CUTOVER_DEV_WORKFLOW_MISMATCH';
  end if;

  v_target_page := public.list_submission_report_cases_v2(
    'report-cutover-test-target', 'finalized', 50
  );
  if exists (
      select 1 from jsonb_array_elements(v_target_page) item
      where (item ->> 'caseId')::uuid = v_case_id
    ) then
    raise exception 'SUBMISSION_REPORT_TEAM_CUTOVER_DEV_CLOSED_QUEUE_VISIBLE';
  end if;
  v_unread_after := (
    public.get_submission_report_unread_counts_v2(
      'report-cutover-test-target'
    ) ->> 'finalized'
  )::integer;
  if v_unread_after <> v_unread_before - 1 then
    raise exception 'SUBMISSION_REPORT_TEAM_CUTOVER_DEV_CLOSED_BADGE_VISIBLE';
  end if;

  v_summary := public.get_submission_report_case_summary_v2(
    'report-cutover-test-target', v_case_id
  );
  if v_summary ->> 'status' <> 'closed' then
    raise exception 'SUBMISSION_REPORT_TEAM_CUTOVER_DEV_CLOSED_DETAIL_MISSING';
  end if;

  v_admin_log := public.list_submission_report_moderation_events_v2(
    'report-cutover-test-admin', null, null, 100
  );
  if not exists (
      select 1 from jsonb_array_elements(v_admin_log -> 'events') event
      where (event ->> 'caseId')::uuid = v_case_id
        and event ->> 'actorDiscordUserId' is not null
        and event ->> 'note' is not null
    ) then
    raise exception 'SUBMISSION_REPORT_TEAM_CUTOVER_DEV_ADMIN_LOG_MISMATCH';
  end if;

  v_delegated_log := public.list_submission_report_moderation_events_v2(
    'report-cutover-test-log-reader', null, null, 100
  );
  if exists (
      select 1 from jsonb_array_elements(v_delegated_log -> 'events') event
      where (event ->> 'caseId')::uuid = v_case_id
        and (
          event ->> 'actorDiscordUserId' is not null
          or event ->> 'note' is not null
        )
    ) then
    raise exception 'SUBMISSION_REPORT_TEAM_CUTOVER_DEV_DELEGATED_REDACTION_MISMATCH';
  end if;

  begin
    perform public.get_submission_report_case_summary_v2(
      'report-cutover-test-log-reader', v_case_id
    );
    v_forbidden_accepted := true;
  exception when sqlstate '42501' then null;
  end;
  if v_forbidden_accepted then
    raise exception 'SUBMISSION_REPORT_TEAM_CUTOVER_DEV_LOG_GRANT_LEAKED_VIEW';
  end if;
end;
$test$;

rollback;
