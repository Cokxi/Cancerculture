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
  v_claim jsonb;
  v_replay jsonb;
  v_reassign jsonb;
  v_close jsonb;
  v_stale_accepted boolean := false;
  v_invalid_accepted boolean := false;
  v_activation_count integer;
begin
  if (select count(*) from public.capability_catalog) <> 38
    or (select count(*) from public.capability_catalog where is_active) <> 31
    or (
      select count(*) from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 31
    or exists (select 1 from public.submission_report_reads) then
    raise exception 'SUBMISSION_REPORT_TEAM_DEV_BASELINE_MISMATCH';
  end if;

  update public.capability_catalog
  set is_active = true, assignable_to_non_admin = true
  where key in (
    'submissions.reports.live.view',
    'submissions.reports.finalized.view',
    'submissions.reports.assign',
    'logs.submission_reporters.view',
    'logs.submission_report_moderation.view'
  );
  get diagnostics v_activation_count = row_count;
  if v_activation_count <> 5 then
    raise exception 'SUBMISSION_REPORT_TEAM_DEV_TEMPORARY_ACTIVATION_MISMATCH';
  end if;

  insert into public.user_logs(discord_user_id, current_discord_username)
  values
    ('report-team-test-admin', 'report-team-test-admin'),
    ('report-team-test-target', 'report-team-test-target'),
    ('report-team-test-subject', 'report-team-test-subject'),
    ('report-team-test-reporter', 'report-team-test-reporter');

  insert into public.team_members(discord_user_id, role, discord_username)
  values
    ('report-team-test-admin', 'admin', 'report-team-test-admin'),
    ('report-team-test-target', 'admin', 'report-team-test-target');

  insert into public.voting_cycles(status, theme, title)
  values ('finished', 'Report team test', 'Report team test')
  returning id into v_cycle_id;

  insert into public.submissions(
    cycle_id, discord_user_id, r2_key, public_visibility_status
  ) values (
    v_cycle_id,
    'report-team-test-subject',
    v_cycle_id::text || '/00000000-0000-4000-8000-000000000009.webp',
    'visible'
  ) returning id into v_submission_id;

  v_created := public.create_submission_report_v2(
    'report-team-test-reporter', 1, repeat('9', 64), v_submission_id, 2,
    'rights_or_ownership', 'copyright_or_unlicensed_use',
    'Rollback-only team workflow contract context.',
    '90000000-0000-4000-8000-000000000001'::uuid
  );
  v_case_id := (v_created ->> 'caseId')::uuid;
  v_report_id := (v_created ->> 'reportId')::uuid;

  perform public.get_submission_report_detail_v2(
    'report-team-test-admin', v_report_id
  );
  perform public.get_submission_report_detail_v2(
    'report-team-test-admin', v_report_id
  );
  if (
      select count(*) from public.submission_report_reads
      where viewer_discord_user_id = 'report-team-test-admin'
        and report_id = v_report_id
    ) <> 1 then
    raise exception 'SUBMISSION_REPORT_TEAM_DEV_READ_RECEIPT_MISMATCH';
  end if;

  select * into strict v_case from public.submission_report_cases
  where case_id = v_case_id;
  v_claim := public.manage_submission_report_case_v2(
    'report-team-test-admin', v_case_id, 'claim', v_case.status,
    v_case.row_version, v_case.latest_report_id, null, null, null,
    '90000000-0000-4000-8000-000000000002'::uuid
  );
  v_replay := public.manage_submission_report_case_v2(
    'report-team-test-admin', v_case_id, 'claim', v_case.status,
    v_case.row_version, v_case.latest_report_id, null, null, null,
    '90000000-0000-4000-8000-000000000002'::uuid
  );
  if (v_claim ->> 'rowVersion') is distinct from (v_replay ->> 'rowVersion')
    or (v_replay ->> 'replayed')::boolean is not true then
    raise exception 'SUBMISSION_REPORT_TEAM_DEV_CLAIM_REPLAY_MISMATCH';
  end if;

  begin
    perform public.manage_submission_report_case_v2(
      'report-team-test-admin', v_case_id, null, 'in_review',
      (v_claim ->> 'rowVersion')::bigint, v_case.latest_report_id,
      null, null, null,
      '90000000-0000-4000-8000-000000000006'::uuid
    );
    v_invalid_accepted := true;
  exception when sqlstate '22023' then null;
  end;
  if v_invalid_accepted then
    raise exception 'SUBMISSION_REPORT_TEAM_DEV_INVALID_ACCEPTED';
  end if;

  begin
    perform public.manage_submission_report_case_v2(
      'report-team-test-admin', v_case_id, 'release', 'in_review',
      v_case.row_version, v_case.latest_report_id, null, null,
      'This stale release must fail.',
      '90000000-0000-4000-8000-000000000003'::uuid
    );
    v_stale_accepted := true;
  exception when sqlstate 'PT409' then null;
  end;
  if v_stale_accepted then
    raise exception 'SUBMISSION_REPORT_TEAM_DEV_STALE_ACCEPTED';
  end if;

  select * into strict v_case from public.submission_report_cases
  where case_id = v_case_id;
  v_reassign := public.manage_submission_report_case_v2(
    'report-team-test-admin', v_case_id, 'reassign', v_case.status,
    v_case.row_version, v_case.latest_report_id,
    'report-team-test-target', null,
    'Reassign to the eligible rollback-only target.',
    '90000000-0000-4000-8000-000000000004'::uuid
  );
  if v_reassign ->> 'assignedToDiscordUserId' <> 'report-team-test-target' then
    raise exception 'SUBMISSION_REPORT_TEAM_DEV_REASSIGN_MISMATCH';
  end if;

  select * into strict v_case from public.submission_report_cases
  where case_id = v_case_id;
  v_close := public.manage_submission_report_case_v2(
    'report-team-test-target', v_case_id, 'close', v_case.status,
    v_case.row_version, v_case.latest_report_id, null,
    'no_action_current_rules',
    'Reviewed under the current rules in a rollback-only test.',
    '90000000-0000-4000-8000-000000000005'::uuid
  );
  if v_close ->> 'status' <> 'closed'
    or not exists (
      select 1 from public.submission_report_case_events
      where case_id = v_case_id and event_type = 'case_reassigned'
        and authorization_capability_key = 'submissions.reports.assign'
    )
    or not exists (
      select 1 from public.submission_report_case_events
      where case_id = v_case_id and event_type = 'case_closed'
        and authorization_capability_key = 'submissions.reports.review'
    ) then
    raise exception 'SUBMISSION_REPORT_TEAM_DEV_CLOSE_MISMATCH';
  end if;
end;
$test$;

rollback;
