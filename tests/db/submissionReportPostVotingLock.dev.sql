\set ON_ERROR_STOP on

begin;

do $test$
declare
  v_cycle_id bigint;
  v_submission_id bigint;
  v_case_id uuid;
  v_first_report_id uuid;
  v_first jsonb;
  v_second jsonb;
  v_history jsonb;
  v_eligibility jsonb;
  v_before jsonb;
  v_after jsonb;
  v_phase_rejected boolean := false;
  v_legacy_rejected boolean := false;
begin
  if to_regprocedure(
      'public.enforce_submission_report_creation_phase()'
    ) is null
    or not exists (
      select 1
      from pg_trigger
      where tgrelid = 'public.submission_reports'::regclass
        and tgname = 'enforce_submission_report_creation_phase'
        and tgenabled = 'O'
        and not tgisinternal
    ) then
    raise exception 'POST_VOTING_REPORT_LOCK_DEV_MIGRATION_MISSING';
  end if;

  insert into public.user_logs (
    discord_user_id,
    current_discord_username
  ) values
    ('post-voting-report-subject', 'post-voting-report-subject'),
    ('post-voting-report-1', 'post-voting-report-1'),
    ('post-voting-report-2', 'post-voting-report-2'),
    ('post-voting-report-3', 'post-voting-report-3'),
    ('post-voting-report-4', 'post-voting-report-4');

  insert into public.voting_cycles (
    status,
    theme,
    title,
    submission_starts_at,
    submission_ends_at
  ) values (
    'submission_open',
    'Post-Voting Report Lock',
    'Post-Voting Report Lock',
    transaction_timestamp(),
    transaction_timestamp() + interval '1 hour'
  ) returning id into v_cycle_id;

  insert into public.submissions (
    cycle_id,
    discord_user_id,
    r2_key,
    public_visibility_status
  ) values (
    v_cycle_id,
    'post-voting-report-subject',
    v_cycle_id::text || '/00000000-0000-4000-8000-000000000111.webp',
    'visible'
  ) returning id into v_submission_id;

  v_eligibility := public.get_submission_report_eligibility(
    'post-voting-report-1',
    1,
    repeat('1', 64),
    v_submission_id
  );
  if (v_eligibility ->> 'canReport')::boolean is not true
    or v_eligibility ->> 'blockedReason' is not null then
    raise exception 'POST_VOTING_REPORT_LOCK_ELIGIBILITY_OPEN';
  end if;

  v_first := public.create_submission_report_v2(
    'post-voting-report-1',
    1,
    repeat('1', 64),
    v_submission_id,
    2,
    'privacy_or_personal_information',
    'doxxing',
    'Submission phase concern.',
    '91000000-0000-4000-8000-000000000001'::uuid
  );
  if v_first ->> 'reportId' is null then
    raise exception 'POST_VOTING_REPORT_LOCK_SUBMISSION_OPEN_FAILED';
  end if;

  update public.voting_cycles
  set
    status = 'voting_open',
    voting_starts_at = transaction_timestamp(),
    voting_ends_at = transaction_timestamp() + interval '1 hour'
  where id = v_cycle_id;

  v_second := public.create_submission_report_v2(
    'post-voting-report-2',
    1,
    repeat('2', 64),
    v_submission_id,
    2,
    'fair_play_manipulation',
    'coordinated_manipulation',
    'Voting phase manipulation concern.',
    '92000000-0000-4000-8000-000000000001'::uuid
  );
  if v_second ->> 'reportId' is null then
    raise exception 'POST_VOTING_REPORT_LOCK_VOTING_OPEN_FAILED';
  end if;

  v_case_id := (v_first ->> 'caseId')::uuid;
  v_first_report_id := (v_first ->> 'reportId')::uuid;

  update public.voting_cycles
  set
    status = 'voting_closed',
    voting_ends_at = transaction_timestamp()
  where id = v_cycle_id;

  v_eligibility := public.get_submission_report_eligibility(
    'post-voting-report-3',
    1,
    repeat('3', 64),
    v_submission_id
  );
  if (v_eligibility ->> 'canReport')::boolean is not false
    or v_eligibility ->> 'blockedReason' <> 'cycle_wrapping_up' then
    raise exception 'POST_VOTING_REPORT_LOCK_ELIGIBILITY_OPEN';
  end if;

  select jsonb_build_object(
    'identities', (select count(*) from public.submission_reporter_identities),
    'cases', (select count(*) from public.submission_report_cases),
    'reports', (select count(*) from public.submission_reports),
    'payloads', (select count(*) from public.submission_report_payloads),
    'events', (select count(*) from public.submission_report_case_events),
    'requests', (select count(*) from public.submission_report_requests),
    'reads', (select count(*) from public.submission_report_reads),
    'caseState', (
      select jsonb_build_object(
        'status', status,
        'rowVersion', row_version,
        'reportCount', report_count,
        'latestReportId', latest_report_id
      )
      from public.submission_report_cases
      where case_id = v_case_id
    )
  ) into v_before;

  begin
    perform public.create_submission_report_v2(
      'post-voting-report-3',
      1,
      repeat('3', 64),
      v_submission_id,
      2,
      'privacy_or_personal_information',
      'doxxing',
      'Post-Voting concern must be rejected.',
      '93000000-0000-4000-8000-000000000001'::uuid
    );
  exception
    when sqlstate 'PT409' then
      if sqlerrm = 'SUBMISSION_REPORT_PHASE_CLOSED' then
        v_phase_rejected := true;
      end if;
  end;
  if not v_phase_rejected then
    raise exception 'POST_VOTING_REPORT_LOCK_RPC_ACCEPTED';
  end if;

  begin
    perform public.create_submission_report(
      'post-voting-report-4',
      1,
      repeat('4', 64),
      v_submission_id,
      1,
      'privacy_or_personal_information',
      'doxxing',
      'Legacy path must also be rejected.',
      '94000000-0000-4000-8000-000000000001'::uuid
    );
  exception
    when sqlstate 'PT409' then
      if sqlerrm = 'SUBMISSION_REPORT_PHASE_CLOSED' then
        v_legacy_rejected := true;
      end if;
  end;
  if not v_legacy_rejected then
    raise exception 'POST_VOTING_REPORT_LOCK_LEGACY_ACCEPTED';
  end if;

  select jsonb_build_object(
    'identities', (select count(*) from public.submission_reporter_identities),
    'cases', (select count(*) from public.submission_report_cases),
    'reports', (select count(*) from public.submission_reports),
    'payloads', (select count(*) from public.submission_report_payloads),
    'events', (select count(*) from public.submission_report_case_events),
    'requests', (select count(*) from public.submission_report_requests),
    'reads', (select count(*) from public.submission_report_reads),
    'caseState', (
      select jsonb_build_object(
        'status', status,
        'rowVersion', row_version,
        'reportCount', report_count,
        'latestReportId', latest_report_id
      )
      from public.submission_report_cases
      where case_id = v_case_id
    )
  ) into v_after;

  if v_after is distinct from v_before then
    raise exception 'POST_VOTING_REPORT_LOCK_RESIDUE';
  end if;
  if not exists (
    select 1
    from public.submission_reports
    where report_id = v_first_report_id
      and case_id = v_case_id
  ) then
    raise exception 'POST_VOTING_REPORT_LOCK_EXISTING_FACT_CHANGED';
  end if;

  update public.voting_cycles
  set
    status = 'finished',
    finalized_at = transaction_timestamp(),
    results_published_at = transaction_timestamp(),
    ended_at = transaction_timestamp()
  where id = v_cycle_id;

  v_eligibility := public.get_submission_report_eligibility(
    'post-voting-report-3',
    1,
    repeat('3', 64),
    v_submission_id
  );
  if (v_eligibility ->> 'canReport')::boolean is not true
    or v_eligibility ->> 'blockedReason' is not null then
    raise exception 'POST_VOTING_REPORT_LOCK_HISTORY_FAILED';
  end if;

  v_history := public.create_submission_report_v2(
    'post-voting-report-3',
    1,
    repeat('3', 64),
    v_submission_id,
    2,
    'rights_or_ownership',
    'copyright_or_unlicensed_use',
    'Finished history rights concern.',
    '95000000-0000-4000-8000-000000000001'::uuid
  );
  if v_history ->> 'reportId' is null
    or (select count(*) from public.submission_reports where case_id = v_case_id) <> 3 then
    raise exception 'POST_VOTING_REPORT_LOCK_HISTORY_FAILED';
  end if;
end;
$test$;

rollback;
