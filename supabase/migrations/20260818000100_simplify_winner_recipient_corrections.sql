begin;

do $baseline$
declare
  v_case_nullable text;
  v_reported_nullable text;
begin
  if (select count(*) from public.capability_catalog) <> 39
    or (select count(*) from public.capability_catalog where is_active) <> 35
    or not exists (
      select 1
      from public.capability_catalog
      where key = 'winners.recipient_corrections.manage'
        and implementation_version = 1
        and definition_hash =
          '7d10b252f8dc45655c58c2fc06a2c5ac9610b6d237169c95f3bfa0ad98605395'
    )
    or exists (
      select 1
      from public.team_role_capabilities
      where capability_key = 'winners.recipient_corrections.manage'
    )
    or to_regclass('public.winner_claims') is null
    or to_regclass('public.winner_recipient_corrections') is null
    or to_regclass('public.winner_claim_requests') is null
    or to_regclass('public.winner_correction_requests') is null
    or to_regclass('public.winner_claim_events') is null
    or exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'winner_public_profiles'
        and column_name = 'claim_expired'
    )
    or to_regprocedure(
      'public.mutate_own_winner_claim(uuid,uuid,uuid,text,text,boolean)'
    ) is null
    or to_regprocedure(
      'public.manage_winner_recipient_correction(text,uuid,uuid,bigint,text,text,timestamp with time zone,text)'
    ) is null
    or to_regprocedure(
      'public.manage_winner_recipient_correction(text,uuid,uuid,bigint,text)'
    ) is not null
    or to_regprocedure('public.get_team_winner_claims(text,boolean)') is null
  then
    raise exception using
      errcode = '55000',
      message = 'WINNER_CORRECTION_SIMPLIFICATION_BASELINE_MISMATCH';
  end if;

  select is_nullable into v_case_nullable
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'winner_recipient_corrections'
    and column_name = 'case_reference';
  select is_nullable into v_reported_nullable
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'winner_recipient_corrections'
    and column_name = 'reported_at';
  if v_case_nullable <> 'NO' or v_reported_nullable <> 'NO' then
    raise exception using
      errcode = '55000',
      message = 'WINNER_CORRECTION_SIMPLIFICATION_COLUMN_BASELINE_MISMATCH';
  end if;
end;
$baseline$;

update public.capability_catalog
set
  description =
    'Propose versioned SOL recipient corrections for eligible manual-wallet winners while preserving winner-only final confirmation.',
  included_actions = array[
    'Propose a canonically valid replacement recipient for an eligible unconfirmed manual-wallet Claim.',
    'Replace an earlier proposal as a new version and start a fresh 24-hour winner review window.',
    'Review the correction version and exact private proposal needed for this correction work.'
  ]::text[],
  excluded_actions = array[
    'Confirming, declining, reopening, or otherwise acting on behalf of a winner.',
    'Changing Profile Wallets, Submission history, payout choices, split percentages, charities, ranks, votes, or finalized results.',
    'Managing actual payouts, amounts, transactions, Treasury keys, publication, or redistribution.',
    'Opening or authenticating Wallet Issue reports, viewing mutable Profile Wallets, or viewing unrelated wallets, secrets, logs, or infrastructure details.'
  ]::text[],
  implementation_version = 2,
  definition_hash =
    'e569fa66e8f9c2794fe030c4e034ebf8a7e458c6ddccf2a868d2cac1fd5ea2bd'
where key = 'winners.recipient_corrections.manage';

alter table public.winner_recipient_corrections
  alter column case_reference drop not null,
  alter column reported_at drop not null;

alter table public.winner_public_profiles
  add column claim_expired boolean not null default false;

update public.winner_public_profiles winner
set claim_expired = (claim.status = 'expired')
from public.winner_claims claim
where claim.cycle_id = winner.cycle_id
  and claim.submission_id = winner.submission_id;

create or replace function public.process_due_winner_claim_transitions(
  p_claim_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_now timestamptz := transaction_timestamp();
  v_count integer := 0;
  v_claim public.winner_claims%rowtype;
begin
  for v_claim in
    select claim.*
    from public.winner_claims claim
    where claim.status = 'unclaimed'
      and claim.claim_deadline_at <= v_now
      and (p_claim_id is null or claim.id = p_claim_id)
    order by claim.claim_deadline_at, claim.id
    for update
  loop
    update public.winner_claims
    set
      status = 'expired',
      version = version + 1,
      claim_deadline_at = null,
      expired_at = v_now,
      updated_at = v_now
    where id = v_claim.id;

    update public.winner_public_profiles
    set wallet_address = null,
        claim_expired = true
    where cycle_id = v_claim.cycle_id
      and submission_id = v_claim.submission_id;

    insert into public.winner_claim_events (
      claim_id, actor_type, action, from_status, to_status, occurred_at
    ) values (
      v_claim.id, 'system', 'expired', 'unclaimed', 'expired', v_now
    );
    v_count := v_count + 1;
  end loop;

  return jsonb_build_object(
    'outcome', 'ok',
    'expiredCount', v_count,
    'processedAt', v_now
  );
end;
$function$;

do $process_existing_due_claims$
begin
  perform public.process_due_winner_claim_transitions(null);
end;
$process_existing_due_claims$;

create or replace function public.mutate_own_winner_claim(
  p_session_id uuid,
  p_claim_id uuid,
  p_request_id uuid,
  p_action text,
  p_expected_candidate_revision text,
  p_publication_acknowledged boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_user_id text;
  v_claim public.winner_claims%rowtype;
  v_request public.winner_claim_requests%rowtype;
  v_candidate jsonb;
  v_source text;
  v_source_version bigint;
  v_address text;
  v_revision text;
  v_request_hash text;
  v_result jsonb;
  v_now timestamptz := transaction_timestamp();
begin
  if p_request_id is null
    or p_action not in ('confirm', 'decline')
    or (
      p_expected_candidate_revision is not null
      and p_expected_candidate_revision !~ '^[0-9a-f]{32}$'
    )
  then
    raise exception using errcode = '22023', message = 'WINNER_CLAIM_INPUT_INVALID';
  end if;

  v_user_id := public.require_account_session(p_session_id);
  perform public.process_due_winner_claim_transitions(p_claim_id);

  select * into v_claim
  from public.winner_claims
  where id = p_claim_id
  for update;
  if not found or v_claim.winner_discord_user_id <> v_user_id then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  v_request_hash := md5(concat_ws(
    '|', p_action, coalesce(p_expected_candidate_revision, ''),
    coalesce(p_publication_acknowledged::text, '')
  ));

  select * into v_request
  from public.winner_claim_requests
  where claim_id = p_claim_id and request_id = p_request_id;
  if found then
    if v_request.actor_discord_user_id <> v_user_id
      or v_request.action <> p_action
      or v_request.request_hash <> v_request_hash
    then
      raise exception using errcode = '22023', message = 'WINNER_CLAIM_REQUEST_REUSED';
    end if;
    return v_request.result || jsonb_build_object('idempotentReplay', true);
  end if;

  if p_action = 'confirm' then
    if p_publication_acknowledged is not true
      or p_expected_candidate_revision is null
    then
      raise exception using errcode = '22023', message = 'WINNER_CLAIM_CONFIRMATION_REQUIRED';
    end if;
    if v_claim.status <> 'unclaimed' then
      v_result := jsonb_build_object('outcome', 'state_conflict', 'status', v_claim.status);
    elsif v_claim.claim_deadline_at <= v_now then
      v_result := jsonb_build_object('outcome', 'state_conflict', 'status', 'expired');
    else
      perform pg_advisory_xact_lock(
        hashtextextended('sol-profile-wallet:' || v_user_id, 0)
      );
      perform pg_advisory_xact_lock(
        hashtextextended('account-2fa:' || v_user_id, 0)
      );
      v_candidate := public.resolve_winner_claim_candidate(p_claim_id, v_user_id);
      if v_candidate->>'outcome' <> 'ready' then
        v_result := jsonb_build_object('outcome', 'recipient_unavailable');
      else
        v_address := v_candidate->>'address';
        v_source := v_candidate->>'source';
        v_revision := v_candidate->>'revision';
        v_source_version := nullif(v_candidate->>'sourceVersion', '')::bigint;
        if v_revision <> p_expected_candidate_revision then
          v_result := jsonb_build_object('outcome', 'candidate_stale');
        elsif not public.is_valid_sol_recipient_address(v_address) then
          v_result := jsonb_build_object('outcome', 'recipient_unavailable');
        else
          update public.winner_claims
          set
            status = 'confirmed',
            version = version + 1,
            claim_deadline_at = null,
            confirmed_recipient = v_address,
            confirmed_recipient_source = v_source,
            confirmed_source_version = v_source_version,
            confirmed_at = v_now,
            updated_at = v_now
          where id = p_claim_id;

          update public.winner_public_profiles
          set wallet_address = v_address,
              claim_expired = false
          where cycle_id = v_claim.cycle_id
            and submission_id = v_claim.submission_id;

          insert into public.winner_claim_events (
            claim_id, actor_type, actor_discord_user_id,
            action, from_status, to_status, occurred_at
          ) values (
            p_claim_id, 'winner', v_user_id,
            'confirmed', 'unclaimed', 'confirmed', v_now
          );
          v_result := jsonb_build_object('outcome', 'confirmed', 'status', 'confirmed');
        end if;
      end if;
    end if;
  else
    if p_publication_acknowledged is not true then
      raise exception using errcode = '22023', message = 'WINNER_CLAIM_DECLINE_CONFIRMATION_REQUIRED';
    end if;
    if v_claim.status not in ('unclaimed', 'correction_pending') then
      v_result := jsonb_build_object('outcome', 'state_conflict', 'status', v_claim.status);
    else
      update public.winner_claims
      set
        status = 'declined',
        version = version + 1,
        claim_deadline_at = null,
        declined_at = v_now,
        updated_at = v_now
      where id = p_claim_id;
      update public.winner_public_profiles
      set wallet_address = null,
          claim_expired = false
      where cycle_id = v_claim.cycle_id
        and submission_id = v_claim.submission_id;
      insert into public.winner_claim_events (
        claim_id, actor_type, actor_discord_user_id,
        action, from_status, to_status, occurred_at
      ) values (
        p_claim_id, 'winner', v_user_id,
        'declined', v_claim.status, 'declined', v_now
      );
      v_result := jsonb_build_object('outcome', 'declined', 'status', 'declined');
    end if;
  end if;

  insert into public.winner_claim_requests (
    claim_id, request_id, actor_discord_user_id, action,
    request_hash, result, created_at
  ) values (
    p_claim_id, p_request_id, v_user_id, p_action,
    v_request_hash, v_result, v_now
  );

  return v_result || jsonb_build_object('idempotentReplay', false);
end;
$function$;

create function public.manage_winner_recipient_correction(
  p_actor_discord_user_id text,
  p_request_id uuid,
  p_claim_id uuid,
  p_expected_claim_version bigint,
  p_proposed_recipient text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor_id text := btrim(p_actor_discord_user_id);
  v_claim public.winner_claims%rowtype;
  v_request public.winner_correction_requests%rowtype;
  v_version bigint;
  v_now timestamptz := transaction_timestamp();
  v_request_hash text;
  v_result jsonb;
begin
  perform public.assert_winner_capability(
    v_actor_id,
    'winners.payouts.view',
    2,
    '9de22d0055e9c8b6b8cb701e4f6f554aa4c241ab0cbfb0a4709ecc9841702a54'
  );
  perform public.assert_winner_capability(
    v_actor_id,
    'winners.recipient_corrections.manage',
    2,
    'e569fa66e8f9c2794fe030c4e034ebf8a7e458c6ddccf2a868d2cac1fd5ea2bd'
  );

  if p_request_id is null
    or p_expected_claim_version is null
    or p_expected_claim_version <= 0
    or p_proposed_recipient is null
    or not public.is_valid_sol_recipient_address(p_proposed_recipient)
  then
    raise exception using errcode = '22023', message = 'WINNER_CORRECTION_INPUT_INVALID';
  end if;

  v_request_hash := md5(concat_ws(
    '|', p_claim_id::text, p_expected_claim_version::text,
    p_proposed_recipient
  ));

  select * into v_request
  from public.winner_correction_requests
  where request_id = p_request_id;
  if found then
    if v_request.actor_discord_user_id <> v_actor_id
      or v_request.claim_id <> p_claim_id
      or v_request.action <> 'propose'
      or v_request.request_hash <> v_request_hash
    then
      raise exception using errcode = '22023', message = 'WINNER_CORRECTION_REQUEST_REUSED';
    end if;
    return v_request.result || jsonb_build_object('idempotentReplay', true);
  end if;

  select * into v_claim
  from public.winner_claims
  where id = p_claim_id
  for update;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  elsif v_claim.version <> p_expected_claim_version then
    v_result := jsonb_build_object('outcome', 'claim_stale', 'claimVersion', v_claim.version);
  elsif v_claim.payout_choice not in ('keep', 'split')
    or v_claim.status in ('confirmed', 'declined', 'not_required')
  then
    v_result := jsonb_build_object('outcome', 'state_conflict', 'status', v_claim.status);
  elsif not exists (
    select 1
    from public.submission_upload_operations operation
    where operation.submission_id = v_claim.submission_id
      and operation.status = 'completed'
      and operation.wallet_source = 'manual'
  ) then
    v_result := jsonb_build_object('outcome', 'not_manual_recipient');
  else
    select coalesce(max(correction.version), 0) + 1
    into v_version
    from public.winner_recipient_corrections correction
    where correction.claim_id = p_claim_id;

    update public.winner_recipient_corrections
    set status = 'superseded', resolved_at = v_now
    where claim_id = p_claim_id and status in ('pending', 'ready');

    insert into public.winner_recipient_corrections (
      claim_id, version, case_reference, reported_at,
      proposed_recipient, status, actor_discord_user_id, created_at
    ) values (
      p_claim_id, v_version, null, null,
      p_proposed_recipient, 'ready', v_actor_id, v_now
    );

    update public.winner_claims
    set
      status = 'unclaimed',
      version = version + 1,
      claim_deadline_at = v_now + interval '24 hours',
      correction_ready_at = v_now,
      expired_at = null,
      updated_at = v_now
    where id = p_claim_id;

    update public.winner_public_profiles
    set wallet_address = null,
        claim_expired = false
    where cycle_id = v_claim.cycle_id
      and submission_id = v_claim.submission_id;

    insert into public.winner_claim_events (
      claim_id, actor_type, actor_discord_user_id, action,
      from_status, to_status, correction_version, case_reference, occurred_at
    ) values (
      p_claim_id, 'team', v_actor_id, 'correction_ready',
      v_claim.status, 'unclaimed', v_version, null, v_now
    );

    v_result := jsonb_build_object(
      'outcome', 'correction_ready',
      'claimVersion', v_claim.version + 1,
      'correctionVersion', v_version,
      'deadlineAt', v_now + interval '24 hours'
    );
  end if;

  insert into public.winner_correction_requests (
    request_id, claim_id, actor_discord_user_id, action,
    request_hash, result, created_at
  ) values (
    p_request_id, p_claim_id, v_actor_id, 'propose',
    v_request_hash, v_result, v_now
  );

  return v_result || jsonb_build_object('idempotentReplay', false);
end;
$function$;

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
      'correctionEligible', exists (
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

alter function public.mutate_own_winner_claim(uuid,uuid,uuid,text,text,boolean)
  owner to postgres;
alter function public.process_due_winner_claim_transitions(uuid)
  owner to postgres;
alter function public.manage_winner_recipient_correction(text,uuid,uuid,bigint,text)
  owner to postgres;
alter function public.get_team_winner_claims(text,boolean)
  owner to postgres;

revoke all on function public.mutate_own_winner_claim(uuid,uuid,uuid,text,text,boolean)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.process_due_winner_claim_transitions(uuid)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.manage_winner_recipient_correction(text,uuid,uuid,bigint,text)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_team_winner_claims(text,boolean)
  from public, anon, authenticated, discord_bot, service_role;

grant execute on function public.mutate_own_winner_claim(uuid,uuid,uuid,text,text,boolean)
  to service_role;
grant execute on function public.process_due_winner_claim_transitions(uuid)
  to service_role;
grant execute on function public.manage_winner_recipient_correction(text,uuid,uuid,bigint,text)
  to service_role;
grant execute on function public.get_team_winner_claims(text,boolean)
  to service_role;

revoke all on function public.manage_winner_recipient_correction(
  text,uuid,uuid,bigint,text,text,timestamptz,text
) from public, anon, authenticated, discord_bot, service_role;
drop function public.manage_winner_recipient_correction(
  text,uuid,uuid,bigint,text,text,timestamptz,text
);

do $postflight$
declare
  v_signature text;
begin
  if (select count(*) from public.capability_catalog) <> 39
    or (select count(*) from public.capability_catalog where is_active) <> 35
    or not exists (
      select 1
      from public.capability_catalog
      where key = 'winners.recipient_corrections.manage'
        and description =
          'Propose versioned SOL recipient corrections for eligible manual-wallet winners while preserving winner-only final confirmation.'
        and implementation_version = 2
        and definition_hash =
          'e569fa66e8f9c2794fe030c4e034ebf8a7e458c6ddccf2a868d2cac1fd5ea2bd'
    )
    or exists (
      select 1
      from public.team_role_capabilities
      where capability_key = 'winners.recipient_corrections.manage'
    )
    or exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'winner_recipient_corrections'
        and column_name in ('case_reference', 'reported_at')
        and is_nullable <> 'YES'
    )
    or not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'winner_public_profiles'
        and column_name = 'claim_expired'
        and data_type = 'boolean'
        and is_nullable = 'NO'
        and column_default = 'false'
    )
    or exists (
      select 1
      from public.winner_public_profiles winner
      join public.winner_claims claim
        on claim.cycle_id = winner.cycle_id
       and claim.submission_id = winner.submission_id
      where winner.claim_expired <> (claim.status = 'expired')
    )
    or to_regprocedure(
      'public.manage_winner_recipient_correction(text,uuid,uuid,bigint,text,text,timestamp with time zone,text)'
    ) is not null
    or to_regprocedure(
      'public.manage_winner_recipient_correction(text,uuid,uuid,bigint,text)'
    ) is null
    or (
      select count(*)
      from pg_proc function_row
      join pg_namespace namespace_row on namespace_row.oid = function_row.pronamespace
      where namespace_row.nspname = 'public'
        and function_row.proname = 'manage_winner_recipient_correction'
    ) <> 1
    or position(
      'correction_incorrect' in pg_get_functiondef(
        'public.mutate_own_winner_claim(uuid,uuid,uuid,text,text,boolean)'::regprocedure
      )
    ) > 0
    or position(
      'caseReference' in pg_get_functiondef(
        'public.get_team_winner_claims(text,boolean)'::regprocedure
      )
    ) > 0
    or position(
      'reportedAt' in pg_get_functiondef(
        'public.get_team_winner_claims(text,boolean)'::regprocedure
      )
    ) > 0
  then
    raise exception using
      errcode = '55000',
      message = 'WINNER_CORRECTION_SIMPLIFICATION_POSTFLIGHT_MISMATCH';
  end if;

  foreach v_signature in array array[
    'public.process_due_winner_claim_transitions(uuid)',
    'public.mutate_own_winner_claim(uuid,uuid,uuid,text,text,boolean)',
    'public.manage_winner_recipient_correction(text,uuid,uuid,bigint,text)',
    'public.get_team_winner_claims(text,boolean)'
  ]
  loop
    if not has_function_privilege('service_role', v_signature, 'EXECUTE')
      or has_function_privilege('anon', v_signature, 'EXECUTE')
      or has_function_privilege('authenticated', v_signature, 'EXECUTE')
      or has_function_privilege('discord_bot', v_signature, 'EXECUTE')
      or (
        select pg_get_userbyid(function_row.proowner) <> 'postgres'
          or function_row.prosecdef is not true
          or function_row.proconfig <> array['search_path=public, pg_temp']
        from pg_proc function_row
        where function_row.oid = v_signature::regprocedure
      )
    then
      raise exception using
        errcode = '55000',
        message = 'WINNER_CORRECTION_SIMPLIFICATION_FUNCTION_MISMATCH';
    end if;
  end loop;
end;
$postflight$;

comment on table public.winner_recipient_corrections is
  'Private versioned manual-recipient proposals; external report intake and authentication are separate product concerns.';
comment on column public.winner_recipient_corrections.case_reference is
  'Legacy nullable external-case reference; new direct proposals leave it null.';
comment on column public.winner_recipient_corrections.reported_at is
  'Legacy nullable external report timestamp; new direct proposals leave it null.';
comment on function public.manage_winner_recipient_correction(text,uuid,uuid,bigint,text) is
  'Proposes a versioned manual-recipient correction with a fresh database-time 24-hour winner review window.';
comment on column public.winner_public_profiles.claim_expired is
  'Public allowlisted marker that the winner did not confirm within the authoritative Claim window.';

commit;
