begin;

set local lock_timeout = '5s';
set local statement_timeout = '20s';

do $contract$
declare
  v_user_id constant text := '999999999999999992';
  v_session_id constant uuid := '40000000-0000-4000-8000-000000000001';
  v_other_session_id constant uuid := '40000000-0000-4000-8000-000000000002';
  v_factor_id constant uuid := '40000000-0000-4000-8000-000000000003';
  v_address_one constant text := 'So11111111111111111111111111111111111111112';
  v_address_two constant text := 'Vote111111111111111111111111111111111111111';
  v_result jsonb;
begin
  if exists (
    select 1 from public.user_logs where discord_user_id = v_user_id
  ) then
    raise exception 'SOL_WALLET_DEV_SYNTHETIC_COLLISION';
  end if;

  insert into public.user_logs (
    discord_user_id, current_discord_username
  ) values (
    v_user_id, 'rollback-sol-wallet-contract'
  );
  insert into public.discord_member_state (
    discord_user_id,
    current_discord_username,
    discord_joined_at,
    is_in_discord,
    discord_ban_active,
    discord_membership_observed_at
  ) values (
    v_user_id,
    'rollback-sol-wallet-contract',
    transaction_timestamp() - interval '90 days',
    true,
    false,
    transaction_timestamp()
  );
  insert into public.sessions (id, discord_user_id)
  values
    (v_session_id, v_user_id),
    (v_other_session_id, v_user_id);
  insert into public.account_totp_factors (
    id,
    discord_user_id,
    secret_ciphertext,
    secret_nonce,
    secret_tag,
    key_version,
    last_accepted_step
  ) values (
    v_factor_id,
    v_user_id,
    repeat('a', 32),
    repeat('b', 24),
    repeat('c', 24),
    1,
    100
  );

  insert into public.account_step_up_grants (
    id, discord_user_id, session_id, factor_id, method, purpose, expires_at
  ) values (
    '40000000-0000-4000-8000-000000000011',
    v_user_id,
    v_session_id,
    v_factor_id,
    'totp',
    'sol_wallet_change',
    transaction_timestamp() + interval '5 minutes'
  );
  v_result := public.change_account_sol_profile_wallet(
    v_session_id,
    '40000000-0000-4000-8000-000000000101',
    0,
    v_address_one
  );
  if v_result #>> '{outcome}' <> 'applied'
    or v_result #>> '{reason}' <> 'created'
    or (v_result #>> '{version}')::bigint <> 1
  then
    raise exception 'SOL_WALLET_DEV_CREATE_MISMATCH';
  end if;

  v_result := public.change_account_sol_profile_wallet(
    v_session_id,
    '40000000-0000-4000-8000-000000000101',
    0,
    v_address_one
  );
  if coalesce((v_result #>> '{idempotentReplay}')::boolean, false) is not true
    or (
      select count(*)
      from public.account_sol_profile_wallet_audit
      where discord_user_id = v_user_id
        and request_id = '40000000-0000-4000-8000-000000000101'
    ) <> 1
  then
    raise exception 'SOL_WALLET_DEV_IDEMPOTENCY_MISMATCH';
  end if;

  insert into public.account_step_up_grants (
    id, discord_user_id, session_id, factor_id, method, purpose, expires_at
  ) values (
    '40000000-0000-4000-8000-000000000012',
    v_user_id,
    v_session_id,
    v_factor_id,
    'totp',
    'sol_wallet_change',
    transaction_timestamp() + interval '5 minutes'
  );
  v_result := public.change_account_sol_profile_wallet(
    v_session_id,
    '40000000-0000-4000-8000-000000000102',
    0,
    v_address_two
  );
  if v_result #>> '{reason}' <> 'stale_version'
    or exists (
      select 1
      from public.account_step_up_grants
      where id = '40000000-0000-4000-8000-000000000012'
        and consumed_at is null
    )
  then
    raise exception 'SOL_WALLET_DEV_STALE_CONTRACT_MISMATCH';
  end if;

  insert into public.account_step_up_grants (
    id, discord_user_id, session_id, factor_id, method, purpose, expires_at
  ) values (
    '40000000-0000-4000-8000-000000000013',
    v_user_id,
    v_session_id,
    v_factor_id,
    'totp',
    'sol_wallet_change',
    transaction_timestamp() + interval '5 minutes'
  );
  v_result := public.change_account_sol_profile_wallet(
    v_session_id,
    '40000000-0000-4000-8000-000000000103',
    1,
    v_address_one
  );
  if v_result #>> '{reason}' <> 'no_change' then
    raise exception 'SOL_WALLET_DEV_SAME_VALUE_MISMATCH';
  end if;

  insert into public.account_step_up_grants (
    id, discord_user_id, session_id, factor_id, method, purpose, expires_at
  ) values (
    '40000000-0000-4000-8000-000000000014',
    v_user_id,
    v_session_id,
    v_factor_id,
    'totp',
    'sol_wallet_change',
    transaction_timestamp() + interval '5 minutes'
  );
  v_result := public.change_account_sol_profile_wallet(
    v_session_id,
    '40000000-0000-4000-8000-000000000104',
    1,
    'not-a-sol-address'
  );
  if v_result #>> '{reason}' <> 'address_invalid'
    or exists (
      select 1
      from public.account_sol_profile_wallet_audit
      where discord_user_id = v_user_id
        and request_id = '40000000-0000-4000-8000-000000000104'
        and to_jsonb(account_sol_profile_wallet_audit)::text like '%not-a-sol-address%'
    )
  then
    raise exception 'SOL_WALLET_DEV_INVALID_ADDRESS_MISMATCH';
  end if;

  insert into public.account_step_up_grants (
    id, discord_user_id, session_id, factor_id, method, purpose, expires_at
  ) values (
    '40000000-0000-4000-8000-000000000015',
    v_user_id,
    v_session_id,
    v_factor_id,
    'totp',
    'sol_wallet_change',
    transaction_timestamp() + interval '5 minutes'
  );
  v_result := public.change_account_sol_profile_wallet(
    v_session_id,
    '40000000-0000-4000-8000-000000000105',
    1,
    v_address_two
  );
  if v_result #>> '{reason}' <> 'replaced'
    or (v_result #>> '{version}')::bigint <> 2
  then
    raise exception 'SOL_WALLET_DEV_REPLACE_MISMATCH';
  end if;

  begin
    perform public.change_account_sol_profile_wallet(
      v_other_session_id,
      '40000000-0000-4000-8000-000000000106',
      2,
      v_address_one
    );
    raise exception 'SOL_WALLET_DEV_WRONG_SESSION_ACCEPTED';
  exception
    when others then
      if sqlerrm not like '%FRESH_STEP_UP_REQUIRED%' then
        raise;
      end if;
  end;

  insert into public.account_step_up_grants (
    id, discord_user_id, session_id, factor_id, method, purpose, expires_at
  ) values (
    '40000000-0000-4000-8000-000000000016',
    v_user_id,
    v_session_id,
    v_factor_id,
    'totp',
    'sol_wallet_change',
    transaction_timestamp() + interval '5 minutes'
  );
  v_result := public.change_account_sol_profile_wallet(
    v_session_id,
    '40000000-0000-4000-8000-000000000107',
    2,
    null
  );
  if v_result #>> '{reason}' <> 'removed'
    or (v_result #>> '{version}')::bigint <> 3
    or (
      select wallet_address is not null
      from public.account_sol_profile_wallets
      where discord_user_id = v_user_id
    )
  then
    raise exception 'SOL_WALLET_DEV_REMOVE_MISMATCH';
  end if;
end;
$contract$;

create function pg_temp.reject_sol_wallet_audit_insert()
returns trigger
language plpgsql
as $function$
begin
  raise exception 'SOL_WALLET_SYNTHETIC_AUDIT_FAILURE';
end;
$function$;

create trigger account_sol_profile_wallet_audit_synthetic_failure
before insert on public.account_sol_profile_wallet_audit
for each row execute function pg_temp.reject_sol_wallet_audit_insert();

do $rollback_contract$
declare
  v_user_id constant text := '999999999999999992';
  v_session_id constant uuid := '40000000-0000-4000-8000-000000000001';
  v_factor_id constant uuid := '40000000-0000-4000-8000-000000000003';
begin
  insert into public.account_step_up_grants (
    id, discord_user_id, session_id, factor_id, method, purpose, expires_at
  ) values (
    '40000000-0000-4000-8000-000000000017',
    v_user_id,
    v_session_id,
    v_factor_id,
    'totp',
    'sol_wallet_change',
    transaction_timestamp() + interval '5 minutes'
  );

  begin
    perform public.change_account_sol_profile_wallet(
      v_session_id,
      '40000000-0000-4000-8000-000000000108',
      3,
      'So11111111111111111111111111111111111111112'
    );
    raise exception 'SOL_WALLET_DEV_ROLLBACK_FAILURE_NOT_RAISED';
  exception
    when others then
      if sqlerrm not like '%SOL_WALLET_SYNTHETIC_AUDIT_FAILURE%' then
        raise;
      end if;
  end;

  if not exists (
    select 1
    from public.account_step_up_grants
    where id = '40000000-0000-4000-8000-000000000017'
      and consumed_at is null
  )
    or exists (
      select 1
      from public.account_sol_profile_wallet_audit
      where discord_user_id = v_user_id
        and request_id = '40000000-0000-4000-8000-000000000108'
    )
    or exists (
      select 1
      from public.account_sol_profile_wallets
      where discord_user_id = v_user_id
        and wallet_address is not null
    )
  then
    raise exception 'SOL_WALLET_DEV_ATOMIC_ROLLBACK_MISMATCH';
  end if;
end;
$rollback_contract$;

rollback;
