begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $contract$
declare
  v_claim public.winner_claims%rowtype;
  v_session_id uuid;
  v_admin_id text;
  v_address_one constant text := 'So11111111111111111111111111111111111111112';
  v_address_two constant text := 'Vote111111111111111111111111111111111111111';
  v_old_candidate jsonb;
  v_new_candidate jsonb;
  v_result jsonb;
  v_version bigint;
  v_rows integer;
  v_multi_cycle_id bigint;
  v_winner_count integer;
begin
  select claim.*
  into v_claim
  from public.winner_claims claim
  where claim.payout_choice in ('keep', 'split')
    and exists (
      select 1
      from public.sessions session_row
      where session_row.discord_user_id = claim.winner_discord_user_id
        and session_row.revoked_at is null
    )
    and exists (
      select 1
      from public.account_totp_factors factor
      where factor.discord_user_id = claim.winner_discord_user_id
    )
    and exists (
      select 1
      from public.account_sol_profile_wallets wallet
      where wallet.discord_user_id = claim.winner_discord_user_id
        and public.is_valid_sol_recipient_address(wallet.wallet_address)
    )
  order by claim.id
  limit 1
  for update;
  if not found then
    raise exception 'WINNER_CLAIM_DEV_OWNER_FIXTURE_UNAVAILABLE';
  end if;

  select session_row.id
  into v_session_id
  from public.sessions session_row
  where session_row.discord_user_id = v_claim.winner_discord_user_id
    and session_row.revoked_at is null
  order by session_row.created_at desc, session_row.id
  limit 1;

  select member.discord_user_id
  into v_admin_id
  from public.team_members member
  join public.team_roles role on role.key = member.role and role.is_active
  where member.role = 'admin'
  order by member.discord_user_id
  limit 1;
  if v_admin_id is null then
    raise exception 'WINNER_CLAIM_DEV_ADMIN_FIXTURE_UNAVAILABLE';
  end if;

  select winner.cycle_id, count(*)::integer
  into v_multi_cycle_id, v_winner_count
  from public.winner_public_profiles winner
  group by winner.cycle_id
  having count(*) > 1
  order by count(*) desc, winner.cycle_id
  limit 1;
  if v_multi_cycle_id is null then
    raise exception 'WINNER_CLAIM_DEV_MULTI_WINNER_FIXTURE_UNAVAILABLE';
  end if;
  v_result := public.finalize_cycle(v_multi_cycle_id, v_admin_id);
  if coalesce((v_result->>'alreadyFinalized')::boolean, false) is not true
    or (v_result->>'winnerCount')::integer <> v_winner_count
    or (
      select count(*) from public.winner_claims claim
      where claim.cycle_id = v_multi_cycle_id
    ) <> v_winner_count
    or exists (
      select 1
      from public.winner_claims claim
      where claim.cycle_id = v_multi_cycle_id
      group by claim.cycle_id, claim.submission_id
      having count(*) <> 1
    )
  then
    raise exception 'WINNER_CLAIM_DEV_MULTI_WINNER_FINALIZATION_MISMATCH';
  end if;
  v_result := public.finalize_cycle(v_multi_cycle_id, v_admin_id);
  if coalesce((v_result->>'alreadyFinalized')::boolean, false) is not true
    or (
      select count(*) from public.winner_claims claim
      where claim.cycle_id = v_multi_cycle_id
    ) <> v_winner_count
  then
    raise exception 'WINNER_CLAIM_DEV_FINALIZATION_IDEMPOTENCY_MISMATCH';
  end if;

  update public.winner_claims
  set
    status = 'unclaimed',
    version = version + 1,
    claim_deadline_at = transaction_timestamp() + interval '24 hours',
    correction_ready_at = null,
    confirmed_recipient = null,
    confirmed_recipient_source = null,
    confirmed_source_version = null,
    confirmed_at = null,
    declined_at = null,
    expired_at = null,
    updated_at = transaction_timestamp()
  where id = v_claim.id;
  update public.winner_public_profiles
  set wallet_address = null,
      claim_expired = false
  where cycle_id = v_claim.cycle_id and submission_id = v_claim.submission_id;

  update public.winner_claims
  set claim_deadline_at = transaction_timestamp() + interval '1 second'
  where id = v_claim.id;
  perform public.process_due_winner_claim_transitions(v_claim.id);
  if (select status from public.winner_claims where id = v_claim.id) <> 'unclaimed'
    or (select claim_expired from public.winner_public_profiles where cycle_id = v_claim.cycle_id and submission_id = v_claim.submission_id)
  then
    raise exception 'WINNER_CLAIM_DEV_BEFORE_BOUNDARY_MISMATCH';
  end if;

  update public.winner_claims
  set claim_deadline_at = transaction_timestamp()
  where id = v_claim.id;
  perform public.process_due_winner_claim_transitions(v_claim.id);
  if (select status from public.winner_claims where id = v_claim.id) <> 'expired'
    or not (select claim_expired from public.winner_public_profiles where cycle_id = v_claim.cycle_id and submission_id = v_claim.submission_id)
  then
    raise exception 'WINNER_CLAIM_DEV_EXACT_BOUNDARY_MISMATCH';
  end if;

  update public.winner_claims
  set
    status = 'unclaimed',
    version = version + 1,
    claim_deadline_at = transaction_timestamp() - interval '1 second',
    expired_at = null,
    updated_at = transaction_timestamp()
  where id = v_claim.id;
  perform public.process_due_winner_claim_transitions(v_claim.id);
  if (select status from public.winner_claims where id = v_claim.id) <> 'expired'
    or not (select claim_expired from public.winner_public_profiles where cycle_id = v_claim.cycle_id and submission_id = v_claim.submission_id)
  then
    raise exception 'WINNER_CLAIM_DEV_AFTER_BOUNDARY_MISMATCH';
  end if;

  update public.winner_claims
  set
    status = 'unclaimed',
    version = version + 1,
    claim_deadline_at = transaction_timestamp() + interval '24 hours',
    expired_at = null,
    updated_at = transaction_timestamp()
  where id = v_claim.id;
  update public.winner_public_profiles
  set claim_expired = false
  where cycle_id = v_claim.cycle_id and submission_id = v_claim.submission_id;

  v_old_candidate := public.resolve_winner_claim_candidate(
    v_claim.id,
    v_claim.winner_discord_user_id
  );
  if v_old_candidate->>'outcome' <> 'ready'
    or v_old_candidate->>'source' <> 'profile'
  then
    raise exception 'WINNER_CLAIM_DEV_PROFILE_PRECEDENCE_MISMATCH';
  end if;

  update public.account_sol_profile_wallets
  set
    wallet_address = case
      when wallet_address = v_address_one then v_address_two
      else v_address_one
    end,
    version = version + 1,
    updated_at = transaction_timestamp()
  where discord_user_id = v_claim.winner_discord_user_id;

  v_new_candidate := public.resolve_winner_claim_candidate(
    v_claim.id,
    v_claim.winner_discord_user_id
  );
  if v_new_candidate->>'source' <> 'profile'
    or v_new_candidate->>'revision' = v_old_candidate->>'revision'
    or v_new_candidate->>'address' = v_old_candidate->>'address'
  then
    raise exception 'WINNER_CLAIM_DEV_IMMEDIATE_PROFILE_CHANGE_MISMATCH';
  end if;

  v_result := public.mutate_own_winner_claim(
    v_session_id,
    v_claim.id,
    '51000000-0000-4000-8000-000000000001',
    'confirm',
    v_old_candidate->>'revision',
    true
  );
  if v_result->>'outcome' <> 'candidate_stale'
    or (select status from public.winner_claims where id = v_claim.id) <> 'unclaimed'
  then
    raise exception 'WINNER_CLAIM_DEV_STALE_CONFIRM_MISMATCH';
  end if;

  v_result := public.mutate_own_winner_claim(
    v_session_id,
    v_claim.id,
    '51000000-0000-4000-8000-000000000001',
    'confirm',
    v_old_candidate->>'revision',
    true
  );
  if v_result->>'outcome' <> 'candidate_stale'
    or coalesce((v_result->>'idempotentReplay')::boolean, false) is not true
  then
    raise exception 'WINNER_CLAIM_DEV_STALE_REPLAY_MISMATCH';
  end if;

  v_result := public.mutate_own_winner_claim(
    v_session_id,
    v_claim.id,
    '51000000-0000-4000-8000-000000000002',
    'confirm',
    v_new_candidate->>'revision',
    true
  );
  if v_result->>'outcome' <> 'confirmed'
    or not exists (
      select 1
      from public.winner_claims claim
      join public.winner_public_profiles winner
        on winner.cycle_id = claim.cycle_id
       and winner.submission_id = claim.submission_id
      where claim.id = v_claim.id
        and claim.status = 'confirmed'
        and claim.confirmed_recipient_source = 'profile'
        and claim.confirmed_recipient = v_new_candidate->>'address'
        and winner.wallet_address = claim.confirmed_recipient
    )
  then
    raise exception 'WINNER_CLAIM_DEV_CONFIRM_MISMATCH';
  end if;

  v_result := public.mutate_own_winner_claim(
    v_session_id,
    v_claim.id,
    '51000000-0000-4000-8000-000000000002',
    'confirm',
    v_new_candidate->>'revision',
    true
  );
  if v_result->>'outcome' <> 'confirmed'
    or coalesce((v_result->>'idempotentReplay')::boolean, false) is not true
    or (
      select count(*)
      from public.winner_claim_events event_row
      where event_row.claim_id = v_claim.id and event_row.action = 'confirmed'
    ) <> 1
  then
    raise exception 'WINNER_CLAIM_DEV_CONFIRM_REPLAY_MISMATCH';
  end if;

  update public.account_sol_profile_wallets
  set
    wallet_address = case
      when wallet_address = v_address_one then v_address_two
      else v_address_one
    end,
    version = version + 1,
    updated_at = transaction_timestamp()
  where discord_user_id = v_claim.winner_discord_user_id;
  if (
    select claim.confirmed_recipient <> winner.wallet_address
      or claim.confirmed_recipient = wallet.wallet_address
    from public.winner_claims claim
    join public.winner_public_profiles winner
      on winner.cycle_id = claim.cycle_id and winner.submission_id = claim.submission_id
    join public.account_sol_profile_wallets wallet
      on wallet.discord_user_id = claim.winner_discord_user_id
    where claim.id = v_claim.id
  ) then
    raise exception 'WINNER_CLAIM_DEV_CONFIRMED_IMMUTABILITY_MISMATCH';
  end if;

  update public.winner_claims
  set
    status = 'unclaimed',
    version = version + 1,
    claim_deadline_at = transaction_timestamp() + interval '24 hours',
    confirmed_recipient = null,
    confirmed_recipient_source = null,
    confirmed_source_version = null,
    confirmed_at = null,
    updated_at = transaction_timestamp()
  where id = v_claim.id
  returning version into v_version;
  update public.winner_public_profiles
  set wallet_address = null,
      claim_expired = false
  where cycle_id = v_claim.cycle_id and submission_id = v_claim.submission_id;
  update public.submission_private_data
  set wallet_address = v_address_one, payout_choice = 'keep'
  where submission_id = v_claim.submission_id;
  update public.submission_upload_operations
  set
    wallet_source = 'manual',
    wallet_address = v_address_one,
    profile_wallet_version = null,
    payout_choice = 'keep',
    split_percent = null,
    charity = null
  where submission_id = v_claim.submission_id and status = 'completed';
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'WINNER_CLAIM_DEV_UPLOAD_FIXTURE_UNAVAILABLE';
  end if;

  update public.account_sol_profile_wallets
  set wallet_address = v_address_two, version = version + 1
  where discord_user_id = v_claim.winner_discord_user_id;
  v_new_candidate := public.resolve_winner_claim_candidate(
    v_claim.id,
    v_claim.winner_discord_user_id
  );
  if v_new_candidate->>'source' <> 'profile'
    or v_new_candidate->>'address' <> v_address_two
  then
    raise exception 'WINNER_CLAIM_DEV_LATE_2FA_PROFILE_PRECEDENCE_MISMATCH';
  end if;

  v_result := public.manage_winner_recipient_correction(
    v_admin_id,
    '52000000-0000-4000-8000-000000000001',
    v_claim.id,
    v_version,
    v_address_one
  );
  if v_result->>'outcome' <> 'correction_ready'
    or not exists (
      select 1
      from public.winner_claims claim
      where claim.id = v_claim.id
        and claim.status = 'unclaimed'
        and claim.claim_deadline_at = transaction_timestamp() + interval '24 hours'
    )
  then
    raise exception 'WINNER_CLAIM_DEV_CORRECTION_RESTART_MISMATCH';
  end if;

  v_result := public.manage_winner_recipient_correction(
    v_admin_id,
    '52000000-0000-4000-8000-000000000001',
    v_claim.id,
    v_version,
    v_address_one
  );
  if v_result->>'outcome' <> 'correction_ready'
    or coalesce((v_result->>'idempotentReplay')::boolean, false) is not true
  then
    raise exception 'WINNER_CLAIM_DEV_CORRECTION_REPLAY_MISMATCH';
  end if;

  update public.account_sol_profile_wallets
  set wallet_address = null, version = version + 1
  where discord_user_id = v_claim.winner_discord_user_id;
  v_new_candidate := public.resolve_winner_claim_candidate(
    v_claim.id,
    v_claim.winner_discord_user_id
  );
  if v_new_candidate->>'source' <> 'correction'
    or v_new_candidate->>'address' <> v_address_one
  then
    raise exception 'WINNER_CLAIM_DEV_CORRECTION_PRECEDENCE_MISMATCH';
  end if;

  select version into v_version
  from public.winner_claims
  where id = v_claim.id;
  v_result := public.manage_winner_recipient_correction(
    v_admin_id,
    '52000000-0000-4000-8000-000000000002',
    v_claim.id,
    v_version,
    v_address_two
  );
  if v_result->>'outcome' <> 'correction_ready'
    or (
      select count(*)
      from public.winner_recipient_corrections correction
      where correction.claim_id = v_claim.id
        and correction.status = 'superseded'
    ) <> 1
    or not exists (
      select 1
      from public.winner_recipient_corrections correction
      where correction.claim_id = v_claim.id
        and correction.status = 'ready'
        and correction.proposed_recipient = v_address_two
        and correction.case_reference is null
        and correction.reported_at is null
    )
  then
    raise exception 'WINNER_CLAIM_DEV_CORRECTION_REPLACEMENT_MISMATCH';
  end if;
  v_new_candidate := public.resolve_winner_claim_candidate(
    v_claim.id,
    v_claim.winner_discord_user_id
  );
  if v_new_candidate->>'source' <> 'correction'
    or v_new_candidate->>'address' <> v_address_two
  then
    raise exception 'WINNER_CLAIM_DEV_CORRECTION_REPLACEMENT_CANDIDATE_MISMATCH';
  end if;

  begin
    perform public.mutate_own_winner_claim(
      v_session_id,
      v_claim.id,
      '51000000-0000-4000-8000-000000000003',
      'correction_incorrect',
      v_new_candidate->>'revision',
      true
    );
    raise exception 'WINNER_CLAIM_DEV_CORRECTION_REJECTION_ACCEPTED';
  exception
    when sqlstate '22023' then
      if sqlerrm <> 'WINNER_CLAIM_INPUT_INVALID' then
        raise;
      end if;
  end;

  begin
    perform public.manage_winner_recipient_correction(
      '999999999999999991',
      '52000000-0000-4000-8000-000000000003',
      v_claim.id,
      (select version from public.winner_claims where id = v_claim.id),
      v_address_one
    );
    raise exception 'WINNER_CLAIM_DEV_UNAUTHORIZED_CORRECTION_ACCEPTED';
  exception
    when insufficient_privilege then null;
  end;

  v_result := public.get_team_winner_claims(v_admin_id, true);
  if v_result->>'outcome' <> 'ok'
    or exists (
      select 1
      from jsonb_array_elements(v_result->'items') item
      where item->>'status' <> 'confirmed'
        and item->>'confirmedRecipient' is not null
    )
    or exists (
      select 1
      from public.winner_claims claim
      join public.winner_public_profiles winner
        on winner.cycle_id = claim.cycle_id and winner.submission_id = claim.submission_id
      where claim.status in (
        'not_required', 'unclaimed', 'correction_pending', 'declined', 'expired'
      )
        and winner.wallet_address is not null
    )
  then
    raise exception 'WINNER_CLAIM_DEV_TEAM_PRIVACY_MISMATCH';
  end if;
end;
$contract$;

rollback;
