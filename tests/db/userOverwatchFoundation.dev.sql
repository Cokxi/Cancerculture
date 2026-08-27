\set ON_ERROR_STOP on

begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

do $preflight$
begin
  if (select count(*) from public.capability_catalog) <> 54
    or (select count(*) from public.capability_catalog where is_active) <> 50
    or (
      select count(*) from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 50
    or exists (
      select 1 from public.team_role_capabilities
      where capability_key in ('users.overwatch.view', 'users.overwatch.manage')
    )
    or to_regprocedure('public.get_user_overwatch_manage_target(text,text)') is null
    or to_regprocedure(
      'public.list_user_overwatch_entries(text,text,integer,integer)'
    ) is null
    or to_regprocedure(
      'public.add_user_to_overwatch(text,text,text,bigint,text,uuid)'
    ) is null
    or to_regprocedure(
      'public.remove_user_from_overwatch(text,text,uuid,text,bigint,text,uuid)'
    ) is null
  then
    raise exception 'DEV_USER_OVERWATCH_PREFLIGHT_DRIFT';
  end if;
end;
$preflight$;

do $contract$
declare
  v_actor text;
  v_target text;
  v_denied_actor text;
  v_add jsonb;
  v_add_replay jsonb;
  v_remove jsonb;
  v_remove_replay jsonb;
  v_readd jsonb;
  v_target_projection jsonb;
  v_active jsonb;
  v_history jsonb;
  v_entry_id uuid;
  v_second_entry_id uuid;
  v_flag_count bigint;
  v_auto_flag_count bigint;
  v_warning_count bigint;
  v_notification_count bigint;
  v_push_count bigint;
  v_report_count bigint;
  v_comment_count bigint;
begin
  select member.discord_user_id
  into v_actor
  from public.team_members member
  where member.role = 'admin'
  order by member.discord_user_id
  limit 1;

  select user_row.discord_user_id
  into v_target
  from public.user_logs user_row
  where user_row.discord_user_id <> v_actor
    and not exists (
      select 1 from public.team_members member
      where member.discord_user_id = user_row.discord_user_id
    )
  order by user_row.discord_user_id
  limit 1;
  v_denied_actor := v_target;

  if v_actor is null or v_target is null then
    raise exception 'DEV_USER_OVERWATCH_FIXTURE_UNAVAILABLE';
  end if;

  select count(*) into v_flag_count from public.user_flag_cases;
  select count(*) into v_auto_flag_count from public.user_warning_auto_flag_cases;
  select count(*) into v_warning_count from public.user_warnings;
  select count(*) into v_notification_count from public.account_notifications;
  select count(*) into v_push_count from public.push_delivery_jobs;
  select count(*) into v_report_count from public.submission_report_cases;
  select count(*) into v_comment_count from public.community_comments;

  begin
    perform public.list_user_overwatch_entries(v_denied_actor, 'active', 10, 0);
    raise exception 'DEV_USER_OVERWATCH_VIEW_DENIAL_FAILED';
  exception when sqlstate '42501' then null;
  end;
  begin
    perform public.get_user_overwatch_manage_target(v_denied_actor, v_target);
    raise exception 'DEV_USER_OVERWATCH_MANAGE_DENIAL_FAILED';
  exception when sqlstate '42501' then null;
  end;

  v_target_projection := public.get_user_overwatch_manage_target(v_actor, v_target);
  if v_target_projection <> jsonb_build_object(
    'outcome', 'found',
    'targetDiscordUserId', v_target,
    'currentState', 'absent',
    'entryId', null,
    'generation', 0,
    'rowVersion', 0
  ) then
    raise exception 'DEV_USER_OVERWATCH_ABSENT_TARGET_SHAPE_FAILED';
  end if;

  v_add := public.add_user_to_overwatch(
    v_actor,
    v_target,
    'absent',
    0,
    'Rollback-only Overwatch second opinion.',
    '57000000-0000-4000-8000-000000000001'::uuid
  );
  if v_add ->> 'operation' <> 'add'
    or v_add ->> 'targetDiscordUserId' <> v_target
    or v_add ->> 'generation' <> '1'
    or v_add ->> 'state' <> 'active'
    or v_add ->> 'rowVersion' <> '1'
    or v_add ->> 'replayed' <> 'false'
    or (select count(*) from jsonb_object_keys(v_add)) <> 8
  then
    raise exception 'DEV_USER_OVERWATCH_ADD_RECEIPT_FAILED';
  end if;
  v_entry_id := (v_add ->> 'entryId')::uuid;

  v_add_replay := public.add_user_to_overwatch(
    v_actor,
    v_target,
    'absent',
    0,
    'Rollback-only Overwatch second opinion.',
    '57000000-0000-4000-8000-000000000001'::uuid
  );
  if v_add_replay - 'replayed' <> v_add - 'replayed'
    or v_add_replay ->> 'replayed' <> 'true'
  then
    raise exception 'DEV_USER_OVERWATCH_ADD_REPLAY_FAILED';
  end if;

  begin
    perform public.add_user_to_overwatch(
      v_actor, v_target, 'absent', 0,
      'Conflicting replay payload.',
      '57000000-0000-4000-8000-000000000001'::uuid
    );
    raise exception 'DEV_USER_OVERWATCH_CONFLICTING_REPLAY_FAILED';
  exception when sqlstate 'PT409' then null;
  end;
  begin
    perform public.add_user_to_overwatch(
      v_actor, v_target, 'absent', 0,
      'Stale parallel Add attempt.',
      '57000000-0000-4000-8000-000000000002'::uuid
    );
    raise exception 'DEV_USER_OVERWATCH_STALE_ADD_FAILED';
  exception when sqlstate 'PT409' then null;
  end;

  if (select count(*) from public.user_overwatch_current where target_discord_user_id = v_target and state = 'active') <> 1
    or (select count(*) from public.user_overwatch_events where target_discord_user_id = v_target) <> 1
    or (select count(*) from public.user_overwatch_requests where target_discord_user_id = v_target) <> 1
  then
    raise exception 'DEV_USER_OVERWATCH_ONE_ACTIVE_FAILED';
  end if;

  begin
    perform public.remove_user_from_overwatch(
      v_actor, v_target, v_entry_id, 'active', 2,
      'Stale Remove attempt.',
      '57000000-0000-4000-8000-000000000003'::uuid
    );
    raise exception 'DEV_USER_OVERWATCH_STALE_REMOVE_FAILED';
  exception when sqlstate 'PT409' then null;
  end;

  v_remove := public.remove_user_from_overwatch(
    v_actor,
    v_target,
    v_entry_id,
    'active',
    1,
    'Rollback-only second opinion completed.',
    '57000000-0000-4000-8000-000000000004'::uuid
  );
  if v_remove ->> 'operation' <> 'remove'
    or v_remove ->> 'entryId' <> v_entry_id::text
    or v_remove ->> 'state' <> 'removed'
    or v_remove ->> 'rowVersion' <> '2'
    or v_remove ->> 'replayed' <> 'false'
  then
    raise exception 'DEV_USER_OVERWATCH_REMOVE_RECEIPT_FAILED';
  end if;

  v_remove_replay := public.remove_user_from_overwatch(
    v_actor,
    v_target,
    v_entry_id,
    'active',
    1,
    'Rollback-only second opinion completed.',
    '57000000-0000-4000-8000-000000000004'::uuid
  );
  if v_remove_replay - 'replayed' <> v_remove - 'replayed'
    or v_remove_replay ->> 'replayed' <> 'true'
  then
    raise exception 'DEV_USER_OVERWATCH_REMOVE_REPLAY_FAILED';
  end if;

  v_readd := public.add_user_to_overwatch(
    v_actor,
    v_target,
    'removed',
    2,
    'Rollback-only new second opinion generation.',
    '57000000-0000-4000-8000-000000000005'::uuid
  );
  v_second_entry_id := (v_readd ->> 'entryId')::uuid;
  if v_second_entry_id = v_entry_id
    or v_readd ->> 'generation' <> '2'
    or v_readd ->> 'state' <> 'active'
  then
    raise exception 'DEV_USER_OVERWATCH_READD_GENERATION_FAILED';
  end if;

  v_active := public.list_user_overwatch_entries(v_actor, 'active', 100, 0);
  v_history := public.list_user_overwatch_entries(v_actor, 'history', 100, 0);
  if jsonb_array_length(v_active -> 'items') <> 1
    or v_active #>> '{items,0,entryId}' <> v_second_entry_id::text
    or jsonb_array_length(v_history -> 'items') <> 1
    or v_history #>> '{items,0,entryId}' <> v_entry_id::text
    or jsonb_array_length(v_history #> '{items,0,events}') <> 2
    or v_history #>> '{items,0,events,0,eventType}' <> 'added'
    or v_history #>> '{items,0,events,1,eventType}' <> 'removed'
  then
    raise exception 'DEV_USER_OVERWATCH_ACTIVE_HISTORY_PROJECTION_FAILED';
  end if;

  begin
    update public.user_overwatch_events
    set reason = 'Forbidden rewrite.'
    where entry_id = (
      select entry_id from public.user_overwatch_generations
      where public_entry_id = v_entry_id
    );
    raise exception 'DEV_USER_OVERWATCH_EVENT_IMMUTABILITY_FAILED';
  exception when sqlstate '55000' then null;
  end;
  begin
    delete from public.user_overwatch_generations
    where public_entry_id = v_entry_id;
    raise exception 'DEV_USER_OVERWATCH_GENERATION_IMMUTABILITY_FAILED';
  exception when sqlstate '55000' then null;
  end;

  if (select count(*) from public.user_flag_cases) <> v_flag_count
    or (select count(*) from public.user_warning_auto_flag_cases) <> v_auto_flag_count
    or (select count(*) from public.user_warnings) <> v_warning_count
    or (select count(*) from public.account_notifications) <> v_notification_count
    or (select count(*) from public.push_delivery_jobs) <> v_push_count
    or (select count(*) from public.submission_report_cases) <> v_report_count
    or (select count(*) from public.community_comments) <> v_comment_count
  then
    raise exception 'DEV_USER_OVERWATCH_PRODUCT_SIDE_EFFECT_FAILED';
  end if;
end;
$contract$;

rollback;
