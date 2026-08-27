\set ON_ERROR_STOP on

begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

do $contract$
declare
  v_actor text;
  v_owner text;
  v_session uuid;
  v_warning_id uuid;
  v_warning public.user_warnings%rowtype;
  v_warning_current public.user_warning_current%rowtype;
  v_submit jsonb;
  v_replay jsonb;
  v_review jsonb;
  v_case public.team_inbox_cases%rowtype;
  v_appeal public.user_warning_appeals%rowtype;
  v_status jsonb;
  v_notification_count bigint;
  v_push_count bigint;
begin
  select member.discord_user_id into v_actor
  from public.team_members member
  where member.role = 'admin'
  order by member.discord_user_id limit 1;

  select warning_row.warning_id, session_row.id
  into v_warning_id, v_session
  from public.user_warnings warning_row
  join public.user_warning_current current_row on current_row.warning_id = warning_row.warning_id
  join public.sessions session_row
    on session_row.discord_user_id = warning_row.target_discord_user_id
   and session_row.revoked_at is null
  where current_row.state = 'active'
  order by warning_row.issued_at desc, session_row.id desc
  limit 1;
  select * into v_warning from public.user_warnings where warning_id = v_warning_id;
  v_owner := v_warning.target_discord_user_id;
  select * into v_warning_current from public.user_warning_current
  where warning_id = v_warning.warning_id;

  if v_actor is null or v_session is null or v_warning.warning_id is null then
    raise exception 'DEV_USER_WARNING_APPEAL_FIXTURE_UNAVAILABLE';
  end if;
  if exists (
    select 1 from public.team_role_capabilities
    where capability_key in ('users.warning_appeals.view', 'users.warning_appeals.review')
  ) then raise exception 'DEV_USER_WARNING_APPEAL_ZERO_GRANT_FAILED'; end if;

  begin
    v_notification_count := (select count(*) from public.account_notifications);
    v_push_count := (select count(*) from public.push_delivery_jobs);
    v_submit := public.submit_user_warning_appeal(
      v_session, v_warning.public_warning_id,
      'Rollback-only Appeal for direct canonical Overrule synchronization.',
      '58000000-0000-4000-8000-000000000001'::uuid
    );
    select * into v_appeal from public.user_warning_appeals
    where warning_id = v_warning.warning_id;
    perform public.overrule_user_warning(
      v_actor, v_warning.public_warning_id, v_warning_current.row_version,
      'Rollback-only canonical correction while Appeal is pending.',
      '58000000-0000-4000-8000-000000000002'::uuid
    );
    select * into v_case from public.team_inbox_cases where id = v_appeal.team_inbox_case_id;
    v_status := public.get_own_user_warning_appeal_status(v_session, v_warning.public_warning_id);
    if v_case.status <> 'solved'
      or v_status ->> 'status' <> 'withdrawn'
      or (select status from public.user_warning_appeal_current where appeal_id = v_appeal.appeal_id) <> 'overruled'
      or (select count(*) from public.user_warning_appeal_events
          where appeal_id = v_appeal.appeal_id and event_type = 'overruled') <> 1
      or (select count(*) from public.notification_events
          where producer_key = 'user_warning_overruled:' || v_warning.warning_id::text) <> 1
      or exists (select 1 from public.notification_events where event_type = 'user_warning_appeal_upheld')
      or (select count(*) from public.account_notifications) <> v_notification_count + 1
      or (select count(*) from public.push_delivery_jobs) <> v_push_count
    then raise exception 'DEV_USER_WARNING_APPEAL_DIRECT_OVERRULE_FAILED'; end if;
    raise exception 'DEV_USER_WARNING_APPEAL_DIRECT_PATH_ROLLBACK';
  exception when raise_exception then
    if sqlerrm <> 'DEV_USER_WARNING_APPEAL_DIRECT_PATH_ROLLBACK' then raise; end if;
  end;

  v_submit := public.submit_user_warning_appeal(
    v_session, v_warning.public_warning_id,
    'Rollback-only Appeal for the explicit Uphold review path.',
    '58000000-0000-4000-8000-000000000003'::uuid
  );
  v_replay := public.submit_user_warning_appeal(
    v_session, v_warning.public_warning_id,
    'Rollback-only Appeal for the explicit Uphold review path.',
    '58000000-0000-4000-8000-000000000003'::uuid
  );
  if v_submit ->> 'replayed' <> 'false' or v_replay ->> 'replayed' <> 'true'
    or v_submit - 'replayed' <> v_replay - 'replayed'
  then raise exception 'DEV_USER_WARNING_APPEAL_SUBMIT_REPLAY_FAILED'; end if;
  begin
    perform public.submit_user_warning_appeal(
      v_session, v_warning.public_warning_id,
      'A materially different second Appeal must always be rejected.',
      '58000000-0000-4000-8000-000000000004'::uuid
    );
    raise exception 'DEV_USER_WARNING_APPEAL_SECOND_SUBMIT_FAILED';
  exception when sqlstate 'PT409' then null;
  end;

  select * into v_appeal from public.user_warning_appeals where warning_id = v_warning.warning_id;
  select * into v_case from public.team_inbox_cases where id = v_appeal.team_inbox_case_id;
  perform public.mutate_user_warning_appeal_case(
    v_actor, v_case.id, '58000000-0000-4000-8000-000000000005'::uuid,
    'claim', 'open', v_case.row_version, v_case.work_version, null
  );
  select * into v_case from public.team_inbox_cases where id = v_case.id;
  begin
    perform public.mutate_team_inbox_case(
      v_actor, v_case.id, '58000000-0000-4000-8000-000000000006'::uuid,
      'return', 'in_progress', v_case.row_version, v_case.work_version,
      'A direct generic return must be rejected.'
    );
    raise exception 'DEV_USER_WARNING_APPEAL_RETURN_GUARD_FAILED';
  exception when sqlstate '55000' then null;
  end;
  perform public.mutate_user_warning_appeal_case(
    v_actor, v_case.id, '58000000-0000-4000-8000-000000000007'::uuid,
    'return', 'in_progress', v_case.row_version, v_case.work_version,
    'Rollback-only return reason.'
  );
  select * into v_case from public.team_inbox_cases where id = v_case.id;
  perform public.mutate_user_warning_appeal_case(
    v_actor, v_case.id, '58000000-0000-4000-8000-000000000008'::uuid,
    'claim', 'open', v_case.row_version, v_case.work_version, null
  );
  select * into v_case from public.team_inbox_cases where id = v_case.id;
  v_notification_count := (select count(*) from public.account_notifications);
  v_push_count := (select count(*) from public.push_delivery_jobs);
  v_review := public.review_user_warning_appeal(
    v_actor, v_case.id, 'uphold', v_case.row_version, v_case.work_version,
    v_case.source_version, 1, v_warning_current.row_version,
    'Rollback-only review found the original Warning supported.',
    '58000000-0000-4000-8000-000000000009'::uuid
  );
  v_replay := public.review_user_warning_appeal(
    v_actor, v_case.id, 'uphold', v_case.row_version, v_case.work_version,
    v_case.source_version, 1, v_warning_current.row_version,
    'Rollback-only review found the original Warning supported.',
    '58000000-0000-4000-8000-000000000009'::uuid
  );
  v_status := public.get_own_user_warning_appeal_status(v_session, v_warning.public_warning_id);
  if v_review ->> 'outcome' <> 'upheld' or v_review ->> 'replayed' <> 'false'
    or v_replay ->> 'replayed' <> 'true'
    or v_status ->> 'status' <> 'upheld'
    or (select status from public.team_inbox_cases where id = v_case.id) <> 'solved'
    or (select state from public.user_warning_current where warning_id = v_warning.warning_id) <> 'active'
    or (select count(*) from public.user_warning_appeal_events
        where appeal_id = v_appeal.appeal_id and event_type = 'upheld') <> 1
    or (select count(*) from public.notification_events
        where producer_key = 'user_warning_appeal_upheld:' || v_appeal.appeal_id::text
          and event_type = 'user_warning_appeal_upheld') <> 1
    or (select count(*) from public.account_notifications) <> v_notification_count + 1
    or (select count(*) from public.push_delivery_jobs) <> v_push_count
  then raise exception 'DEV_USER_WARNING_APPEAL_UPHOLD_FAILED'; end if;

  begin
    perform public.get_user_warning_appeal_case_detail(v_owner, v_case.id);
    raise exception 'DEV_USER_WARNING_APPEAL_VIEW_DENIAL_FAILED';
  exception when sqlstate '42501' then null;
  end;
end;
$contract$;

rollback;
