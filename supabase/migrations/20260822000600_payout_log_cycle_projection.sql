begin;

do $baseline$
begin
  if to_regprocedure('public.get_team_payout_logs(text,integer)') is null
    or to_regclass('public.payout_events') is null
    or to_regclass('public.cycle_prize_pools') is null
    or to_regclass('public.cycle_prize_pool_components') is null
    or to_regclass('public.cycle_prize_allocations') is null
    or to_regclass('public.payout_plans') is null
    or to_regclass('public.payout_lines') is null
    or to_regclass('public.payout_transactions') is null
    or to_regclass('public.payout_return_claims') is null
    or to_regclass('public.payout_donation_corrections') is null
    or to_regclass('public.payout_allocation_disqualifications') is null
  then
    raise exception using
      errcode = '55000',
      message = 'PAYOUT_LOG_CYCLE_PROJECTION_BASELINE_MISMATCH';
  end if;
end;
$baseline$;

create or replace function public.get_team_payout_logs(
  p_actor_discord_user_id text,
  p_limit integer default 200
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_role text;
  v_items jsonb;
begin
  v_role := public.assert_winners_payout_capability(
    p_actor_discord_user_id,
    'winners.payout_logs.view'
  );

  if p_limit not between 1 and 500 then
    raise exception using message = 'PAYOUT_INPUT_INVALID';
  end if;

  with recent_events as materialized (
    select event.*
    from public.payout_events event
    order by event.occurred_at desc, event.id desc
    limit p_limit
  ), resolved_events as (
    select
      event.*,
      case
        when event.target_type = 'pool' then (
          select pool.cycle_id
          from public.cycle_prize_pools pool
          where pool.public_id = event.target_public_id
        )
        when event.target_type = 'component' then (
          select component.cycle_id
          from public.cycle_prize_pool_components component
          where component.public_id = event.target_public_id
        )
        when event.target_type = 'allocation' then (
          select allocation.cycle_id
          from public.cycle_prize_allocations allocation
          where allocation.public_id = event.target_public_id
        )
        when event.target_type = 'plan' then (
          select allocation.cycle_id
          from public.payout_plans plan
          join public.cycle_prize_allocations allocation
            on allocation.id = plan.allocation_id
          where plan.public_id = event.target_public_id
        )
        when event.target_type = 'line' then (
          select allocation.cycle_id
          from public.payout_lines line
          join public.payout_plans plan on plan.id = line.plan_id
          join public.cycle_prize_allocations allocation
            on allocation.id = plan.allocation_id
          where line.public_id = event.target_public_id
        )
        when event.target_type = 'transaction' then (
          select allocation.cycle_id
          from public.payout_transactions transaction
          join public.payout_lines line on line.id = transaction.payout_line_id
          join public.payout_plans plan on plan.id = line.plan_id
          join public.cycle_prize_allocations allocation
            on allocation.id = plan.allocation_id
          where transaction.public_id = event.target_public_id
        )
        when event.target_type = 'return_claim' then (
          select return_claim.cycle_id
          from public.payout_return_claims return_claim
          where return_claim.public_id = event.target_public_id
        )
        when event.target_type = 'donation_correction' then (
          select allocation.cycle_id
          from public.payout_donation_corrections correction
          join public.cycle_prize_allocations allocation
            on allocation.id = correction.allocation_id
          where correction.public_id = event.target_public_id
        )
        when event.target_type = 'payout_disqualification' then (
          select allocation.cycle_id
          from public.payout_allocation_disqualifications disqualification
          join public.cycle_prize_allocations allocation
            on allocation.id = disqualification.allocation_id
          where disqualification.public_id = event.target_public_id
        )
      end as cycle_id
    from recent_events event
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'eventId', event.id,
        'eventType', event.event_type,
        'actorDiscordUserId', event.actor_discord_user_id,
        'targetType', event.target_type,
        'targetPublicId', event.target_public_id,
        'targetVersion', event.target_version,
        'requestId', event.request_id,
        'reason', event.reason,
        'details', event.details,
        'occurredAt', event.occurred_at,
        'cycleNumber', cycle.public_number,
        'cycleStatus', cycle.status
      )
      order by event.occurred_at desc, event.id desc
    ),
    '[]'::jsonb
  )
  into v_items
  from resolved_events event
  left join public.voting_cycles cycle on cycle.id = event.cycle_id;

  return jsonb_build_object('outcome', 'ok', 'items', v_items);
end;
$function$;

alter function public.get_team_payout_logs(text,integer) owner to postgres;

revoke all on function public.get_team_payout_logs(text,integer)
  from public, anon, authenticated, discord_bot, service_role;
grant execute on function public.get_team_payout_logs(text,integer) to service_role;

do $postflight$
declare
  v_function regprocedure := 'public.get_team_payout_logs(text,integer)'::regprocedure;
begin
  if not exists (
    select 1
    from pg_proc function_row
    where function_row.oid = v_function
      and pg_get_userbyid(function_row.proowner) = 'postgres'
      and function_row.prosecdef
      and function_row.provolatile = 's'
      and function_row.proconfig = array['search_path=public, pg_temp']::text[]
  )
    or not has_function_privilege('service_role', v_function, 'EXECUTE')
    or has_function_privilege('anon', v_function, 'EXECUTE')
    or has_function_privilege('authenticated', v_function, 'EXECUTE')
    or has_function_privilege('discord_bot', v_function, 'EXECUTE')
  then
    raise exception using
      errcode = '55000',
      message = 'PAYOUT_LOG_CYCLE_PROJECTION_POSTFLIGHT_MISMATCH';
  end if;
end;
$postflight$;

comment on function public.get_team_payout_logs(text,integer) is
  'Capability-protected private payout audit projection with public Cycle grouping metadata.';

commit;
