\set ON_ERROR_STOP on

begin;

do $test$
declare
  v_cycle_id bigint;
  v_submission_id bigint;
  v_case_id uuid;
  v_report_id uuid;
  v_latest_report_id uuid;
  v_read_report_id uuid;
  v_case public.submission_report_cases%rowtype;
  v_result jsonb;
  v_summary jsonb;
  v_page jsonb;
  v_counts jsonb;
  v_read_count integer;
  v_index integer;
begin
  if (select count(*) from public.capability_catalog) <> 38
    or (select count(*) from public.capability_catalog where is_active) <> 34
    or (
      select count(*) from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 34
    or exists (
      select 1 from public.user_logs
      where discord_user_id like 'report-work-backlog-%'
    ) then
    raise exception 'REPORT_WORK_BACKLOG_DEV_BASELINE_MISMATCH';
  end if;

  insert into public.user_logs(discord_user_id, current_discord_username)
  values
    ('report-work-backlog-admin-a', 'report-work-backlog-admin-a'),
    ('report-work-backlog-admin-b', 'report-work-backlog-admin-b'),
    ('report-work-backlog-subject', 'report-work-backlog-subject');

  insert into public.user_logs(discord_user_id, current_discord_username)
  select
    'report-work-backlog-reporter-' || reporter_index,
    'report-work-backlog-reporter-' || reporter_index
  from generate_series(1, 32) reporter_index;

  insert into public.team_members(discord_user_id, role, discord_username)
  values
    ('report-work-backlog-admin-a', 'admin', 'report-work-backlog-admin-a'),
    ('report-work-backlog-admin-b', 'admin', 'report-work-backlog-admin-b');

  insert into public.voting_cycles(status, theme, title)
  values ('voting_open', 'Report work backlog test', 'Report work backlog test')
  returning id into v_cycle_id;

  insert into public.submissions(
    cycle_id, discord_user_id, r2_key, public_visibility_status
  ) values (
    v_cycle_id,
    'report-work-backlog-subject',
    v_cycle_id::text || '/00000000-0000-4000-8000-000000000020.webp',
    'visible'
  ) returning id into v_submission_id;

  for v_index in 1..4 loop
    v_result := public.create_submission_report_v2(
      'report-work-backlog-reporter-' || v_index,
      1,
      md5('report-work-backlog-' || v_index) || md5('report-work-backlog-' || v_index),
      v_submission_id,
      2,
      'other_rules_concern',
      'other',
      'Rollback-only relevant Report context number ' || v_index || '.',
      gen_random_uuid()
    );
    v_case_id := (v_result ->> 'caseId')::uuid;
    if v_index = 1 then
      v_read_report_id := (v_result ->> 'reportId')::uuid;
    end if;
  end loop;

  v_result := public.get_submission_report_eligibility(
    'report-work-backlog-reporter-5',
    1,
    md5('report-work-backlog-5') || md5('report-work-backlog-5'),
    v_submission_id
  );
  if (v_result ->> 'hasMultipleExistingReports')::boolean
    or not (v_result ->> 'canReport')::boolean
    or v_result ? 'existingReportCount'
    or v_result ? 'exactReportCount' then
    raise exception 'REPORT_WORK_BACKLOG_DEV_FOUR_HINT_MISMATCH';
  end if;

  v_result := public.create_submission_report_v2(
    'report-work-backlog-reporter-5',
    1,
    md5('report-work-backlog-5') || md5('report-work-backlog-5'),
    v_submission_id,
    2,
    'other_rules_concern',
    'other',
    'Rollback-only relevant Report context number five.',
    gen_random_uuid()
  );

  v_result := public.get_submission_report_eligibility(
    'report-work-backlog-reporter-6',
    1,
    md5('report-work-backlog-6') || md5('report-work-backlog-6'),
    v_submission_id
  );
  if not (v_result ->> 'hasMultipleExistingReports')::boolean
    or not (v_result ->> 'canReport')::boolean
    or v_result ? 'existingReportCount'
    or v_result ? 'exactReportCount' then
    raise exception 'REPORT_WORK_BACKLOG_DEV_FIVE_HINT_MISMATCH';
  end if;

  for v_index in 6..30 loop
    v_result := public.create_submission_report_v2(
      'report-work-backlog-reporter-' || v_index,
      1,
      md5('report-work-backlog-' || v_index) || md5('report-work-backlog-' || v_index),
      v_submission_id,
      2,
      'other_rules_concern',
      'other',
      'Rollback-only relevant Report context number ' || v_index || '.',
      gen_random_uuid()
    );
  end loop;

  v_page := public.list_submission_report_cases_v2(
    'report-work-backlog-admin-a', 'live', 50
  );
  v_counts := public.get_submission_report_unread_counts_v2(
    'report-work-backlog-admin-a'
  );
  if not exists (
      select 1
      from jsonb_array_elements(v_page) item
      where (item ->> 'caseId')::uuid = v_case_id
        and (item ->> 'reportCount')::integer = 30
        and (item ->> 'workBacklogReportCount')::integer = 30
        and not item ? 'unreadReportCount'
    )
    or (v_counts ->> 'live')::integer <> 30 then
    raise exception 'REPORT_WORK_BACKLOG_DEV_OPEN_COUNT_MISMATCH';
  end if;

  perform public.get_submission_report_detail_v2(
    'report-work-backlog-admin-a', v_read_report_id
  );
  select count(*)::integer into v_read_count
  from public.submission_report_reads
  where report_id in (
    select report_id from public.submission_reports where case_id = v_case_id
  );
  v_counts := public.get_submission_report_unread_counts_v2(
    'report-work-backlog-admin-a'
  );
  if v_read_count <> 1
    or (v_counts ->> 'live')::integer <> 30
    or exists (
      select 1 from public.submission_report_reads
      where viewer_discord_user_id = 'report-work-backlog-admin-b'
    ) then
    raise exception 'REPORT_WORK_BACKLOG_DEV_READ_CHANGED_WORK_MISMATCH';
  end if;

  select * into strict v_case
  from public.submission_report_cases where case_id = v_case_id;
  perform public.manage_submission_report_case_v3(
    'report-work-backlog-admin-a', v_case_id, 'claim', v_case.status,
    v_case.row_version, v_case.latest_report_id, null, null, null,
    gen_random_uuid()
  );
  v_counts := public.get_submission_report_unread_counts_v2(
    'report-work-backlog-admin-b'
  );
  if (v_counts ->> 'live')::integer <> 30 then
    raise exception 'REPORT_WORK_BACKLOG_DEV_CLAIM_CHANGED_WORK_MISMATCH';
  end if;

  select * into strict v_case
  from public.submission_report_cases where case_id = v_case_id;
  perform public.manage_submission_report_case_v3(
    'report-work-backlog-admin-a', v_case_id, 'release', v_case.status,
    v_case.row_version, v_case.latest_report_id, null, null, null,
    gen_random_uuid()
  );
  v_counts := public.get_submission_report_unread_counts_v2(
    'report-work-backlog-admin-b'
  );
  if (v_counts ->> 'live')::integer <> 30 then
    raise exception 'REPORT_WORK_BACKLOG_DEV_RELEASE_CHANGED_WORK_MISMATCH';
  end if;

  select * into strict v_case
  from public.submission_report_cases where case_id = v_case_id;
  perform public.manage_submission_report_case_v3(
    'report-work-backlog-admin-a', v_case_id, 'claim', v_case.status,
    v_case.row_version, v_case.latest_report_id, null, null, null,
    gen_random_uuid()
  );

  select * into strict v_case
  from public.submission_report_cases where case_id = v_case_id;
  perform public.manage_submission_report_case_v3(
    'report-work-backlog-admin-a', v_case_id, 'close', v_case.status,
    v_case.row_version, v_case.latest_report_id, null,
    'no_action_current_rules', null, gen_random_uuid()
  );
  select * into strict v_case
  from public.submission_report_cases where case_id = v_case_id;
  v_counts := public.get_submission_report_unread_counts_v2(
    'report-work-backlog-admin-b'
  );
  v_summary := public.get_submission_report_case_summary_v2(
    'report-work-backlog-admin-a', v_case_id
  );
  if v_case.status <> 'closed'
    or v_case.reviewed_through_report_id <> v_case.latest_report_id
    or (v_counts ->> 'live')::integer <> 0
    or v_read_count <> (
      select count(*)::integer from public.submission_report_reads
      where report_id in (
        select report_id from public.submission_reports where case_id = v_case_id
      )
    )
    or exists (
      select 1 from jsonb_array_elements(v_summary -> 'reports') report
      where (report ->> 'isNew')::boolean
    )
    or not exists (
      select 1 from jsonb_array_elements(v_summary -> 'reports') report
      where (report ->> 'reportId')::uuid = v_read_report_id
        and (report ->> 'isRead')::boolean
    )
    or exists (
      select 1 from jsonb_array_elements(v_summary -> 'reports') report
      where (report ->> 'reportId')::uuid <> v_read_report_id
        and (report ->> 'isRead')::boolean
    ) then
    raise exception 'REPORT_WORK_BACKLOG_DEV_CLOSE_MISMATCH';
  end if;

  v_result := public.create_submission_report_v2(
    'report-work-backlog-reporter-31',
    1,
    md5('report-work-backlog-31') || md5('report-work-backlog-31'),
    v_submission_id,
    2,
    'other_rules_concern',
    'other',
    'Rollback-only relevant Report context after completed review.',
    gen_random_uuid()
  );
  v_latest_report_id := (v_result ->> 'reportId')::uuid;
  select * into strict v_case
  from public.submission_report_cases where case_id = v_case_id;
  v_counts := public.get_submission_report_unread_counts_v2(
    'report-work-backlog-admin-b'
  );
  v_summary := public.get_submission_report_case_summary_v2(
    'report-work-backlog-admin-b', v_case_id
  );
  if v_case.status <> 'open'
    or v_case.report_count <> 31
    or v_case.reviewed_through_report_id = v_latest_report_id
    or (v_counts ->> 'live')::integer <> 1
    or (
      select count(*) from jsonb_array_elements(v_summary -> 'reports') report
      where (report ->> 'isNew')::boolean
    ) <> 1
    or not exists (
      select 1 from jsonb_array_elements(v_summary -> 'reports') report
      where (report ->> 'reportId')::uuid = v_latest_report_id
        and (report ->> 'isNew')::boolean
    ) then
    raise exception 'REPORT_WORK_BACKLOG_DEV_REOPEN_MISMATCH';
  end if;
  if (v_counts ->> 'live')::integer <> 1 then
    raise exception 'REPORT_WORK_BACKLOG_DEV_THIRTY_PLUS_ONE_MISMATCH';
  end if;
  if not exists (
    select 1 from public.submission_report_case_events
    where case_id = v_case_id and event_type = 'case_reopened_by_report'
      and report_id = v_latest_report_id
  ) then
    raise exception 'REPORT_WORK_BACKLOG_DEV_CLOSE_BEFORE_REPORT_MISMATCH';
  end if;

  update public.voting_cycles set status = 'finished'
  where id = v_cycle_id;
  v_counts := public.get_submission_report_unread_counts_v2(
    'report-work-backlog-admin-b'
  );
  if (v_counts ->> 'live')::integer <> 0
    or (v_counts ->> 'finalized')::integer <> 1 then
    raise exception 'REPORT_WORK_BACKLOG_DEV_AREA_CHANGE_MISMATCH';
  end if;

  update public.voting_cycles
  set status = 'draft', reset_count = reset_count + 1
  where id = v_cycle_id;
  v_counts := public.get_submission_report_unread_counts_v2(
    'report-work-backlog-admin-b'
  );
  if (v_counts ->> 'live')::integer <> 0
    or (v_counts ->> 'finalized')::integer <> 1 then
    raise exception 'REPORT_WORK_BACKLOG_DEV_CYCLE_RESET_MISMATCH';
  end if;

  select * into strict v_case
  from public.submission_report_cases where case_id = v_case_id;
  perform public.manage_submission_report_case_v3(
    'report-work-backlog-admin-a', v_case_id, 'claim', v_case.status,
    v_case.row_version, v_case.latest_report_id, null, null, null,
    gen_random_uuid()
  );
  select * into strict v_case
  from public.submission_report_cases where case_id = v_case_id;
  perform public.manage_submission_report_case_v3(
    'report-work-backlog-admin-a', v_case_id, 'close', v_case.status,
    v_case.row_version, v_case.latest_report_id, null,
    'action_taken', null, gen_random_uuid()
  );
  if exists (
      select 1
      from public.submission_report_case_events report_event
      join public.submission_report_case_events close_event
        on close_event.case_id = report_event.case_id
       and close_event.event_type = 'case_closed'
       and close_event.report_cursor_id = v_latest_report_id
      where report_event.case_id = v_case_id
        and report_event.event_type = 'report_created'
        and report_event.report_id = v_latest_report_id
        and report_event.case_version >= close_event.case_version
    )
    or (public.get_submission_report_unread_counts_v2(
      'report-work-backlog-admin-b'
    ) ->> 'total')::integer <> 0 then
    raise exception 'REPORT_WORK_BACKLOG_DEV_REPORT_BEFORE_CLOSE_MISMATCH';
  end if;

  if not exists (
      select 1
      from jsonb_array_elements(
        public.list_submission_report_moderation_events_v2(
          'report-work-backlog-admin-a', null, null, 100
        ) -> 'events'
      ) event
      where (event ->> 'caseId')::uuid = v_case_id
    )
    or not exists (
      select 1 from public.submission_report_case_events
      where case_id = v_case_id and event_type = 'case_closed'
    ) then
    raise exception 'REPORT_WORK_BACKLOG_DEV_LOG_REGRESSION';
  end if;
end;
$test$;

rollback;
