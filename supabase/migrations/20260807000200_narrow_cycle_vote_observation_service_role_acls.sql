begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $preflight$
declare
  relation_name text;
  qualified_name text;
  unwanted_privilege text;
begin
  if current_user <> 'postgres'
    or not exists (select 1 from pg_roles where rolname = 'service_role')
    or not exists (select 1 from pg_roles where rolname = 'anon')
    or not exists (select 1 from pg_roles where rolname = 'authenticated') then
    raise exception using
      errcode = '55000',
      message = 'CYCLE_VOTE_OBSERVATION_ACL_ROLE_MISMATCH';
  end if;

  if to_regprocedure(
      'public.prevent_cycle_vote_observation_history_mutation()'
    ) is null
    or to_regprocedure('public.bind_cycle_vote_signal_policy()') is null
    or to_regprocedure(
      'public.queue_cycle_vote_observation_snapshot()'
    ) is null
    or to_regprocedure(
      'public.calculate_cycle_vote_observation_snapshot(bigint,integer)'
    ) is null then
    raise exception using
      errcode = '55000',
      message = 'CYCLE_VOTE_OBSERVATION_ACL_SOURCE_MISMATCH';
  end if;

  foreach relation_name in array array[
    'cycle_vote_signal_policies',
    'cycle_vote_signal_policy_state',
    'cycle_vote_signal_bindings',
    'cycle_vote_observation_snapshots',
    'cycle_vote_submission_observations',
    'cycle_vote_observation_events'
  ] loop
    qualified_name := 'public.' || relation_name;

    if to_regclass(qualified_name) is null
      or not exists (
        select 1
        from pg_class relation
        where relation.oid = to_regclass(qualified_name)
          and relation.relrowsecurity
      )
      or not has_table_privilege('service_role', qualified_name, 'SELECT') then
      raise exception using
        errcode = '55000',
        message = 'CYCLE_VOTE_OBSERVATION_ACL_SOURCE_MISMATCH';
    end if;

    foreach unwanted_privilege in array array[
      'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
    ] loop
      if not has_table_privilege(
        'service_role',
        qualified_name,
        unwanted_privilege
      ) then
        raise exception using
          errcode = '55000',
          message = 'CYCLE_VOTE_OBSERVATION_ACL_SOURCE_MISMATCH';
      end if;
    end loop;
  end loop;

  if (select count(*) from public.cycle_vote_signal_policies) <> 1
    or (select count(*) from public.cycle_vote_signal_policy_state) <> 1
    or (select count(*) from public.cycle_vote_signal_bindings) <> 0
    or (select count(*) from public.cycle_vote_observation_snapshots) <> 0
    or (select count(*) from public.cycle_vote_submission_observations) <> 0
    or (select count(*) from public.cycle_vote_observation_events) <> 0
    or not exists (
      select 1
      from public.cycle_vote_signal_policies policy
      join public.cycle_vote_signal_policy_state state
        on state.active_policy_id = policy.id
      where state.id = true
        and policy.schema_version = 1
        and policy.policy_version = 1
        and policy.mode = 'aggregate_only'
    ) then
    raise exception using
      errcode = '55000',
      message = 'CYCLE_VOTE_OBSERVATION_ACL_DATA_MISMATCH';
  end if;
end;
$preflight$;

-- The established postgres defaults intentionally grant service_role broad
-- access to future server tables. These six privacy-sensitive tables override
-- that general default with an explicit read-only application contract.
revoke all on table
  public.cycle_vote_signal_policies,
  public.cycle_vote_signal_policy_state,
  public.cycle_vote_signal_bindings,
  public.cycle_vote_observation_snapshots,
  public.cycle_vote_submission_observations,
  public.cycle_vote_observation_events
from service_role;

grant select on table
  public.cycle_vote_signal_policies,
  public.cycle_vote_signal_policy_state,
  public.cycle_vote_signal_bindings,
  public.cycle_vote_observation_snapshots,
  public.cycle_vote_submission_observations,
  public.cycle_vote_observation_events
to service_role;

do $postflight$
declare
  relation_name text;
  qualified_name text;
  forbidden_role text;
  unwanted_privilege text;
  function_row record;
begin
  if (
    select count(*)
    from pg_proc function_definition
    join pg_namespace namespace
      on namespace.oid = function_definition.pronamespace
    where namespace.nspname = 'public'
      and function_definition.proname in (
        'prevent_cycle_vote_observation_history_mutation',
        'bind_cycle_vote_signal_policy',
        'queue_cycle_vote_observation_snapshot',
        'calculate_cycle_vote_observation_snapshot'
      )
  ) <> 4 then
    raise exception using
      errcode = '55000',
      message = 'CYCLE_VOTE_OBSERVATION_FUNCTION_POSTFLIGHT_MISMATCH';
  end if;

  foreach relation_name in array array[
    'cycle_vote_signal_policies',
    'cycle_vote_signal_policy_state',
    'cycle_vote_signal_bindings',
    'cycle_vote_observation_snapshots',
    'cycle_vote_submission_observations',
    'cycle_vote_observation_events'
  ] loop
    qualified_name := 'public.' || relation_name;

    if not has_table_privilege('service_role', qualified_name, 'SELECT') then
      raise exception using
        errcode = '55000',
        message = 'CYCLE_VOTE_OBSERVATION_ACL_POSTFLIGHT_MISMATCH';
    end if;

    foreach unwanted_privilege in array array[
      'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
    ] loop
      if has_table_privilege(
        'service_role',
        qualified_name,
        unwanted_privilege
      ) then
        raise exception using
          errcode = '55000',
          message = 'CYCLE_VOTE_OBSERVATION_ACL_POSTFLIGHT_MISMATCH';
      end if;
    end loop;

    foreach forbidden_role in array array['anon', 'authenticated'] loop
      foreach unwanted_privilege in array array[
        'SELECT', 'INSERT', 'UPDATE', 'DELETE',
        'TRUNCATE', 'REFERENCES', 'TRIGGER'
      ] loop
        if has_table_privilege(
          forbidden_role,
          qualified_name,
          unwanted_privilege
        ) then
          raise exception using
            errcode = '55000',
            message = 'CYCLE_VOTE_OBSERVATION_ACL_POSTFLIGHT_MISMATCH';
        end if;
      end loop;
    end loop;
  end loop;

  for function_row in
    select
      function_definition.oid,
      function_definition.oid::regprocedure::text as signature,
      function_definition.proname,
      pg_get_userbyid(function_definition.proowner) as owner_name,
      function_definition.prosecdef,
      function_definition.proconfig
    from pg_proc function_definition
    join pg_namespace namespace
      on namespace.oid = function_definition.pronamespace
    where namespace.nspname = 'public'
      and function_definition.proname in (
        'prevent_cycle_vote_observation_history_mutation',
        'bind_cycle_vote_signal_policy',
        'queue_cycle_vote_observation_snapshot',
        'calculate_cycle_vote_observation_snapshot'
      )
  loop
    if function_row.owner_name <> 'postgres'
      or not function_row.prosecdef
      or function_row.proconfig is distinct from
        array['search_path=public, pg_temp']::text[]
      or has_function_privilege('anon', function_row.oid, 'EXECUTE')
      or has_function_privilege('authenticated', function_row.oid, 'EXECUTE')
      or (
        function_row.proname = 'calculate_cycle_vote_observation_snapshot'
        and not has_function_privilege(
          'service_role',
          function_row.oid,
          'EXECUTE'
        )
      )
      or (
        function_row.proname <> 'calculate_cycle_vote_observation_snapshot'
        and has_function_privilege(
          'service_role',
          function_row.oid,
          'EXECUTE'
        )
      ) then
      raise exception using
        errcode = '55000',
        message = 'CYCLE_VOTE_OBSERVATION_FUNCTION_POSTFLIGHT_MISMATCH';
    end if;
  end loop;

  if not found then
    raise exception using
      errcode = '55000',
      message = 'CYCLE_VOTE_OBSERVATION_FUNCTION_POSTFLIGHT_MISMATCH';
  end if;
end;
$postflight$;

commit;
