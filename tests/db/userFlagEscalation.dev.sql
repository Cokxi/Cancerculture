\set ON_ERROR_STOP on

begin;

do $test$
declare
  v_actor_id text;
  v_target_id text;
  v_case_id uuid;
  v_version bigint;
  v_result jsonb;
  v_conflict_seen boolean := false;
  v_hold_seen boolean := false;
begin
  select member_row.discord_user_id
  into v_actor_id
  from public.team_members as member_row
  join public.team_roles as role_row
    on role_row.key = member_row.role and role_row.is_active
  where member_row.role = 'admin'
  order by member_row.discord_user_id
  limit 1;

  select user_row.discord_user_id
  into v_target_id
  from public.user_logs as user_row
  where not user_row.is_banned
    and user_row.discord_user_id <> v_actor_id
    and not exists (
      select 1
      from public.user_flag_cases as flag_case
      where flag_case.discord_user_id = user_row.discord_user_id
        and flag_case.status in ('open', 'escalated')
    )
  order by user_row.discord_user_id
  limit 1;

  if v_actor_id is null or v_target_id is null then
    raise exception '5C2 DEV test fixture unavailable';
  end if;

  v_result := public.create_user_flag_case(
    v_actor_id,
    v_target_id,
    'other',
    '5C2 transactional DEV verification',
    null,
    null,
    gen_random_uuid()
  );
  v_case_id := (v_result ->> 'caseId')::uuid;
  v_version := (v_result ->> 'rowVersion')::bigint;

  begin
    perform public.create_user_flag_case(
      v_actor_id,
      v_target_id,
      'other',
      '5C2 serialized duplicate verification',
      null,
      null,
      gen_random_uuid()
    );
  exception
    when sqlstate 'PT409' then
      v_conflict_seen := true;
  end;
  if not v_conflict_seen then
    raise exception '5C2 duplicate active case did not return PT409';
  end if;

  v_result := public.review_user_flag_case(
    v_actor_id,
    v_case_id,
    v_version,
    'escalated',
    '5C2 escalation and participation hold verification',
    gen_random_uuid()
  );
  v_version := (v_result ->> 'rowVersion')::bigint;

  if not public.is_user_participation_held(v_target_id) then
    raise exception '5C2 escalation did not derive participation hold';
  end if;

  begin
    insert into public.submission_upload_operations (discord_user_id)
    values (v_target_id);
  exception
    when insufficient_privilege then
      if sqlerrm = 'PARTICIPATION_UNAVAILABLE' then
        v_hold_seen := true;
      else
        raise;
      end if;
  end;
  if not v_hold_seen then
    raise exception '5C2 upload reserve trigger did not block held user';
  end if;

  v_result := public.review_user_flag_case(
    v_actor_id,
    v_case_id,
    v_version,
    'banned_resolved',
    '5C2 atomic website ban and resolution verification',
    gen_random_uuid()
  );

  if (v_result ->> 'status') <> 'resolved'
    or (v_result ->> 'websiteBanApplied')::boolean is not true
    or not exists (
      select 1
      from public.user_logs
      where discord_user_id = v_target_id
        and is_banned
        and ban_source = 'admin_manual'
        and banned_by_discord_user_id = v_actor_id
    ) then
    raise exception '5C2 atomic ban and resolution contract failed';
  end if;

  if public.is_user_participation_held(v_target_id) then
    raise exception '5C2 resolved case retained participation hold';
  end if;

  if (
    select count(*)
    from public.user_flag_actor_snapshots as snapshot
    join public.user_flag_events as event_row on event_row.event_id = snapshot.event_id
    where event_row.case_id = v_case_id
      and snapshot.actor_account_id = v_actor_id
      and snapshot.actor_discord_user_id = v_actor_id
  ) <> 3 then
    raise exception '5C2 actor snapshots are incomplete';
  end if;

  v_conflict_seen := false;
  begin
    perform public.review_user_flag_case(
      v_actor_id,
      v_case_id,
      (v_result ->> 'rowVersion')::bigint,
      'escalated',
      '5C2 forbidden re-escalation verification',
      gen_random_uuid()
    );
  exception
    when sqlstate 'PT409' then
      v_conflict_seen := true;
  end;
  if not v_conflict_seen then
    raise exception '5C2 closed case transition did not return PT409';
  end if;
end
$test$;

rollback;
