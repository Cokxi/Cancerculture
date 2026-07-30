\set ON_ERROR_STOP on

begin;

set local lock_timeout = '5s';
set local statement_timeout = '45s';

create temporary table team_member_test_context (
  actor_id text not null,
  non_admin_actor_id text not null,
  user_logs_target_id text not null,
  discord_state_target_id text not null,
  baseline_members bigint not null,
  baseline_audit bigint not null,
  baseline_roles bigint not null,
  baseline_grants bigint not null,
  baseline_admins bigint not null
) on commit drop;

do $setup$
declare
  v_actor_id text;
  v_user_logs_target_id text;
  v_non_admin_actor_id text := '99999999999999003';
  v_discord_state_target_id text := '99999999999999001';
begin
  select discord_user_id
  into v_actor_id
  from public.team_members
  where role = 'admin'
    and discord_user_id ~ '^[0-9]{5,32}$'
  order by discord_user_id
  limit 1;

  select user_row.discord_user_id
  into v_user_logs_target_id
  from public.user_logs user_row
  where user_row.discord_user_id ~ '^[0-9]{5,32}$'
    and not exists (
      select 1
      from public.team_members member
      where member.discord_user_id = user_row.discord_user_id
    )
  order by user_row.discord_user_id
  limit 1;

  if v_actor_id is null or v_user_logs_target_id is null then
    raise exception 'DEV_TEAM_MEMBER_TEST_IDENTITY_PREFLIGHT_FAILED';
  end if;

  if exists (
    select 1
    from public.team_members
    where discord_user_id in (
      v_non_admin_actor_id,
      v_discord_state_target_id
    )
  )
    or exists (
      select 1
      from public.user_logs
      where discord_user_id in (
        v_non_admin_actor_id,
        v_discord_state_target_id
      )
    )
    or exists (
      select 1
      from public.discord_member_state
      where discord_user_id in (
        v_non_admin_actor_id,
        v_discord_state_target_id
      )
    )
    or exists (
      select 1
      from public.team_roles
      where key in (
        'custom_member_test_active',
        'custom_member_test_inactive'
      )
    )
  then
    raise exception 'DEV_TEAM_MEMBER_TEST_SYNTHETIC_ID_COLLISION';
  end if;

  insert into pg_temp.team_member_test_context (
    actor_id,
    non_admin_actor_id,
    user_logs_target_id,
    discord_state_target_id,
    baseline_members,
    baseline_audit,
    baseline_roles,
    baseline_grants,
    baseline_admins
  )
  select
    v_actor_id,
    v_non_admin_actor_id,
    v_user_logs_target_id,
    v_discord_state_target_id,
    (select count(*) from public.team_members),
    (select count(*) from public.team_authorization_audit),
    (select count(*) from public.team_roles),
    (select count(*) from public.team_role_capabilities),
    (
      select count(*)
      from public.team_members
      where role = 'admin'
    );

  insert into public.discord_member_state (
    discord_user_id,
    current_discord_username
  )
  values (
    v_discord_state_target_id,
    'rollback-member-state-only'
  );

  insert into public.team_roles (
    key,
    display_name,
    description,
    is_system,
    is_active,
    sort_order
  )
  values
    (
      'custom_member_test_active',
      'Rollback Active Role',
      'Rollback-only active custom role.',
      false,
      true,
      9000
    ),
    (
      'custom_member_test_inactive',
      'Rollback Inactive Role',
      'Rollback-only inactive custom role.',
      false,
      false,
      9001
    );

  insert into public.team_members (
    discord_user_id,
    discord_username,
    role
  )
  values (
    v_non_admin_actor_id,
    'rollback-non-admin-actor',
    'trial_moderator'
  );
end;
$setup$;

grant select on table pg_temp.team_member_test_context
  to service_role;

set local role service_role;

do $service_role_member_tests$
declare
  v_context pg_temp.team_member_test_context%rowtype;
  v_first jsonb;
  v_retry jsonb;
begin
  select *
  into v_context
  from pg_temp.team_member_test_context;

  v_first := public.add_team_member(
    v_context.actor_id,
    v_context.user_logs_target_id,
    'trial_moderator',
    true,
    'Rollback add from known user log',
    '20000000-0000-0000-0000-000000000001'::uuid
  );
  v_retry := public.add_team_member(
    v_context.actor_id,
    v_context.user_logs_target_id,
    'trial_moderator',
    true,
    'Rollback add from known user log',
    '20000000-0000-0000-0000-000000000001'::uuid
  );

  if v_first <> v_retry
    or v_first ->> 'operation' <> 'add_team_member'
    or v_first ->> 'newRole' <> 'trial_moderator'
    or v_first ->> 'targetDiscordUserId' <>
      v_context.user_logs_target_id
    or (
      select count(*)
      from public.team_members
      where discord_user_id = v_context.user_logs_target_id
        and role = 'trial_moderator'
    ) <> 1
    or (
      select count(*)
      from public.team_authorization_audit
      where idempotency_key =
        '20000000-0000-0000-0000-000000000001'::uuid
        and event_type = 'member_added'
        and actor_discord_user_id = v_context.actor_id
        and target_discord_user_id =
          v_context.user_logs_target_id
        and target_role_key = 'trial_moderator'
        and reason = 'Rollback add from known user log'
        and before_state =
          jsonb_build_object('teamMembership', null)
        and after_state = v_first
    ) <> 1
    or (
      select count(*)
      from public.team_role_capabilities
    ) <> v_context.baseline_grants then
    raise exception 'ADD_FROM_USER_LOG_OR_RETRY_FAILED';
  end if;

  begin
    perform public.add_team_member(
      v_context.actor_id,
      v_context.user_logs_target_id,
      'trial_moderator',
      true,
      'Different payload for same key',
      '20000000-0000-0000-0000-000000000001'::uuid
    );
    raise exception 'ADD_IDEMPOTENCY_CONFLICT_NOT_REJECTED';
  exception
    when invalid_parameter_value then
      if sqlerrm <> 'TEAM_AUTH_IDEMPOTENCY_CONFLICT' then
        raise;
      end if;
  end;

  begin
    perform public.add_team_member(
      v_context.actor_id,
      v_context.user_logs_target_id,
      'moderator',
      true,
      'Existing membership with a new key',
      '20000000-0000-0000-0000-000000000002'::uuid
    );
    raise exception 'EXISTING_TEAM_MEMBER_REASSIGNED_BY_ADD';
  exception
    when unique_violation then
      if sqlerrm <> 'TEAM_MEMBER_ALREADY_EXISTS' then
        raise;
      end if;
  end;

  begin
    perform public.remove_team_member(
      v_context.actor_id,
      v_context.user_logs_target_id,
      'moderator',
      'Stale expected role',
      '20000000-0000-0000-0000-000000000003'::uuid
    );
    raise exception 'STALE_REMOVE_ACCEPTED';
  exception
    when serialization_failure then
      if sqlerrm <> 'TEAM_MEMBER_ROLE_CONFLICT' then
        raise;
      end if;
  end;

  v_first := public.remove_team_member(
    v_context.actor_id,
    v_context.user_logs_target_id,
    'trial_moderator',
    'Rollback physical member removal',
    '20000000-0000-0000-0000-000000000004'::uuid
  );
  v_retry := public.remove_team_member(
    v_context.actor_id,
    v_context.user_logs_target_id,
    'trial_moderator',
    'Rollback physical member removal',
    '20000000-0000-0000-0000-000000000004'::uuid
  );

  if v_first <> v_retry
    or v_first ->> 'operation' <> 'remove_team_member'
    or v_first ->> 'previousRole' <> 'trial_moderator'
    or v_first -> 'newRole' <> 'null'::jsonb
    or exists (
      select 1
      from public.team_members
      where discord_user_id = v_context.user_logs_target_id
    )
    or (
      select count(*)
      from public.team_authorization_audit
      where idempotency_key =
        '20000000-0000-0000-0000-000000000004'::uuid
        and event_type = 'member_removed'
        and target_discord_user_id =
          v_context.user_logs_target_id
        and target_role_key = 'trial_moderator'
        and before_state ->> 'previousRole' =
          'trial_moderator'
        and after_state = v_first
    ) <> 1 then
    raise exception 'PHYSICAL_REMOVE_OR_RETRY_FAILED';
  end if;

  begin
    perform public.remove_team_member(
      v_context.actor_id,
      v_context.user_logs_target_id,
      'trial_moderator',
      'Missing target with a new key',
      '20000000-0000-0000-0000-000000000005'::uuid
    );
    raise exception 'MISSING_TEAM_MEMBER_REMOVE_ACCEPTED';
  exception
    when no_data_found then
      if sqlerrm <> 'TEAM_MEMBER_NOT_FOUND' then
        raise;
      end if;
  end;

  perform public.add_team_member(
    v_context.actor_id,
    v_context.user_logs_target_id,
    'custom_member_test_active',
    true,
    'Rollback explicit re-add to custom role',
    '20000000-0000-0000-0000-000000000006'::uuid
  );

  if (
    select count(*)
    from public.team_authorization_audit
    where target_discord_user_id =
        v_context.user_logs_target_id
      and event_type = 'member_added'
  ) <> 2
    or not exists (
      select 1
      from public.team_members
      where discord_user_id = v_context.user_logs_target_id
        and role = 'custom_member_test_active'
    ) then
    raise exception 'EXPLICIT_READD_FAILED';
  end if;

  perform public.remove_team_member(
    v_context.actor_id,
    v_context.user_logs_target_id,
    'custom_member_test_active',
    'Rollback remove after explicit re-add',
    '20000000-0000-0000-0000-000000000007'::uuid
  );

  perform public.add_team_member(
    v_context.actor_id,
    v_context.discord_state_target_id,
    'moderator',
    true,
    'Rollback add from Discord member state',
    '20000000-0000-0000-0000-000000000008'::uuid
  );

  if exists (
    select 1
    from public.user_logs
    where discord_user_id =
      v_context.discord_state_target_id
  )
    or not exists (
      select 1
      from public.team_members
      where discord_user_id =
          v_context.discord_state_target_id
        and discord_username =
          'rollback-member-state-only'
        and role = 'moderator'
    ) then
    raise exception 'ADD_FROM_DISCORD_STATE_FALLBACK_FAILED';
  end if;

  begin
    perform public.add_team_member(
      v_context.actor_id,
      '99999999999999002',
      'trial_moderator',
      true,
      'Rollback unknown identity rejection',
      '20000000-0000-0000-0000-000000000009'::uuid
    );
    raise exception 'UNKNOWN_IDENTITY_ACCEPTED';
  exception
    when no_data_found then
      if sqlerrm <> 'TARGET_IDENTITY_UNKNOWN' then
        raise;
      end if;
  end;

  begin
    perform public.add_team_member(
      v_context.actor_id,
      '99999999999999002',
      'admin',
      true,
      'Rollback Admin add rejection',
      '20000000-0000-0000-0000-000000000010'::uuid
    );
    raise exception 'ADMIN_ADD_ACCEPTED';
  exception
    when insufficient_privilege then
      if sqlerrm <> 'ADMIN_ROLE_REQUIRES_OWNER_RPC' then
        raise;
      end if;
  end;

  begin
    perform public.add_team_member(
      v_context.actor_id,
      v_context.user_logs_target_id,
      'custom_member_test_inactive',
      true,
      'Rollback inactive role rejection',
      '20000000-0000-0000-0000-000000000011'::uuid
    );
    raise exception 'INACTIVE_ROLE_ADD_ACCEPTED';
  exception
    when sqlstate '55000' then
      if sqlerrm <> 'TEAM_ROLE_INACTIVE' then
        raise;
      end if;
  end;

  begin
    perform public.add_team_member(
      v_context.actor_id,
      v_context.user_logs_target_id,
      'missing_member_role',
      true,
      'Rollback missing role rejection',
      '20000000-0000-0000-0000-000000000012'::uuid
    );
    raise exception 'MISSING_ROLE_ADD_ACCEPTED';
  exception
    when no_data_found then
      if sqlerrm <> 'TEAM_ROLE_NOT_FOUND' then
        raise;
      end if;
  end;

  begin
    perform public.add_team_member(
      v_context.actor_id,
      v_context.user_logs_target_id,
      'trial_moderator',
      false,
      'Rollback invalid expected state',
      '20000000-0000-0000-0000-000000000013'::uuid
    );
    raise exception 'EXPECTED_ABSENT_FALSE_ACCEPTED';
  exception
    when invalid_parameter_value then
      if sqlerrm <> 'TEAM_MEMBER_EXPECTED_ABSENT_REQUIRED' then
        raise;
      end if;
  end;

  begin
    perform public.add_team_member(
      v_context.actor_id,
      v_context.user_logs_target_id,
      'trial_moderator',
      true,
      'x',
      '20000000-0000-0000-0000-000000000014'::uuid
    );
    raise exception 'SHORT_REASON_ACCEPTED';
  exception
    when invalid_parameter_value then
      if sqlerrm <> 'INVALID_REASON' then
        raise;
      end if;
  end;

  begin
    perform public.add_team_member(
      v_context.non_admin_actor_id,
      v_context.user_logs_target_id,
      'trial_moderator',
      true,
      'Rollback non-admin actor rejection',
      '20000000-0000-0000-0000-000000000015'::uuid
    );
    raise exception 'NON_ADMIN_ADD_ACTOR_ACCEPTED';
  exception
    when insufficient_privilege then
      if sqlerrm <> 'ACTOR_NOT_ADMIN' then
        raise;
      end if;
  end;

  begin
    perform public.remove_team_member(
      v_context.actor_id,
      v_context.actor_id,
      'trial_moderator',
      'Rollback Admin target rejection',
      '20000000-0000-0000-0000-000000000016'::uuid
    );
    raise exception 'ADMIN_REMOVE_ACCEPTED';
  exception
    when insufficient_privilege then
      if sqlerrm <> 'ADMIN_MEMBER_REMOVE_FORBIDDEN' then
        raise;
      end if;
  end;

  perform public.set_team_member_non_admin_role(
    v_context.actor_id,
    v_context.discord_state_target_id,
    'super_moderator',
    'moderator',
    'Rollback concurrent-role-change analogue',
    '20000000-0000-0000-0000-000000000017'::uuid
  );

  begin
    perform public.remove_team_member(
      v_context.actor_id,
      v_context.discord_state_target_id,
      'moderator',
      'Rollback stale after role change',
      '20000000-0000-0000-0000-000000000018'::uuid
    );
    raise exception 'ROLE_CHANGE_STALE_REMOVE_ACCEPTED';
  exception
    when serialization_failure then
      if sqlerrm <> 'TEAM_MEMBER_ROLE_CONFLICT' then
        raise;
      end if;
  end;

  v_first := public.remove_team_member(
    v_context.actor_id,
    v_context.discord_state_target_id,
    'super_moderator',
    'Rollback final Discord-state removal',
    '20000000-0000-0000-0000-000000000019'::uuid
  );
  v_retry := public.remove_team_member(
    v_context.actor_id,
    v_context.discord_state_target_id,
    'super_moderator',
    'Rollback final Discord-state removal',
    '20000000-0000-0000-0000-000000000019'::uuid
  );

  if v_first <> v_retry then
    raise exception 'REMOVE_RETRY_RESULT_CHANGED';
  end if;

  begin
    perform public.remove_team_member(
      v_context.actor_id,
      v_context.discord_state_target_id,
      'super_moderator',
      'Different remove payload for same key',
      '20000000-0000-0000-0000-000000000019'::uuid
    );
    raise exception 'REMOVE_IDEMPOTENCY_CONFLICT_NOT_REJECTED';
  exception
    when invalid_parameter_value then
      if sqlerrm <> 'TEAM_AUTH_IDEMPOTENCY_CONFLICT' then
        raise;
      end if;
  end;

  begin
    perform public.remove_team_member(
      v_context.non_admin_actor_id,
      v_context.user_logs_target_id,
      'trial_moderator',
      'Rollback non-admin remove rejection',
      '20000000-0000-0000-0000-000000000020'::uuid
    );
    raise exception 'NON_ADMIN_REMOVE_ACTOR_ACCEPTED';
  exception
    when insufficient_privilege then
      if sqlerrm <> 'ACTOR_NOT_ADMIN' then
        raise;
      end if;
  end;

  if exists (
    select 1
    from public.team_authorization_audit
    where idempotency_key in (
      '20000000-0000-0000-0000-000000000002'::uuid,
      '20000000-0000-0000-0000-000000000003'::uuid,
      '20000000-0000-0000-0000-000000000005'::uuid,
      '20000000-0000-0000-0000-000000000009'::uuid,
      '20000000-0000-0000-0000-000000000010'::uuid,
      '20000000-0000-0000-0000-000000000011'::uuid,
      '20000000-0000-0000-0000-000000000012'::uuid,
      '20000000-0000-0000-0000-000000000013'::uuid,
      '20000000-0000-0000-0000-000000000014'::uuid,
      '20000000-0000-0000-0000-000000000015'::uuid,
      '20000000-0000-0000-0000-000000000016'::uuid,
      '20000000-0000-0000-0000-000000000018'::uuid,
      '20000000-0000-0000-0000-000000000020'::uuid
    )
  ) then
    raise exception 'FAILED_MEMBER_MUTATION_WROTE_AUDIT';
  end if;
end;
$service_role_member_tests$;

reset role;

do $audit_immutability$
declare
  v_audit_before bigint;
begin
  select count(*)
  into v_audit_before
  from public.team_authorization_audit;

  begin
    update public.team_authorization_audit
    set reason = 'Rollback illegal audit update'
    where idempotency_key =
      '20000000-0000-0000-0000-000000000001'::uuid;
    raise exception 'AUTHORIZATION_AUDIT_UPDATE_ACCEPTED';
  exception
    when sqlstate '55000' then
      if sqlerrm <> 'TEAM_AUTHORIZATION_AUDIT_IMMUTABLE' then
        raise;
      end if;
  end;

  begin
    delete from public.team_authorization_audit
    where idempotency_key =
      '20000000-0000-0000-0000-000000000001'::uuid;
    raise exception 'AUTHORIZATION_AUDIT_DELETE_ACCEPTED';
  exception
    when sqlstate '55000' then
      if sqlerrm <> 'TEAM_AUTHORIZATION_AUDIT_IMMUTABLE' then
        raise;
      end if;
  end;

  if (
    select count(*)
    from public.team_authorization_audit
  ) <> v_audit_before then
    raise exception 'AUDIT_IMMUTABILITY_TEST_CHANGED_COUNT';
  end if;
end;
$audit_immutability$;

rollback;

begin read only;

set local lock_timeout = '5s';
set local statement_timeout = '20s';

do $rollback_control$
begin
  if exists (
    select 1
    from public.team_members
    where discord_user_id like '99999999999999%'
  )
    or exists (
      select 1
      from public.discord_member_state
      where discord_user_id like '99999999999999%'
    )
    or exists (
      select 1
      from public.team_roles
      where key in (
        'custom_member_test_active',
        'custom_member_test_inactive'
      )
    )
    or exists (
      select 1
      from public.team_authorization_audit
      where idempotency_key::text like
        '20000000-0000-0000-0000-%'
    ) then
    raise exception 'DEV_TEAM_MEMBER_TEST_ROLLBACK_FAILED';
  end if;
end;
$rollback_control$;

rollback;

\echo 'DEV team member mutation rollback tests passed.'
