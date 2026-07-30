\set ON_ERROR_STOP on

begin;

set local lock_timeout = '5s';
set local statement_timeout = '45s';

do $preflight$
begin
  if (
    select count(*)
    from public.team_roles
  ) <> 4
    or (
      select count(*)
      from public.capability_catalog
    ) <> 3
    or (
      select count(*)
      from public.team_role_capabilities
    ) <> 9
    or (
      select count(*)
      from public.team_authorization_audit
    ) <> 0
    or (
      select count(*)
      from public.team_members
      where role = 'admin'
    ) <> 1 then
    raise exception 'DEV_MUTATION_TEST_PREFLIGHT_DRIFT';
  end if;
end;
$preflight$;

insert into public.team_members (
  discord_user_id,
  discord_username,
  role
)
values
  (
    'auth-mut-test-non-admin',
    'auth-mut-test-non-admin',
    'trial_moderator'
  ),
  (
    'auth-mut-test-member',
    'auth-mut-test-member',
    'trial_moderator'
  ),
  (
    'auth-mut-test-admin-target',
    'auth-mut-test-admin-target',
    'moderator'
  ),
  (
    'auth-mut-test-legacy-target',
    'auth-mut-test-legacy-target',
    'trial_moderator'
  );

set local role service_role;

do $service_role_create_and_idempotency$
declare
  v_actor_id text;
  v_first jsonb;
  v_retry jsonb;
  v_role_key text :=
    'custom_10000000000000000000000000000001';
begin
  select discord_user_id
  into v_actor_id
  from public.team_members
  where role = 'admin'
  limit 1;

  v_first := public.create_team_role(
    v_actor_id,
    'Rollback Reviewer',
    'Created only inside the rollback test.',
    50,
    'Rollback-only role creation',
    '10000000-0000-0000-0000-000000000001'::uuid
  );
  v_retry := public.create_team_role(
    v_actor_id,
    'Rollback Reviewer',
    'Created only inside the rollback test.',
    50,
    'Rollback-only role creation',
    '10000000-0000-0000-0000-000000000001'::uuid
  );

  if v_first <> v_retry
    or v_first #>> '{role,key}' <> v_role_key
    or v_first #>> '{role,rowVersion}' <> '1'
    or (
      select count(*)
      from public.team_roles
      where key = v_role_key
        and is_system = false
        and is_active = true
        and row_version = 1
    ) <> 1
    or exists (
      select 1
      from public.team_role_capabilities
      where role_key = v_role_key
    )
    or (
      select count(*)
      from public.team_authorization_audit
      where idempotency_key =
        '10000000-0000-0000-0000-000000000001'::uuid
        and event_type = 'role_created'
        and request_hash ~ '^[0-9a-f]{64}$'
    ) <> 1 then
    raise exception 'ROLE_CREATE_OR_IDEMPOTENCY_FAILED';
  end if;

  begin
    perform public.create_team_role(
      v_actor_id,
      'Rollback Reviewer',
      'Created only inside the rollback test.',
      50,
      'Rollback-only different reason',
      '10000000-0000-0000-0000-000000000001'::uuid
    );
    raise exception 'IDEMPOTENCY_CONFLICT_NOT_REJECTED';
  exception
    when sqlstate '22023' then
      if sqlerrm <> 'TEAM_AUTH_IDEMPOTENCY_CONFLICT' then
        raise;
      end if;
  end;
end;
$service_role_create_and_idempotency$;

reset role;

do $role_and_capability_tests$
declare
  v_actor_id text;
  v_role_key text :=
    'custom_10000000000000000000000000000001';
  v_version bigint;
  v_capability_version integer;
  v_capability_hash text;
  v_result jsonb;
  v_retry jsonb;
  v_audit_count bigint;
begin
  select discord_user_id
  into v_actor_id
  from public.team_members
  where role = 'admin'
  limit 1;

  v_result := public.update_team_role(
    v_actor_id,
    v_role_key,
    'Rollback Senior Reviewer',
    'Updated only inside the rollback test.',
    60,
    1,
    'Rollback-only metadata update',
    '10000000-0000-0000-0000-000000000002'::uuid
  );
  v_retry := public.update_team_role(
    v_actor_id,
    v_role_key,
    'Rollback Senior Reviewer',
    'Updated only inside the rollback test.',
    60,
    1,
    'Rollback-only metadata update',
    '10000000-0000-0000-0000-000000000002'::uuid
  );

  if v_result <> v_retry
    or v_result #>> '{role,rowVersion}' <> '2'
    or (
      select count(*)
      from public.team_authorization_audit
      where idempotency_key =
        '10000000-0000-0000-0000-000000000002'::uuid
    ) <> 1 then
    raise exception 'ROLE_UPDATE_OR_RETRY_FAILED';
  end if;

  begin
    perform public.update_team_role(
      v_actor_id,
      v_role_key,
      'Stale update',
      'Must fail.',
      61,
      1,
      'Rollback-only stale version',
      '10000000-0000-0000-0000-000000000003'::uuid
    );
    raise exception 'STALE_ROLE_VERSION_ACCEPTED';
  exception
    when serialization_failure then
      if sqlerrm <> 'TEAM_ROLE_VERSION_CONFLICT' then
        raise;
      end if;
  end;

  begin
    perform public.update_team_role(
      v_actor_id,
      'admin',
      'Changed Admin',
      'Must fail.',
      0,
      1,
      'Rollback-only admin mutation',
      '10000000-0000-0000-0000-000000000004'::uuid
    );
    raise exception 'ADMIN_ROLE_METADATA_MUTATION_ACCEPTED';
  exception
    when insufficient_privilege then
      if sqlerrm <> 'ADMIN_ROLE_IMMUTABLE' then
        raise;
      end if;
  end;

  select count(*)
  into v_audit_count
  from public.team_authorization_audit;

  v_result := public.update_team_role(
    v_actor_id,
    v_role_key,
    'Rollback Senior Reviewer',
    'Updated only inside the rollback test.',
    60,
    2,
    'Rollback-only no-op',
    '10000000-0000-0000-0000-000000000005'::uuid
  );

  if (v_result ->> 'changed')::boolean
    or (
      select count(*)
      from public.team_authorization_audit
    ) <> v_audit_count then
    raise exception 'ROLE_NOOP_WROTE_AUDIT';
  end if;

  begin
    perform public.update_team_role(
      v_actor_id,
      v_role_key,
      'Rollback Senior Reviewer',
      'Updated only inside the rollback test.',
      60,
      2,
      null,
      '10000000-0000-0000-0000-000000000033'::uuid
    );
    raise exception 'NULL_REASON_ACCEPTED';
  exception
    when invalid_parameter_value then
      if sqlerrm <> 'INVALID_REASON' then
        raise;
      end if;
  end;

  select implementation_version, definition_hash
  into v_capability_version, v_capability_hash
  from public.capability_catalog
  where key = 'users.flag';

  update public.capability_catalog
  set is_active = false
  where key = 'users.flag';

  begin
    perform public.set_team_role_capability(
      v_actor_id,
      v_role_key,
      'users.flag',
      true,
      2,
      v_capability_version,
      v_capability_hash,
      'Rollback-only inactive capability',
      '10000000-0000-0000-0000-000000000006'::uuid
    );
    raise exception 'INACTIVE_CAPABILITY_ACCEPTED';
  exception
    when sqlstate '55000' then
      if sqlerrm <> 'CAPABILITY_INACTIVE' then
        raise;
      end if;
  end;

  update public.capability_catalog
  set is_active = true,
      assignable_to_non_admin = false
  where key = 'users.flag';

  begin
    perform public.set_team_role_capability(
      v_actor_id,
      v_role_key,
      'users.flag',
      true,
      2,
      v_capability_version,
      v_capability_hash,
      'Rollback-only unassignable capability',
      '10000000-0000-0000-0000-000000000007'::uuid
    );
    raise exception 'UNASSIGNABLE_CAPABILITY_ACCEPTED';
  exception
    when insufficient_privilege then
      if sqlerrm <> 'CAPABILITY_NOT_ASSIGNABLE' then
        raise;
      end if;
  end;

  update public.capability_catalog
  set assignable_to_non_admin = true
  where key = 'users.flag';

  begin
    perform public.set_team_role_capability(
      v_actor_id,
      v_role_key,
      'users.flag',
      true,
      2,
      v_capability_version,
      null,
      'Rollback-only null hash rejection',
      '10000000-0000-0000-0000-000000000034'::uuid
    );
    raise exception 'NULL_CAPABILITY_HASH_ACCEPTED';
  exception
    when invalid_parameter_value then
      if sqlerrm <> 'INVALID_CAPABILITY_MUTATION_REQUEST' then
        raise;
      end if;
  end;

  begin
    perform public.set_team_role_capability(
      v_actor_id,
      v_role_key,
      'users.flag',
      true,
      2,
      v_capability_version + 1,
      v_capability_hash,
      'Rollback-only capability drift',
      '10000000-0000-0000-0000-000000000008'::uuid
    );
    raise exception 'CAPABILITY_VERSION_DRIFT_ACCEPTED';
  exception
    when serialization_failure then
      if sqlerrm <> 'CAPABILITY_DEFINITION_CONFLICT' then
        raise;
      end if;
  end;

  begin
    perform public.set_team_role_capability(
      v_actor_id,
      v_role_key,
      'users.*',
      true,
      2,
      v_capability_version,
      v_capability_hash,
      'Rollback-only wildcard rejection',
      '10000000-0000-0000-0000-000000000009'::uuid
    );
    raise exception 'CAPABILITY_WILDCARD_ACCEPTED';
  exception
    when invalid_parameter_value then
      if sqlerrm <> 'INVALID_CAPABILITY_MUTATION_REQUEST' then
        raise;
      end if;
  end;

  begin
    perform public.set_team_role_capability(
      v_actor_id,
      'admin',
      'users.flag',
      true,
      1,
      v_capability_version,
      v_capability_hash,
      'Rollback-only admin grant rejection',
      '10000000-0000-0000-0000-000000000010'::uuid
    );
    raise exception 'ADMIN_CAPABILITY_GRANT_ACCEPTED';
  exception
    when insufficient_privilege then
      if sqlerrm <> 'ADMIN_CAPABILITY_GRANT_FORBIDDEN' then
        raise;
      end if;
  end;

  v_result := public.set_team_role_capability(
    v_actor_id,
    v_role_key,
    'users.flag',
    true,
    2,
    v_capability_version,
    v_capability_hash,
    'Rollback-only capability grant',
    '10000000-0000-0000-0000-000000000011'::uuid
  );
  v_retry := public.set_team_role_capability(
    v_actor_id,
    v_role_key,
    'users.flag',
    true,
    2,
    v_capability_version,
    v_capability_hash,
    'Rollback-only capability grant',
    '10000000-0000-0000-0000-000000000011'::uuid
  );

  if v_result <> v_retry
    or v_result ->> 'rowVersion' <> '3'
    or not exists (
      select 1
      from public.team_role_capabilities
      where role_key = v_role_key
        and capability_key = 'users.flag'
        and granted_by_discord_user_id = v_actor_id
    )
    or (
      select count(*)
      from public.team_authorization_audit
      where idempotency_key =
        '10000000-0000-0000-0000-000000000011'::uuid
    ) <> 1 then
    raise exception 'CAPABILITY_GRANT_OR_RETRY_FAILED';
  end if;

  v_result := public.set_team_role_capability(
    v_actor_id,
    v_role_key,
    'users.flag',
    false,
    3,
    v_capability_version,
    v_capability_hash,
    'Rollback-only capability revocation',
    '10000000-0000-0000-0000-000000000012'::uuid
  );

  if v_result ->> 'rowVersion' <> '4'
    or exists (
      select 1
      from public.team_role_capabilities
      where role_key = v_role_key
        and capability_key = 'users.flag'
    ) then
    raise exception 'CAPABILITY_REVOCATION_FAILED';
  end if;

  select row_version
  into v_version
  from public.team_roles
  where key = v_role_key;

  if v_version <> 4 then
    raise exception 'CAPABILITY_ROW_VERSION_FAILED';
  end if;
end;
$role_and_capability_tests$;

do $activation_and_member_tests$
declare
  v_actor_id text;
  v_role_key text :=
    'custom_10000000000000000000000000000001';
  v_version bigint;
  v_capability_version integer;
  v_capability_hash text;
  v_result jsonb;
  v_audit_count bigint;
begin
  select discord_user_id
  into v_actor_id
  from public.team_members
  where role = 'admin'
  limit 1;

  select implementation_version, definition_hash
  into v_capability_version, v_capability_hash
  from public.capability_catalog
  where key = 'users.flag';

  perform public.set_team_role_capability(
    v_actor_id,
    v_role_key,
    'users.flag',
    true,
    4,
    v_capability_version,
    v_capability_hash,
    'Rollback-only preserved capability grant',
    '10000000-0000-0000-0000-000000000013'::uuid
  );

  v_result := public.set_team_role_active(
    v_actor_id,
    v_role_key,
    false,
    5,
    'Rollback-only role deactivation',
    '10000000-0000-0000-0000-000000000014'::uuid
  );

  if v_result ->> 'rowVersion' <> '6'
    or not exists (
      select 1
      from public.team_role_capabilities
      where role_key = v_role_key
        and capability_key = 'users.flag'
    ) then
    raise exception 'ROLE_DEACTIVATION_OR_GRANT_PRESERVATION_FAILED';
  end if;

  perform public.set_team_role_active(
    v_actor_id,
    v_role_key,
    true,
    6,
    'Rollback-only role reactivation',
    '10000000-0000-0000-0000-000000000015'::uuid
  );

  v_result := public.set_team_member_non_admin_role(
    v_actor_id,
    'auth-mut-test-member',
    v_role_key,
    'trial_moderator',
    'Rollback-only custom role assignment',
    '10000000-0000-0000-0000-000000000016'::uuid
  );

  if v_result ->> 'newRole' <> v_role_key then
    raise exception 'CUSTOM_ROLE_ASSIGNMENT_FAILED';
  end if;

  select count(*)
  into v_audit_count
  from public.team_authorization_audit;

  v_result := public.set_team_member_non_admin_role(
    v_actor_id,
    'auth-mut-test-member',
    v_role_key,
    v_role_key,
    'Rollback-only member role no-op',
    '10000000-0000-0000-0000-000000000017'::uuid
  );

  if (v_result ->> 'changed')::boolean
    or (
      select count(*)
      from public.team_authorization_audit
    ) <> v_audit_count then
    raise exception 'MEMBER_ROLE_NOOP_WROTE_AUDIT';
  end if;

  begin
    perform public.set_team_role_active(
      v_actor_id,
      v_role_key,
      false,
      7,
      'Rollback-only assigned-role deactivation',
      '10000000-0000-0000-0000-000000000018'::uuid
    );
    raise exception 'ASSIGNED_ROLE_DEACTIVATION_ACCEPTED';
  exception
    when check_violation then
      if sqlerrm <> 'TEAM_ROLE_HAS_ASSIGNED_MEMBERS' then
        raise;
      end if;
  end;

  begin
    perform public.set_team_member_non_admin_role(
      v_actor_id,
      'auth-mut-test-member',
      'moderator',
      'trial_moderator',
      'Rollback-only expected-role conflict',
      '10000000-0000-0000-0000-000000000019'::uuid
    );
    raise exception 'EXPECTED_PREVIOUS_ROLE_NOT_ENFORCED';
  exception
    when serialization_failure then
      if sqlerrm <> 'TEAM_MEMBER_ROLE_CONFLICT' then
        raise;
      end if;
  end;

  begin
    perform public.set_team_member_non_admin_role(
      v_actor_id,
      'auth-mut-test-member',
      'admin',
      v_role_key,
      'Rollback-only admin transition rejection',
      '10000000-0000-0000-0000-000000000020'::uuid
    );
    raise exception 'NORMAL_MEMBER_RPC_PROMOTED_ADMIN';
  exception
    when insufficient_privilege then
      if sqlerrm <> 'ADMIN_ROLE_REQUIRES_OWNER_RPC' then
        raise;
      end if;
  end;

  begin
    perform public.set_team_member_non_admin_role(
      v_actor_id,
      v_actor_id,
      'moderator',
      'admin',
      'Rollback-only admin target rejection',
      '10000000-0000-0000-0000-000000000021'::uuid
    );
    raise exception 'NORMAL_MEMBER_RPC_DEMOTED_ADMIN';
  exception
    when insufficient_privilege then
      if sqlerrm <> 'ADMIN_ROLE_REQUIRES_OWNER_RPC' then
        raise;
      end if;
  end;

  perform public.set_team_member_non_admin_role(
    v_actor_id,
    'auth-mut-test-member',
    'trial_moderator',
    v_role_key,
    'Rollback-only restore before inactive assignment',
    '10000000-0000-0000-0000-000000000022'::uuid
  );

  perform public.set_team_role_active(
    v_actor_id,
    v_role_key,
    false,
    7,
    'Rollback-only inactive assignment setup',
    '10000000-0000-0000-0000-000000000023'::uuid
  );

  begin
    perform public.set_team_member_non_admin_role(
      v_actor_id,
      'auth-mut-test-member',
      v_role_key,
      'trial_moderator',
      'Rollback-only inactive assignment rejection',
      '10000000-0000-0000-0000-000000000024'::uuid
    );
    raise exception 'INACTIVE_ROLE_ASSIGNMENT_ACCEPTED';
  exception
    when sqlstate '55000' then
      if sqlerrm <> 'TEAM_ROLE_INACTIVE' then
        raise;
      end if;
  end;

  perform public.set_team_role_active(
    v_actor_id,
    v_role_key,
    true,
    8,
    'Rollback-only final reactivation',
    '10000000-0000-0000-0000-000000000025'::uuid
  );

  begin
    perform public.set_team_role_active(
      v_actor_id,
      'admin',
      false,
      1,
      'Rollback-only admin deactivation rejection',
      '10000000-0000-0000-0000-000000000026'::uuid
    );
    raise exception 'ADMIN_DEACTIVATION_ACCEPTED';
  exception
    when insufficient_privilege then
      if sqlerrm <> 'ADMIN_ROLE_IMMUTABLE' then
        raise;
      end if;
  end;

  select row_version
  into v_version
  from public.team_roles
  where key = v_role_key;

  if v_version <> 9 then
    raise exception 'ACTIVATION_ROW_VERSION_FAILED';
  end if;
end;
$activation_and_member_tests$;

do $admin_and_legacy_tests$
declare
  v_actor_id text;
  v_result jsonb;
  v_retry jsonb;
  v_auth_audit_count bigint;
  v_legacy_log_count bigint;
begin
  select discord_user_id
  into v_actor_id
  from public.team_members
  where role = 'admin'
  limit 1;

  v_result := public.set_team_member_admin_role(
    v_actor_id,
    'auth-mut-test-admin-target',
    true,
    'moderator',
    null,
    'Rollback-only admin promotion',
    '10000000-0000-0000-0000-000000000027'::uuid
  );
  v_retry := public.set_team_member_admin_role(
    v_actor_id,
    'auth-mut-test-admin-target',
    true,
    'moderator',
    null,
    'Rollback-only admin promotion',
    '10000000-0000-0000-0000-000000000027'::uuid
  );

  if v_result <> v_retry
    or v_result ->> 'newRole' <> 'admin'
    or exists (
      select 1
      from public.team_role_capabilities
      where role_key = 'admin'
    )
    or (
      select count(*)
      from public.team_authorization_audit
      where idempotency_key =
        '10000000-0000-0000-0000-000000000027'::uuid
    ) <> 1 then
    raise exception 'ADMIN_PROMOTION_OR_RETRY_FAILED';
  end if;

  begin
    perform public.set_team_member_admin_role(
      v_actor_id,
      'auth-mut-test-admin-target',
      false,
      'admin',
      null,
      'Rollback-only missing fallback',
      '10000000-0000-0000-0000-000000000028'::uuid
    );
    raise exception 'ADMIN_DEMOTION_WITHOUT_FALLBACK_ACCEPTED';
  exception
    when invalid_parameter_value then
      if sqlerrm <> 'ADMIN_DEMOTION_FALLBACK_REQUIRED' then
        raise;
      end if;
  end;

  update public.team_roles
  set is_active = false
  where key = 'moderator';

  begin
    perform public.set_team_member_admin_role(
      v_actor_id,
      'auth-mut-test-admin-target',
      false,
      'admin',
      'moderator',
      'Rollback-only inactive fallback',
      '10000000-0000-0000-0000-000000000029'::uuid
    );
    raise exception 'INACTIVE_ADMIN_FALLBACK_ACCEPTED';
  exception
    when sqlstate '55000' then
      if sqlerrm <> 'TEAM_ROLE_INACTIVE' then
        raise;
      end if;
  end;

  update public.team_roles
  set is_active = true
  where key = 'moderator';

  begin
    perform public.set_team_member_admin_role(
      v_actor_id,
      v_actor_id,
      false,
      'admin',
      'moderator',
      'Rollback-only self demotion',
      '10000000-0000-0000-0000-000000000030'::uuid
    );
    raise exception 'ADMIN_SELF_DEMOTION_ACCEPTED';
  exception
    when insufficient_privilege then
      if sqlerrm <> 'ADMIN_SELF_DEMOTION_FORBIDDEN' then
        raise;
      end if;
  end;

  perform public.set_team_member_admin_role(
    v_actor_id,
    'auth-mut-test-admin-target',
    false,
    'admin',
    'moderator',
    'Rollback-only valid admin demotion',
    '10000000-0000-0000-0000-000000000031'::uuid
  );

  begin
    perform public.set_team_member_admin_role(
      v_actor_id,
      v_actor_id,
      false,
      'admin',
      'moderator',
      'Rollback-only last admin rejection',
      '10000000-0000-0000-0000-000000000032'::uuid
    );
    raise exception 'LAST_ADMIN_DEMOTION_ACCEPTED';
  exception
    when check_violation then
      if sqlerrm <> 'LAST_ADMIN_PROTECTED' then
        raise;
      end if;
  end;

  select count(*)
  into v_auth_audit_count
  from public.team_authorization_audit;
  select count(*)
  into v_legacy_log_count
  from public.admin_action_logs
  where target_id = 'auth-mut-test-legacy-target';

  v_result := public.set_team_member_role(
    v_actor_id,
    'auth-mut-test-legacy-target',
    'moderator',
    'Rollback-only legacy compatibility change'
  );

  if not (v_result ->> 'changed')::boolean
    or v_result ->> 'previousRole' <> 'trial_moderator'
    or v_result ->> 'newRole' <> 'moderator'
    or (
      select count(*)
      from public.team_authorization_audit
    ) <> v_auth_audit_count + 1
    or (
      select count(*)
      from public.admin_action_logs
      where target_id = 'auth-mut-test-legacy-target'
    ) <> v_legacy_log_count + 1 then
    raise exception 'LEGACY_WRAPPER_COMPATIBILITY_FAILED';
  end if;

  begin
    perform public.set_team_member_role(
      'auth-mut-test-non-admin',
      'auth-mut-test-legacy-target',
      'trial_moderator',
      'Rollback-only non-admin actor rejection'
    );
    raise exception 'NON_ADMIN_LEGACY_ACTOR_ACCEPTED';
  exception
    when insufficient_privilege then
      if sqlerrm <> 'ACTOR_NOT_ADMIN' then
        raise;
      end if;
  end;

  begin
    perform public.set_team_member_role(
      v_actor_id,
      v_actor_id,
      null,
      'Rollback-only legacy last-admin rejection'
    );
    raise exception 'LEGACY_LAST_ADMIN_REMOVAL_ACCEPTED';
  exception
    when check_violation then
      if sqlerrm <> 'LAST_ADMIN_PROTECTED' then
        raise;
      end if;
  end;
end;
$admin_and_legacy_tests$;

do $audit_tests$
declare
  v_audit_id uuid;
begin
  if exists (
    select 1
    from public.team_authorization_audit
    where request_hash !~ '^[0-9a-f]{64}$'
      or actor_role_key <> 'admin'
      or jsonb_typeof(before_state) <> 'object'
      or jsonb_typeof(after_state) <> 'object'
  ) then
    raise exception 'AUTHORIZATION_AUDIT_SHAPE_INVALID';
  end if;

  if exists (
    select idempotency_key
    from public.team_authorization_audit
    group by idempotency_key
    having count(*) <> 1
  ) then
    raise exception 'AUTHORIZATION_AUDIT_IDEMPOTENCY_DUPLICATE';
  end if;

  select id
  into v_audit_id
  from public.team_authorization_audit
  limit 1;

  begin
    update public.team_authorization_audit
    set reason = 'Rollback-only illegal audit update'
    where id = v_audit_id;
    raise exception 'AUTHORIZATION_AUDIT_UPDATE_ACCEPTED';
  exception
    when sqlstate '55000' then
      if sqlerrm <> 'TEAM_AUTHORIZATION_AUDIT_IMMUTABLE' then
        raise;
      end if;
  end;

  begin
    delete from public.team_authorization_audit
    where id = v_audit_id;
    raise exception 'AUTHORIZATION_AUDIT_DELETE_ACCEPTED';
  exception
    when sqlstate '55000' then
      if sqlerrm <> 'TEAM_AUTHORIZATION_AUDIT_IMMUTABLE' then
        raise;
      end if;
  end;
end;
$audit_tests$;

rollback;

begin read only;

set local lock_timeout = '5s';
set local statement_timeout = '20s';

do $rollback_control$
begin
  if (
    select count(*)
    from public.team_roles
  ) <> 4
    or (
      select count(*)
      from public.capability_catalog
    ) <> 3
    or (
      select count(*)
      from public.team_role_capabilities
    ) <> 9
    or (
      select count(*)
      from public.team_authorization_audit
    ) <> 0
    or (
      select count(*)
      from public.team_members
      where role = 'admin'
    ) <> 1
    or exists (
      select 1
      from public.team_roles
      where key =
        'custom_10000000000000000000000000000001'
    )
    or exists (
      select 1
      from public.team_members
      where discord_user_id like 'auth-mut-test-%'
    )
    or exists (
      select 1
      from public.admin_action_logs
      where target_id like 'auth-mut-test-%'
    ) then
    raise exception 'DEV_MUTATION_TEST_ROLLBACK_FAILED';
  end if;
end;
$rollback_control$;

rollback;

\echo 'DEV team authorization mutation rollback tests passed.'
