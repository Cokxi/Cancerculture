\set ON_ERROR_STOP on

begin;

set local lock_timeout = '5s';
set local statement_timeout = '45s';

create temporary table team_authorization_batch_test_context (
  baseline_roles bigint not null,
  baseline_catalog bigint not null,
  baseline_grants bigint not null,
  baseline_members bigint not null,
  baseline_audit bigint not null,
  baseline_batches bigint not null
) on commit drop;

insert into pg_temp.team_authorization_batch_test_context
select
  (select count(*) from public.team_roles),
  (select count(*) from public.capability_catalog),
  (select count(*) from public.team_role_capabilities),
  (select count(*) from public.team_members),
  (select count(*) from public.team_authorization_audit),
  (select count(*) from public.team_authorization_batches);

do $setup$
begin
  if exists (
    select 1
    from public.team_roles
    where key in (
      'custom_batch_test_a',
      'custom_batch_test_b',
      'custom_batch_test_inactive'
    )
  )
    or exists (
      select 1
      from public.team_members
      where discord_user_id = '99999999999998001'
    )
    or exists (
      select 1
      from public.team_authorization_batches
      where idempotency_key::text like
        '40000000-0000-0000-0000-%'
    ) then
    raise exception 'DEV_BATCH_TEST_SYNTHETIC_COLLISION';
  end if;

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
      'custom_batch_test_a',
      'Rollback Batch Role A',
      'Rollback-only active batch role.',
      false,
      true,
      9100
    ),
    (
      'custom_batch_test_b',
      'Rollback Batch Role B',
      'Rollback-only active batch role.',
      false,
      true,
      9101
    ),
    (
      'custom_batch_test_inactive',
      'Rollback Inactive Batch Role',
      'Rollback-only inactive batch role.',
      false,
      false,
      9102
    );

  insert into public.team_members (
    discord_user_id,
    discord_username,
    role
  )
  values (
    '99999999999998001',
    'rollback-batch-non-admin',
    'trial_moderator'
  );
end;
$setup$;

create function pg_temp.expect_capability_batch_error(
  p_actor text,
  p_roles jsonb,
  p_capabilities jsonb,
  p_changes jsonb,
  p_reason text,
  p_key uuid,
  p_expected_state text,
  p_expected_message text
)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
declare
  v_state text;
  v_message text;
begin
  begin
    perform public.apply_team_role_capability_changes(
      p_actor,
      p_roles,
      p_capabilities,
      p_changes,
      p_reason,
      p_key
    );
    raise exception 'EXPECTED_BATCH_ERROR_NOT_RAISED';
  exception
    when others then
      get stacked diagnostics
        v_state = returned_sqlstate,
        v_message = message_text;
      if v_state <> p_expected_state
        or v_message <> p_expected_message then
        raise exception
          'UNEXPECTED_BATCH_ERROR state=% message=% expected_state=% expected_message=%',
          v_state,
          v_message,
          p_expected_state,
          p_expected_message;
      end if;
  end;
end;
$function$;

create function pg_temp.set_batch_test_capability_flags(
  p_is_active boolean,
  p_is_assignable boolean
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $function$
  update public.capability_catalog
  set is_active = p_is_active,
      assignable_to_non_admin = p_is_assignable
  where key = 'users.flag';
$function$;

grant execute on function pg_temp.expect_capability_batch_error(
  text, jsonb, jsonb, jsonb, text, uuid, text, text
) to service_role;
grant execute on function pg_temp.set_batch_test_capability_flags(
  boolean, boolean
) to service_role;
grant select on table pg_temp.team_authorization_batch_test_context
  to service_role;

set local role service_role;

do $positive_batch_tests$
declare
  v_actor text;
  v_roles jsonb;
  v_capabilities jsonb;
  v_changes jsonb;
  v_reordered_roles jsonb;
  v_reordered_capabilities jsonb;
  v_reordered_changes jsonb;
  v_first jsonb;
  v_retry jsonb;
  v_noop jsonb;
  v_mixed jsonb;
  v_batch_id text;
  v_audit_before bigint;
  v_version_a bigint;
  v_version_b bigint;
  v_capability_version integer;
  v_capability_hash text;
  v_single jsonb;
begin
  select discord_user_id
  into v_actor
  from public.team_members
  where role = 'admin'
  order by discord_user_id
  limit 1;

  select jsonb_agg(
    jsonb_build_object(
      'role_key', role_row.key,
      'expected_row_version', role_row.row_version
    )
    order by role_row.key
  )
  into v_roles
  from public.team_roles role_row
  where role_row.key in (
    'custom_batch_test_a',
    'custom_batch_test_b'
  );

  select jsonb_agg(
    jsonb_build_object(
      'capability_key', capability_row.key,
      'expected_implementation_version',
        capability_row.implementation_version,
      'expected_definition_hash',
        capability_row.definition_hash
    )
    order by capability_row.key
  )
  into v_capabilities
  from public.capability_catalog capability_row;

  v_changes := jsonb_build_array(
    jsonb_build_object(
      'role_key', 'custom_batch_test_a',
      'capability_key',
        'submissions.submission_phase.moderate',
      'desired_granted', true
    ),
    jsonb_build_object(
      'role_key', 'custom_batch_test_a',
      'capability_key', 'users.directory.basic.view',
      'desired_granted', false
    ),
    jsonb_build_object(
      'role_key', 'custom_batch_test_a',
      'capability_key', 'users.flag',
      'desired_granted', true
    ),
    jsonb_build_object(
      'role_key', 'custom_batch_test_b',
      'capability_key',
        'submissions.submission_phase.moderate',
      'desired_granted', true
    ),
    jsonb_build_object(
      'role_key', 'custom_batch_test_b',
      'capability_key', 'users.directory.basic.view',
      'desired_granted', false
    )
  );

  v_first := public.apply_team_role_capability_changes(
    v_actor,
    v_roles,
    v_capabilities,
    v_changes,
    'Rollback multi-role capability batch',
    '40000000-0000-0000-0000-000000000001'::uuid
  );
  v_batch_id := v_first ->> 'batchId';

  if v_first ->> 'operation' <>
      'apply_team_role_capability_changes'
    or (v_first ->> 'replayed')::boolean
    or (v_first ->> 'submittedCount')::integer <> 5
    or (v_first ->> 'changedCount')::integer <> 3
    or (v_first ->> 'noopCount')::integer <> 2
    or (v_first ->> 'grantCount')::integer <> 3
    or (v_first ->> 'revokeCount')::integer <> 0
    or jsonb_array_length(v_first -> 'affectedRoles') <> 2
    or (
      select count(*)
      from public.team_authorization_batches
      where idempotency_key =
        '40000000-0000-0000-0000-000000000001'::uuid
        and batch_id::text = v_batch_id
        and submitted_pair_count = 5
        and changed_pair_count = 3
        and noop_pair_count = 2
        and grant_count = 3
        and revoke_count = 0
        and affected_role_count = 2
        and result = v_first
    ) <> 1
    or (
      select count(*)
      from public.team_authorization_audit
      where request_id = v_batch_id
        and event_type = 'capability_granted'
        and request_hash ~ '^[0-9a-f]{64}$'
    ) <> 3
    or exists (
      select 1
      from public.team_authorization_audit
      where request_id = v_batch_id
        and (
          before_state ->> 'batchId' <> v_batch_id
          or after_state ->> 'batchId' <> v_batch_id
          or before_state ->> 'rowVersion' <> '1'
          or after_state ->> 'rowVersion' <> '2'
        )
    )
    or (
      select count(*)
      from public.team_role_capabilities
      where role_key in (
        'custom_batch_test_a',
        'custom_batch_test_b'
      )
    ) <> 3
    or (
      select count(*)
      from public.team_roles
      where key in (
        'custom_batch_test_a',
        'custom_batch_test_b'
      )
        and row_version = 2
    ) <> 2 then
    raise exception 'POSITIVE_MULTI_ROLE_BATCH_FAILED';
  end if;

  select jsonb_agg(value order by value ->> 'role_key' desc)
  into v_reordered_roles
  from jsonb_array_elements(v_roles);
  select jsonb_agg(
    value order by value ->> 'capability_key' desc
  )
  into v_reordered_capabilities
  from jsonb_array_elements(v_capabilities);
  select jsonb_agg(
    value
    order by
      value ->> 'role_key' desc,
      value ->> 'capability_key' desc
  )
  into v_reordered_changes
  from jsonb_array_elements(v_changes);

  v_retry := public.apply_team_role_capability_changes(
    v_actor,
    v_reordered_roles,
    v_reordered_capabilities,
    v_reordered_changes,
    'Rollback multi-role capability batch',
    '40000000-0000-0000-0000-000000000001'::uuid
  );

  if not (v_retry ->> 'replayed')::boolean
    or v_retry - 'replayed' <> v_first - 'replayed'
    or (
      select count(*)
      from public.team_authorization_batches
      where idempotency_key =
        '40000000-0000-0000-0000-000000000001'::uuid
    ) <> 1
    or (
      select count(*)
      from public.team_authorization_audit
      where request_id = v_batch_id
    ) <> 3 then
    raise exception 'ORDER_INDEPENDENT_REPLAY_FAILED';
  end if;

  perform pg_temp.expect_capability_batch_error(
    v_actor,
    v_roles,
    v_capabilities,
    v_changes,
    'Different payload for same idempotency key',
    '40000000-0000-0000-0000-000000000001'::uuid,
    '22023',
    'TEAM_AUTH_IDEMPOTENCY_CONFLICT'
  );

  select jsonb_agg(
    jsonb_build_object(
      'role_key', role_row.key,
      'expected_row_version', role_row.row_version
    )
    order by role_row.key
  )
  into v_roles
  from public.team_roles role_row
  where role_row.key in (
    'custom_batch_test_a',
    'custom_batch_test_b'
  );

  select count(*)
  into v_audit_before
  from public.team_authorization_audit;

  v_noop := public.apply_team_role_capability_changes(
    v_actor,
    v_roles,
    v_capabilities,
    v_changes,
    'Rollback full no-op capability batch',
    '40000000-0000-0000-0000-000000000002'::uuid
  );

  if (v_noop ->> 'changedCount')::integer <> 0
    or (v_noop ->> 'noopCount')::integer <> 5
    or jsonb_array_length(v_noop -> 'affectedRoles') <> 0
    or (
      select count(*)
      from public.team_authorization_audit
    ) <> v_audit_before
    or (
      select count(*)
      from public.team_roles
      where key in (
        'custom_batch_test_a',
        'custom_batch_test_b'
      )
        and row_version = 2
    ) <> 2 then
    raise exception 'FULL_NOOP_BATCH_FAILED';
  end if;

  v_changes := jsonb_build_array(
    jsonb_build_object(
      'role_key', 'custom_batch_test_a',
      'capability_key',
        'submissions.submission_phase.moderate',
      'desired_granted', false
    ),
    jsonb_build_object(
      'role_key', 'custom_batch_test_a',
      'capability_key', 'users.directory.basic.view',
      'desired_granted', true
    ),
    jsonb_build_object(
      'role_key', 'custom_batch_test_a',
      'capability_key', 'users.flag',
      'desired_granted', true
    )
  );
  select jsonb_agg(
    jsonb_build_object(
      'role_key', role_row.key,
      'expected_row_version', role_row.row_version
    )
  )
  into v_roles
  from public.team_roles role_row
  where role_row.key = 'custom_batch_test_a';

  v_mixed := public.apply_team_role_capability_changes(
    v_actor,
    v_roles,
    v_capabilities,
    v_changes,
    'Rollback mixed grant revoke and no-op batch',
    '40000000-0000-0000-0000-000000000003'::uuid
  );

  if (v_mixed ->> 'submittedCount')::integer <> 3
    or (v_mixed ->> 'changedCount')::integer <> 2
    or (v_mixed ->> 'noopCount')::integer <> 1
    or (v_mixed ->> 'grantCount')::integer <> 1
    or (v_mixed ->> 'revokeCount')::integer <> 1
    or jsonb_array_length(v_mixed -> 'affectedRoles') <> 1
    or (
      select row_version
      from public.team_roles
      where key = 'custom_batch_test_a'
    ) <> 3
    or (
      select count(*)
      from public.team_authorization_audit
      where request_id = v_mixed ->> 'batchId'
    ) <> 2 then
    raise exception 'MIXED_BATCH_OR_SINGLE_ROLE_VERSION_FAILED';
  end if;

  select implementation_version, definition_hash
  into v_capability_version, v_capability_hash
  from public.capability_catalog
  where key = 'users.flag';
  select row_version
  into v_version_b
  from public.team_roles
  where key = 'custom_batch_test_b';

  v_single := public.set_team_role_capability(
    v_actor,
    'custom_batch_test_b',
    'users.flag',
    true,
    v_version_b,
    v_capability_version,
    v_capability_hash,
    'Rollback existing single RPC regression',
    '40000000-0000-0000-0000-000000000004'::uuid
  );

  if not (v_single ->> 'changed')::boolean
    or v_single ->> 'rowVersion' <> (v_version_b + 1)::text
    or (
      select request_id
      from public.team_authorization_audit
      where idempotency_key =
        '40000000-0000-0000-0000-000000000004'::uuid
    ) is not null then
    raise exception 'EXISTING_SINGLE_RPC_REGRESSION_FAILED';
  end if;

  perform public.update_team_role(
    v_actor,
    'custom_batch_test_b',
    'Rollback Batch Role B Updated',
    'Rollback-only metadata mutation regression.',
    9201,
    v_version_b + 1,
    'Rollback existing metadata RPC regression',
    '40000000-0000-0000-0000-000000000005'::uuid
  );

  select row_version
  into v_version_a
  from public.team_roles
  where key = 'custom_batch_test_a';
  select row_version
  into v_version_b
  from public.team_roles
  where key = 'custom_batch_test_b';

  if v_version_a <> 3 or v_version_b <> 4 then
    raise exception 'EXISTING_METADATA_RPC_REGRESSION_FAILED';
  end if;
end;
$positive_batch_tests$;

do $negative_batch_tests$
declare
  v_actor text;
  v_non_admin text := '99999999999998001';
  v_role_a jsonb;
  v_role_b jsonb;
  v_roles jsonb;
  v_inactive_role jsonb;
  v_capability jsonb;
  v_other_capability jsonb;
  v_capabilities jsonb;
  v_change jsonb;
  v_other_change jsonb;
  v_role_version bigint;
  v_capability_version integer;
  v_capability_hash text;
  v_before_grants bigint;
  v_before_audit bigint;
  v_before_batches bigint;
begin
  select discord_user_id
  into v_actor
  from public.team_members
  where role = 'admin'
  order by discord_user_id
  limit 1;

  select row_version
  into v_role_version
  from public.team_roles
  where key = 'custom_batch_test_a';
  v_role_a := jsonb_build_object(
    'role_key', 'custom_batch_test_a',
    'expected_row_version', v_role_version
  );
  v_role_b := jsonb_build_object(
    'role_key', 'custom_batch_test_b',
    'expected_row_version',
      (
        select row_version
        from public.team_roles
        where key = 'custom_batch_test_b'
      )
  );
  v_inactive_role := jsonb_build_object(
    'role_key', 'custom_batch_test_inactive',
    'expected_row_version', 1
  );
  v_roles := jsonb_build_array(v_role_a);

  select implementation_version, definition_hash
  into v_capability_version, v_capability_hash
  from public.capability_catalog
  where key = 'users.flag';
  v_capability := jsonb_build_object(
    'capability_key', 'users.flag',
    'expected_implementation_version', v_capability_version,
    'expected_definition_hash', v_capability_hash
  );
  select jsonb_build_object(
    'capability_key', capability_row.key,
    'expected_implementation_version',
      capability_row.implementation_version,
    'expected_definition_hash', capability_row.definition_hash
  )
  into v_other_capability
  from public.capability_catalog capability_row
  where capability_row.key =
    'users.directory.basic.view';
  v_capabilities := jsonb_build_array(v_capability);
  v_change := jsonb_build_object(
    'role_key', 'custom_batch_test_a',
    'capability_key', 'users.flag',
    'desired_granted', false
  );
  v_other_change := jsonb_build_object(
    'role_key', 'custom_batch_test_a',
    'capability_key', 'users.directory.basic.view',
    'desired_granted', false
  );

  perform pg_temp.expect_capability_batch_error(
    v_non_admin,
    v_roles,
    v_capabilities,
    jsonb_build_array(v_change),
    'Rollback non-admin actor rejection',
    '40000000-0000-0000-0000-000000000101'::uuid,
    '42501',
    'ACTOR_NOT_ADMIN'
  );

  perform pg_temp.expect_capability_batch_error(
    v_actor,
    jsonb_build_array(jsonb_build_object(
      'role_key', 'admin',
      'expected_row_version', 1
    )),
    v_capabilities,
    jsonb_build_array(jsonb_build_object(
      'role_key', 'admin',
      'capability_key', 'users.flag',
      'desired_granted', false
    )),
    'Rollback admin role rejection',
    '40000000-0000-0000-0000-000000000102'::uuid,
    '42501',
    'ADMIN_CAPABILITY_GRANT_FORBIDDEN'
  );

  perform pg_temp.expect_capability_batch_error(
    v_actor,
    jsonb_build_array(jsonb_build_object(
      'role_key', 'custom_batch_test_missing',
      'expected_row_version', 1
    )),
    v_capabilities,
    jsonb_build_array(jsonb_build_object(
      'role_key', 'custom_batch_test_missing',
      'capability_key', 'users.flag',
      'desired_granted', true
    )),
    'Rollback unknown role rejection',
    '40000000-0000-0000-0000-000000000103'::uuid,
    'P0002',
    'TEAM_ROLE_NOT_FOUND'
  );

  perform pg_temp.expect_capability_batch_error(
    v_actor,
    jsonb_build_array(v_inactive_role),
    v_capabilities,
    jsonb_build_array(jsonb_build_object(
      'role_key', 'custom_batch_test_inactive',
      'capability_key', 'users.flag',
      'desired_granted', true
    )),
    'Rollback inactive role rejection',
    '40000000-0000-0000-0000-000000000104'::uuid,
    '55000',
    'TEAM_ROLE_INACTIVE'
  );

  perform pg_temp.expect_capability_batch_error(
    v_actor,
    v_roles,
    jsonb_build_array(jsonb_build_object(
      'capability_key', 'users.missing',
      'expected_implementation_version', 1,
      'expected_definition_hash',
        repeat('0', 64)
    )),
    jsonb_build_array(jsonb_build_object(
      'role_key', 'custom_batch_test_a',
      'capability_key', 'users.missing',
      'desired_granted', true
    )),
    'Rollback unknown capability rejection',
    '40000000-0000-0000-0000-000000000105'::uuid,
    'P0002',
    'CAPABILITY_NOT_FOUND'
  );

  perform pg_temp.set_batch_test_capability_flags(false, true);
  perform pg_temp.expect_capability_batch_error(
    v_actor,
    v_roles,
    v_capabilities,
    jsonb_build_array(v_change),
    'Rollback inactive capability rejection',
    '40000000-0000-0000-0000-000000000106'::uuid,
    '55000',
    'CAPABILITY_INACTIVE'
  );
  perform pg_temp.set_batch_test_capability_flags(true, false);
  perform pg_temp.expect_capability_batch_error(
    v_actor,
    v_roles,
    v_capabilities,
    jsonb_build_array(v_change),
    'Rollback unassignable capability rejection',
    '40000000-0000-0000-0000-000000000107'::uuid,
    '42501',
    'CAPABILITY_NOT_ASSIGNABLE'
  );
  perform pg_temp.set_batch_test_capability_flags(true, true);

  perform pg_temp.expect_capability_batch_error(
    v_actor,
    jsonb_build_array(
      v_role_a || jsonb_build_object(
        'expected_row_version', v_role_version - 1
      )
    ),
    v_capabilities,
    jsonb_build_array(v_change),
    'Rollback stale role version rejection',
    '40000000-0000-0000-0000-000000000108'::uuid,
    '40001',
    'TEAM_ROLE_VERSION_CONFLICT'
  );

  perform pg_temp.expect_capability_batch_error(
    v_actor,
    v_roles,
    jsonb_build_array(
      v_capability || jsonb_build_object(
        'expected_implementation_version',
          v_capability_version + 1
      )
    ),
    jsonb_build_array(v_change),
    'Rollback stale implementation rejection',
    '40000000-0000-0000-0000-000000000109'::uuid,
    '40001',
    'CAPABILITY_IMPLEMENTATION_VERSION_CONFLICT'
  );

  perform pg_temp.expect_capability_batch_error(
    v_actor,
    v_roles,
    jsonb_build_array(
      v_capability || jsonb_build_object(
        'expected_definition_hash', repeat('f', 64)
      )
    ),
    jsonb_build_array(v_change),
    'Rollback definition hash rejection',
    '40000000-0000-0000-0000-000000000110'::uuid,
    '40001',
    'CAPABILITY_DEFINITION_CONFLICT'
  );

  perform pg_temp.expect_capability_batch_error(
    v_actor,
    jsonb_build_array(v_role_a, v_role_a),
    v_capabilities,
    jsonb_build_array(v_change),
    'Rollback duplicate role snapshot rejection',
    '40000000-0000-0000-0000-000000000111'::uuid,
    '22023',
    'DUPLICATE_ROLE_SNAPSHOT'
  );

  perform pg_temp.expect_capability_batch_error(
    v_actor,
    v_roles,
    jsonb_build_array(v_capability, v_capability),
    jsonb_build_array(v_change),
    'Rollback duplicate capability snapshot rejection',
    '40000000-0000-0000-0000-000000000112'::uuid,
    '22023',
    'DUPLICATE_CAPABILITY_SNAPSHOT'
  );

  perform pg_temp.expect_capability_batch_error(
    v_actor,
    v_roles,
    v_capabilities,
    jsonb_build_array(v_change, v_change),
    'Rollback duplicate pair rejection',
    '40000000-0000-0000-0000-000000000113'::uuid,
    '22023',
    'DUPLICATE_CAPABILITY_CHANGE'
  );

  perform pg_temp.expect_capability_batch_error(
    v_actor,
    '[]'::jsonb,
    v_capabilities,
    jsonb_build_array(v_change),
    'Rollback missing role snapshot rejection',
    '40000000-0000-0000-0000-000000000114'::uuid,
    '22023',
    'CAPABILITY_BATCH_ROLE_SNAPSHOT_MISMATCH'
  );

  perform pg_temp.expect_capability_batch_error(
    v_actor,
    jsonb_build_array(v_role_a, v_role_b),
    v_capabilities,
    jsonb_build_array(v_change),
    'Rollback excess role snapshot rejection',
    '40000000-0000-0000-0000-000000000115'::uuid,
    '22023',
    'CAPABILITY_BATCH_ROLE_SNAPSHOT_MISMATCH'
  );

  perform pg_temp.expect_capability_batch_error(
    v_actor,
    v_roles,
    '[]'::jsonb,
    jsonb_build_array(v_change),
    'Rollback missing capability snapshot rejection',
    '40000000-0000-0000-0000-000000000116'::uuid,
    '22023',
    'CAPABILITY_BATCH_CAPABILITY_SNAPSHOT_MISMATCH'
  );

  perform pg_temp.expect_capability_batch_error(
    v_actor,
    v_roles,
    jsonb_build_array(v_capability, v_other_capability),
    jsonb_build_array(v_change),
    'Rollback excess capability snapshot rejection',
    '40000000-0000-0000-0000-000000000117'::uuid,
    '22023',
    'CAPABILITY_BATCH_CAPABILITY_SNAPSHOT_MISMATCH'
  );

  perform pg_temp.expect_capability_batch_error(
    v_actor,
    '[]'::jsonb,
    '[]'::jsonb,
    '[]'::jsonb,
    'Rollback empty batch rejection',
    '40000000-0000-0000-0000-000000000118'::uuid,
    '22023',
    'CAPABILITY_BATCH_EMPTY'
  );

  perform pg_temp.expect_capability_batch_error(
    v_actor,
    v_roles,
    v_capabilities,
    (
      select jsonb_agg(v_change)
      from generate_series(1, 501)
    ),
    'Rollback oversized batch rejection',
    '40000000-0000-0000-0000-000000000119'::uuid,
    '22023',
    'CAPABILITY_BATCH_TOO_LARGE'
  );

  perform pg_temp.expect_capability_batch_error(
    v_actor,
    v_roles,
    v_capabilities,
    jsonb_build_array(v_change),
    'x',
    '40000000-0000-0000-0000-000000000120'::uuid,
    '22023',
    'INVALID_REASON'
  );

  perform pg_temp.expect_capability_batch_error(
    v_actor,
    '{}'::jsonb,
    v_capabilities,
    jsonb_build_array(v_change),
    'Rollback invalid JSON shape rejection',
    '40000000-0000-0000-0000-000000000121'::uuid,
    '22023',
    'INVALID_CAPABILITY_BATCH_SHAPE'
  );

  select count(*) into v_before_grants
  from public.team_role_capabilities;
  select count(*) into v_before_audit
  from public.team_authorization_audit;
  select count(*) into v_before_batches
  from public.team_authorization_batches;

  perform pg_temp.expect_capability_batch_error(
    v_actor,
    jsonb_build_array(
      v_role_a,
      jsonb_build_object(
        'role_key', 'custom_batch_test_missing',
        'expected_row_version', 1
      )
    ),
    v_capabilities,
    jsonb_build_array(
      v_change,
      jsonb_build_object(
        'role_key', 'custom_batch_test_missing',
        'capability_key', 'users.flag',
        'desired_granted', true
      )
    ),
    'Rollback all or nothing invalid pair',
    '40000000-0000-0000-0000-000000000122'::uuid,
    'P0002',
    'TEAM_ROLE_NOT_FOUND'
  );

  if (select count(*) from public.team_role_capabilities)
      <> v_before_grants
    or (select count(*) from public.team_authorization_audit)
      <> v_before_audit
    or (select count(*) from public.team_authorization_batches)
      <> v_before_batches
    or (
      select row_version
      from public.team_roles
      where key = 'custom_batch_test_a'
    ) <> v_role_version then
    raise exception 'FAILED_BATCH_LEFT_PARTIAL_STATE';
  end if;

  if exists (
    select 1
    from public.team_authorization_batches
    where idempotency_key::text like
      '40000000-0000-0000-0000-0000000001%'
  ) then
    raise exception 'REJECTED_BATCH_WROTE_LEDGER';
  end if;
end;
$negative_batch_tests$;

reset role;

do $immutability_and_invariant_tests$
declare
  v_batch_id uuid;
  v_audit_id uuid;
begin
  select batch_id
  into v_batch_id
  from public.team_authorization_batches
  order by created_at
  limit 1;
  select id
  into v_audit_id
  from public.team_authorization_audit
  where request_id = v_batch_id::text
  limit 1;

  begin
    update public.team_authorization_batches
    set reason = 'Rollback illegal batch update'
    where batch_id = v_batch_id;
    raise exception 'BATCH_UPDATE_ACCEPTED';
  exception
    when sqlstate '55000' then
      if sqlerrm <> 'TEAM_AUTHORIZATION_BATCH_IMMUTABLE' then
        raise;
      end if;
  end;

  begin
    delete from public.team_authorization_batches
    where batch_id = v_batch_id;
    raise exception 'BATCH_DELETE_ACCEPTED';
  exception
    when sqlstate '55000' then
      if sqlerrm <> 'TEAM_AUTHORIZATION_BATCH_IMMUTABLE' then
        raise;
      end if;
  end;

  begin
    update public.team_authorization_audit
    set request_id = null
    where id = v_audit_id;
    raise exception 'BATCH_AUDIT_CORRELATION_UPDATE_ACCEPTED';
  exception
    when sqlstate '55000' then
      if sqlerrm <> 'TEAM_AUTHORIZATION_AUDIT_IMMUTABLE' then
        raise;
      end if;
  end;

  if exists (
    select 1
    from public.team_role_capabilities
    where role_key = 'admin'
  )
    or (
      select count(*)
      from public.capability_catalog
    ) <> 3
    or (
      select array_agg(key order by key)
      from public.capability_catalog
    ) <> array[
      'submissions.submission_phase.moderate',
      'users.directory.basic.view',
      'users.flag'
    ]::text[] then
    raise exception 'BATCH_AUTHORIZATION_INVARIANT_FAILED';
  end if;
end;
$immutability_and_invariant_tests$;

rollback;

begin read only;

set local lock_timeout = '5s';
set local statement_timeout = '20s';

do $rollback_control$
begin
  if exists (
    select 1
    from public.team_roles
    where key in (
      'custom_batch_test_a',
      'custom_batch_test_b',
      'custom_batch_test_inactive'
    )
  )
    or exists (
      select 1
      from public.team_members
      where discord_user_id = '99999999999998001'
    )
    or exists (
      select 1
      from public.team_authorization_batches
      where idempotency_key::text like
        '40000000-0000-0000-0000-%'
    )
    or exists (
      select 1
      from public.team_authorization_audit
      where request_id is not null
        and request_id in (
          select batch_id::text
          from public.team_authorization_batches
          where idempotency_key::text like
            '40000000-0000-0000-0000-%'
        )
    )
    or exists (
      select 1
      from public.team_role_capabilities
      where role_key like 'custom_batch_test_%'
    ) then
    raise exception 'DEV_BATCH_TEST_ROLLBACK_FAILED';
  end if;
end;
$rollback_control$;

rollback;

\echo 'DEV team authorization batch rollback tests passed.'
