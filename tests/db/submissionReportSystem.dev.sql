\set ON_ERROR_STOP on

begin;

do $test$
declare
  v_cycle_id bigint;
  v_submission_id bigint;
  v_first jsonb;
  v_replay jsonb;
  v_second jsonb;
  v_third jsonb;
  v_fourth jsonb;
  v_fifth jsonb;
  v_case jsonb;
  v_review jsonb;
  v_stale_accepted boolean := false;
  v_duplicate_accepted boolean := false;
  v_removed_accepted boolean := false;
  v_case_id uuid;
  v_latest_report_id uuid;
  v_row_version bigint;
  v_status text;
begin
  if (select count(*) from public.capability_catalog) <> 33
    or (select count(*) from public.capability_catalog where is_active) <> 29
    or (
      select count(*) from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 29
    or exists (
      select 1 from public.team_role_capabilities
      where capability_key in ('submissions.reports.view', 'submissions.reports.review')
    ) then
    raise exception 'SUBMISSION_REPORT_DEV_BASELINE_MISMATCH';
  end if;

  -- Exercise the guarded read/review RPCs without durably activating either
  -- capability. The surrounding transaction rolls this staging change back.
  update public.capability_catalog
  set is_active = true, assignable_to_non_admin = true
  where key in ('submissions.reports.view', 'submissions.reports.review');
  if not found or (
      select count(*) from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 31 then
    raise exception 'SUBMISSION_REPORT_DEV_TEMPORARY_ACTIVATION_MISMATCH';
  end if;

  insert into public.user_logs(discord_user_id, current_discord_username)
  values
    ('report-test-admin', 'report-test-admin'),
    ('report-test-subject', 'report-test-subject'),
    ('report-test-1', 'report-test-1'),
    ('report-test-2', 'report-test-2'),
    ('report-test-3', 'report-test-3'),
    ('report-test-4', 'report-test-4'),
    ('report-test-5', 'report-test-5'),
    ('report-test-6', 'report-test-6');

  insert into public.team_members(discord_user_id, role, discord_username)
  values ('report-test-admin', 'admin', 'report-test-admin');

  insert into public.voting_cycles(status, theme, title)
  values ('finished', 'Report test', 'Report test')
  returning id into v_cycle_id;

  insert into public.submissions(
    cycle_id, discord_user_id, r2_key, public_visibility_status
  ) values (
    v_cycle_id, 'report-test-subject',
    v_cycle_id::text || '/00000000-0000-4000-8000-000000000001.webp',
    'visible'
  ) returning id into v_submission_id;

  v_first := public.create_submission_report(
    'report-test-1', 1, repeat('1', 64), v_submission_id, 1,
    'privacy_or_personal_information', 'doxxing',
    'Contains personal information.',
    '10000000-0000-4000-8000-000000000001'::uuid
  );
  v_replay := public.create_submission_report(
    'report-test-1', 1, repeat('1', 64), v_submission_id, 1,
    'privacy_or_personal_information', 'doxxing',
    'Contains personal information.',
    '10000000-0000-4000-8000-000000000001'::uuid
  );
  if (v_first ->> 'reportId') is distinct from (v_replay ->> 'reportId')
    or (v_replay ->> 'replayed')::boolean is not true then
    raise exception 'SUBMISSION_REPORT_DEV_REPLAY_MISMATCH';
  end if;

  begin
    perform public.create_submission_report(
      'report-test-1', 1, repeat('1', 64), v_submission_id, 1,
      'spam_or_platform_abuse', 'spam', null,
      '10000000-0000-4000-8000-000000000002'::uuid
    );
    v_duplicate_accepted := true;
  exception when sqlstate 'PT409' then null;
  end;
  if v_duplicate_accepted then
    raise exception 'SUBMISSION_REPORT_DEV_DUPLICATE_ACCEPTED';
  end if;

  v_second := public.create_submission_report(
    'report-test-2', 1, repeat('2', 64), v_submission_id, 1,
    'spam_or_platform_abuse', 'spam', null,
    '20000000-0000-4000-8000-000000000001'::uuid
  );
  v_third := public.create_submission_report(
    'report-test-3', 1, repeat('3', 64), v_submission_id, 1,
    'fair_play_manipulation', 'coordinated_manipulation', null,
    '30000000-0000-4000-8000-000000000001'::uuid
  );
  if not coalesce((public.get_submission_report_eligibility(
      'report-test-4', 1, repeat('4', 64), v_submission_id
    ) ->> 'hasMultipleExistingReports')::boolean, false) then
    raise exception 'SUBMISSION_REPORT_DEV_MULTIPLE_HINT_MISSING';
  end if;

  v_case_id := (v_first ->> 'caseId')::uuid;
  v_case := public.get_submission_report_case('report-test-admin', v_case_id);
  if jsonb_array_length(v_case -> 'reports') <> 3
    or (v_case ->> 'reportCount')::integer <> 3 then
    raise exception 'SUBMISSION_REPORT_DEV_CASE_GROUPING_MISMATCH';
  end if;

  v_review := public.review_submission_report_case(
    'report-test-admin', v_case_id, 'start_review',
    v_case ->> 'status', (v_case ->> 'rowVersion')::bigint,
    (v_case ->> 'latestReportId')::uuid, null, null,
    '40000000-0000-4000-8000-000000000001'::uuid
  );
  if v_review ->> 'status' <> 'in_review' then
    raise exception 'SUBMISSION_REPORT_DEV_REVIEW_START_MISMATCH';
  end if;

  v_fourth := public.create_submission_report(
    'report-test-4', 1, repeat('4', 64), v_submission_id, 1,
    'low_effort_or_off_topic', 'low_effort', null,
    '50000000-0000-4000-8000-000000000001'::uuid
  );
  begin
    perform public.review_submission_report_case(
      'report-test-admin', v_case_id, 'close', 'in_review',
      (v_review ->> 'rowVersion')::bigint,
      (v_review ->> 'latestReportId')::uuid,
      'no_action_current_rules', 'Reviewed under the current rules.',
      '60000000-0000-4000-8000-000000000001'::uuid
    );
    v_stale_accepted := true;
  exception when sqlstate 'PT409' then null;
  end;
  if v_stale_accepted then
    raise exception 'SUBMISSION_REPORT_DEV_STALE_ACCEPTED';
  end if;

  select status, row_version, latest_report_id
  into v_status, v_row_version, v_latest_report_id
  from public.submission_report_cases where case_id = v_case_id;
  perform public.review_submission_report_case(
    'report-test-admin', v_case_id, 'close', v_status, v_row_version,
    v_latest_report_id, 'no_action_current_rules',
    'Reviewed under the current rules.',
    '60000000-0000-4000-8000-000000000002'::uuid
  );
  if exists (
    select 1 from public.submission_report_payloads payload
    join public.submission_reports report on report.report_id = payload.report_id
    where report.case_id = v_case_id and payload.retention_due_at is null
  ) then
    raise exception 'SUBMISSION_REPORT_DEV_RETENTION_DUE_MISSING';
  end if;

  v_fifth := public.create_submission_report(
    'report-test-5', 1, repeat('5', 64), v_submission_id, 1,
    'other_rules_concern', null, 'A new concern after case closure.',
    '70000000-0000-4000-8000-000000000001'::uuid
  );
  select status into v_status from public.submission_report_cases where case_id = v_case_id;
  if v_status <> 'open' or not exists (
    select 1 from public.submission_report_case_events
    where case_id = v_case_id and event_type = 'case_reopened_by_report'
  ) then
    raise exception 'SUBMISSION_REPORT_DEV_REOPEN_MISMATCH';
  end if;

  update public.submissions set public_visibility_status = 'removed'
  where id = v_submission_id;
  begin
    perform public.create_submission_report(
      'report-test-6', 1, repeat('6', 64), v_submission_id, 1,
      'other_rules_concern', null, null,
      '80000000-0000-4000-8000-000000000001'::uuid
    );
    v_removed_accepted := true;
  exception when no_data_found then null;
  end;
  if v_removed_accepted then
    raise exception 'SUBMISSION_REPORT_DEV_REMOVED_ACCEPTED';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name like 'submission_report%'
      and column_name in ('remoteip', 'remote_ip', 'turnstile_token', 'device_identifier', 'r2_key', 'storage_key')
  ) then
    raise exception 'SUBMISSION_REPORT_DEV_FORBIDDEN_DATA_COLUMN';
  end if;
end;
$test$;

rollback;
