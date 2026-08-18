begin;

do $baseline$
begin
  if to_regclass('public.wallet_issue_intakes') is null
    or to_regprocedure('public.resolve_wallet_issue_case(text,uuid,uuid,text,bigint,bigint,bigint,bigint,bigint,text)') is null
    or to_regprocedure('public.get_team_winner_claims(text,boolean)') is null
    or to_regprocedure('public.protect_team_correction_profile_wallet_control()') is not null
    or exists (
      select 1 from pg_trigger
      where tgrelid = 'public.winner_recipient_corrections'::regclass
        and tgname = 'winner_corrections_profile_wallet_control_guard'
        and not tgisinternal
    )
  then
    raise exception using
      errcode = '55000',
      message = 'PROFILE_WALLET_OWNER_CONTROL_GUARD_BASELINE_MISMATCH';
  end if;
end;
$baseline$;

create function public.protect_team_correction_profile_wallet_control()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner_id text;
begin
  if new.status <> 'ready' then
    return new;
  end if;

  select claim.winner_discord_user_id
  into v_owner_id
  from public.winner_claims claim
  where claim.id = new.claim_id;

  if exists (
    select 1
    from public.account_sol_profile_wallets wallet
    where wallet.discord_user_id = v_owner_id
      and public.is_valid_sol_recipient_address(wallet.wallet_address)
      and exists (
        select 1
        from public.account_totp_factors factor
        where factor.discord_user_id = v_owner_id
      )
  ) then
    raise exception using
      errcode = '55000',
      message = 'WINNER_PROFILE_WALLET_OWNER_CONTROLLED';
  end if;

  return new;
end;
$function$;

create trigger winner_corrections_profile_wallet_control_guard
before insert on public.winner_recipient_corrections
for each row execute function public.protect_team_correction_profile_wallet_control();

create or replace function public.get_team_winner_claims(
  p_actor_discord_user_id text,
  p_include_corrections boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_items jsonb;
begin
  perform public.assert_winner_capability(
    p_actor_discord_user_id,
    'winners.payouts.view',
    2,
    '9de22d0055e9c8b6b8cb701e4f6f554aa4c241ab0cbfb0a4709ecc9841702a54'
  );
  if p_include_corrections then
    perform public.assert_winner_capability(
      p_actor_discord_user_id,
      'winners.recipient_corrections.manage',
      2,
      'e569fa66e8f9c2794fe030c4e034ebf8a7e458c6ddccf2a868d2cac1fd5ea2bd'
    );
  end if;

  perform public.process_due_winner_claim_transitions(null);

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'claimId', claim.id,
      'claimVersion', claim.version,
      'cycleId', claim.cycle_id,
      'cycleNumber', cycle.public_number,
      'cycleTheme', cycle.theme,
      'submissionId', claim.submission_id,
      'discordUserId', claim.winner_discord_user_id,
      'publicProfileId', user_log.public_profile_id,
      'currentDiscordUsername', user_log.current_discord_username,
      'currentDiscordHandle', user_log.current_discord_handle,
      'currentDisplayName', user_log.current_display_name,
      'currentGuildNickname', user_log.current_guild_nickname,
      'voteCount', winner.vote_count,
      'winShare', winner.win_share,
      'payoutChoice', claim.payout_choice,
      'splitPercent', claim.split_percent,
      'charity', claim.charity,
      'status', claim.status,
      'finalizedAt', claim.finalized_at,
      'deadlineAt', claim.claim_deadline_at,
      'confirmedAt', claim.confirmed_at,
      'declinedAt', claim.declined_at,
      'expiredAt', claim.expired_at,
      'confirmedRecipientSource', case when claim.status = 'confirmed' then claim.confirmed_recipient_source else null end,
      'walletAddress', case
        when claim.status = 'confirmed' and claim.payout_choice in ('keep', 'split')
          then claim.confirmed_recipient
        else null
      end,
      'profileWalletOwnerControlled', profile_wallet.owner_controlled,
      'correctionEligible', not profile_wallet.owner_controlled and exists (
        select 1
        from public.submission_upload_operations operation
        where operation.submission_id = claim.submission_id
          and operation.status = 'completed'
          and operation.wallet_source = 'manual'
      ),
      'latestCorrection', case
        when p_include_corrections and correction.id is not null then
          jsonb_build_object(
            'version', correction.version,
            'status', correction.status,
            'proposedRecipient', correction.proposed_recipient
          )
        else null
      end
    ) order by claim.cycle_id desc, claim.submission_id
  ), '[]'::jsonb)
  into v_items
  from public.winner_claims claim
  join public.voting_cycles cycle on cycle.id = claim.cycle_id
  join public.winner_public_profiles winner
    on winner.cycle_id = claim.cycle_id
   and winner.submission_id = claim.submission_id
  left join public.user_logs user_log
    on user_log.discord_user_id = claim.winner_discord_user_id
  cross join lateral (
    select exists (
      select 1
      from public.account_sol_profile_wallets wallet
      where wallet.discord_user_id = claim.winner_discord_user_id
        and public.is_valid_sol_recipient_address(wallet.wallet_address)
        and exists (
          select 1
          from public.account_totp_factors factor
          where factor.discord_user_id = claim.winner_discord_user_id
        )
    ) as owner_controlled
  ) profile_wallet
  left join lateral (
    select correction_row.*
    from public.winner_recipient_corrections correction_row
    where correction_row.claim_id = claim.id
    order by correction_row.version desc
    limit 1
  ) correction on true;

  return jsonb_build_object(
    'outcome', 'ok',
    'databaseTime', transaction_timestamp(),
    'items', v_items
  );
end;
$function$;

alter function public.protect_team_correction_profile_wallet_control() owner to postgres;
alter function public.get_team_winner_claims(text,boolean) owner to postgres;
revoke all on function public.protect_team_correction_profile_wallet_control()
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_team_winner_claims(text,boolean)
  from public, anon, authenticated, discord_bot, service_role;
grant execute on function public.get_team_winner_claims(text,boolean)
  to service_role;

do $postflight$
begin
  if not exists (
      select 1 from pg_trigger
      where tgrelid = 'public.winner_recipient_corrections'::regclass
        and tgname = 'winner_corrections_profile_wallet_control_guard'
        and not tgisinternal
    )
    or has_function_privilege(
      'service_role',
      'public.protect_team_correction_profile_wallet_control()',
      'EXECUTE'
    )
    or not has_function_privilege(
      'service_role',
      'public.get_team_winner_claims(text,boolean)',
      'EXECUTE'
    )
    or position(
      'profileWalletOwnerControlled' in pg_get_functiondef(
        'public.get_team_winner_claims(text,boolean)'::regprocedure
      )
    ) = 0
  then
    raise exception using
      errcode = '55000',
      message = 'PROFILE_WALLET_OWNER_CONTROL_GUARD_POSTFLIGHT_MISMATCH';
  end if;
end;
$postflight$;

comment on function public.protect_team_correction_profile_wallet_control() is
  'Prevents every Team recipient correction while the winner owns an active 2FA Profile Wallet.';
comment on function public.get_team_winner_claims(text,boolean) is
  'Returns private Team payout state and suppresses Team correction eligibility for winner-owned active 2FA Profile Wallets.';

commit;
