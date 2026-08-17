begin;

do $baseline$
begin
  if to_regclass('public.winner_claims') is not null
    or to_regclass('public.winner_recipient_corrections') is not null
    or to_regclass('public.winner_claim_requests') is not null
    or to_regclass('public.winner_correction_requests') is not null
    or to_regclass('public.winner_claim_events') is not null
    or to_regprocedure('public.finalize_cycle_without_winner_claims(bigint,text)') is not null
    or to_regprocedure('public.finalize_cycle(bigint,text)') is null
    or to_regprocedure('public.require_account_session(uuid)') is null
    or to_regprocedure('public.is_valid_sol_recipient_address(text)') is null
    or to_regclass('public.account_sol_profile_wallets') is null
    or to_regclass('public.account_totp_factors') is null
    or to_regclass('public.submission_upload_operations') is null
    or to_regclass('public.submission_private_data') is null
    or coalesce((
      select column_info.is_nullable
      from information_schema.columns column_info
      where column_info.table_schema = 'public'
        and column_info.table_name = 'winner_public_profiles'
        and column_info.column_name = 'wallet_address'
    ), '<missing>') <> 'NO'
    or (select count(*) from public.capability_catalog) <> 38
    or (select count(*) from public.capability_catalog where is_active) <> 34
    or not exists (
      select 1
      from public.capability_catalog
      where key = 'winners.payouts.view'
        and is_active
        and assignable_to_non_admin
        and implementation_version = 1
        and definition_hash =
          'd482f10a0e15ea2f166f633e7cf8a27760987ea748fddc4b5c34aa6abde978e9'
    )
    or exists (
      select 1
      from public.capability_catalog
      where key = 'winners.recipient_corrections.manage'
    )
    or exists (
      select 1
      from public.winner_public_profiles winner
      left join public.submissions submission
        on submission.id = winner.submission_id
      left join public.cycle_results result_row
        on result_row.cycle_id = winner.cycle_id
       and result_row.submission_id = winner.submission_id
       and result_row.is_winner
      where submission.id is null
        or result_row.id is null
        or winner.payout_choice not in ('keep', 'split', 'donate')
    )
  then
    raise exception using
      errcode = '55000',
      message = 'WINNER_CLAIM_BASELINE_MISMATCH';
  end if;
end;
$baseline$;

alter table public.winner_public_profiles
  alter column wallet_address drop not null;

update public.capability_catalog
set
  description =
    'Review finalized winner identities, prize shares, payout choices, charities, Claim status, and confirmed locked recipient addresses without changing Claims or payouts.',
  included_actions = array[
    'View finalized winners grouped by cycle with theme, submission, identity, votes, and prize share.',
    'View payout choice, charity or split details for every finalized winner.',
    'View all six canonical Claim states, deadlines, and terminal timestamps.',
    'View and copy an exact recipient only after a confirmed keep or split Claim.'
  ]::text[],
  excluded_actions = array[
    'Viewing mutable Profile Wallets, Upload snapshots, correction drafts, or unconfirmed, declined, expired, or donation recipients.',
    'Initiating, confirming, declining, reopening, or otherwise changing Claims, recipient corrections, or payouts.',
    'Editing winners, rankings, votes, refunds, disqualifications, or finalized cycle history.',
    'Viewing non-winner private submission data, unrelated wallets, secrets, sponsor reports, unrelated logs, or infrastructure details.'
  ]::text[],
  implementation_version = 2,
  definition_hash =
    '9de22d0055e9c8b6b8cb701e4f6f554aa4c241ab0cbfb0a4709ecc9841702a54'
where key = 'winners.payouts.view';

insert into public.capability_catalog (
  key,
  display_name,
  description,
  category,
  included_actions,
  excluded_actions,
  risk_level,
  assignable_to_non_admin,
  is_active,
  implementation_version,
  definition_hash
)
values (
  'winners.recipient_corrections.manage',
  'Manage Winner Recipient Corrections',
  'Record and propose bounded winner recipient corrections only for eligible manual-wallet winners with a timely verified Tally case.',
  'Winner & Payouts',
  array[
    'Suspend an eligible unconfirmed manual-wallet Claim for a verified Tally case reported no later than finalization.',
    'Propose a canonically valid replacement recipient as a new version and start a fresh 24-hour winner review window.',
    'Review the bounded case reference, report timestamp, version, and exact private proposal needed for correction work.'
  ]::text[],
  array[
    'Confirming, declining, reopening, or otherwise acting on behalf of a winner.',
    'Changing Profile Wallets, Submission history, payout choices, split percentages, charities, ranks, votes, or finalized results.',
    'Managing actual payouts, amounts, transactions, Treasury keys, publication, or redistribution.',
    'Opening post-finalization Tally cases or viewing unrelated wallets, Tally content, secrets, logs, or infrastructure details.'
  ]::text[],
  'critical',
  true,
  true,
  1,
  '7d10b252f8dc45655c58c2fc06a2c5ac9610b6d237169c95f3bfa0ad98605395'
);

create table public.winner_claims (
  id uuid primary key default gen_random_uuid(),
  cycle_id bigint not null references public.voting_cycles(id) on delete restrict,
  submission_id bigint not null references public.submissions(id) on delete restrict,
  winner_discord_user_id text not null
    references public.user_logs(discord_user_id) on delete restrict,
  payout_choice text not null check (payout_choice in ('keep', 'split', 'donate')),
  split_percent integer,
  charity text,
  status text not null check (status in (
    'not_required', 'unclaimed', 'correction_pending',
    'confirmed', 'declined', 'expired'
  )),
  version bigint not null default 1 check (version > 0),
  finalized_at timestamptz not null,
  initial_deadline_at timestamptz,
  claim_deadline_at timestamptz,
  correction_ready_at timestamptz,
  confirmed_recipient text,
  confirmed_recipient_source text check (
    confirmed_recipient_source is null
    or confirmed_recipient_source in ('profile', 'correction', 'submission')
  ),
  confirmed_source_version bigint,
  confirmed_at timestamptz,
  declined_at timestamptz,
  expired_at timestamptz,
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  unique (cycle_id, submission_id),
  unique (id, winner_discord_user_id),
  constraint winner_claim_decision_check check (
    (
      payout_choice = 'keep'
      and split_percent is null
      and charity is null
    )
    or (
      payout_choice = 'split'
      and split_percent between 1 and 99
      and nullif(btrim(charity), '') is not null
      and length(charity) <= 256
    )
    or (
      payout_choice = 'donate'
      and split_percent is null
      and nullif(btrim(charity), '') is not null
      and length(charity) <= 256
    )
  ),
  constraint winner_claim_state_check check (
    (
      status = 'not_required'
      and payout_choice = 'donate'
      and initial_deadline_at is null
      and claim_deadline_at is null
      and correction_ready_at is null
      and confirmed_recipient is null
      and confirmed_recipient_source is null
      and confirmed_source_version is null
      and confirmed_at is null
      and declined_at is null
      and expired_at is null
    )
    or (
      payout_choice in ('keep', 'split')
      and initial_deadline_at is not null
      and (
        (status = 'unclaimed' and claim_deadline_at is not null)
        or (status <> 'unclaimed' and claim_deadline_at is null)
      )
      and (
        (
          status = 'confirmed'
          and public.is_valid_sol_recipient_address(confirmed_recipient)
          and confirmed_recipient_source is not null
          and confirmed_at is not null
        )
        or (
          status <> 'confirmed'
          and confirmed_recipient is null
          and confirmed_recipient_source is null
          and confirmed_source_version is null
          and confirmed_at is null
        )
      )
      and ((status = 'declined') = (declined_at is not null))
      and ((status = 'expired') = (expired_at is not null))
    )
  )
);

create index winner_claims_owner_recent_idx
  on public.winner_claims(winner_discord_user_id, finalized_at desc, id);
create index winner_claims_due_idx
  on public.winner_claims(claim_deadline_at, id)
  where status = 'unclaimed';

create table public.winner_recipient_corrections (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references public.winner_claims(id) on delete restrict,
  version bigint not null check (version > 0),
  case_reference text not null check (
    char_length(btrim(case_reference)) between 1 and 120
    and case_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$'
  ),
  reported_at timestamptz not null,
  proposed_recipient text,
  status text not null check (status in ('pending', 'ready', 'incorrect', 'superseded')),
  actor_discord_user_id text not null,
  created_at timestamptz not null default transaction_timestamp(),
  resolved_at timestamptz,
  unique (claim_id, version),
  constraint winner_recipient_correction_value_check check (
    (status = 'pending' and proposed_recipient is null)
    or (
      status in ('ready', 'incorrect')
      and public.is_valid_sol_recipient_address(proposed_recipient)
    )
    or (
      status = 'superseded'
      and (
        proposed_recipient is null
        or public.is_valid_sol_recipient_address(proposed_recipient)
      )
    )
  )
);

create index winner_recipient_corrections_claim_idx
  on public.winner_recipient_corrections(claim_id, version desc);

create table public.winner_claim_requests (
  claim_id uuid not null references public.winner_claims(id) on delete restrict,
  request_id uuid not null,
  actor_discord_user_id text not null,
  action text not null check (action in ('confirm', 'decline', 'correction_incorrect')),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{32}$'),
  result jsonb not null,
  created_at timestamptz not null default transaction_timestamp(),
  primary key (claim_id, request_id)
);

create table public.winner_correction_requests (
  request_id uuid primary key,
  claim_id uuid not null references public.winner_claims(id) on delete restrict,
  actor_discord_user_id text not null,
  action text not null check (action in ('record_pending', 'propose')),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{32}$'),
  result jsonb not null,
  created_at timestamptz not null default transaction_timestamp()
);

create table public.winner_claim_events (
  id bigint generated always as identity primary key,
  claim_id uuid not null references public.winner_claims(id) on delete restrict,
  actor_type text not null check (actor_type in ('winner', 'team', 'system')),
  actor_discord_user_id text,
  action text not null check (action in (
    'confirmed', 'declined', 'expired', 'correction_pending',
    'correction_ready', 'correction_incorrect'
  )),
  from_status text not null,
  to_status text not null,
  correction_version bigint,
  case_reference text,
  occurred_at timestamptz not null default transaction_timestamp()
);

create index winner_claim_events_claim_idx
  on public.winner_claim_events(claim_id, occurred_at desc, id desc);

alter table public.winner_claims enable row level security;
alter table public.winner_recipient_corrections enable row level security;
alter table public.winner_claim_requests enable row level security;
alter table public.winner_correction_requests enable row level security;
alter table public.winner_claim_events enable row level security;

revoke all on table public.winner_claims
  from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.winner_recipient_corrections
  from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.winner_claim_requests
  from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.winner_correction_requests
  from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.winner_claim_events
  from public, anon, authenticated, discord_bot, service_role;
revoke all on sequence public.winner_claim_events_id_seq
  from public, anon, authenticated, discord_bot, service_role;

create function public.protect_winner_claim_event()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  raise exception using
    errcode = '55000',
    message = 'WINNER_CLAIM_EVENT_IS_APPEND_ONLY';
end;
$function$;

create trigger winner_claim_events_no_update
before update on public.winner_claim_events
for each row execute function public.protect_winner_claim_event();

create trigger winner_claim_events_no_delete
before delete on public.winner_claim_events
for each row execute function public.protect_winner_claim_event();

create function public.assert_winner_capability(
  p_actor_discord_user_id text,
  p_capability_key text,
  p_implementation_version integer,
  p_definition_hash text
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
    or v_actor_id !~ '^[0-9]+$'
  then
    raise exception using errcode = '42501', message = 'WINNER_CAPABILITY_FORBIDDEN';
  end if;

  if not exists (
    select 1
    from public.capability_catalog capability
    where capability.key = p_capability_key
      and capability.is_active
      and capability.assignable_to_non_admin
      and capability.implementation_version = p_implementation_version
      and capability.definition_hash = p_definition_hash
  ) then
    raise exception using
      errcode = '55000',
      message = 'WINNER_CAPABILITY_DEPENDENCY_UNAVAILABLE';
  end if;

  select member.role
  into v_actor_role
  from public.team_members member
  join public.team_roles role
    on role.key = member.role
   and role.is_active
  where member.discord_user_id = v_actor_id;

  if not found or (
    v_actor_role <> 'admin'
    and not exists (
      select 1
      from public.team_role_capabilities grant_row
      where grant_row.role_key = v_actor_role
        and grant_row.capability_key = p_capability_key
    )
  ) then
    raise exception using errcode = '42501', message = 'WINNER_CAPABILITY_FORBIDDEN';
  end if;

  return v_actor_role;
end;
$function$;

create function public.process_due_winner_claim_transitions(
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
    set wallet_address = null
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

create function public.resolve_winner_claim_candidate(
  p_claim_id uuid,
  p_winner_discord_user_id text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_claim public.winner_claims%rowtype;
  v_address text;
  v_source text;
  v_source_version bigint;
  v_revision text;
begin
  select * into v_claim
  from public.winner_claims
  where id = p_claim_id
    and winner_discord_user_id = p_winner_discord_user_id;

  if not found or v_claim.status <> 'unclaimed' then
    return jsonb_build_object('outcome', 'not_ready');
  end if;

  select wallet.wallet_address, wallet.version
  into v_address, v_source_version
  from public.account_sol_profile_wallets wallet
  where wallet.discord_user_id = p_winner_discord_user_id
    and public.is_valid_sol_recipient_address(wallet.wallet_address)
    and exists (
      select 1
      from public.account_totp_factors factor
      where factor.discord_user_id = p_winner_discord_user_id
    );

  if found then
    v_source := 'profile';
  else
    select correction.proposed_recipient, correction.version
    into v_address, v_source_version
    from public.winner_recipient_corrections correction
    where correction.claim_id = p_claim_id
      and correction.status = 'ready'
    order by correction.version desc
    limit 1;

    if found then
      v_source := 'correction';
    else
      select private_data.wallet_address
      into v_address
      from public.submission_private_data private_data
      where private_data.submission_id = v_claim.submission_id
      order by private_data.id desc
      limit 1;
      v_source := 'submission';
      v_source_version := null;
    end if;
  end if;

  if not public.is_valid_sol_recipient_address(v_address) then
    return jsonb_build_object('outcome', 'recipient_unavailable');
  end if;

  v_revision := md5(concat_ws(
    '|',
    v_claim.id::text,
    v_claim.version::text,
    coalesce(v_claim.claim_deadline_at::text, ''),
    v_source,
    coalesce(v_source_version::text, ''),
    v_address
  ));

  return jsonb_build_object(
    'outcome', 'ready',
    'address', v_address,
    'source', v_source,
    'sourceVersion', v_source_version,
    'revision', v_revision
  );
end;
$function$;

create function public.get_own_winner_claims(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_user_id text;
  v_items jsonb;
begin
  v_user_id := public.require_account_session(p_session_id);
  perform public.process_due_winner_claim_transitions(null);

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'claimId', claim.id,
      'cycleId', claim.cycle_id,
      'cycleNumber', cycle.public_number,
      'submissionId', claim.submission_id,
      'payoutChoice', claim.payout_choice,
      'splitPercent', claim.split_percent,
      'charity', claim.charity,
      'status', claim.status,
      'finalizedAt', claim.finalized_at,
      'deadlineAt', claim.claim_deadline_at,
      'confirmedAt', claim.confirmed_at,
      'declinedAt', claim.declined_at,
      'expiredAt', claim.expired_at
    ) order by claim.finalized_at desc, claim.id
  ), '[]'::jsonb)
  into v_items
  from public.winner_claims claim
  join public.voting_cycles cycle on cycle.id = claim.cycle_id
  where claim.winner_discord_user_id = v_user_id;

  return jsonb_build_object(
    'outcome', 'ok',
    'databaseTime', transaction_timestamp(),
    'items', v_items
  );
end;
$function$;

create function public.get_own_winner_claim(
  p_session_id uuid,
  p_claim_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_user_id text;
  v_claim public.winner_claims%rowtype;
  v_candidate jsonb;
begin
  v_user_id := public.require_account_session(p_session_id);
  perform public.process_due_winner_claim_transitions(p_claim_id);

  select * into v_claim
  from public.winner_claims
  where id = p_claim_id
    and winner_discord_user_id = v_user_id;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  v_candidate := case
    when v_claim.status = 'unclaimed'
      then public.resolve_winner_claim_candidate(v_claim.id, v_user_id)
    else jsonb_build_object('outcome', 'not_ready')
  end;

  return jsonb_build_object(
    'outcome', 'ok',
    'databaseTime', transaction_timestamp(),
    'claimId', v_claim.id,
    'claimVersion', v_claim.version,
    'cycleId', v_claim.cycle_id,
    'cycleNumber', (select public_number from public.voting_cycles where id = v_claim.cycle_id),
    'submissionId', v_claim.submission_id,
    'payoutChoice', v_claim.payout_choice,
    'splitPercent', v_claim.split_percent,
    'charity', v_claim.charity,
    'status', v_claim.status,
    'finalizedAt', v_claim.finalized_at,
    'initialDeadlineAt', v_claim.initial_deadline_at,
    'deadlineAt', v_claim.claim_deadline_at,
    'confirmedAt', v_claim.confirmed_at,
    'declinedAt', v_claim.declined_at,
    'expiredAt', v_claim.expired_at,
    'confirmedRecipient', case when v_claim.status = 'confirmed' then v_claim.confirmed_recipient else null end,
    'confirmedRecipientSource', case when v_claim.status = 'confirmed' then v_claim.confirmed_recipient_source else null end,
    'candidate', v_candidate
  );
end;
$function$;

create function public.mutate_own_winner_claim(
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
  v_correction public.winner_recipient_corrections%rowtype;
begin
  if p_request_id is null
    or p_action not in ('confirm', 'decline', 'correction_incorrect')
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
          set wallet_address = v_address
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
  elsif p_action = 'decline' then
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
      set wallet_address = null
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
  else
    if p_expected_candidate_revision is null or v_claim.status <> 'unclaimed' then
      v_result := jsonb_build_object('outcome', 'state_conflict', 'status', v_claim.status);
    else
      v_candidate := public.resolve_winner_claim_candidate(p_claim_id, v_user_id);
      if v_candidate->>'outcome' <> 'ready'
        or v_candidate->>'source' <> 'correction'
        or v_candidate->>'revision' <> p_expected_candidate_revision
      then
        v_result := jsonb_build_object('outcome', 'candidate_stale');
      else
        select * into v_correction
        from public.winner_recipient_corrections
        where claim_id = p_claim_id and status = 'ready'
        order by version desc
        limit 1
        for update;
        if not found then
          v_result := jsonb_build_object('outcome', 'candidate_stale');
        else
          update public.winner_recipient_corrections
          set status = 'incorrect', resolved_at = v_now
          where id = v_correction.id;
          update public.winner_claims
          set
            status = 'correction_pending',
            version = version + 1,
            claim_deadline_at = null,
            updated_at = v_now
          where id = p_claim_id;
          insert into public.winner_claim_events (
            claim_id, actor_type, actor_discord_user_id, action,
            from_status, to_status, correction_version, case_reference, occurred_at
          ) values (
            p_claim_id, 'winner', v_user_id, 'correction_incorrect',
            'unclaimed', 'correction_pending', v_correction.version,
            v_correction.case_reference, v_now
          );
          v_result := jsonb_build_object(
            'outcome', 'correction_pending', 'status', 'correction_pending'
          );
        end if;
      end if;
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
  p_action text,
  p_case_reference text,
  p_reported_at timestamptz,
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
    1,
    '7d10b252f8dc45655c58c2fc06a2c5ac9610b6d237169c95f3bfa0ad98605395'
  );

  if p_request_id is null
    or p_expected_claim_version is null
    or p_expected_claim_version <= 0
    or p_action not in ('record_pending', 'propose')
    or p_reported_at is null
    or p_case_reference is null
    or char_length(btrim(p_case_reference)) not between 1 and 120
    or btrim(p_case_reference) !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$'
    or (p_action = 'record_pending' and p_proposed_recipient is not null)
    or (
      p_action = 'propose'
      and (
        p_proposed_recipient is null
        or not public.is_valid_sol_recipient_address(p_proposed_recipient)
      )
    )
  then
    raise exception using errcode = '22023', message = 'WINNER_CORRECTION_INPUT_INVALID';
  end if;

  v_request_hash := md5(concat_ws(
    '|', p_claim_id::text, p_expected_claim_version::text, p_action,
    btrim(p_case_reference), p_reported_at::text, coalesce(p_proposed_recipient, '')
  ));

  select * into v_request
  from public.winner_correction_requests
  where request_id = p_request_id;
  if found then
    if v_request.actor_discord_user_id <> v_actor_id
      or v_request.claim_id <> p_claim_id
      or v_request.action <> p_action
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
  elsif p_reported_at > v_claim.finalized_at then
    v_result := jsonb_build_object('outcome', 'report_too_late');
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
      p_claim_id, v_version, btrim(p_case_reference), p_reported_at,
      p_proposed_recipient,
      case when p_action = 'propose' then 'ready' else 'pending' end,
      v_actor_id, v_now
    );

    update public.winner_claims
    set
      status = case when p_action = 'propose' then 'unclaimed' else 'correction_pending' end,
      version = version + 1,
      claim_deadline_at = case when p_action = 'propose' then v_now + interval '24 hours' else null end,
      correction_ready_at = case when p_action = 'propose' then v_now else correction_ready_at end,
      expired_at = null,
      updated_at = v_now
    where id = p_claim_id;

    update public.winner_public_profiles
    set wallet_address = null
    where cycle_id = v_claim.cycle_id
      and submission_id = v_claim.submission_id;

    insert into public.winner_claim_events (
      claim_id, actor_type, actor_discord_user_id, action,
      from_status, to_status, correction_version, case_reference, occurred_at
    ) values (
      p_claim_id, 'team', v_actor_id,
      case when p_action = 'propose' then 'correction_ready' else 'correction_pending' end,
      v_claim.status,
      case when p_action = 'propose' then 'unclaimed' else 'correction_pending' end,
      v_version, btrim(p_case_reference), v_now
    );

    v_result := jsonb_build_object(
      'outcome', case when p_action = 'propose' then 'correction_ready' else 'correction_pending' end,
      'claimVersion', v_claim.version + 1,
      'correctionVersion', v_version,
      'deadlineAt', case when p_action = 'propose' then v_now + interval '24 hours' else null end
    );
  end if;

  insert into public.winner_correction_requests (
    request_id, claim_id, actor_discord_user_id, action,
    request_hash, result, created_at
  ) values (
    p_request_id, p_claim_id, v_actor_id, p_action,
    v_request_hash, v_result, v_now
  );

  return v_result || jsonb_build_object('idempotentReplay', false);
end;
$function$;

create function public.get_team_winner_claims(
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
      1,
      '7d10b252f8dc45655c58c2fc06a2c5ac9610b6d237169c95f3bfa0ad98605395'
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
            'caseReference', correction.case_reference,
            'reportedAt', correction.reported_at,
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

insert into public.winner_claims (
  cycle_id, submission_id, winner_discord_user_id,
  payout_choice, split_percent, charity, status, version,
  finalized_at, initial_deadline_at, claim_deadline_at,
  created_at, updated_at
)
select
  winner.cycle_id,
  winner.submission_id,
  submission.discord_user_id,
  winner.payout_choice,
  winner.split_percent,
  winner.charity,
  case when winner.payout_choice = 'donate' then 'not_required' else 'unclaimed' end,
  1,
  coalesce(cycle.finalized_at, result_row.finalized_at, transaction_timestamp()),
  case when winner.payout_choice = 'donate' then null else transaction_timestamp() + interval '24 hours' end,
  case when winner.payout_choice = 'donate' then null else transaction_timestamp() + interval '24 hours' end,
  transaction_timestamp(),
  transaction_timestamp()
from public.winner_public_profiles winner
join public.submissions submission on submission.id = winner.submission_id
join public.voting_cycles cycle on cycle.id = winner.cycle_id
join public.cycle_results result_row
  on result_row.cycle_id = winner.cycle_id
 and result_row.submission_id = winner.submission_id
 and result_row.is_winner
on conflict (cycle_id, submission_id) do nothing;

update public.winner_public_profiles winner
set wallet_address = null
where exists (
  select 1
  from public.winner_claims claim
  where claim.cycle_id = winner.cycle_id
    and claim.submission_id = winner.submission_id
    and claim.status <> 'confirmed'
);

alter function public.finalize_cycle(bigint, text)
  rename to finalize_cycle_without_winner_claims;

create function public.finalize_cycle(
  p_cycle_id bigint,
  p_actor_discord_user_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_result jsonb;
  v_finalized_at timestamptz;
  v_winner_count integer;
  v_claim_count integer;
begin
  v_result := public.finalize_cycle_without_winner_claims(
    p_cycle_id,
    p_actor_discord_user_id
  );

  select finalized_at into v_finalized_at
  from public.voting_cycles
  where id = p_cycle_id
  for update;
  if v_finalized_at is null then
    raise exception using message = 'WINNER_CLAIM_FINALIZATION_TIME_MISSING';
  end if;

  insert into public.winner_claims (
    cycle_id, submission_id, winner_discord_user_id,
    payout_choice, split_percent, charity, status, version,
    finalized_at, initial_deadline_at, claim_deadline_at,
    created_at, updated_at
  )
  select
    winner.cycle_id,
    winner.submission_id,
    submission.discord_user_id,
    winner.payout_choice,
    winner.split_percent,
    winner.charity,
    case when winner.payout_choice = 'donate' then 'not_required' else 'unclaimed' end,
    1,
    v_finalized_at,
    case when winner.payout_choice = 'donate' then null else v_finalized_at + interval '24 hours' end,
    case when winner.payout_choice = 'donate' then null else v_finalized_at + interval '24 hours' end,
    v_finalized_at,
    v_finalized_at
  from public.winner_public_profiles winner
  join public.submissions submission on submission.id = winner.submission_id
  where winner.cycle_id = p_cycle_id
  on conflict (cycle_id, submission_id) do nothing;

  update public.winner_public_profiles winner
  set wallet_address = null
  where winner.cycle_id = p_cycle_id
    and exists (
      select 1
      from public.winner_claims claim
      where claim.cycle_id = winner.cycle_id
        and claim.submission_id = winner.submission_id
        and claim.status <> 'confirmed'
    );

  select count(*)::integer into v_winner_count
  from public.winner_public_profiles
  where cycle_id = p_cycle_id;
  select count(*)::integer into v_claim_count
  from public.winner_claims
  where cycle_id = p_cycle_id;
  if v_winner_count = 0 or v_claim_count <> v_winner_count then
    raise exception using message = 'WINNER_CLAIM_FINALIZATION_INCOMPLETE';
  end if;

  return v_result || jsonb_build_object('winnerClaimCount', v_claim_count);
end;
$function$;

alter table public.winner_claims owner to postgres;
alter table public.winner_recipient_corrections owner to postgres;
alter table public.winner_claim_requests owner to postgres;
alter table public.winner_correction_requests owner to postgres;
alter table public.winner_claim_events owner to postgres;
alter sequence public.winner_claim_events_id_seq owner to postgres;

alter function public.protect_winner_claim_event() owner to postgres;
alter function public.assert_winner_capability(text,text,integer,text) owner to postgres;
alter function public.process_due_winner_claim_transitions(uuid) owner to postgres;
alter function public.resolve_winner_claim_candidate(uuid,text) owner to postgres;
alter function public.get_own_winner_claims(uuid) owner to postgres;
alter function public.get_own_winner_claim(uuid,uuid) owner to postgres;
alter function public.mutate_own_winner_claim(uuid,uuid,uuid,text,text,boolean) owner to postgres;
alter function public.manage_winner_recipient_correction(text,uuid,uuid,bigint,text,text,timestamptz,text) owner to postgres;
alter function public.get_team_winner_claims(text,boolean) owner to postgres;
alter function public.finalize_cycle_without_winner_claims(bigint,text) owner to postgres;
alter function public.finalize_cycle(bigint,text) owner to postgres;

revoke all on function public.protect_winner_claim_event()
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.assert_winner_capability(text,text,integer,text)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.process_due_winner_claim_transitions(uuid)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.resolve_winner_claim_candidate(uuid,text)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_own_winner_claims(uuid)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_own_winner_claim(uuid,uuid)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.mutate_own_winner_claim(uuid,uuid,uuid,text,text,boolean)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.manage_winner_recipient_correction(text,uuid,uuid,bigint,text,text,timestamptz,text)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_team_winner_claims(text,boolean)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.finalize_cycle_without_winner_claims(bigint,text)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.finalize_cycle(bigint,text)
  from public, anon, authenticated, discord_bot, service_role;

grant execute on function public.process_due_winner_claim_transitions(uuid)
  to service_role;
grant execute on function public.get_own_winner_claims(uuid)
  to service_role;
grant execute on function public.get_own_winner_claim(uuid,uuid)
  to service_role;
grant execute on function public.mutate_own_winner_claim(uuid,uuid,uuid,text,text,boolean)
  to service_role;
grant execute on function public.manage_winner_recipient_correction(text,uuid,uuid,bigint,text,text,timestamptz,text)
  to service_role;
grant execute on function public.get_team_winner_claims(text,boolean)
  to service_role;

do $postflight$
declare
  v_signature text;
begin
  if (select count(*) from public.capability_catalog) <> 39
    or (select count(*) from public.capability_catalog where is_active) <> 35
    or exists (
      select 1
      from public.team_role_capabilities
      where capability_key = 'winners.recipient_corrections.manage'
    )
    or exists (
      select 1
      from public.winner_public_profiles winner
      join public.winner_claims claim
        on claim.cycle_id = winner.cycle_id
       and claim.submission_id = winner.submission_id
      where claim.status <> 'confirmed'
        and winner.wallet_address is not null
    )
    or exists (
      select 1
      from public.winner_public_profiles winner
      where not exists (
        select 1
        from public.winner_claims claim
        where claim.cycle_id = winner.cycle_id
          and claim.submission_id = winner.submission_id
      )
    )
  then
    raise exception using
      errcode = '55000',
      message = 'WINNER_CLAIM_POSTFLIGHT_MISMATCH';
  end if;

  foreach v_signature in array array[
    'public.process_due_winner_claim_transitions(uuid)',
    'public.get_own_winner_claims(uuid)',
    'public.get_own_winner_claim(uuid,uuid)',
    'public.mutate_own_winner_claim(uuid,uuid,uuid,text,text,boolean)',
    'public.manage_winner_recipient_correction(text,uuid,uuid,bigint,text,text,timestamp with time zone,text)',
    'public.get_team_winner_claims(text,boolean)'
  ]
  loop
    if not has_function_privilege('service_role', v_signature, 'EXECUTE')
      or has_function_privilege('anon', v_signature, 'EXECUTE')
      or has_function_privilege('authenticated', v_signature, 'EXECUTE')
      or has_function_privilege('discord_bot', v_signature, 'EXECUTE')
    then
      raise exception using
        errcode = '55000',
        message = 'WINNER_CLAIM_FUNCTION_ACL_MISMATCH';
    end if;
  end loop;
end;
$postflight$;

comment on table public.winner_claims is
  'Private canonical one-row-per-finalized-winner Claim state with immutable confirmed recipient.';
comment on table public.winner_recipient_corrections is
  'Private versioned manual-recipient correction proposals bound to timely verified Tally cases.';
comment on function public.process_due_winner_claim_transitions(uuid) is
  'Provider-neutral database-time transition for due unclaimed winner Claims.';
comment on function public.finalize_cycle(bigint,text) is
  'Preserves canonical Cycle finalization and atomically creates exactly one Claim per tied rank-one winner.';

commit;
