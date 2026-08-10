\set ON_ERROR_STOP on

begin;

do $contract$
declare
  v_actor_id text;
  v_case public.submission_report_cases%rowtype;
  v_result jsonb;
begin
  select member.discord_user_id into strict v_actor_id
  from public.team_members member
  where member.role = 'admin'
  order by member.discord_user_id
  limit 1;

  select * into strict v_case
  from public.submission_report_cases
  where latest_report_id is not null
  order by updated_at, case_id
  limit 1
  for update;

  update public.submission_report_cases
  set status = 'in_review',
      row_version = row_version + 1,
      assigned_to_discord_user_id = v_actor_id,
      assigned_to_display_name = 'Rollback contract reviewer',
      assigned_at = statement_timestamp(),
      review_started_at = statement_timestamp(),
      review_started_by_discord_user_id = v_actor_id,
      review_started_by_display_name = 'Rollback contract reviewer',
      reviewed_through_report_id = null,
      reviewed_through_report_at = null,
      closed_at = null,
      closed_by_discord_user_id = null,
      closed_by_display_name = null,
      close_disposition = null,
      close_note = null,
      updated_at = statement_timestamp()
  where case_id = v_case.case_id
  returning * into strict v_case;

  begin
    perform public.manage_submission_report_case_v3(
      v_actor_id,
      v_case.case_id,
      'close',
      v_case.status,
      v_case.row_version,
      v_case.latest_report_id,
      null,
      'no_action_current_rules',
      'short',
      extensions.gen_random_uuid()
    );
    raise exception using errcode = 'P0001',
      message = 'SUBMISSION_REPORT_OPTIONAL_CLOSE_NOTE_SHORT_NOTE_ACCEPTED';
  exception
    when sqlstate '22023' then null;
  end;

  begin
    perform public.manage_submission_report_case_v3(
      v_actor_id,
      v_case.case_id,
      'forced_release',
      v_case.status,
      v_case.row_version,
      v_case.latest_report_id,
      null,
      null,
      null,
      extensions.gen_random_uuid()
    );
    raise exception using errcode = 'P0001',
      message = 'SUBMISSION_REPORT_OPTIONAL_CLOSE_NOTE_OVERRIDE_WITHOUT_REASON_ACCEPTED';
  exception
    when sqlstate '22023' then null;
  end;

  v_result := public.manage_submission_report_case_v3(
    v_actor_id,
    v_case.case_id,
    'close',
    v_case.status,
    v_case.row_version,
    v_case.latest_report_id,
    null,
    'no_action_current_rules',
    null,
    extensions.gen_random_uuid()
  );

  if v_result ->> 'status' <> 'closed'
    or not exists (
      select 1
      from public.submission_report_cases report_case
      where report_case.case_id = v_case.case_id
        and report_case.status = 'closed'
        and report_case.close_disposition = 'no_action_current_rules'
        and report_case.close_note is null
    )
    or not exists (
      select 1
      from public.submission_report_case_events event_row
      where event_row.case_id = v_case.case_id
        and event_row.event_type = 'case_closed'
        and event_row.case_version = v_case.row_version + 1
        and event_row.note is null
    ) then
    raise exception using errcode = 'P0001',
      message = 'SUBMISSION_REPORT_OPTIONAL_CLOSE_NOTE_CONTRACT_MISMATCH';
  end if;
end;
$contract$;

rollback;
