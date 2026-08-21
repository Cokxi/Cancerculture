begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $preflight$
begin
  if (select count(*) from public.capability_catalog) <> 43
    or (select count(*) from public.capability_catalog where is_active) <> 39
    or to_regclass('public.cycle_prize_allocations') is null
    or to_regprocedure('public.allocate_cycle_prize_component(uuid)') is null
    or exists (select 1 from public.team_role_capabilities where capability_key in ('winners.manage_payouts', 'winners.payout_logs.view'))
  then raise exception using errcode = '55000', message = 'PAYOUT_ALLOCATION_FIX_BASELINE_MISMATCH'; end if;
end;
$preflight$;

create or replace function public.allocate_cycle_prize_component(p_component_id uuid)
returns integer language plpgsql security definer set search_path = public, pg_temp
as $function$
declare
  v_component public.cycle_prize_pool_components%rowtype;
  v_count integer;
  v_total bigint;
begin
  select * into v_component from public.cycle_prize_pool_components where id = p_component_id;
  if not found then raise exception using message = 'PAYOUT_COMPONENT_NOT_FOUND'; end if;
  if exists (select 1 from public.cycle_prize_allocations where component_id = p_component_id) then
    select count(*)::integer, coalesce(sum(gross_lamports), 0)::bigint into v_count, v_total
    from public.cycle_prize_allocations where component_id = p_component_id;
    if v_count = 0 or v_total <> v_component.amount_lamports then
      raise exception using message = 'PAYOUT_ALLOCATION_REPLAY_INCOMPLETE';
    end if;
    return v_count;
  end if;
  if not exists (select 1 from public.voting_cycles where id = v_component.cycle_id and status = 'finished') then
    return 0;
  end if;

  with winner_weights as (
    select
      claim.id as claim_id,
      claim.cycle_id,
      claim.submission_id,
      claim.winner_discord_user_id,
      claim.payout_choice,
      claim.split_percent,
      claim.charity,
      winner.win_share::numeric as weight,
      sum(winner.win_share::numeric) over () as total_weight,
      encode(extensions.digest(convert_to(claim.id::text, 'utf8'), 'sha256'), 'hex') as tie_key,
      organization.source_type,
      organization.organization_revision_id,
      organization.effective_version,
      organization.effective_state,
      organization.effective_name,
      organization.effective_website_url
    from public.winner_claims claim
    join public.winner_public_profiles winner
      on winner.cycle_id = claim.cycle_id and winner.submission_id = claim.submission_id
    left join public.submission_organization_references organization
      on organization.submission_id = claim.submission_id
    where claim.cycle_id = v_component.cycle_id
  ), exact_shares as (
    select *,
      (v_component.amount_lamports::numeric * weight / total_weight) as exact_lamports,
      floor(v_component.amount_lamports::numeric * weight / total_weight)::bigint as base_lamports
    from winner_weights
    where total_weight > 0
  ), ordered as (
    select *,
      row_number() over (order by (exact_lamports - base_lamports::numeric) desc, tie_key asc) as remainder_rank,
      sum(base_lamports) over ()::bigint as base_total
    from exact_shares
  ), apportioned as (
    select *, base_lamports + case when remainder_rank <= v_component.amount_lamports - base_total then 1 else 0 end as gross
    from ordered
  )
  insert into public.cycle_prize_allocations (
    component_id, claim_id, cycle_id, submission_id, winner_discord_user_id,
    win_share_snapshot, stable_tie_key, gross_lamports, winner_lamports, donation_lamports,
    payout_choice, split_percent, organization_source_type, organization_revision_id,
    organization_effective_version, organization_effective_state, organization_name,
    organization_website_url
  )
  select
    v_component.id, claim_id, cycle_id, submission_id, winner_discord_user_id,
    weight, tie_key, gross,
    case payout_choice when 'keep' then gross when 'donate' then 0
      else floor(gross::numeric * split_percent::numeric / 100)::bigint end,
    case payout_choice when 'keep' then 0 when 'donate' then gross
      else gross - floor(gross::numeric * split_percent::numeric / 100)::bigint end,
    payout_choice,
    split_percent,
    case when payout_choice in ('donate', 'split') then coalesce(source_type, 'legacy') end,
    case when payout_choice in ('donate', 'split') then organization_revision_id end,
    case when payout_choice in ('donate', 'split') then coalesce(effective_version, 1) end,
    case when payout_choice in ('donate', 'split') then coalesce(effective_state, 'pending') end,
    case when payout_choice in ('donate', 'split') then coalesce(effective_name, charity) end,
    case when payout_choice in ('donate', 'split') and effective_state = 'verified' then effective_website_url end
  from apportioned;

  get diagnostics v_count = row_count;
  select coalesce(sum(gross_lamports), 0)::bigint into v_total
  from public.cycle_prize_allocations where component_id = p_component_id;
  if v_count = 0 or v_total <> v_component.amount_lamports then
    raise exception using message = 'PAYOUT_ALLOCATION_TOTAL_MISMATCH';
  end if;
  insert into public.payout_events(event_type, target_type, target_public_id, target_version, details)
  select 'allocation_created', 'component', v_component.public_id, v_component.component_version,
    jsonb_build_object('allocationCount', v_count, 'amountLamports', v_component.amount_lamports::text);
  return v_count;
end;
$function$;

alter function public.allocate_cycle_prize_component(uuid) owner to postgres;
revoke all on function public.allocate_cycle_prize_component(uuid) from public, anon, authenticated, discord_bot, service_role;

do $postflight$
begin
  if pg_get_userbyid((select proowner from pg_proc where oid = 'public.allocate_cycle_prize_component(uuid)'::regprocedure)) <> 'postgres'
    or not (select prosecdef from pg_proc where oid = 'public.allocate_cycle_prize_component(uuid)'::regprocedure)
    or (select proconfig from pg_proc where oid = 'public.allocate_cycle_prize_component(uuid)'::regprocedure) is distinct from array['search_path=public, pg_temp']::text[]
  then raise exception using errcode = '55000', message = 'PAYOUT_ALLOCATION_FIX_POSTFLIGHT_MISMATCH'; end if;
end;
$postflight$;

commit;
