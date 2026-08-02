begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $preflight$
begin
  if current_user <> 'postgres'
    or not exists (select 1 from pg_roles where rolname = 'service_role')
    or not exists (select 1 from pg_roles where rolname = 'discord_bot')
    or not exists (select 1 from pg_roles where rolname = 'anon')
    or not exists (select 1 from pg_roles where rolname = 'authenticated')
  then
    raise exception using
      errcode = '55000',
      message = 'CYCLE_SCHEDULER_HEALTH_ROLE_BASELINE_MISMATCH';
  end if;

  if to_regclass('public.cycle_scheduler_health') is not null
    or to_regprocedure('public.begin_cycle_scheduler_run(uuid)') is not null
    or to_regprocedure('public.finish_cycle_scheduler_run(uuid,boolean,text)') is not null
    or to_regprocedure('public.process_due_cycle_transitions(bigint)') is null
  then
    raise exception using
      errcode = '55000',
      message = 'CYCLE_SCHEDULER_HEALTH_SCHEMA_BASELINE_MISMATCH';
  end if;
end;
$preflight$;

create table public.cycle_scheduler_health (
  id smallint primary key default 1,
  active_run_id uuid,
  active_run_started_at timestamptz,
  last_run_id uuid,
  last_started_at timestamptz,
  last_completed_at timestamptz,
  last_succeeded_at timestamptz,
  last_failed_at timestamptz,
  last_outcome text,
  last_duration_ms integer,
  consecutive_failures integer not null default 0,
  updated_at timestamptz not null default clock_timestamp(),
  constraint cycle_scheduler_health_singleton_check check (id = 1),
  constraint cycle_scheduler_health_active_run_check check (
    (active_run_id is null) = (active_run_started_at is null)
  ),
  constraint cycle_scheduler_health_outcome_check check (
    last_outcome is null
    or last_outcome in (
      'transitioned',
      'repaired',
      'noop',
      'diagnostic',
      'failed'
    )
  ),
  constraint cycle_scheduler_health_duration_check check (
    last_duration_ms is null
    or last_duration_ms between 0 and 3600000
  ),
  constraint cycle_scheduler_health_failures_check check (
    consecutive_failures between 0 and 1000000
  )
);

insert into public.cycle_scheduler_health (id) values (1);

alter table public.cycle_scheduler_health enable row level security;

revoke all on table public.cycle_scheduler_health
  from public, anon, authenticated, discord_bot, postgres, service_role;
grant select on table public.cycle_scheduler_health to service_role;

create function public.begin_cycle_scheduler_run(p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_health public.cycle_scheduler_health%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if p_run_id is null then
    raise exception using
      errcode = '22023',
      message = 'CYCLE_SCHEDULER_RUN_ID_REQUIRED';
  end if;

  select * into strict v_health
  from public.cycle_scheduler_health
  where id = 1
  for update;

  if v_health.active_run_id = p_run_id then
    return jsonb_build_object('outcome', 'resumed');
  end if;

  if v_health.active_run_id is null and v_health.last_run_id = p_run_id then
    return jsonb_build_object('outcome', 'replay');
  end if;

  update public.cycle_scheduler_health
  set
    last_run_id = case
      when active_run_id is null then last_run_id
      else active_run_id
    end,
    last_completed_at = case
      when active_run_id is null then last_completed_at
      else v_now
    end,
    last_failed_at = case
      when active_run_id is null then last_failed_at
      else v_now
    end,
    last_outcome = case
      when active_run_id is null then last_outcome
      else 'failed'
    end,
    last_duration_ms = case
      when active_run_started_at is null then last_duration_ms
      else least(
        3600000,
        greatest(
          0,
          floor(extract(epoch from (v_now - active_run_started_at)) * 1000)::integer
        )
      )
    end,
    consecutive_failures = case
      when active_run_id is null then consecutive_failures
      else least(1000000, consecutive_failures + 1)
    end,
    active_run_id = p_run_id,
    active_run_started_at = v_now,
    last_started_at = v_now,
    updated_at = v_now
  where id = 1;

  return jsonb_build_object('outcome', 'started');
end;
$$;

create function public.finish_cycle_scheduler_run(
  p_run_id uuid,
  p_succeeded boolean,
  p_outcome text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_health public.cycle_scheduler_health%rowtype;
  v_now timestamptz := clock_timestamp();
  v_duration_ms integer;
begin
  if p_run_id is null
    or p_succeeded is null
    or p_outcome is null
    or (
      p_succeeded
      and p_outcome not in ('transitioned', 'repaired', 'noop', 'diagnostic')
    )
    or (not p_succeeded and p_outcome <> 'failed')
  then
    raise exception using
      errcode = '22023',
      message = 'CYCLE_SCHEDULER_RESULT_INVALID';
  end if;

  select * into strict v_health
  from public.cycle_scheduler_health
  where id = 1
  for update;

  if v_health.active_run_id is null and v_health.last_run_id = p_run_id then
    return jsonb_build_object('outcome', 'replay');
  end if;

  if v_health.active_run_id is distinct from p_run_id then
    return jsonb_build_object('outcome', 'stale');
  end if;

  v_duration_ms := least(
    3600000,
    greatest(
      0,
      floor(extract(epoch from (v_now - v_health.active_run_started_at)) * 1000)::integer
    )
  );

  update public.cycle_scheduler_health
  set
    active_run_id = null,
    active_run_started_at = null,
    last_run_id = p_run_id,
    last_completed_at = v_now,
    last_succeeded_at = case when p_succeeded then v_now else last_succeeded_at end,
    last_failed_at = case when p_succeeded then last_failed_at else v_now end,
    last_outcome = p_outcome,
    last_duration_ms = v_duration_ms,
    consecutive_failures = case
      when p_succeeded then 0
      else least(1000000, consecutive_failures + 1)
    end,
    updated_at = v_now
  where id = 1;

  return jsonb_build_object('outcome', 'recorded');
end;
$$;

alter function public.begin_cycle_scheduler_run(uuid) owner to postgres;
alter function public.finish_cycle_scheduler_run(uuid, boolean, text) owner to postgres;

revoke all on function public.begin_cycle_scheduler_run(uuid)
  from public, anon, authenticated, discord_bot, postgres, service_role;
revoke all on function public.finish_cycle_scheduler_run(uuid, boolean, text)
  from public, anon, authenticated, discord_bot, postgres, service_role;
grant execute on function public.begin_cycle_scheduler_run(uuid) to service_role;
grant execute on function public.finish_cycle_scheduler_run(uuid, boolean, text) to service_role;

comment on table public.cycle_scheduler_health is
  'Server-only singleton health state for the external cycle scheduler.';
comment on column public.cycle_scheduler_health.active_run_id is
  'Stable scheduler run identifier while an invocation is active.';
comment on column public.cycle_scheduler_health.consecutive_failures is
  'Bounded count of failed or abandoned runs since the latest success.';

do $postflight$
declare
  v_signature text;
  v_function regprocedure;
begin
  if not exists (
    select 1
    from pg_class c
    where c.oid = 'public.cycle_scheduler_health'::regclass
      and c.relrowsecurity
      and pg_get_userbyid(c.relowner) = 'postgres'
  )
    or (select count(*) from public.cycle_scheduler_health) <> 1
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
      message = 'CYCLE_SCHEDULER_HEALTH_TABLE_POSTFLIGHT_FAILED';
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
      or has_function_privilege('anon', v_function, 'EXECUTE')
      or has_function_privilege('authenticated', v_function, 'EXECUTE')
      or has_function_privilege('discord_bot', v_function, 'EXECUTE')
      or not has_function_privilege('service_role', v_function, 'EXECUTE')
    then
      raise exception using
        errcode = '55000',
        message = 'CYCLE_SCHEDULER_HEALTH_FUNCTION_POSTFLIGHT_FAILED',
        detail = v_signature;
    end if;
  end loop;
end;
$postflight$;

commit;
