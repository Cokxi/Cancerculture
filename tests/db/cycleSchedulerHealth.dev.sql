begin;

set local statement_timeout = '15s';
set local lock_timeout = '5s';
set local role service_role;

do $test$
declare
  v_run_1 constant uuid := '10000000-0000-7000-8000-000000000001';
  v_run_2 constant uuid := '10000000-0000-7000-8000-000000000002';
  v_run_3 constant uuid := '10000000-0000-7000-8000-000000000003';
  v_result jsonb;
  v_health public.cycle_scheduler_health%rowtype;
begin
  v_result := public.begin_cycle_scheduler_run(v_run_1);
  if v_result->>'outcome' <> 'started' then
    raise exception 'first begin was not started: %', v_result;
  end if;

  v_result := public.begin_cycle_scheduler_run(v_run_1);
  if v_result->>'outcome' <> 'resumed' then
    raise exception 'same-run retry was not resumed: %', v_result;
  end if;

  v_result := public.finish_cycle_scheduler_run(v_run_1, true, 'noop');
  if v_result->>'outcome' <> 'recorded' then
    raise exception 'successful finish was not recorded: %', v_result;
  end if;

  v_result := public.finish_cycle_scheduler_run(v_run_1, true, 'noop');
  if v_result->>'outcome' <> 'replay' then
    raise exception 'same finish was not a replay: %', v_result;
  end if;

  perform public.begin_cycle_scheduler_run(v_run_2);
  perform public.begin_cycle_scheduler_run(v_run_3);

  v_result := public.finish_cycle_scheduler_run(v_run_2, false, 'failed');
  if v_result->>'outcome' <> 'stale' then
    raise exception 'superseded finish was not stale: %', v_result;
  end if;

  v_result := public.finish_cycle_scheduler_run(v_run_3, false, 'failed');
  if v_result->>'outcome' <> 'recorded' then
    raise exception 'failed finish was not recorded: %', v_result;
  end if;

  select * into strict v_health
  from public.cycle_scheduler_health
  where id = 1;

  if v_health.active_run_id is not null
    or v_health.last_run_id <> v_run_3
    or v_health.last_outcome <> 'failed'
    or v_health.consecutive_failures <> 2
    or v_health.last_completed_at is null
    or v_health.last_failed_at is null
  then
    raise exception 'scheduler health state is inconsistent';
  end if;
end;
$test$;

rollback;

select 'cycle_scheduler_health_ok' as result;
