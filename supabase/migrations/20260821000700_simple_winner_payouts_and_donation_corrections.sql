do $baseline$
begin
  if to_regclass('public.cycle_prize_allocations') is null
    or to_regclass('public.payout_plans') is null
    or to_regclass('public.payout_lines') is null
    or to_regclass('public.payout_transactions') is null
    or to_regclass('public.payout_private_evidence') is null
    or to_regclass('public.notification_events') is null
    or to_regclass('public.account_notifications') is null
    or to_regclass('public.submission_organization_references') is null
    or to_regprocedure('public.assert_winners_payout_capability(text,text)') is null
    or to_regprocedure('public.require_account_session(uuid)') is null
    or to_regprocedure('public.is_safe_public_https_url(text)') is null
  then
    raise exception using message = 'SIMPLE_WINNER_PAYOUT_BASELINE_MISSING';
  end if;

  if to_regclass('public.payout_donation_corrections') is not null
    or to_regclass('public.payout_allocation_disqualifications') is not null
    or to_regprocedure('public.complete_and_publish_payout(text,uuid,uuid,bigint,text,text,bigint,text,bigint,text,integer,integer,integer,boolean)') is not null
  then
    raise exception using message = 'SIMPLE_WINNER_PAYOUT_ALREADY_APPLIED';
  end if;
end;
$baseline$;

create table public.payout_donation_corrections (
  id uuid primary key default gen_random_uuid(),
  public_id uuid not null unique default gen_random_uuid(),
  allocation_id uuid not null references public.cycle_prize_allocations(id),
  attempt_version bigint not null check (attempt_version > 0),
  row_version bigint not null default 1 check (row_version > 0),
  status text not null default 'open'
    check (status in ('open', 'submitted', 'expired', 'superseded', 'completed', 'disqualified')),
  public_reason text not null
    check (public_reason = btrim(public_reason) and char_length(public_reason) between 3 and 300),
  deadline_at timestamptz,
  selection_source text check (selection_source in ('catalog', 'other')),
  organization_public_key text references public.donation_organizations(public_key),
  selected_name text
    check (selected_name is null or (selected_name = btrim(selected_name) and char_length(selected_name) between 2 and 160)),
  selected_website_url text
    check (selected_website_url is null or public.is_safe_public_https_url(selected_website_url)),
  requested_by text not null check (requested_by ~ '^[0-9]+$'),
  submitted_at timestamptz,
  completed_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  unique (allocation_id, attempt_version),
  constraint payout_donation_correction_state_check check (
    (status = 'open' and deadline_at is not null and selection_source is null
      and organization_public_key is null and selected_name is null
      and selected_website_url is null and submitted_at is null
      and completed_at is null and closed_at is null)
    or (status = 'submitted' and deadline_at is null and selection_source is not null
      and selected_name is not null and selected_website_url is not null
      and submitted_at is not null and completed_at is null and closed_at is null)
    or (status = 'completed' and deadline_at is null and selection_source is not null
      and selected_name is not null and selected_website_url is not null
      and submitted_at is not null and completed_at is not null and closed_at is not null)
    or (status in ('expired', 'superseded', 'disqualified') and deadline_at is null
      and completed_at is null and closed_at is not null)
  ),
  constraint payout_donation_correction_selection_check check (
    selection_source is null
    or (selection_source = 'catalog' and organization_public_key is not null)
    or (selection_source = 'other' and organization_public_key is null)
  )
);

create unique index payout_donation_corrections_one_current_idx
  on public.payout_donation_corrections(allocation_id)
  where status in ('open', 'submitted');

create table public.payout_allocation_disqualifications (
  id uuid primary key default gen_random_uuid(),
  public_id uuid not null unique default gen_random_uuid(),
  allocation_id uuid not null unique references public.cycle_prize_allocations(id),
  row_version bigint not null default 1 check (row_version > 0),
  public_reason text not null
    check (public_reason = btrim(public_reason) and char_length(public_reason) between 3 and 300),
  created_by text not null check (created_by ~ '^[0-9]+$'),
  created_at timestamptz not null default transaction_timestamp()
);

alter table public.payout_private_evidence
  add column public_approved boolean not null default false,
  add column public_approved_at timestamptz,
  add constraint payout_private_evidence_public_approval_check
    check ((public_approved and public_approved_at is not null)
      or (not public_approved and public_approved_at is null));

alter table public.notification_events
  add column public_body text
    check (public_body is null or (public_body = btrim(public_body) and char_length(public_body) between 3 and 500));

alter table public.notification_events
  drop constraint notification_event_type_check,
  drop constraint notification_event_category_check;

alter table public.notification_events
  add constraint notification_event_type_check
    check (event_type in (
      'winner_claim_required',
      'winner_correction_ready',
      'winner_donation_finalized',
      'donation_recipient_change_required',
      'submission_disqualified',
      'submission_reinstated',
      'cycle_results_ready',
      'wallet_issue_received',
      'wallet_issue_correction_ready',
      'wallet_issue_resolved'
    )),
  add constraint notification_event_category_check
    check (
      (event_type in (
          'winner_claim_required',
          'winner_correction_ready',
          'winner_donation_finalized',
          'donation_recipient_change_required'
        ) and category_key = 'winners_claims')
      or (event_type in ('submission_disqualified', 'submission_reinstated')
        and category_key = 'submission_moderation')
      or (event_type = 'cycle_results_ready' and category_key = 'cycles_voting')
      or (event_type in (
          'wallet_issue_received',
          'wallet_issue_correction_ready',
          'wallet_issue_resolved'
        ) and category_key = 'wallet_issues')
    );

alter table public.payout_events
  drop constraint payout_events_event_type_check,
  drop constraint payout_events_target_type_check;

alter table public.payout_events
  add constraint payout_events_event_type_check check (event_type in (
    'pool_created', 'pool_changed', 'pool_cleared', 'pool_locked', 'pool_amount_pending', 'pool_component_added',
    'allocation_created', 'plan_prepared', 'plan_locked', 'plan_published', 'plan_aborted', 'plan_replaced',
    'donation_recipient_set', 'donation_unavailable', 'donation_correction_requested',
    'donation_correction_submitted', 'donation_correction_expired', 'donation_correction_completed',
    'payout_disqualified', 'transaction_issued', 'transaction_verified', 'evidence_attached',
    'poll_linked', 'poll_outcome_applied', 'rollover_created', 'organization_redirected',
    'return_claim_created', 'follow_up_linked', 'return_claim_confirmed',
    'return_claim_declined', 'return_claim_expired'
  )),
  add constraint payout_events_target_type_check check (target_type in (
    'pool', 'component', 'allocation', 'plan', 'line', 'transaction',
    'return_claim', 'donation_correction', 'payout_disqualification'
  ));

create function public.process_due_payout_donation_corrections(p_correction_public_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_count integer := 0;
  v_row public.payout_donation_corrections%rowtype;
begin
  for v_row in
    select correction.*
    from public.payout_donation_corrections correction
    where correction.status = 'open'
      and correction.deadline_at <= transaction_timestamp()
      and (p_correction_public_id is null or correction.public_id = p_correction_public_id)
    order by correction.deadline_at, correction.id
    for update
  loop
    update public.payout_donation_corrections
    set status = 'expired', row_version = row_version + 1,
        deadline_at = null, closed_at = transaction_timestamp(),
        updated_at = transaction_timestamp()
    where id = v_row.id
    returning * into v_row;

    insert into public.payout_events(
      event_type, target_type, target_public_id, target_version, reason
    ) values (
      'donation_correction_expired', 'donation_correction',
      v_row.public_id, v_row.row_version, v_row.public_reason
    );
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$function$;

create function public.request_donation_recipient_correction(
  p_actor_discord_user_id text,
  p_request_id uuid,
  p_allocation_public_id uuid,
  p_public_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_role text;
  v_allocation public.cycle_prize_allocations%rowtype;
  v_reason text := nullif(btrim(coalesce(p_public_reason, '')), '');
  v_current public.payout_donation_corrections%rowtype;
  v_correction public.payout_donation_corrections%rowtype;
  v_attempt bigint;
  v_hash text;
  v_request public.payout_mutation_requests%rowtype;
  v_response jsonb;
  v_event public.notification_events%rowtype;
  v_notification_id uuid;
  v_visible boolean;
begin
  v_role := public.assert_winners_payout_capability(
    p_actor_discord_user_id, 'winners.manage_payouts'
  );
  if p_request_id is null or p_allocation_public_id is null
    or v_reason is null or char_length(v_reason) not between 3 and 300
  then
    raise exception using message = 'PAYOUT_INPUT_INVALID';
  end if;

  v_hash := public.payout_request_hash(jsonb_build_object(
    'allocation', p_allocation_public_id, 'reason', v_reason
  ));
  select * into v_request
  from public.payout_mutation_requests
  where actor_discord_user_id = p_actor_discord_user_id
    and request_id = p_request_id and action = 'request_donation_correction';
  if found then
    if v_request.request_hash <> v_hash then
      raise exception using message = 'PAYOUT_REQUEST_REUSED';
    end if;
    return v_request.response || jsonb_build_object('replayed', true);
  end if;

  select * into v_allocation
  from public.cycle_prize_allocations
  where public_id = p_allocation_public_id
  for update;
  if not found or v_allocation.donation_lamports <= 0 then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if exists (
    select 1 from public.payout_allocation_disqualifications disqualification
    where disqualification.allocation_id = v_allocation.id
  ) or exists (
    select 1
    from public.payout_plans plan
    join public.payout_lines line on line.plan_id = plan.id
    where plan.allocation_id = v_allocation.id
      and line.current_transaction_id is not null
  ) then
    return jsonb_build_object('outcome', 'state_conflict');
  end if;

  perform public.process_due_payout_donation_corrections(null);
  select * into v_current
  from public.payout_donation_corrections
  where allocation_id = v_allocation.id and status in ('open', 'submitted')
  for update;
  if found then
    update public.payout_donation_corrections
    set status = 'superseded', row_version = row_version + 1,
        deadline_at = null, closed_at = transaction_timestamp(),
        updated_at = transaction_timestamp()
    where id = v_current.id;
  end if;

  select coalesce(max(attempt_version), 0) + 1 into v_attempt
  from public.payout_donation_corrections
  where allocation_id = v_allocation.id;

  insert into public.payout_donation_corrections(
    allocation_id, attempt_version, public_reason, deadline_at, requested_by
  ) values (
    v_allocation.id, v_attempt, v_reason,
    transaction_timestamp() + interval '24 hours', p_actor_discord_user_id
  ) returning * into v_correction;

  insert into public.payout_events(
    event_type, actor_discord_user_id, target_type, target_public_id,
    target_version, request_id, reason,
    details
  ) values (
    'donation_correction_requested', p_actor_discord_user_id,
    'donation_correction', v_correction.public_id,
    v_correction.row_version, p_request_id, v_reason,
    jsonb_build_object('attemptVersion', v_correction.attempt_version)
  );

  v_visible := coalesce(public.resolve_account_notification_visibility(
    v_allocation.winner_discord_user_id, 'winners_claims'
  ), false);
  insert into public.notification_events(
    producer_key, event_type, category_key, audience_type,
    owner_discord_user_id, deep_link, public_body
  ) values (
    'donation-correction:' || v_correction.public_id::text,
    'donation_recipient_change_required', 'winners_claims', 'account',
    v_allocation.winner_discord_user_id,
    '/my-profile#donation-correction-' || v_correction.public_id::text,
    'Choose another charity within 24 hours. Reason: ' || v_reason
  ) returning * into v_event;

  insert into public.account_notifications(
    event_id, owner_discord_user_id, visible_in_product
  ) values (
    v_event.id, v_allocation.winner_discord_user_id, v_visible
  ) returning id into v_notification_id;

  v_response := jsonb_build_object(
    'outcome', 'correction_requested',
    'correctionPublicId', v_correction.public_id,
    'rowVersion', v_correction.row_version,
    'deadlineAt', v_correction.deadline_at,
    'replayed', false
  );
  insert into public.payout_mutation_requests(
    actor_discord_user_id, request_id, action, request_hash, response
  ) values (
    p_actor_discord_user_id, p_request_id,
    'request_donation_correction', v_hash, v_response
  );
  return v_response;
end;
$function$;

create function public.submit_own_donation_recipient_correction(
  p_session_id uuid,
  p_correction_public_id uuid,
  p_request_id uuid,
  p_expected_version bigint,
  p_source_type text,
  p_organization_public_key text,
  p_other_name text,
  p_other_website_url text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner_id text;
  v_correction public.payout_donation_corrections%rowtype;
  v_allocation public.cycle_prize_allocations%rowtype;
  v_organization public.donation_organizations%rowtype;
  v_revision public.donation_organization_revisions%rowtype;
  v_name text;
  v_url text;
  v_hash text;
  v_request public.payout_mutation_requests%rowtype;
  v_response jsonb;
begin
  v_owner_id := public.require_account_session(p_session_id);
  if p_correction_public_id is null or p_request_id is null
    or p_expected_version <= 0 or p_source_type not in ('catalog', 'other')
  then
    raise exception using message = 'PAYOUT_INPUT_INVALID';
  end if;
  perform public.process_due_payout_donation_corrections(p_correction_public_id);

  select * into v_correction
  from public.payout_donation_corrections
  where public_id = p_correction_public_id
  for update;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  select * into strict v_allocation
  from public.cycle_prize_allocations where id = v_correction.allocation_id;
  if v_allocation.winner_discord_user_id <> v_owner_id then
    raise exception using message = 'PAYOUT_OWNER_FORBIDDEN';
  end if;

  if p_source_type = 'catalog' then
    select organization.* into v_organization
    from public.donation_organizations organization
    where organization.public_key = p_organization_public_key
      and organization.state = 'active';
    if not found then return jsonb_build_object('outcome', 'organization_invalid'); end if;
    select revision.* into v_revision
    from public.donation_organization_revisions revision
    where revision.id = v_organization.published_revision_id
      and revision.selectable and revision.provider_status = 'available';
    if not found then return jsonb_build_object('outcome', 'organization_invalid'); end if;
    v_name := v_revision.display_name;
    v_url := v_revision.official_website_url;
  else
    v_name := nullif(regexp_replace(btrim(coalesce(p_other_name, '')), '\s+', ' ', 'g'), '');
    v_url := nullif(btrim(coalesce(p_other_website_url, '')), '');
    if v_name is null or char_length(v_name) not between 2 and 160
      or not public.is_safe_public_https_url(v_url)
    then
      return jsonb_build_object('outcome', 'organization_invalid');
    end if;
  end if;

  v_hash := public.payout_request_hash(jsonb_build_object(
    'correction', p_correction_public_id,
    'expectedVersion', p_expected_version,
    'sourceType', p_source_type,
    'organizationPublicKey', p_organization_public_key,
    'name', v_name, 'url', v_url
  ));
  select * into v_request
  from public.payout_mutation_requests
  where actor_discord_user_id = v_owner_id and request_id = p_request_id
    and action = 'submit_donation_correction';
  if found then
    if v_request.request_hash <> v_hash then
      raise exception using message = 'PAYOUT_REQUEST_REUSED';
    end if;
    return v_request.response || jsonb_build_object('replayed', true);
  end if;

  if v_correction.row_version <> p_expected_version
    or v_correction.status <> 'open'
    or v_correction.deadline_at <= transaction_timestamp()
  then
    return jsonb_build_object('outcome', 'state_conflict');
  end if;

  update public.payout_donation_corrections
  set status = 'submitted', row_version = row_version + 1,
      deadline_at = null, selection_source = p_source_type,
      organization_public_key = case when p_source_type = 'catalog' then p_organization_public_key end,
      selected_name = v_name, selected_website_url = v_url,
      submitted_at = transaction_timestamp(), updated_at = transaction_timestamp()
  where id = v_correction.id
  returning * into v_correction;

  insert into public.payout_events(
    event_type, actor_discord_user_id, target_type, target_public_id,
    target_version, request_id,
    details
  ) values (
    'donation_correction_submitted', v_owner_id,
    'donation_correction', v_correction.public_id,
    v_correction.row_version, p_request_id,
    jsonb_build_object('sourceType', p_source_type)
  );

  v_response := jsonb_build_object(
    'outcome', 'submitted', 'correctionPublicId', v_correction.public_id,
    'rowVersion', v_correction.row_version, 'replayed', false
  );
  insert into public.payout_mutation_requests(
    actor_discord_user_id, request_id, action, request_hash, response
  ) values (
    v_owner_id, p_request_id, 'submit_donation_correction', v_hash, v_response
  );
  return v_response;
end;
$function$;

create function public.disqualify_payout_allocation(
  p_actor_discord_user_id text,
  p_request_id uuid,
  p_allocation_public_id uuid,
  p_public_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_role text;
  v_allocation public.cycle_prize_allocations%rowtype;
  v_reason text := nullif(btrim(coalesce(p_public_reason, '')), '');
  v_disqualification public.payout_allocation_disqualifications%rowtype;
  v_hash text;
  v_request public.payout_mutation_requests%rowtype;
  v_response jsonb;
begin
  v_role := public.assert_winners_payout_capability(
    p_actor_discord_user_id, 'winners.manage_payouts'
  );
  if p_request_id is null or p_allocation_public_id is null
    or v_reason is null or char_length(v_reason) not between 3 and 300
  then raise exception using message = 'PAYOUT_INPUT_INVALID'; end if;
  v_hash := public.payout_request_hash(jsonb_build_object(
    'allocation', p_allocation_public_id, 'reason', v_reason
  ));
  select * into v_request from public.payout_mutation_requests
  where actor_discord_user_id = p_actor_discord_user_id
    and request_id = p_request_id and action = 'disqualify_payout';
  if found then
    if v_request.request_hash <> v_hash then raise exception using message = 'PAYOUT_REQUEST_REUSED'; end if;
    return v_request.response || jsonb_build_object('replayed', true);
  end if;
  select * into v_allocation from public.cycle_prize_allocations
  where public_id = p_allocation_public_id for update;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  if exists (
    select 1 from public.payout_plans plan
    join public.payout_lines line on line.plan_id = plan.id
    where plan.allocation_id = v_allocation.id and line.current_transaction_id is not null
  ) then return jsonb_build_object('outcome', 'state_conflict'); end if;

  insert into public.payout_allocation_disqualifications(
    allocation_id, public_reason, created_by
  ) values (v_allocation.id, v_reason, p_actor_discord_user_id)
  on conflict (allocation_id) do nothing
  returning * into v_disqualification;
  if not found then return jsonb_build_object('outcome', 'already_disqualified'); end if;

  update public.payout_donation_corrections
  set status = 'disqualified', row_version = row_version + 1,
      deadline_at = null, closed_at = transaction_timestamp(), updated_at = transaction_timestamp()
  where allocation_id = v_allocation.id and status in ('open', 'submitted');

  insert into public.payout_events(
    event_type, actor_discord_user_id, target_type, target_public_id,
    target_version, request_id, reason,
    details
  ) values (
    'payout_disqualified', p_actor_discord_user_id,
    'payout_disqualification', v_disqualification.public_id,
    v_disqualification.row_version, p_request_id, v_reason,
    jsonb_build_object('grossLamports', v_allocation.gross_lamports::text)
  );
  v_response := jsonb_build_object(
    'outcome', 'disqualified',
    'disqualificationPublicId', v_disqualification.public_id,
    'rowVersion', v_disqualification.row_version, 'replayed', false
  );
  insert into public.payout_mutation_requests(
    actor_discord_user_id, request_id, action, request_hash, response
  ) values (p_actor_discord_user_id, p_request_id, 'disqualify_payout', v_hash, v_response);
  return v_response;
end;
$function$;

create function public.complete_and_publish_payout(
  p_actor_discord_user_id text,
  p_request_id uuid,
  p_allocation_public_id uuid,
  p_expected_claim_version bigint,
  p_donation_operation_recipient text,
  p_winner_signature text,
  p_winner_slot bigint,
  p_winner_verified_recipient text,
  p_winner_verified_lamports bigint,
  p_donation_signature text,
  p_donation_slot bigint,
  p_donation_verified_recipient text,
  p_donation_verified_lamports bigint,
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
  v_line public.payout_lines%rowtype;
  v_winner_line public.payout_lines%rowtype;
  v_donation_line public.payout_lines%rowtype;
  v_transaction public.payout_transactions%rowtype;
  v_correction public.payout_donation_corrections%rowtype;
  v_reference public.submission_organization_references%rowtype;
  v_org_name text;
  v_org_url text;
  v_org_source text;
  v_org_revision bigint;
  v_org_version bigint;
  v_next_plan_version bigint;
  v_hash text;
  v_request public.payout_mutation_requests%rowtype;
  v_response jsonb;
begin
  v_role := public.assert_winners_payout_capability(
    p_actor_discord_user_id, 'winners.manage_payouts'
  );
  if p_request_id is null or p_allocation_public_id is null
    or p_expected_claim_version <= 0
  then raise exception using message = 'PAYOUT_INPUT_INVALID'; end if;

  v_hash := public.payout_request_hash(jsonb_build_object(
    'allocation', p_allocation_public_id,
    'claimVersion', p_expected_claim_version,
    'donationRecipient', p_donation_operation_recipient,
    'winnerSignature', p_winner_signature,
    'winnerSlot', p_winner_slot,
    'winnerVerifiedRecipient', p_winner_verified_recipient,
    'winnerVerifiedLamports', p_winner_verified_lamports,
    'donationSignature', p_donation_signature,
    'donationSlot', p_donation_slot,
    'donationVerifiedRecipient', p_donation_verified_recipient,
    'donationVerifiedLamports', p_donation_verified_lamports,
    'receiptKey', p_receipt_r2_key,
    'receiptBytes', p_receipt_byte_size,
    'receiptWidth', p_receipt_width,
    'receiptHeight', p_receipt_height,
    'receiptPublicApproved', p_receipt_public_approved
  ));
  select * into v_request from public.payout_mutation_requests
  where actor_discord_user_id = p_actor_discord_user_id
    and request_id = p_request_id and action = 'complete_and_publish';
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
  then
    return jsonb_build_object('outcome', 'donation_correction_required');
  end if;

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

  if v_allocation.winner_lamports > 0 and (
    p_winner_signature is null
    or p_winner_signature !~ '^[1-9A-HJ-NP-Za-km-z]{80,100}$'
    or p_winner_slot is null or p_winner_slot <= 0
    or p_winner_verified_recipient is distinct from v_claim.confirmed_recipient
    or p_winner_verified_lamports is distinct from v_allocation.winner_lamports
  ) then return jsonb_build_object('outcome', 'winner_verification_invalid'); end if;
  if v_allocation.winner_lamports = 0 and num_nonnulls(
    p_winner_signature, p_winner_slot, p_winner_verified_recipient,
    p_winner_verified_lamports
  ) <> 0 then return jsonb_build_object('outcome', 'winner_verification_invalid'); end if;

  if v_allocation.donation_lamports > 0 and (
    not public.is_valid_sol_recipient_address(p_donation_operation_recipient)
    or p_donation_signature is null
    or p_donation_signature !~ '^[1-9A-HJ-NP-Za-km-z]{80,100}$'
    or p_donation_slot is null or p_donation_slot <= 0
    or p_donation_verified_recipient is distinct from p_donation_operation_recipient
    or p_donation_verified_lamports is distinct from v_allocation.donation_lamports
  ) then return jsonb_build_object('outcome', 'donation_verification_invalid'); end if;
  if v_allocation.donation_lamports = 0 and num_nonnulls(
    p_donation_operation_recipient, p_donation_signature, p_donation_slot,
    p_donation_verified_recipient, p_donation_verified_lamports,
    p_receipt_r2_key, p_receipt_byte_size, p_receipt_width,
    p_receipt_height
  ) <> 0 then return jsonb_build_object('outcome', 'donation_verification_invalid'); end if;

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
    if v_correction.id is not null
      and v_correction.status in ('submitted', 'completed')
    then
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
      select * into v_reference
      from public.submission_organization_references
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
  if found and v_plan.state = 'published' then
    return jsonb_build_object('outcome', 'already_published');
  end if;
  if found and v_plan.state not in ('draft', 'locked') then
    return jsonb_build_object('outcome', 'state_conflict');
  end if;
  if found and exists (
    select 1 from public.payout_lines line
    where line.plan_id = v_plan.id
      and (line.current_transaction_id is not null
        or line.state not in ('prepared', 'locked'))
  ) then return jsonb_build_object('outcome', 'state_conflict'); end if;

  if not found then
    select coalesce(max(plan_version), 0) + 1 into v_next_plan_version
    from public.payout_plans where allocation_id = v_allocation.id;
    insert into public.payout_plans(allocation_id, plan_version, created_by)
    values (v_allocation.id, v_next_plan_version, p_actor_discord_user_id)
    returning * into v_plan;
    if v_allocation.winner_lamports > 0 then
      insert into public.payout_lines(
        plan_id, line_kind, amount_lamports, winner_claim_id, winner_recipient
      ) values (
        v_plan.id, 'winner', v_allocation.winner_lamports,
        v_claim.id, v_claim.confirmed_recipient
      );
    end if;
    if v_allocation.donation_lamports > 0 then
      insert into public.payout_lines(
        plan_id, line_kind, amount_lamports,
        organization_source_type, organization_revision_id,
        organization_effective_version, organization_effective_state,
        organization_name, organization_website_url
      ) values (
        v_plan.id, 'donation', v_allocation.donation_lamports,
        v_org_source, v_org_revision, coalesce(v_org_version, 1), 'verified',
        v_org_name, v_org_url
      );
    end if;
    insert into public.payout_events(
      event_type, actor_discord_user_id, target_type, target_public_id,
      target_version, request_id, details
    ) values (
      'plan_prepared', p_actor_discord_user_id, 'plan', v_plan.public_id,
      v_plan.row_version, p_request_id,
      jsonb_build_object('allocationPublicId', v_allocation.public_id)
    );
  end if;

  if v_plan.state = 'draft' then
    if v_allocation.donation_lamports > 0 then
      update public.payout_lines
      set donation_operation_recipient = p_donation_operation_recipient,
          organization_source_type = v_org_source,
          organization_revision_id = v_org_revision,
          organization_effective_version = coalesce(v_org_version, 1),
          organization_effective_state = 'verified',
          organization_name = v_org_name,
          organization_website_url = v_org_url,
          row_version = row_version + 1,
          updated_at = transaction_timestamp()
      where plan_id = v_plan.id and line_kind = 'donation'
      returning * into v_donation_line;
      insert into public.payout_events(
        event_type, actor_discord_user_id, target_type, target_public_id,
        target_version, request_id
      ) values (
        'donation_recipient_set', p_actor_discord_user_id, 'line',
        v_donation_line.public_id, v_donation_line.row_version, p_request_id
      );
    end if;
    update public.payout_lines
    set state = 'locked', row_version = row_version + 1,
        updated_at = transaction_timestamp()
    where plan_id = v_plan.id and state = 'prepared';
    update public.payout_plans
    set state = 'locked', row_version = row_version + 1,
        locked_at = transaction_timestamp()
    where id = v_plan.id returning * into v_plan;
    insert into public.payout_events(
      event_type, actor_discord_user_id, target_type, target_public_id,
      target_version, request_id
    ) values (
      'plan_locked', p_actor_discord_user_id, 'plan', v_plan.public_id,
      v_plan.row_version, p_request_id
    );
  end if;

  select * into v_winner_line from public.payout_lines
  where plan_id = v_plan.id and line_kind = 'winner' for update;
  if found then
    insert into public.payout_transactions(
      payout_line_id, transaction_version, signature, canonical_explorer_url,
      evidence_level, expected_recipient, expected_lamports,
      verification_slot, recorded_by
    ) values (
      v_winner_line.id, 1, p_winner_signature,
      'https://explorer.solana.com/tx/' || p_winner_signature || '?cluster=mainnet-beta',
      'on_chain_verified', v_claim.confirmed_recipient,
      v_allocation.winner_lamports, p_winner_slot, p_actor_discord_user_id
    ) returning * into v_transaction;
    update public.payout_lines
    set current_transaction_id = v_transaction.id, state = 'verified',
        row_version = row_version + 1, updated_at = transaction_timestamp()
    where id = v_winner_line.id returning * into v_winner_line;
    insert into public.payout_events(
      event_type, actor_discord_user_id, target_type, target_public_id,
      target_version, request_id,
      details
    ) values (
      'transaction_verified', p_actor_discord_user_id, 'transaction',
      v_transaction.public_id, v_transaction.transaction_version, p_request_id,
      jsonb_build_object('linePublicId', v_winner_line.public_id)
    );
  end if;

  select * into v_donation_line from public.payout_lines
  where plan_id = v_plan.id and line_kind = 'donation' for update;
  if found then
    if v_donation_line.donation_operation_recipient is distinct from p_donation_operation_recipient
      or v_donation_line.organization_name is distinct from v_org_name
      or v_donation_line.organization_website_url is distinct from v_org_url
    then return jsonb_build_object('outcome', 'state_conflict'); end if;
    insert into public.payout_transactions(
      payout_line_id, transaction_version, signature, canonical_explorer_url,
      evidence_level, expected_recipient, expected_lamports,
      verification_slot, recorded_by
    ) values (
      v_donation_line.id, 1, p_donation_signature,
      'https://explorer.solana.com/tx/' || p_donation_signature || '?cluster=mainnet-beta',
      'on_chain_verified', p_donation_operation_recipient,
      v_allocation.donation_lamports, p_donation_slot, p_actor_discord_user_id
    ) returning * into v_transaction;
    update public.payout_lines
    set current_transaction_id = v_transaction.id, state = 'verified',
        row_version = row_version + 1, updated_at = transaction_timestamp()
    where id = v_donation_line.id returning * into v_donation_line;
    insert into public.payout_events(
      event_type, actor_discord_user_id, target_type, target_public_id,
      target_version, request_id,
      details
    ) values (
      'transaction_verified', p_actor_discord_user_id, 'transaction',
      v_transaction.public_id, v_transaction.transaction_version, p_request_id,
      jsonb_build_object('linePublicId', v_donation_line.public_id)
    );
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
      insert into public.payout_events(
        event_type, actor_discord_user_id, target_type, target_public_id,
        target_version, request_id,
        details
      ) values (
        'evidence_attached', p_actor_discord_user_id, 'transaction',
        v_transaction.public_id, v_transaction.transaction_version, p_request_id,
        jsonb_build_object('publicApproved', p_receipt_public_approved)
      );
    end if;
  end if;

  update public.payout_plans
  set state = 'published', row_version = row_version + 1,
      published_at = transaction_timestamp()
  where id = v_plan.id returning * into v_plan;
  insert into public.payout_events(
    event_type, actor_discord_user_id, target_type, target_public_id,
    target_version, request_id
  ) values (
    'plan_published', p_actor_discord_user_id, 'plan', v_plan.public_id,
    v_plan.row_version, p_request_id
  );

  if v_correction.id is not null and v_correction.status = 'submitted' then
    update public.payout_donation_corrections
    set status = 'completed', row_version = row_version + 1,
        completed_at = transaction_timestamp(), closed_at = transaction_timestamp(),
        updated_at = transaction_timestamp()
    where id = v_correction.id returning * into v_correction;
    insert into public.payout_events(
      event_type, actor_discord_user_id, target_type, target_public_id,
      target_version, request_id
    ) values (
      'donation_correction_completed', p_actor_discord_user_id,
      'donation_correction', v_correction.public_id,
      v_correction.row_version, p_request_id
    );
  end if;

  v_response := jsonb_build_object(
    'outcome', 'published', 'planPublicId', v_plan.public_id,
    'rowVersion', v_plan.row_version, 'replayed', false
  );
  insert into public.payout_mutation_requests(
    actor_discord_user_id, request_id, action, request_hash, response
  ) values (
    p_actor_discord_user_id, p_request_id,
    'complete_and_publish', v_hash, v_response
  );
  return v_response;
end;
$function$;

create function public.get_simple_team_payouts(
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
        'transactionSignature', winner_transaction.signature,
        'transactionUrl', winner_transaction.canonical_explorer_url
      ) end,
      'donationLine', case when donation_line.id is null then null else jsonb_build_object(
        'linePublicId', donation_line.public_id,
        'state', donation_line.state,
        'recipient', case when p_include_management then donation_line.donation_operation_recipient end,
        'transactionSignature', donation_transaction.signature,
        'transactionUrl', donation_transaction.canonical_explorer_url,
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
    where candidate.payout_transaction_id = donation_transaction.id
    order by candidate.created_at desc, candidate.id desc
    limit 1
  ) evidence on true;

  return jsonb_build_object(
    'outcome', 'ok', 'databaseTime', transaction_timestamp(), 'items', v_items
  );
end;
$function$;

create function public.get_own_payout_donation_corrections(p_session_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner_id text;
  v_items jsonb;
begin
  v_owner_id := public.require_account_session(p_session_id);
  perform public.process_due_payout_donation_corrections(null);
  select coalesce(jsonb_agg(jsonb_build_object(
    'correctionPublicId', correction.public_id,
    'rowVersion', correction.row_version,
    'attemptVersion', correction.attempt_version,
    'status', correction.status,
    'publicReason', correction.public_reason,
    'deadlineAt', correction.deadline_at,
    'submittedAt', correction.submitted_at,
    'cycleNumber', cycle.public_number,
    'submissionId', allocation.submission_id,
    'payoutChoice', allocation.payout_choice,
    'splitPercent', allocation.split_percent,
    'donationLamports', allocation.donation_lamports::text,
    'currentOrganizationName', allocation.organization_name
  ) order by correction.created_at desc), '[]'::jsonb)
  into v_items
  from public.payout_donation_corrections correction
  join public.cycle_prize_allocations allocation on allocation.id = correction.allocation_id
  join public.voting_cycles cycle on cycle.id = allocation.cycle_id
  where allocation.winner_discord_user_id = v_owner_id
    and correction.status in ('open', 'submitted', 'expired');
  return jsonb_build_object(
    'outcome', 'ok', 'databaseTime', transaction_timestamp(), 'items', v_items
  );
end;
$function$;

create function public.get_public_submission_payout(p_submission_id bigint)
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
    'organizationName', case when plan.state = 'published' then donation_line.organization_name end,
    'organizationWebsiteUrl', case when plan.state = 'published' then donation_line.organization_website_url end,
    'donationRecipient', case when plan.state = 'published' then donation_line.donation_operation_recipient end,
    'donationTransactionUrl', case when plan.state = 'published' then donation_transaction.canonical_explorer_url end,
    'donationTransactionSignature', case when plan.state = 'published' then donation_transaction.signature end,
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
    where candidate.payout_transaction_id = donation_transaction.id
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

create function public.get_public_payout_receipt_source(p_evidence_public_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select jsonb_build_object(
    'r2Key', evidence.r2_key,
    'byteSize', evidence.byte_size,
    'width', evidence.width,
    'height', evidence.height
  )
  from public.payout_private_evidence evidence
  join public.payout_transactions transaction on transaction.id = evidence.payout_transaction_id
  join public.payout_lines line on line.id = transaction.payout_line_id
  join public.payout_plans plan on plan.id = line.plan_id
  where evidence.public_id = p_evidence_public_id
    and evidence.public_approved
    and plan.state = 'published'
    and line.line_kind = 'donation';
$function$;

create or replace function public.get_own_notifications(
  p_session_id uuid,
  p_before_created_at timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 20
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner_id text;
  v_items jsonb;
begin
  if p_limit not between 1 and 50
    or ((p_before_created_at is null) <> (p_before_id is null))
  then
    raise exception using errcode = '22023', message = 'NOTIFICATION_PAGE_INPUT_INVALID';
  end if;
  v_owner_id := public.require_account_session(p_session_id);
  select coalesce(jsonb_agg(item.payload order by item.created_at desc, item.id desc), '[]'::jsonb)
  into v_items
  from (
    select notification.created_at, notification.id,
      jsonb_build_object(
        'id', notification.id,
        'categoryKey', event.category_key,
        'eventType', event.event_type,
        'title', case event.event_type
          when 'winner_claim_required' then 'Winner claim required'
          when 'winner_correction_ready' then 'Winner claim ready'
          when 'winner_donation_finalized' then 'Winner result finalized'
          when 'donation_recipient_change_required' then 'Choose another charity'
          when 'submission_disqualified' then 'Submission disqualified'
          when 'submission_reinstated' then 'Submission restored'
          when 'wallet_issue_received' then 'Wallet issue received'
          when 'wallet_issue_correction_ready' then 'Wallet correction ready'
          when 'wallet_issue_resolved' then 'Wallet issue resolved'
          else 'Cycle results are ready'
        end,
        'body', coalesce(event.public_body, case event.event_type
          when 'winner_claim_required' then 'Review and confirm your winner claim.'
          when 'winner_correction_ready' then 'Review the full recipient and confirm your Claim within 24 hours.'
          when 'winner_donation_finalized' then 'View your finalized winner result.'
          when 'donation_recipient_change_required' then 'Choose another charity within 24 hours.'
          when 'submission_disqualified' then 'View your moderation history for details.'
          when 'submission_reinstated' then 'View your moderation history for details.'
          when 'wallet_issue_received' then 'Your winning-Submission report is ready for Team review.'
          when 'wallet_issue_correction_ready' then 'Review the full recipient and confirm your Claim within 24 hours.'
          when 'wallet_issue_resolved' then 'Review the current recipient and confirm your Claim within 24 hours.'
          else 'View the finalized Cycle results.'
        end),
        'actionLabel', case event.event_type
          when 'winner_claim_required' then 'Review claim'
          when 'winner_correction_ready' then 'Review claim'
          when 'winner_donation_finalized' then 'View result'
          when 'donation_recipient_change_required' then 'Choose charity'
          when 'submission_disqualified' then 'View details'
          when 'submission_reinstated' then 'View details'
          when 'wallet_issue_received' then 'View claim'
          when 'wallet_issue_correction_ready' then 'Review claim'
          when 'wallet_issue_resolved' then 'Review claim'
          else 'View results'
        end,
        'createdAt', notification.created_at,
        'readAt', notification.read_at
      ) payload
    from public.account_notifications notification
    join public.notification_events event on event.id = notification.event_id
    where notification.owner_discord_user_id = v_owner_id
      and notification.visible_in_product
      and (notification.read_at is null
        or notification.read_at > transaction_timestamp() - interval '3 days')
      and (p_before_created_at is null
        or (notification.created_at, notification.id) < (p_before_created_at, p_before_id))
    order by notification.created_at desc, notification.id desc
    limit p_limit + 1
  ) item;
  return jsonb_build_object('items', v_items);
end;
$function$;

create trigger preserve_payout_disqualifications
before update or delete on public.payout_allocation_disqualifications
for each row execute function public.reject_payout_append_only_rewrite();

alter table public.payout_donation_corrections enable row level security;
alter table public.payout_allocation_disqualifications enable row level security;

revoke all on table public.payout_donation_corrections,
  public.payout_allocation_disqualifications
  from public, anon, authenticated, discord_bot, service_role;

alter table public.payout_donation_corrections owner to postgres;
alter table public.payout_allocation_disqualifications owner to postgres;

alter function public.process_due_payout_donation_corrections(uuid) owner to postgres;
alter function public.request_donation_recipient_correction(text,uuid,uuid,text) owner to postgres;
alter function public.submit_own_donation_recipient_correction(uuid,uuid,uuid,bigint,text,text,text,text) owner to postgres;
alter function public.disqualify_payout_allocation(text,uuid,uuid,text) owner to postgres;
alter function public.complete_and_publish_payout(text,uuid,uuid,bigint,text,text,bigint,text,bigint,text,bigint,text,bigint,text,integer,integer,integer,boolean) owner to postgres;
alter function public.get_simple_team_payouts(text,boolean) owner to postgres;
alter function public.get_own_payout_donation_corrections(uuid) owner to postgres;
alter function public.get_public_submission_payout(bigint) owner to postgres;
alter function public.get_public_payout_receipt_source(uuid) owner to postgres;
alter function public.get_own_notifications(uuid,timestamptz,uuid,integer) owner to postgres;

revoke all on function public.process_due_payout_donation_corrections(uuid),
  public.request_donation_recipient_correction(text,uuid,uuid,text),
  public.submit_own_donation_recipient_correction(uuid,uuid,uuid,bigint,text,text,text,text),
  public.disqualify_payout_allocation(text,uuid,uuid,text),
  public.complete_and_publish_payout(text,uuid,uuid,bigint,text,text,bigint,text,bigint,text,bigint,text,bigint,text,integer,integer,integer,boolean),
  public.get_simple_team_payouts(text,boolean),
  public.get_own_payout_donation_corrections(uuid),
  public.get_public_submission_payout(bigint),
  public.get_public_payout_receipt_source(uuid),
  public.get_own_notifications(uuid,timestamptz,uuid,integer)
  from public, anon, authenticated, discord_bot, service_role;

grant execute on function public.request_donation_recipient_correction(text,uuid,uuid,text),
  public.submit_own_donation_recipient_correction(uuid,uuid,uuid,bigint,text,text,text,text),
  public.disqualify_payout_allocation(text,uuid,uuid,text),
  public.complete_and_publish_payout(text,uuid,uuid,bigint,text,text,bigint,text,bigint,text,bigint,text,bigint,text,integer,integer,integer,boolean),
  public.get_simple_team_payouts(text,boolean),
  public.get_own_payout_donation_corrections(uuid),
  public.get_public_submission_payout(bigint),
  public.get_public_payout_receipt_source(uuid),
  public.get_own_notifications(uuid,timestamptz,uuid,integer)
  to service_role;

comment on table public.payout_donation_corrections is
  'Versioned winner-owned 24-hour donation-recipient correction attempts; no amount or percentage changes.';
comment on table public.payout_allocation_disqualifications is
  'Append-only payout-only disqualification preserving the canonical Cycle winner and Submission.';
comment on function public.complete_and_publish_payout(text,uuid,uuid,bigint,text,text,bigint,text,bigint,text,bigint,text,bigint,text,integer,integer,integer,boolean) is
  'Completes one canonical winner payout from verified proof and publishes it atomically without exposing technical plan controls.';
