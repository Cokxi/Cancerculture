begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $preflight$
declare
  v_signature text;
  v_function regprocedure;
begin
  if current_user <> 'postgres'
    or to_regclass('public.cycle_scheduler_health') is null
    or not exists (
      select 1
      from pg_class c
      where c.oid = 'public.cycle_scheduler_health'::regclass
        and pg_get_userbyid(c.relowner) = 'postgres'
        and c.relrowsecurity
    )
    or not has_table_privilege('postgres', 'public.cycle_scheduler_health', 'SELECT')
    or has_table_privilege('postgres', 'public.cycle_scheduler_health', 'UPDATE')
    or not has_table_privilege(
      'service_role',
      'public.cycle_scheduler_health',
      'SELECT'
    )
  then
    raise exception using
      errcode = '55000',
      message = 'CYCLE_SCHEDULER_OWNER_ACL_BASELINE_MISMATCH';
  end if;

  foreach v_signature in array array[
    'public.begin_cycle_scheduler_run(uuid)',
    'public.finish_cycle_scheduler_run(uuid,boolean,text)'
  ] loop
    v_function := to_regprocedure(v_signature);

    if v_function is null
      or not exists (
        select 1
        from pg_proc p
        where p.oid = v_function
          and pg_get_userbyid(p.proowner) = 'postgres'
          and p.prosecdef
          and p.proconfig = array['search_path=public, pg_temp']::text[]
      )
      or not has_function_privilege('service_role', v_function, 'EXECUTE')
    then
      raise exception using
        errcode = '55000',
        message = 'CYCLE_SCHEDULER_OWNER_ACL_FUNCTION_BASELINE_MISMATCH',
        detail = v_signature;
    end if;
  end loop;
end;
$preflight$;

grant update on table public.cycle_scheduler_health to postgres;

do $postflight$
begin
  if not has_table_privilege(
    'postgres',
    'public.cycle_scheduler_health',
    'SELECT'
  )
    or not has_table_privilege(
      'postgres',
      'public.cycle_scheduler_health',
      'UPDATE'
    )
    or has_table_privilege(
      'postgres',
      'public.cycle_scheduler_health',
      'INSERT, DELETE, TRUNCATE, REFERENCES, TRIGGER'
    )
    or exists (
      select 1
      from information_schema.role_table_grants
      where table_schema = 'public'
        and table_name = 'cycle_scheduler_health'
        and grantee in ('PUBLIC', 'anon', 'authenticated', 'discord_bot')
    )
  then
    raise exception using
      errcode = '55000',
      message = 'CYCLE_SCHEDULER_OWNER_ACL_POSTFLIGHT_FAILED';
  end if;
end;
$postflight$;

commit;
