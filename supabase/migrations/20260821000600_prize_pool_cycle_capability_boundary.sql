begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $preflight$
begin
  if (select count(*) from public.capability_catalog) <> 43
    or (select count(*) from public.capability_catalog where is_active) <> 39
    or not exists (
      select 1
      from public.capability_catalog
      where key = 'cycles.manage'
        and implementation_version = 1
        and definition_hash =
          '4f3e07f01bc453f594994689c3049e698ca2bd1d1c99e75927d161056033f710'
    )
    or not exists (
      select 1
      from public.capability_catalog
      where key = 'winners.manage_payouts'
        and implementation_version = 1
        and definition_hash =
          'a8dfec835cd096ca2c4e51b82209efad394432a0e5239ed28cafc81b1b3bfa93'
    )
    or to_regprocedure('public.assert_cycle_manager(text)') is null
    or to_regprocedure('public.assert_winners_payout_capability(text,text)') is null
    or to_regprocedure('public.manage_current_cycle_prize_pool(text,uuid,bigint,bigint,bigint,bigint)') is null
    or to_regprocedure('public.manage_cycle_prize_pool(text,uuid,bigint,bigint,text,bigint,text,uuid,text)') is not null
  then
    raise exception using
      errcode = '55000',
      message = 'PRIZE_POOL_CAPABILITY_BOUNDARY_BASELINE_MISMATCH';
  end if;
end;
$preflight$;

do $catalog$
declare
  v_count integer;
begin
  update public.capability_catalog
  set display_name = 'Manage Cycles',
      description = 'Operate the current cycle through hardened start, prize-pool, scheduling, phase, sponsorship, end-review, finalization, pause, and reset workflows.',
      category = 'Cycles',
      included_actions = array[
        'Create or reuse a clean draft and start normal or sponsored cycles.',
        'Set or change the optional exact-Lamport prize pool for the current running Cycle before voting ends, with exact amount confirmation.',
        'Set or clear current-phase timers, configure votes per user, pause or resume, and advance submission or voting phases.',
        'Perform exceptional submission disqualification or reinstatement after voting closes and before finalization.',
        'Finalize or reset the current cycle through confirmed auditable workflows.',
        'Manage the current and next cycle theme plus the sponsored-cycle draft.'
      ]::text[],
      excluded_actions = array[
        'Viewing Cycle Logs or unrelated logs without their separate capabilities.',
        'Managing roles, permissions, team membership, Owner access, or other administrative domains.',
        'Managing winner payout plans, refunding votes, editing individual votes, repairing finalized history, or moderating open phases without their separate capabilities.',
        'Accessing raw secrets, storage credentials, scheduler credentials, or arbitrary media-cleanup work.'
      ]::text[],
      risk_level = 'critical',
      assignable_to_non_admin = true,
      is_active = true,
      implementation_version = 2,
      definition_hash =
        'c0ba905e5e737ca1d09afa197f1bcb9adaf8919e7fb6fb37d33b53cfb54fb38a'
  where key = 'cycles.manage'
    and implementation_version = 1
    and definition_hash =
      '4f3e07f01bc453f594994689c3049e698ca2bd1d1c99e75927d161056033f710';
  get diagnostics v_count = row_count;
  if v_count <> 1 then
    raise exception using
      errcode = '55000',
      message = 'PRIZE_POOL_CYCLE_CAPABILITY_UPDATE_MISMATCH';
  end if;

  update public.capability_catalog
  set display_name = 'Manage Payouts',
      description = 'Manage canonical Claim-bound manual SOL payout workflows without custodying Treasury keys or transferring funds automatically.',
      category = 'Payouts',
      included_actions = array[
        'Prepare, lock, issue, verify, publish, abort, or visibly replace canonical payout plans derived only from finalized Winner records.',
        'Record a donation operation recipient, transaction evidence, provider confirmation, bounded private proof metadata, and an unavailable-donation state.',
        'Link a manually created Community Vote and apply its exact binding rollover, named-organization, follow-up, or return-to-winner outcome.'
      ]::text[],
      excluded_actions = array[
        'Entering, confirming, replacing, or changing a winner recipient; only the winner''s immutable confirmed Claim may supply it.',
        'Setting or changing the current Cycle prize pool; that belongs exclusively to Cycle Management and closes when voting ends.',
        'Changing winners, ranks, win shares, votes, payout choices, split percentages, original organization choices, or locked base components.',
        'Storing Treasury private keys, connecting a Treasury Wallet, automatically transferring SOL, creating or activating polls, or silently redistributing funds.',
        'Managing roles, grants, Team membership, Owner access, organization publication, or unrelated content and logs.'
      ]::text[],
      risk_level = 'critical',
      assignable_to_non_admin = true,
      is_active = true,
      implementation_version = 2,
      definition_hash =
        '37bc1cd814466cbdca9276fe722bd610ced8b7baf1106b905f8a62a51a8c7a26'
  where key = 'winners.manage_payouts'
    and implementation_version = 1
    and definition_hash =
      'a8dfec835cd096ca2c4e51b82209efad394432a0e5239ed28cafc81b1b3bfa93';
  get diagnostics v_count = row_count;
  if v_count <> 1 then
    raise exception using
      errcode = '55000',
      message = 'PRIZE_POOL_PAYOUT_CAPABILITY_UPDATE_MISMATCH';
  end if;
end;
$catalog$;

create or replace function public.assert_cycle_manager(
  p_actor_discord_user_id text
)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor_id text := btrim(p_actor_discord_user_id);
  v_actor_role text;
begin
  if nullif(v_actor_id, '') is null
    or char_length(v_actor_id) > 100
    or v_actor_id !~ '^[0-9]+$' then
    raise exception using
      errcode = '42501',
      message = 'CYCLE_MANAGEMENT_FORBIDDEN';
  end if;

  if not exists (
    select 1
    from public.capability_catalog capability_row
    where capability_row.key = 'cycles.manage'
      and capability_row.is_active
      and capability_row.assignable_to_non_admin
      and capability_row.implementation_version = 2
      and capability_row.definition_hash =
        'c0ba905e5e737ca1d09afa197f1bcb9adaf8919e7fb6fb37d33b53cfb54fb38a'
  ) then
    raise exception using
      errcode = '55000',
      message = 'CYCLE_MANAGEMENT_AUTHORIZATION_DEPENDENCY_UNAVAILABLE';
  end if;

  select member_row.role
  into v_actor_role
  from public.team_members member_row
  join public.team_roles role_row
    on role_row.key = member_row.role
   and role_row.is_active
  where member_row.discord_user_id = v_actor_id;

  if not found
    or (
      v_actor_role <> 'admin'
      and not exists (
        select 1
        from public.team_role_capabilities grant_row
        where grant_row.role_key = v_actor_role
          and grant_row.capability_key = 'cycles.manage'
      )
    ) then
    raise exception using
      errcode = '42501',
      message = 'CYCLE_MANAGEMENT_FORBIDDEN';
  end if;

  return v_actor_role;
end;
$function$;

create or replace function public.assert_winners_payout_capability(
  p_actor_discord_user_id text,
  p_capability_key text
)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor text := btrim(coalesce(p_actor_discord_user_id, ''));
  v_role text;
  v_hash text;
  v_version integer;
begin
  if v_actor !~ '^[0-9]+$'
    or char_length(v_actor) > 100
    or p_capability_key not in (
      'winners.manage_payouts',
      'winners.payout_logs.view',
      'winners.payouts.view'
    ) then
    raise exception using
      errcode = '42501',
      message = 'PAYOUT_CAPABILITY_FORBIDDEN';
  end if;

  v_hash := case p_capability_key
    when 'winners.manage_payouts' then
      '37bc1cd814466cbdca9276fe722bd610ced8b7baf1106b905f8a62a51a8c7a26'
    when 'winners.payout_logs.view' then
      '91f8ef9be3147c220c0591843f752145c2b2f865424f58afc76ab0b21448e019'
    else
      '9de22d0055e9c8b6b8cb701e4f6f554aa4c241ab0cbfb0a4709ecc9841702a54'
  end;
  v_version := case p_capability_key
    when 'winners.payout_logs.view' then 1
    else 2
  end;

  if not exists (
    select 1
    from public.capability_catalog capability
    where capability.key = p_capability_key
      and capability.is_active
      and capability.assignable_to_non_admin
      and capability.implementation_version = v_version
      and capability.definition_hash = v_hash
  ) then
    raise exception using
      errcode = '55000',
      message = 'PAYOUT_CAPABILITY_UNAVAILABLE';
  end if;

  select member.role
  into v_role
  from public.team_members member
  join public.team_roles role
    on role.key = member.role
   and role.is_active
  where member.discord_user_id = v_actor;
  if not found
    or (
      v_role <> 'admin'
      and not exists (
        select 1
        from public.team_role_capabilities grant_row
        where grant_row.role_key = v_role
          and grant_row.capability_key = p_capability_key
      )
    ) then
    raise exception using
      errcode = '42501',
      message = 'PAYOUT_CAPABILITY_FORBIDDEN';
  end if;
  return v_role;
end;
$function$;

alter function public.assert_cycle_manager(text) owner to postgres;
alter function public.assert_winners_payout_capability(text,text)
  owner to postgres;

revoke all on function
  public.assert_cycle_manager(text),
  public.assert_winners_payout_capability(text,text)
  from public, anon, authenticated, discord_bot, service_role;

do $postflight$
begin
  if (select count(*) from public.capability_catalog) <> 43
    or (select count(*) from public.capability_catalog where is_active) <> 39
    or not exists (
      select 1
      from public.capability_catalog
      where key = 'cycles.manage'
        and display_name = 'Manage Cycles'
        and implementation_version = 2
        and definition_hash =
          'c0ba905e5e737ca1d09afa197f1bcb9adaf8919e7fb6fb37d33b53cfb54fb38a'
    )
    or not exists (
      select 1
      from public.capability_catalog
      where key = 'winners.manage_payouts'
        and display_name = 'Manage Payouts'
        and implementation_version = 2
        and definition_hash =
          '37bc1cd814466cbdca9276fe722bd610ced8b7baf1106b905f8a62a51a8c7a26'
    )
    or has_function_privilege(
      'service_role',
      'public.assert_cycle_manager(text)',
      'execute'
    )
    or has_function_privilege(
      'service_role',
      'public.assert_winners_payout_capability(text,text)',
      'execute'
    )
  then
    raise exception using
      errcode = '55000',
      message = 'PRIZE_POOL_CAPABILITY_BOUNDARY_POSTFLIGHT_MISMATCH';
  end if;
end;
$postflight$;

comment on function public.assert_cycle_manager(text) is
  'Fail-closed exact cycles.manage guard, including current-Cycle prize-pool management before voting ends.';
comment on function public.assert_winners_payout_capability(text,text) is
  'Fail-closed exact payout guard. Current-Cycle prize-pool management is deliberately excluded and belongs to cycles.manage.';

commit;
