begin;

alter table public.payout_transactions
  add column verified_lamports bigint;

update public.payout_transactions
set verified_lamports = expected_lamports
where evidence_level = 'on_chain_verified';

create function public.set_payout_transaction_verified_lamports()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $function$
begin
  if new.evidence_level = 'on_chain_verified' and new.verified_lamports is null then
    new.verified_lamports := new.expected_lamports;
  end if;
  return new;
end;
$function$;

create trigger set_payout_transaction_verified_lamports
before insert on public.payout_transactions
for each row execute function public.set_payout_transaction_verified_lamports();

alter function public.set_payout_transaction_verified_lamports() owner to postgres;
revoke all on function public.set_payout_transaction_verified_lamports()
  from public, anon, authenticated, discord_bot, service_role;

alter table public.payout_transactions
  add constraint payout_transaction_verified_lamports_check check (
    (evidence_level = 'on_chain_verified' and verified_lamports > 0)
    or (evidence_level = 'operator_confirmed_provider' and verified_lamports is null)
  );

alter table public.payout_lines
  add column paid_lamports bigint,
  add column overpayment_reason text;

update public.payout_lines
set paid_lamports = amount_lamports
where current_transaction_id is not null;

alter table public.payout_lines
  add constraint payout_line_paid_amount_check check (
    (paid_lamports is null and overpayment_reason is null)
    or (paid_lamports = amount_lamports and overpayment_reason is null)
    or (
      paid_lamports > amount_lamports
      and overpayment_reason = btrim(overpayment_reason)
      and char_length(overpayment_reason) between 3 and 500
    )
  );

create function public.complete_and_publish_payout_v2(
  p_actor_discord_user_id text,
  p_request_id uuid,
  p_allocation_public_id uuid,
  p_expected_claim_version bigint,
  p_donation_operation_recipient text,
  p_winner_transactions jsonb,
  p_winner_overpayment_confirmed boolean,
  p_winner_overpayment_reason text,
  p_donation_transactions jsonb,
  p_donation_overpayment_confirmed boolean,
  p_donation_overpayment_reason text,
  p_receipt_r2_key text,
  p_receipt_byte_size integer,
  p_receipt_width integer,
  p_receipt_height integer,
  p_receipt_public_approved boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_role text;
  v_allocation public.cycle_prize_allocations%rowtype;
  v_claim public.winner_claims%rowtype;
  v_plan public.payout_plans%rowtype;
  v_winner_line public.payout_lines%rowtype;
  v_donation_line public.payout_lines%rowtype;
  v_transaction public.payout_transactions%rowtype;
  v_transaction_input record;
  v_correction public.payout_donation_corrections%rowtype;
  v_reference public.submission_organization_references%rowtype;
  v_org_name text;
  v_org_url text;
  v_org_source text;
  v_org_revision bigint;
  v_org_version bigint;
  v_next_plan_version bigint;
  v_transaction_version bigint;
  v_winner_count integer;
  v_winner_unique_count integer;
  v_winner_total bigint;
  v_donation_count integer;
  v_donation_unique_count integer;
  v_donation_total bigint;
  v_hash text;
  v_request public.payout_mutation_requests%rowtype;
  v_response jsonb;
begin
  v_role := public.assert_winners_payout_capability(
    p_actor_discord_user_id, 'winners.manage_payouts'
  );
  if p_request_id is null or p_allocation_public_id is null
    or p_expected_claim_version <= 0
    or jsonb_typeof(coalesce(p_winner_transactions, '[]'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(p_donation_transactions, '[]'::jsonb)) <> 'array'
  then raise exception using message = 'PAYOUT_INPUT_INVALID'; end if;

  p_winner_transactions := coalesce(p_winner_transactions, '[]'::jsonb);
  p_donation_transactions := coalesce(p_donation_transactions, '[]'::jsonb);
  if jsonb_array_length(p_winner_transactions) > 10
    or jsonb_array_length(p_donation_transactions) > 10
  then raise exception using message = 'PAYOUT_INPUT_INVALID'; end if;

  v_hash := public.payout_request_hash(jsonb_build_object(
    'allocation', p_allocation_public_id,
    'claimVersion', p_expected_claim_version,
    'donationRecipient', p_donation_operation_recipient,
    'winnerTransactions', p_winner_transactions,
    'winnerOverpaymentConfirmed', p_winner_overpayment_confirmed,
    'winnerOverpaymentReason', p_winner_overpayment_reason,
    'donationTransactions', p_donation_transactions,
    'donationOverpaymentConfirmed', p_donation_overpayment_confirmed,
    'donationOverpaymentReason', p_donation_overpayment_reason,
    'receiptKey', p_receipt_r2_key,
    'receiptBytes', p_receipt_byte_size,
    'receiptWidth', p_receipt_width,
    'receiptHeight', p_receipt_height,
    'receiptPublicApproved', p_receipt_public_approved
  ));
  select * into v_request from public.payout_mutation_requests
  where actor_discord_user_id = p_actor_discord_user_id
    and request_id = p_request_id and action = 'complete_and_publish_v2';
  if found then
    if v_request.request_hash <> v_hash then raise exception using message = 'PAYOUT_REQUEST_REUSED'; end if;
    return v_request.response || jsonb_build_object('replayed', true);
  end if;

  select * into v_allocation from public.cycle_prize_allocations
  where public_id = p_allocation_public_id for update;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  if exists (
    select 1 from public.payout_allocation_disqualifications disqualification
    where disqualification.allocation_id = v_allocation.id
  ) then return jsonb_build_object('outcome', 'payout_disqualified'); end if;

  perform public.process_due_payout_donation_corrections(null);
  select * into v_correction
  from public.payout_donation_corrections
  where allocation_id = v_allocation.id
  order by attempt_version desc limit 1 for update;
  if v_correction.id is not null
    and v_correction.status in ('open', 'expired', 'disqualified')
  then return jsonb_build_object('outcome', 'donation_correction_required'); end if;

  select * into v_claim from public.winner_claims
  where id = v_allocation.claim_id for update;
  if not found or v_claim.version <> p_expected_claim_version then
    return jsonb_build_object('outcome', 'claim_stale');
  end if;
  if (v_allocation.payout_choice = 'donate' and v_claim.status <> 'not_required')
    or (v_allocation.payout_choice in ('keep', 'split')
      and (v_claim.status <> 'confirmed'
        or not public.is_valid_sol_recipient_address(v_claim.confirmed_recipient)))
  then return jsonb_build_object('outcome', 'claim_not_ready'); end if;

  select count(*), count(distinct input.signature), coalesce(sum(input.lamports), 0)
  into v_winner_count, v_winner_unique_count, v_winner_total
  from jsonb_to_recordset(p_winner_transactions)
    as input(signature text, slot bigint, recipient text, lamports bigint)
  where input.signature ~ '^[1-9A-HJ-NP-Za-km-z]{80,100}$'
    and input.slot > 0 and input.lamports > 0
    and input.recipient = v_claim.confirmed_recipient;

  if v_allocation.winner_lamports > 0 and (
    v_winner_count <> jsonb_array_length(p_winner_transactions)
    or v_winner_count not between 1 and 10
    or v_winner_unique_count <> v_winner_count
  ) then return jsonb_build_object('outcome', 'winner_verification_invalid'); end if;
  if v_allocation.winner_lamports = 0 and (
    jsonb_array_length(p_winner_transactions) <> 0
    or coalesce(p_winner_overpayment_confirmed, false)
    or p_winner_overpayment_reason is not null
  ) then return jsonb_build_object('outcome', 'winner_verification_invalid'); end if;
  if v_allocation.winner_lamports > 0 and v_winner_total < v_allocation.winner_lamports
  then return jsonb_build_object('outcome', 'winner_underpaid'); end if;
  if v_allocation.winner_lamports > 0 and v_winner_total = v_allocation.winner_lamports and (
    coalesce(p_winner_overpayment_confirmed, false) or p_winner_overpayment_reason is not null
  ) then return jsonb_build_object('outcome', 'winner_overpayment_invalid'); end if;
  if v_allocation.winner_lamports > 0 and v_winner_total > v_allocation.winner_lamports and (
    not coalesce(p_winner_overpayment_confirmed, false)
    or p_winner_overpayment_reason is null
    or p_winner_overpayment_reason <> btrim(p_winner_overpayment_reason)
    or char_length(p_winner_overpayment_reason) not between 3 and 500
  ) then return jsonb_build_object('outcome', 'winner_overpayment_confirmation_required'); end if;

  select count(*), count(distinct input.signature), coalesce(sum(input.lamports), 0)
  into v_donation_count, v_donation_unique_count, v_donation_total
  from jsonb_to_recordset(p_donation_transactions)
    as input(signature text, slot bigint, recipient text, lamports bigint)
  where input.signature ~ '^[1-9A-HJ-NP-Za-km-z]{80,100}$'
    and input.slot > 0 and input.lamports > 0
    and input.recipient = p_donation_operation_recipient;

  if v_allocation.donation_lamports > 0 and (
    not public.is_valid_sol_recipient_address(p_donation_operation_recipient)
    or v_donation_count <> jsonb_array_length(p_donation_transactions)
    or v_donation_count not between 1 and 10
    or v_donation_unique_count <> v_donation_count
  ) then return jsonb_build_object('outcome', 'donation_verification_invalid'); end if;
  if v_allocation.donation_lamports = 0 and (
    p_donation_operation_recipient is not null
    or jsonb_array_length(p_donation_transactions) <> 0
    or coalesce(p_donation_overpayment_confirmed, false)
    or p_donation_overpayment_reason is not null
    or num_nonnulls(p_receipt_r2_key, p_receipt_byte_size, p_receipt_width, p_receipt_height) <> 0
    or coalesce(p_receipt_public_approved, false)
  ) then return jsonb_build_object('outcome', 'donation_verification_invalid'); end if;
  if v_allocation.donation_lamports > 0 and v_donation_total < v_allocation.donation_lamports
  then return jsonb_build_object('outcome', 'donation_underpaid'); end if;
  if v_allocation.donation_lamports > 0 and v_donation_total = v_allocation.donation_lamports and (
    coalesce(p_donation_overpayment_confirmed, false) or p_donation_overpayment_reason is not null
  ) then return jsonb_build_object('outcome', 'donation_overpayment_invalid'); end if;
  if v_allocation.donation_lamports > 0 and v_donation_total > v_allocation.donation_lamports and (
    not coalesce(p_donation_overpayment_confirmed, false)
    or p_donation_overpayment_reason is null
    or p_donation_overpayment_reason <> btrim(p_donation_overpayment_reason)
    or char_length(p_donation_overpayment_reason) not between 3 and 500
  ) then return jsonb_build_object('outcome', 'donation_overpayment_confirmation_required'); end if;

  if exists (
    select 1 from (
      select input.signature from jsonb_to_recordset(p_winner_transactions)
        as input(signature text, slot bigint, recipient text, lamports bigint)
      union all
      select input.signature from jsonb_to_recordset(p_donation_transactions)
        as input(signature text, slot bigint, recipient text, lamports bigint)
    ) signatures
    group by signatures.signature having count(*) > 1
  ) then return jsonb_build_object('outcome', 'duplicate_signature'); end if;

  if p_receipt_r2_key is null then
    if num_nonnulls(p_receipt_byte_size, p_receipt_width, p_receipt_height) <> 0
      or coalesce(p_receipt_public_approved, false)
    then return jsonb_build_object('outcome', 'receipt_invalid'); end if;
  elsif p_receipt_r2_key !~ '^payout-evidence/[0-9A-Fa-f-]{36}[.]webp$'
    or p_receipt_byte_size not between 1 and 3145728
    or p_receipt_width not between 1 and 4096
    or p_receipt_height not between 1 and 8192
    or p_receipt_public_approved is null
  then return jsonb_build_object('outcome', 'receipt_invalid'); end if;

  if v_allocation.donation_lamports > 0 then
    if v_correction.id is not null and v_correction.status in ('submitted', 'completed') then
      v_org_source := v_correction.selection_source;
      v_org_name := v_correction.selected_name;
      v_org_url := v_correction.selected_website_url;
      if v_correction.selection_source = 'catalog' then
        select organization.published_revision_id, revision.revision_number
        into v_org_revision, v_org_version
        from public.donation_organizations organization
        join public.donation_organization_revisions revision
          on revision.id = organization.published_revision_id
        where organization.public_key = v_correction.organization_public_key
          and organization.state = 'active';
      end if;
    else
      select * into v_reference from public.submission_organization_references
      where submission_id = v_allocation.submission_id;
      v_org_source := v_allocation.organization_source_type;
      v_org_revision := v_allocation.organization_revision_id;
      v_org_version := v_allocation.organization_effective_version;
      if v_allocation.organization_effective_state = 'verified'
        and public.is_safe_public_https_url(v_allocation.organization_website_url)
      then
        v_org_name := v_allocation.organization_name;
        v_org_url := v_allocation.organization_website_url;
      elsif v_reference.submission_id is not null
        and v_reference.source_type = 'other'
        and public.is_safe_public_https_url(v_reference.original_website_url)
      then
        v_org_name := v_reference.original_name;
        v_org_url := v_reference.original_website_url;
        v_org_source := 'other';
        v_org_revision := null;
        v_org_version := v_reference.effective_version;
      end if;
    end if;
    if v_org_name is null or char_length(v_org_name) not between 2 and 160
      or not public.is_safe_public_https_url(v_org_url)
    then return jsonb_build_object('outcome', 'organization_review_required'); end if;
  end if;

  select * into v_plan from public.payout_plans
  where allocation_id = v_allocation.id and state not in ('aborted', 'replaced')
  for update;
  if found and v_plan.state = 'published' then return jsonb_build_object('outcome', 'already_published'); end if;
  if found and v_plan.state not in ('draft', 'locked') then return jsonb_build_object('outcome', 'state_conflict'); end if;
  if found and exists (
    select 1 from public.payout_lines line
    where line.plan_id = v_plan.id
      and (line.current_transaction_id is not null or line.state not in ('prepared', 'locked'))
  ) then return jsonb_build_object('outcome', 'state_conflict'); end if;

  if not found then
    select coalesce(max(plan_version), 0) + 1 into v_next_plan_version
    from public.payout_plans where allocation_id = v_allocation.id;
    insert into public.payout_plans(allocation_id, plan_version, created_by)
    values (v_allocation.id, v_next_plan_version, p_actor_discord_user_id)
    returning * into v_plan;
    if v_allocation.winner_lamports > 0 then
      insert into public.payout_lines(plan_id, line_kind, amount_lamports, winner_claim_id, winner_recipient)
      values (v_plan.id, 'winner', v_allocation.winner_lamports, v_claim.id, v_claim.confirmed_recipient);
    end if;
    if v_allocation.donation_lamports > 0 then
      insert into public.payout_lines(
        plan_id, line_kind, amount_lamports, organization_source_type,
        organization_revision_id, organization_effective_version,
        organization_effective_state, organization_name, organization_website_url
      ) values (
        v_plan.id, 'donation', v_allocation.donation_lamports, v_org_source,
        v_org_revision, coalesce(v_org_version, 1), 'verified', v_org_name, v_org_url
      );
    end if;
    insert into public.payout_events(event_type, actor_discord_user_id, target_type, target_public_id, target_version, request_id, details)
    values ('plan_prepared', p_actor_discord_user_id, 'plan', v_plan.public_id, v_plan.row_version, p_request_id,
      jsonb_build_object('allocationPublicId', v_allocation.public_id));
  end if;

  if v_plan.state = 'draft' then
    if v_allocation.donation_lamports > 0 then
      update public.payout_lines
      set donation_operation_recipient = p_donation_operation_recipient,
          organization_source_type = v_org_source,
          organization_revision_id = v_org_revision,
          organization_effective_version = coalesce(v_org_version, 1),
          organization_effective_state = 'verified', organization_name = v_org_name,
          organization_website_url = v_org_url, row_version = row_version + 1,
          updated_at = transaction_timestamp()
      where plan_id = v_plan.id and line_kind = 'donation' returning * into v_donation_line;
      insert into public.payout_events(event_type, actor_discord_user_id, target_type, target_public_id, target_version, request_id)
      values ('donation_recipient_set', p_actor_discord_user_id, 'line', v_donation_line.public_id, v_donation_line.row_version, p_request_id);
    end if;
    update public.payout_lines set state = 'locked', row_version = row_version + 1, updated_at = transaction_timestamp()
    where plan_id = v_plan.id and state = 'prepared';
    update public.payout_plans set state = 'locked', row_version = row_version + 1, locked_at = transaction_timestamp()
    where id = v_plan.id returning * into v_plan;
    insert into public.payout_events(event_type, actor_discord_user_id, target_type, target_public_id, target_version, request_id)
    values ('plan_locked', p_actor_discord_user_id, 'plan', v_plan.public_id, v_plan.row_version, p_request_id);
  end if;

  select * into v_winner_line from public.payout_lines
  where plan_id = v_plan.id and line_kind = 'winner' for update;
  if found then
    v_transaction_version := 0;
    for v_transaction_input in
      select * from jsonb_to_recordset(p_winner_transactions)
        as input(signature text, slot bigint, recipient text, lamports bigint)
    loop
      v_transaction_version := v_transaction_version + 1;
      insert into public.payout_transactions(
        payout_line_id, transaction_version, signature, canonical_explorer_url,
        evidence_level, expected_recipient, expected_lamports, verified_lamports,
        verification_slot, recorded_by
      ) values (
        v_winner_line.id, v_transaction_version, v_transaction_input.signature,
        'https://explorer.solana.com/tx/' || v_transaction_input.signature || '?cluster=mainnet-beta',
        'on_chain_verified', v_claim.confirmed_recipient, v_allocation.winner_lamports,
        v_transaction_input.lamports, v_transaction_input.slot, p_actor_discord_user_id
      ) returning * into v_transaction;
      insert into public.payout_events(event_type, actor_discord_user_id, target_type, target_public_id, target_version, request_id, details)
      values ('transaction_verified', p_actor_discord_user_id, 'transaction', v_transaction.public_id,
        v_transaction.transaction_version, p_request_id,
        jsonb_build_object('linePublicId', v_winner_line.public_id, 'verifiedLamports', v_transaction.verified_lamports::text));
    end loop;
    update public.payout_lines
    set current_transaction_id = v_transaction.id, state = 'verified', paid_lamports = v_winner_total,
        overpayment_reason = case when v_winner_total > amount_lamports then p_winner_overpayment_reason end,
        row_version = row_version + 1, updated_at = transaction_timestamp()
    where id = v_winner_line.id returning * into v_winner_line;
  end if;

  select * into v_donation_line from public.payout_lines
  where plan_id = v_plan.id and line_kind = 'donation' for update;
  if found then
    if v_donation_line.donation_operation_recipient is distinct from p_donation_operation_recipient
      or v_donation_line.organization_name is distinct from v_org_name
      or v_donation_line.organization_website_url is distinct from v_org_url
    then return jsonb_build_object('outcome', 'state_conflict'); end if;
    v_transaction_version := 0;
    for v_transaction_input in
      select * from jsonb_to_recordset(p_donation_transactions)
        as input(signature text, slot bigint, recipient text, lamports bigint)
    loop
      v_transaction_version := v_transaction_version + 1;
      insert into public.payout_transactions(
        payout_line_id, transaction_version, signature, canonical_explorer_url,
        evidence_level, expected_recipient, expected_lamports, verified_lamports,
        verification_slot, recorded_by
      ) values (
        v_donation_line.id, v_transaction_version, v_transaction_input.signature,
        'https://explorer.solana.com/tx/' || v_transaction_input.signature || '?cluster=mainnet-beta',
        'on_chain_verified', p_donation_operation_recipient, v_allocation.donation_lamports,
        v_transaction_input.lamports, v_transaction_input.slot, p_actor_discord_user_id
      ) returning * into v_transaction;
      insert into public.payout_events(event_type, actor_discord_user_id, target_type, target_public_id, target_version, request_id, details)
      values ('transaction_verified', p_actor_discord_user_id, 'transaction', v_transaction.public_id,
        v_transaction.transaction_version, p_request_id,
        jsonb_build_object('linePublicId', v_donation_line.public_id, 'verifiedLamports', v_transaction.verified_lamports::text));
    end loop;
    update public.payout_lines
    set current_transaction_id = v_transaction.id, state = 'verified', paid_lamports = v_donation_total,
        overpayment_reason = case when v_donation_total > amount_lamports then p_donation_overpayment_reason end,
        row_version = row_version + 1, updated_at = transaction_timestamp()
    where id = v_donation_line.id returning * into v_donation_line;
    if p_receipt_r2_key is not null then
      insert into public.payout_private_evidence(
        payout_transaction_id, r2_key, byte_size, width, height,
        uploaded_by, public_approved, public_approved_at
      ) values (
        v_transaction.id, p_receipt_r2_key, p_receipt_byte_size,
        p_receipt_width, p_receipt_height, p_actor_discord_user_id,
        p_receipt_public_approved,
        case when p_receipt_public_approved then transaction_timestamp() end
      );
      insert into public.payout_events(event_type, actor_discord_user_id, target_type, target_public_id, target_version, request_id, details)
      values ('evidence_attached', p_actor_discord_user_id, 'transaction', v_transaction.public_id,
        v_transaction.transaction_version, p_request_id,
        jsonb_build_object('publicApproved', p_receipt_public_approved));
    end if;
  end if;

  update public.payout_plans
  set state = 'published', row_version = row_version + 1, published_at = transaction_timestamp()
  where id = v_plan.id returning * into v_plan;
  insert into public.payout_events(event_type, actor_discord_user_id, target_type, target_public_id, target_version, request_id, details)
  values ('plan_published', p_actor_discord_user_id, 'plan', v_plan.public_id, v_plan.row_version, p_request_id,
    jsonb_build_object(
      'winnerPaidLamports', case when v_allocation.winner_lamports > 0 then v_winner_total::text end,
      'donationPaidLamports', case when v_allocation.donation_lamports > 0 then v_donation_total::text end,
      'winnerOverpaymentConfirmed', coalesce(p_winner_overpayment_confirmed, false),
      'donationOverpaymentConfirmed', coalesce(p_donation_overpayment_confirmed, false)
    ));

  if v_correction.id is not null and v_correction.status = 'submitted' then
    update public.payout_donation_corrections
    set status = 'completed', row_version = row_version + 1,
        completed_at = transaction_timestamp(), closed_at = transaction_timestamp(),
        updated_at = transaction_timestamp()
    where id = v_correction.id returning * into v_correction;
    insert into public.payout_events(event_type, actor_discord_user_id, target_type, target_public_id, target_version, request_id)
    values ('donation_correction_completed', p_actor_discord_user_id, 'donation_correction',
      v_correction.public_id, v_correction.row_version, p_request_id);
  end if;

  v_response := jsonb_build_object(
    'outcome', 'published', 'planPublicId', v_plan.public_id,
    'rowVersion', v_plan.row_version, 'replayed', false
  );
  insert into public.payout_mutation_requests(actor_discord_user_id, request_id, action, request_hash, response)
  values (p_actor_discord_user_id, p_request_id, 'complete_and_publish_v2', v_hash, v_response);
  return v_response;
exception when unique_violation then
  raise exception using errcode = '23505', message = 'PAYOUT_SIGNATURE_ALREADY_USED';
end;
$function$;

revoke all on function public.complete_and_publish_payout_v2(text,uuid,uuid,bigint,text,jsonb,boolean,text,jsonb,boolean,text,text,integer,integer,integer,boolean)
  from public, anon, authenticated, discord_bot, service_role;
grant execute on function public.complete_and_publish_payout_v2(text,uuid,uuid,bigint,text,jsonb,boolean,text,jsonb,boolean,text,text,integer,integer,integer,boolean)
  to service_role;
alter function public.complete_and_publish_payout_v2(text,uuid,uuid,bigint,text,jsonb,boolean,text,jsonb,boolean,text,text,integer,integer,integer,boolean)
  owner to postgres;

revoke execute on function public.complete_and_publish_payout(text,uuid,uuid,bigint,text,text,bigint,text,bigint,text,bigint,text,bigint,text,integer,integer,integer,boolean)
  from service_role;

comment on function public.complete_and_publish_payout_v2(text,uuid,uuid,bigint,text,jsonb,boolean,text,jsonb,boolean,text,text,integer,integer,integer,boolean) is
  'Atomically publishes one payout from one or more recipient-verified Mainnet transfers per line; underpayment is rejected and a transparent overpayment requires explicit confirmation and a bounded public reason.';

create function public.get_simple_team_payouts_v2(
  p_actor_discord_user_id text,
  p_include_management boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $function$
declare
  v_role text;
  v_items jsonb;
begin
  v_role := public.assert_winners_payout_capability(
    p_actor_discord_user_id, 'winners.payouts.view'
  );
  if p_include_management then
    perform public.assert_winners_payout_capability(
      p_actor_discord_user_id, 'winners.manage_payouts'
    );
  end if;
  perform public.process_due_payout_donation_corrections(null);
  perform public.process_due_winner_claim_transitions(null);

  select coalesce(jsonb_agg(jsonb_build_object(
    'allocationPublicId', allocation.public_id,
    'cycleId', allocation.cycle_id,
    'cycleNumber', cycle.public_number,
    'submissionId', allocation.submission_id,
    'submissionR2Key', submission.r2_key,
    'winnerPublicProfileId', user_log.public_profile_id,
    'winnerDisplayName', coalesce(
      nullif(user_log.current_guild_nickname, ''),
      nullif(user_log.current_display_name, ''),
      nullif(user_log.current_discord_handle, ''),
      nullif(user_log.current_discord_username, ''),
      nullif(submission.discord_username_at_upload, ''),
      'Winner'
    ),
    'payoutChoice', allocation.payout_choice,
    'splitPercent', allocation.split_percent,
    'grossLamports', allocation.gross_lamports::text,
    'winnerLamports', allocation.winner_lamports::text,
    'donationLamports', allocation.donation_lamports::text,
    'claimStatus', claim.status,
    'claimVersion', claim.version,
    'claimDeadlineAt', claim.deadline_at,
    'winnerRecipient', case when p_include_management and claim.status = 'confirmed'
      then claim.confirmed_recipient end,
    'organizationSource', coalesce(
      case when correction.status in ('submitted', 'completed') then correction.selection_source end,
      allocation.organization_source_type
    ),
    'organizationName', coalesce(
      case when correction.status in ('submitted', 'completed') then correction.selected_name end,
      case when allocation.organization_effective_state = 'verified' then allocation.organization_name end,
      reference.original_name
    ),
    'organizationWebsiteUrl', coalesce(
      case when correction.status in ('submitted', 'completed') then correction.selected_website_url end,
      case when allocation.organization_effective_state = 'verified' then allocation.organization_website_url end,
      reference.original_website_url
    ),
    'organizationReviewRequired', allocation.donation_lamports > 0 and correction.id is null
      and allocation.organization_effective_state <> 'verified',
    'correction', case when correction.id is null then null else jsonb_build_object(
      'correctionPublicId', correction.public_id,
      'attemptVersion', correction.attempt_version,
      'rowVersion', correction.row_version,
      'status', correction.status,
      'publicReason', correction.public_reason,
      'deadlineAt', correction.deadline_at,
      'submittedAt', correction.submitted_at,
      'selectionSource', correction.selection_source,
      'selectedName', correction.selected_name,
      'selectedWebsiteUrl', correction.selected_website_url
    ) end,
    'disqualification', case when disqualification.id is null then null else jsonb_build_object(
      'disqualificationPublicId', disqualification.public_id,
      'publicReason', disqualification.public_reason,
      'createdAt', disqualification.created_at
    ) end,
    'plan', case when plan.id is null then null else jsonb_build_object(
      'planPublicId', plan.public_id,
      'planVersion', plan.plan_version,
      'rowVersion', plan.row_version,
      'state', plan.state,
      'publishedAt', plan.published_at,
      'winnerLine', case when winner_line.id is null then null else jsonb_build_object(
        'linePublicId', winner_line.public_id,
        'state', winner_line.state,
        'recipient', case when p_include_management then winner_line.winner_recipient end,
        'paidLamports', winner_line.paid_lamports::text,
        'overpaymentReason', winner_line.overpayment_reason,
        'transactionSignature', winner_transaction.signature,
        'transactionUrl', winner_transaction.canonical_explorer_url,
        'transactions', coalesce((
          select jsonb_agg(jsonb_build_object(
            'signature', transaction.signature,
            'canonicalExplorerUrl', transaction.canonical_explorer_url,
            'verifiedLamports', transaction.verified_lamports::text,
            'recordedAt', transaction.recorded_at
          ) order by transaction.transaction_version)
          from public.payout_transactions transaction
          where transaction.payout_line_id = winner_line.id
        ), '[]'::jsonb)
      ) end,
      'donationLine', case when donation_line.id is null then null else jsonb_build_object(
        'linePublicId', donation_line.public_id,
        'state', donation_line.state,
        'recipient', case when p_include_management then donation_line.donation_operation_recipient end,
        'paidLamports', donation_line.paid_lamports::text,
        'overpaymentReason', donation_line.overpayment_reason,
        'transactionSignature', donation_transaction.signature,
        'transactionUrl', donation_transaction.canonical_explorer_url,
        'transactions', coalesce((
          select jsonb_agg(jsonb_build_object(
            'signature', transaction.signature,
            'canonicalExplorerUrl', transaction.canonical_explorer_url,
            'verifiedLamports', transaction.verified_lamports::text,
            'recordedAt', transaction.recorded_at
          ) order by transaction.transaction_version)
          from public.payout_transactions transaction
          where transaction.payout_line_id = donation_line.id
        ), '[]'::jsonb),
        'receiptPublicId', evidence.public_id,
        'receiptPublicApproved', coalesce(evidence.public_approved, false)
      ) end
    ) end
  ) order by cycle.id desc, allocation.stable_tie_key), '[]'::jsonb)
  into v_items
  from public.cycle_prize_allocations allocation
  join public.voting_cycles cycle on cycle.id = allocation.cycle_id
  join public.submissions submission on submission.id = allocation.submission_id
  join public.user_logs user_log on user_log.discord_user_id = allocation.winner_discord_user_id
  join public.winner_claims claim on claim.id = allocation.claim_id
  left join public.submission_organization_references reference
    on reference.submission_id = allocation.submission_id
  left join lateral (
    select candidate.* from public.payout_donation_corrections candidate
    where candidate.allocation_id = allocation.id
    order by candidate.attempt_version desc limit 1
  ) correction on true
  left join public.payout_allocation_disqualifications disqualification
    on disqualification.allocation_id = allocation.id
  left join lateral (
    select candidate.* from public.payout_plans candidate
    where candidate.allocation_id = allocation.id
      and candidate.state not in ('aborted', 'replaced')
    order by candidate.plan_version desc limit 1
  ) plan on true
  left join public.payout_lines winner_line
    on winner_line.plan_id = plan.id and winner_line.line_kind = 'winner'
  left join public.payout_transactions winner_transaction
    on winner_transaction.id = winner_line.current_transaction_id
  left join public.payout_lines donation_line
    on donation_line.plan_id = plan.id and donation_line.line_kind = 'donation'
  left join public.payout_transactions donation_transaction
    on donation_transaction.id = donation_line.current_transaction_id
  left join lateral (
    select candidate.*
    from public.payout_private_evidence candidate
    join public.payout_transactions transaction
      on transaction.id = candidate.payout_transaction_id
    where transaction.payout_line_id = donation_line.id
    order by candidate.created_at desc, candidate.id desc
    limit 1
  ) evidence on true;

  return jsonb_build_object(
    'outcome', 'ok', 'databaseTime', transaction_timestamp(), 'items', v_items
  );
end;
$function$;

revoke all on function public.get_simple_team_payouts_v2(text,boolean)
  from public, anon, authenticated, discord_bot, service_role;
grant execute on function public.get_simple_team_payouts_v2(text,boolean)
  to service_role;
alter function public.get_simple_team_payouts_v2(text,boolean) owner to postgres;

create function public.get_public_submission_payout_v2(p_submission_id bigint)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $function$
declare
  v_payload jsonb;
begin
  if p_submission_id is null or p_submission_id <= 0 then
    raise exception using message = 'PAYOUT_INPUT_INVALID';
  end if;
  perform public.process_due_payout_donation_corrections(null);
  perform public.process_due_winner_claim_transitions(null);

  select jsonb_strip_nulls(jsonb_build_object(
    'state', case
      when disqualification.id is not null then 'payout_disqualified'
      when plan.state = 'published' then 'paid'
      when correction.status = 'open' then 'donation_change_required'
      when correction.status = 'submitted' then 'donation_review_pending'
      when correction.status = 'expired' then 'donation_change_expired'
      when claim.status = 'expired' then 'claim_expired'
      when claim.status = 'declined' then 'claim_declined'
      else null
    end,
    'payoutChoice', allocation.payout_choice,
    'splitPercent', allocation.split_percent,
    'grossLamports', allocation.gross_lamports::text,
    'winnerLamports', allocation.winner_lamports::text,
    'donationLamports', allocation.donation_lamports::text,
    'claimStatus', claim.status,
    'winnerRecipient', case when plan.state = 'published' then winner_line.winner_recipient end,
    'winnerTransactionUrl', case when plan.state = 'published' then winner_transaction.canonical_explorer_url end,
    'winnerTransactionSignature', case when plan.state = 'published' then winner_transaction.signature end,
    'winnerTransactions', case when plan.state = 'published' then coalesce((
      select jsonb_agg(jsonb_build_object(
        'signature', transaction.signature,
        'canonicalExplorerUrl', transaction.canonical_explorer_url,
        'verifiedLamports', transaction.verified_lamports::text
      ) order by transaction.transaction_version)
      from public.payout_transactions transaction
      where transaction.payout_line_id = winner_line.id
    ), '[]'::jsonb) else '[]'::jsonb end,
    'winnerPaidLamports', case when plan.state = 'published' then winner_line.paid_lamports::text end,
    'winnerOverpaymentReason', case when plan.state = 'published' then winner_line.overpayment_reason end,
    'organizationName', case when plan.state = 'published' then donation_line.organization_name end,
    'organizationWebsiteUrl', case when plan.state = 'published' then donation_line.organization_website_url end,
    'donationRecipient', case when plan.state = 'published' then donation_line.donation_operation_recipient end,
    'donationTransactionUrl', case when plan.state = 'published' then donation_transaction.canonical_explorer_url end,
    'donationTransactionSignature', case when plan.state = 'published' then donation_transaction.signature end,
    'donationTransactions', case when plan.state = 'published' then coalesce((
      select jsonb_agg(jsonb_build_object(
        'signature', transaction.signature,
        'canonicalExplorerUrl', transaction.canonical_explorer_url,
        'verifiedLamports', transaction.verified_lamports::text
      ) order by transaction.transaction_version)
      from public.payout_transactions transaction
      where transaction.payout_line_id = donation_line.id
    ), '[]'::jsonb) else '[]'::jsonb end,
    'donationPaidLamports', case when plan.state = 'published' then donation_line.paid_lamports::text end,
    'donationOverpaymentReason', case when plan.state = 'published' then donation_line.overpayment_reason end,
    'receiptPublicId', case when plan.state = 'published' and evidence.public_approved then evidence.public_id end,
    'publicReason', coalesce(disqualification.public_reason, correction.public_reason),
    'publishedAt', plan.published_at
  )) into v_payload
  from public.cycle_prize_allocations allocation
  join public.winner_claims claim on claim.id = allocation.claim_id
  left join lateral (
    select candidate.* from public.payout_donation_corrections candidate
    where candidate.allocation_id = allocation.id
    order by candidate.attempt_version desc limit 1
  ) correction on true
  left join public.payout_allocation_disqualifications disqualification
    on disqualification.allocation_id = allocation.id
  left join lateral (
    select candidate.* from public.payout_plans candidate
    where candidate.allocation_id = allocation.id and candidate.state = 'published'
    order by candidate.plan_version desc limit 1
  ) plan on true
  left join public.payout_lines winner_line
    on winner_line.plan_id = plan.id and winner_line.line_kind = 'winner'
  left join public.payout_transactions winner_transaction
    on winner_transaction.id = winner_line.current_transaction_id
  left join public.payout_lines donation_line
    on donation_line.plan_id = plan.id and donation_line.line_kind = 'donation'
  left join public.payout_transactions donation_transaction
    on donation_transaction.id = donation_line.current_transaction_id
  left join lateral (
    select candidate.*
    from public.payout_private_evidence candidate
    join public.payout_transactions transaction
      on transaction.id = candidate.payout_transaction_id
    where transaction.payout_line_id = donation_line.id
      and candidate.public_approved
    order by candidate.created_at desc, candidate.id desc
    limit 1
  ) evidence on true
  where allocation.submission_id = p_submission_id
  order by allocation.allocated_at desc
  limit 1;

  if v_payload is null or not (v_payload ? 'state') then return null; end if;
  return v_payload;
end;
$function$;

revoke all on function public.get_public_submission_payout_v2(bigint)
  from public, anon, authenticated, discord_bot, service_role;
grant execute on function public.get_public_submission_payout_v2(bigint)
  to service_role;
alter function public.get_public_submission_payout_v2(bigint) owner to postgres;

commit;
