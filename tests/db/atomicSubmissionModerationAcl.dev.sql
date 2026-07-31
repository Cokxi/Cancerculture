\set ON_ERROR_STOP on

begin read only;

set local statement_timeout = '30s';

do $acl_contract$
declare
  v_function regprocedure :=
    'public.moderate_submission(text,bigint,bigint,text,text,boolean,text,text,text,uuid)'::regprocedure;
  v_function_row record;
  v_role text;
  v_table text;
begin
  if (
    select count(*)
    from pg_proc as procedure_row
    join pg_namespace as namespace_row
      on namespace_row.oid = procedure_row.pronamespace
    where namespace_row.nspname = 'public'
      and procedure_row.proname = 'moderate_submission'
  ) <> 1 then
    raise exception 'MODERATE_SUBMISSION_SIGNATURE_COUNT_FAILED';
  end if;

  select
    pg_get_userbyid(proowner) as owner_name,
    prosecdef,
    proconfig,
    proacl
  into strict v_function_row
  from pg_proc
  where oid = v_function;

  if v_function_row.owner_name <> 'postgres'
    or not v_function_row.prosecdef
    or not ('search_path=public, pg_temp' = any(v_function_row.proconfig))
    or not has_function_privilege('postgres', v_function, 'EXECUTE')
    or not has_function_privilege('service_role', v_function, 'EXECUTE')
    or has_function_privilege('anon', v_function, 'EXECUTE')
    or has_function_privilege('authenticated', v_function, 'EXECUTE')
    or has_function_privilege('discord_bot', v_function, 'EXECUTE')
    or exists (
      select 1
      from aclexplode(v_function_row.proacl)
      where grantee = 0 and privilege_type = 'EXECUTE'
    )
  then
    raise exception 'MODERATE_SUBMISSION_FUNCTION_ACL_FAILED';
  end if;

  if not has_table_privilege(
    'service_role',
    'public.submission_moderation_requests',
    'SELECT'
  ) or has_table_privilege(
    'service_role',
    'public.submission_moderation_requests',
    'INSERT,UPDATE,DELETE,TRUNCATE'
  ) then
    raise exception 'MODERATION_LEDGER_SERVICE_ROLE_ACL_FAILED';
  end if;

  foreach v_role in array array['anon', 'authenticated', 'discord_bot']
  loop
    foreach v_table in array array[
      'submission_moderation_requests',
      'moderation_action_logs',
      'submissions',
      'team_members',
      'team_roles',
      'capability_catalog',
      'team_role_capabilities'
    ]
    loop
      if has_table_privilege(
        v_role,
        format('public.%I', v_table),
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
      ) then
        raise exception 'BROWSER_TABLE_ACL_FAILED: %.%', v_role, v_table;
      end if;
    end loop;
  end loop;
end;
$acl_contract$;

do $schema_and_catalog_contract$
begin
  if not exists (
    select 1
    from pg_class as table_row
    join pg_namespace as namespace_row
      on namespace_row.oid = table_row.relnamespace
    where namespace_row.nspname = 'public'
      and table_row.relname = 'submission_moderation_requests'
      and table_row.relowner = 'postgres'::regrole
      and table_row.relrowsecurity
  )
    or (
      select count(*)
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'moderation_action_logs'
        and column_name in (
          'moderation_request_id',
          'moderation_phase',
          'moderation_operation',
          'before_state',
          'after_state'
        )
    ) <> 5
    or not exists (
      select 1
      from pg_indexes
      where schemaname = 'public'
        and tablename = 'moderation_action_logs'
        and indexname =
          'moderation_action_logs_moderation_request_id_idx'
        and indexdef like 'CREATE UNIQUE INDEX%'
    )
    or (select count(*) from public.capability_catalog) <> 7
    or (select count(*) from public.capability_catalog where is_active) <> 6
    or (
      select count(*)
      from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 6
    or not exists (
      select 1
      from public.capability_catalog
      where key = 'submissions.submission_phase.moderate'
        and not is_active
        and not assignable_to_non_admin
        and implementation_version = 2
        and definition_hash =
          '7d62383086022588673bb5c6cc7156851f99a7815d6f305d72bbfa2e0064789b'
        and deprecated_at is not null
    )
    or exists (select 1 from public.team_role_capabilities)
  then
    raise exception 'MODERATION_SCHEMA_OR_CATALOG_CONTRACT_FAILED';
  end if;
end;
$schema_and_catalog_contract$;

rollback;
