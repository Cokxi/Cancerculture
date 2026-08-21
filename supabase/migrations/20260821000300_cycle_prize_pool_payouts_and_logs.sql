begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $preflight$
begin
  if (select count(*) from public.capability_catalog) <> 41
    or (select count(*) from public.capability_catalog where is_active) <> 37
    or not exists (
      select 1 from public.capability_catalog
      where key = 'winners.payouts.view'
        and implementation_version = 2
        and definition_hash = '9de22d0055e9c8b6b8cb701e4f6f554aa4c241ab0cbfb0a4709ecc9841702a54'
        and is_active and assignable_to_non_admin
    )
    or not exists (
      select 1 from public.capability_catalog
      where key = 'donation_organizations.manage'
        and implementation_version = 1
        and definition_hash = '18240d25d2183ebb17f7b1a56345ab2acc3906455d253b90cfee79cd5d6aa58d'
        and is_active and assignable_to_non_admin
    )
    or not exists (
      select 1 from public.capability_catalog
      where key = 'community.polls.manage'
        and implementation_version = 1
        and definition_hash = '042a289cd77aca920ab6d07abec54cec1b380423c90aa3693b7fbb11537a9a7e'
        and is_active and assignable_to_non_admin
    )
    or exists (
      select 1 from public.capability_catalog
      where key in ('winners.manage_payouts', 'winners.payout_logs.view')
    )
    or exists (
      select 1 from public.team_role_capabilities
      where capability_key in ('winners.manage_payouts', 'winners.payout_logs.view')
    )
    or to_regprocedure('public.finalize_cycle(bigint,text)') is null
    or to_regprocedure('public.finalize_cycle_without_prize_pool(bigint,text)') is not null
    or to_regclass('public.winner_claims') is null
    or to_regclass('public.submission_organization_references') is null
    or to_regclass('public.community_polls') is null
    or to_regclass('public.cycle_prize_pools') is not null
    or to_regclass('public.payout_plans') is not null
  then
    raise exception using errcode = '55000', message = 'PAYOUT_FOUNDATION_BASELINE_MISMATCH';
  end if;
end;
$preflight$;

insert into public.capability_catalog (
  key, display_name, description, category, included_actions,
  excluded_actions, risk_level, assignable_to_non_admin, is_active,
  implementation_version, definition_hash
)
values
(
  'winners.payout_logs.view',
  'View Payout Logs',
  'Review the append-only prize-pool, payout-plan, transaction-evidence, and community-disposition history without changing payout state or opening private evidence files.',
  'Payouts',
  array[
    'View bounded append-only prize-pool and payout lifecycle events with actor, database time, version, and idempotency context.',
    'View transaction verification level, canonical explorer reference, replacement linkage, and private evidence metadata.',
    'View linked Community Vote and applied rollover, alternative-organization, follow-up, or return-Claim outcomes.'
  ]::text[],
  array[
    'Changing prize pools, payout plans, recipients, transactions, evidence, polls, Claims, or publication state.',
    'Viewing Treasury secrets, mutable Profile Wallets, unconfirmed winner recipients, raw provider payloads, or private evidence bytes.',
    'Managing roles, grants, Team membership, Owner access, organizations, Community polls, or unrelated logs.'
  ]::text[],
  'high', true, true, 1,
  '91f8ef9be3147c220c0591843f752145c2b2f865424f58afc76ab0b21448e019'
),
(
  'winners.manage_payouts',
  'Manage Prize Pools and Payouts',
  'Manage exact-Lamport Cycle prize pools and canonical Claim-bound manual SOL payout workflows without custodying Treasury keys or transferring funds automatically.',
  'Payouts',
  array[
    'Set, change, or clear a running Cycle prize pool and add immutable finalized determinations, supplements, replacements, or rollovers.',
    'Prepare, lock, issue, verify, publish, abort, or visibly replace canonical payout plans derived only from finalized Winner records.',
    'Record a donation operation recipient, transaction evidence, provider confirmation, bounded private proof metadata, and an unavailable-donation state.',
    'Link a manually created Community Vote and apply its exact binding rollover, named-organization, follow-up, or return-to-winner outcome.'
  ]::text[],
  array[
    'Entering, confirming, replacing, or changing a winner recipient; only the winner''s immutable confirmed Claim may supply it.',
    'Changing winners, ranks, win shares, votes, payout choices, split percentages, original organization choices, or locked base components.',
    'Storing Treasury private keys, connecting a Treasury Wallet, automatically transferring SOL, creating or activating polls, or silently redistributing funds.',
    'Managing roles, grants, Team membership, Owner access, organization publication, or unrelated content and logs.'
  ]::text[],
  'critical', true, true, 1,
  'a8dfec835cd096ca2c4e51b82209efad394432a0e5239ed28cafc81b1b3bfa93'
);

create table public.cycle_prize_pools (
  cycle_id bigint primary key references public.voting_cycles(id),
  public_id uuid not null unique default gen_random_uuid(),
  row_version bigint not null default 1 check (row_version > 0),
  announced_lamports bigint check (announced_lamports > 0),
  state text not null default 'running'
    check (state in ('running', 'amount_pending', 'locked')),
  finalized_at timestamptz,
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  constraint cycle_prize_pool_state_check check (
    (state = 'running' and finalized_at is null)
    or (state in ('amount_pending', 'locked') and finalized_at is not null)
  )
);

create table public.cycle_prize_pool_components (
  id uuid primary key default gen_random_uuid(),
  public_id uuid not null unique default gen_random_uuid(),
  cycle_id bigint not null references public.cycle_prize_pools(cycle_id),
  component_version bigint not null check (component_version > 0),
  component_kind text not null
    check (component_kind in ('base', 'determination', 'supplement', 'replacement', 'rollover')),
  amount_lamports bigint not null check (amount_lamports > 0),
  replaces_component_id uuid references public.cycle_prize_pool_components(id),
  source_payout_line_id uuid,
  actor_discord_user_id text not null check (actor_discord_user_id ~ '^[0-9]+$'),
  reason text check (reason is null or (reason = btrim(reason) and char_length(reason) between 3 and 500)),
  locked_at timestamptz not null default transaction_timestamp(),
  unique (cycle_id, component_version),
  unique (replaces_component_id),
  constraint cycle_prize_pool_component_shape_check check (
    (component_kind = 'base' and component_version = 1 and replaces_component_id is null and source_payout_line_id is null)
    or (component_kind = 'determination' and replaces_component_id is null and source_payout_line_id is null)
    or (component_kind = 'supplement' and replaces_component_id is null and source_payout_line_id is null)
    or (component_kind = 'replacement' and replaces_component_id is not null and source_payout_line_id is null)
    or (component_kind = 'rollover' and replaces_component_id is null and source_payout_line_id is not null)
  )
);

create unique index cycle_prize_pool_one_base_idx
  on public.cycle_prize_pool_components(cycle_id)
  where component_kind = 'base';
create unique index cycle_prize_pool_one_determination_idx
  on public.cycle_prize_pool_components(cycle_id)
  where component_kind = 'determination';
create unique index cycle_prize_pool_rollover_source_idx
  on public.cycle_prize_pool_components(source_payout_line_id)
  where source_payout_line_id is not null;

create table public.cycle_prize_allocations (
  id uuid primary key default gen_random_uuid(),
  public_id uuid not null unique default gen_random_uuid(),
  component_id uuid not null references public.cycle_prize_pool_components(id),
  claim_id uuid not null references public.winner_claims(id),
  cycle_id bigint not null references public.voting_cycles(id),
  submission_id bigint not null references public.submissions(id),
  winner_discord_user_id text not null references public.user_logs(discord_user_id),
  win_share_snapshot numeric(38,20) not null check (win_share_snapshot > 0),
  stable_tie_key text not null check (stable_tie_key ~ '^[0-9a-f]{64}$'),
  gross_lamports bigint not null check (gross_lamports >= 0),
  winner_lamports bigint not null check (winner_lamports >= 0),
  donation_lamports bigint not null check (donation_lamports >= 0),
  payout_choice text not null check (payout_choice in ('keep', 'split', 'donate')),
  split_percent integer,
  organization_source_type text,
  organization_revision_id bigint references public.donation_organization_revisions(id),
  organization_effective_version bigint,
  organization_effective_state text check (organization_effective_state in ('verified', 'pending', 'quarantined')),
  organization_name text,
  organization_website_url text,
  allocated_at timestamptz not null default transaction_timestamp(),
  unique (component_id, claim_id),
  constraint cycle_prize_allocation_total_check check (winner_lamports + donation_lamports = gross_lamports),
  constraint cycle_prize_allocation_choice_check check (
    (payout_choice = 'keep' and split_percent is null and winner_lamports = gross_lamports and donation_lamports = 0)
    or (payout_choice = 'donate' and split_percent is null and winner_lamports = 0 and donation_lamports = gross_lamports)
    or (payout_choice = 'split' and split_percent between 1 and 99)
  ),
  constraint cycle_prize_allocation_organization_check check (
    (donation_lamports = 0 and organization_name is null and organization_effective_state is null)
    or (donation_lamports > 0 and nullif(btrim(organization_name), '') is not null and organization_effective_state is not null)
  )
);

create table public.payout_plans (
  id uuid primary key default gen_random_uuid(),
  public_id uuid not null unique default gen_random_uuid(),
  allocation_id uuid not null references public.cycle_prize_allocations(id),
  plan_version bigint not null default 1 check (plan_version > 0),
  row_version bigint not null default 1 check (row_version > 0),
  state text not null default 'draft'
    check (state in ('draft', 'locked', 'published', 'aborted', 'replaced')),
  replacement_for_plan_id uuid references public.payout_plans(id),
  created_by text not null check (created_by ~ '^[0-9]+$'),
  created_at timestamptz not null default transaction_timestamp(),
  locked_at timestamptz,
  published_at timestamptz,
  closed_at timestamptz,
  unique (allocation_id, plan_version),
  unique (replacement_for_plan_id)
);

create unique index payout_plans_one_current_allocation_idx
  on public.payout_plans(allocation_id)
  where state not in ('aborted', 'replaced');

create table public.payout_lines (
  id uuid primary key default gen_random_uuid(),
  public_id uuid not null unique default gen_random_uuid(),
  plan_id uuid not null references public.payout_plans(id),
  line_kind text not null check (line_kind in ('winner', 'donation')),
  amount_lamports bigint not null check (amount_lamports > 0),
  row_version bigint not null default 1 check (row_version > 0),
  state text not null default 'prepared'
    check (state in ('prepared', 'locked', 'verified', 'unavailable', 'community_pending', 'rolled_over', 'redirected', 'return_claim', 'replaced')),
  winner_claim_id uuid references public.winner_claims(id),
  winner_recipient text,
  organization_source_type text,
  organization_revision_id bigint references public.donation_organization_revisions(id),
  organization_effective_version bigint,
  organization_effective_state text check (organization_effective_state in ('verified', 'pending', 'quarantined')),
  organization_name text,
  organization_website_url text,
  donation_operation_recipient text,
  unavailable_reason text check (unavailable_reason is null or (unavailable_reason = btrim(unavailable_reason) and char_length(unavailable_reason) between 3 and 500)),
  replacement_for_line_id uuid references public.payout_lines(id),
  current_transaction_id uuid,
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  unique (plan_id, line_kind, replacement_for_line_id),
  unique (replacement_for_line_id),
  constraint payout_line_shape_check check (
    (line_kind = 'winner' and winner_claim_id is not null and public.is_valid_sol_recipient_address(winner_recipient)
      and organization_name is null and donation_operation_recipient is null)
    or (line_kind = 'donation' and winner_claim_id is null and winner_recipient is null and nullif(btrim(organization_name), '') is not null)
  )
);

alter table public.cycle_prize_pool_components
  add constraint cycle_prize_pool_component_source_line_fk
  foreign key (source_payout_line_id) references public.payout_lines(id);

create table public.payout_transactions (
  id uuid primary key default gen_random_uuid(),
  public_id uuid not null unique default gen_random_uuid(),
  payout_line_id uuid not null references public.payout_lines(id),
  transaction_version bigint not null check (transaction_version > 0),
  signature text not null unique check (char_length(signature) between 80 and 100 and signature ~ '^[1-9A-HJ-NP-Za-km-z]+$'),
  canonical_explorer_url text not null check (canonical_explorer_url = 'https://explorer.solana.com/tx/' || signature || '?cluster=mainnet-beta'),
  evidence_level text not null check (evidence_level in ('on_chain_verified', 'operator_confirmed_provider')),
  expected_recipient text not null check (public.is_valid_sol_recipient_address(expected_recipient)),
  expected_lamports bigint not null check (expected_lamports > 0),
  provider_reference text check (provider_reference is null or (provider_reference = btrim(provider_reference) and char_length(provider_reference) <= 300)),
  verification_slot bigint check (verification_slot is null or verification_slot > 0),
  replaces_transaction_id uuid references public.payout_transactions(id),
  recorded_by text not null check (recorded_by ~ '^[0-9]+$'),
  recorded_at timestamptz not null default transaction_timestamp(),
  unique (payout_line_id, transaction_version),
  unique (replaces_transaction_id),
  constraint payout_transaction_evidence_check check (
    (evidence_level = 'on_chain_verified' and verification_slot is not null)
    or (evidence_level = 'operator_confirmed_provider' and nullif(provider_reference, '') is not null)
  )
);

alter table public.payout_lines
  add constraint payout_lines_current_transaction_fk
  foreign key (current_transaction_id) references public.payout_transactions(id);

create table public.payout_private_evidence (
  id uuid primary key default gen_random_uuid(),
  public_id uuid not null unique default gen_random_uuid(),
  payout_transaction_id uuid not null references public.payout_transactions(id),
  r2_key text not null unique check (r2_key ~ '^payout-evidence/[0-9A-Fa-f-]{36}[.]webp$'),
  byte_size integer not null check (byte_size between 1 and 3145728),
  width integer not null check (width between 1 and 4096),
  height integer not null check (height between 1 and 8192),
  uploaded_by text not null check (uploaded_by ~ '^[0-9]+$'),
  uploaded_at timestamptz not null default transaction_timestamp(),
  unique (payout_transaction_id)
);

create table public.payout_poll_links (
  id uuid primary key default gen_random_uuid(),
  public_id uuid not null unique default gen_random_uuid(),
  payout_line_id uuid not null references public.payout_lines(id),
  poll_id uuid not null references public.community_polls(id),
  poll_version bigint not null check (poll_version > 0),
  option_mappings jsonb not null check (jsonb_typeof(option_mappings) = 'array' and jsonb_array_length(option_mappings) between 1 and 8),
  applied_option_id uuid references public.community_poll_options(id),
  follow_up_poll_id uuid references public.community_polls(id),
  applied_at timestamptz,
  linked_by text not null check (linked_by ~ '^[0-9]+$'),
  linked_at timestamptz not null default transaction_timestamp(),
  applied_by text check (applied_by is null or applied_by ~ '^[0-9]+$'),
  unique (payout_line_id, poll_id),
  constraint payout_poll_application_check check ((applied_at is null) = (applied_option_id is null) and (applied_at is null) = (applied_by is null))
);

create table public.payout_return_claims (
  id uuid primary key default gen_random_uuid(),
  public_id uuid not null unique default gen_random_uuid(),
  source_payout_line_id uuid not null unique references public.payout_lines(id),
  cycle_id bigint not null references public.voting_cycles(id),
  submission_id bigint not null references public.submissions(id),
  winner_discord_user_id text not null references public.user_logs(discord_user_id),
  amount_lamports bigint not null check (amount_lamports > 0),
  status text not null default 'unclaimed' check (status in ('unclaimed', 'confirmed', 'declined', 'expired')),
  row_version bigint not null default 1 check (row_version > 0),
  deadline_at timestamptz,
  confirmed_recipient text,
  confirmed_recipient_source text check (confirmed_recipient_source in ('profile', 'manual_return')),
  confirmed_at timestamptz,
  declined_at timestamptz,
  expired_at timestamptz,
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  constraint payout_return_claim_state_check check (
    (status = 'unclaimed' and deadline_at is not null and confirmed_recipient is null and confirmed_at is null and declined_at is null and expired_at is null)
    or (status = 'confirmed' and deadline_at is null and public.is_valid_sol_recipient_address(confirmed_recipient) and confirmed_at is not null and declined_at is null and expired_at is null)
    or (status = 'declined' and deadline_at is null and confirmed_recipient is null and confirmed_at is null and declined_at is not null and expired_at is null)
    or (status = 'expired' and deadline_at is null and confirmed_recipient is null and confirmed_at is null and declined_at is null and expired_at is not null)
  )
);

create table public.payout_events (
  id bigint generated always as identity primary key,
  event_type text not null check (event_type in (
    'pool_created', 'pool_changed', 'pool_cleared', 'pool_locked', 'pool_amount_pending', 'pool_component_added',
    'allocation_created', 'plan_prepared', 'plan_locked', 'plan_published', 'plan_aborted', 'plan_replaced',
    'donation_recipient_set', 'donation_unavailable', 'transaction_issued', 'transaction_verified', 'evidence_attached',
    'poll_linked', 'poll_outcome_applied', 'rollover_created', 'organization_redirected', 'return_claim_created', 'follow_up_linked',
    'return_claim_confirmed', 'return_claim_declined', 'return_claim_expired'
  )),
  actor_discord_user_id text check (actor_discord_user_id is null or actor_discord_user_id ~ '^[0-9]+$'),
  target_type text not null check (target_type in ('pool', 'component', 'allocation', 'plan', 'line', 'transaction', 'return_claim')),
  target_public_id uuid not null,
  target_version bigint not null check (target_version > 0),
  request_id uuid,
  reason text check (reason is null or (reason = btrim(reason) and char_length(reason) between 3 and 500)),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object' and octet_length(details::text) <= 4000),
  occurred_at timestamptz not null default transaction_timestamp()
);

create index payout_events_recent_idx on public.payout_events(occurred_at desc, id desc);

create table public.payout_mutation_requests (
  actor_discord_user_id text not null check (actor_discord_user_id ~ '^[0-9]+$'),
  request_id uuid not null,
  action text not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  response jsonb not null check (jsonb_typeof(response) = 'object'),
  created_at timestamptz not null default transaction_timestamp(),
  primary key (actor_discord_user_id, request_id, action)
);

create table public.payout_return_claim_requests (
  claim_id uuid not null references public.payout_return_claims(id),
  request_id uuid not null,
  action text not null check (action in ('confirm', 'decline')),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  response jsonb not null check (jsonb_typeof(response) = 'object'),
  created_at timestamptz not null default transaction_timestamp(),
  primary key (claim_id, request_id)
);

create function public.reject_payout_append_only_rewrite()
returns trigger language plpgsql set search_path = public, pg_temp
as $function$
begin
  raise exception using errcode = '55000', message = 'PAYOUT_APPEND_ONLY_REWRITE_FORBIDDEN';
end;
$function$;

create trigger preserve_cycle_prize_pool_components before update or delete on public.cycle_prize_pool_components for each row execute function public.reject_payout_append_only_rewrite();
create trigger preserve_cycle_prize_allocations before update or delete on public.cycle_prize_allocations for each row execute function public.reject_payout_append_only_rewrite();
create trigger preserve_payout_transactions before update or delete on public.payout_transactions for each row execute function public.reject_payout_append_only_rewrite();
create trigger preserve_payout_private_evidence before update or delete on public.payout_private_evidence for each row execute function public.reject_payout_append_only_rewrite();
create trigger preserve_payout_events before update or delete on public.payout_events for each row execute function public.reject_payout_append_only_rewrite();
create trigger preserve_payout_requests before update or delete on public.payout_mutation_requests for each row execute function public.reject_payout_append_only_rewrite();
create trigger preserve_return_claim_requests before update or delete on public.payout_return_claim_requests for each row execute function public.reject_payout_append_only_rewrite();

create function public.assert_winners_payout_capability(p_actor_discord_user_id text, p_capability_key text)
returns text language plpgsql stable security definer set search_path = public, pg_temp
as $function$
declare
  v_actor text := btrim(coalesce(p_actor_discord_user_id, ''));
  v_role text;
  v_hash text;
begin
  if v_actor !~ '^[0-9]+$' or char_length(v_actor) > 100
    or p_capability_key not in ('winners.manage_payouts', 'winners.payout_logs.view', 'winners.payouts.view')
  then raise exception using errcode = '42501', message = 'PAYOUT_CAPABILITY_FORBIDDEN'; end if;
  v_hash := case p_capability_key
    when 'winners.manage_payouts' then 'a8dfec835cd096ca2c4e51b82209efad394432a0e5239ed28cafc81b1b3bfa93'
    when 'winners.payout_logs.view' then '91f8ef9be3147c220c0591843f752145c2b2f865424f58afc76ab0b21448e019'
    else '9de22d0055e9c8b6b8cb701e4f6f554aa4c241ab0cbfb0a4709ecc9841702a54'
  end;
  if not exists (
    select 1 from public.capability_catalog
    where key = p_capability_key and is_active and assignable_to_non_admin
      and implementation_version = case when p_capability_key = 'winners.payouts.view' then 2 else 1 end
      and definition_hash = v_hash
  ) then raise exception using errcode = '55000', message = 'PAYOUT_CAPABILITY_UNAVAILABLE'; end if;
  select member.role into v_role
  from public.team_members member join public.team_roles role on role.key = member.role and role.is_active
  where member.discord_user_id = v_actor;
  if not found or (v_role <> 'admin' and not exists (
    select 1 from public.team_role_capabilities grant_row
    where grant_row.role_key = v_role and grant_row.capability_key = p_capability_key
  )) then raise exception using errcode = '42501', message = 'PAYOUT_CAPABILITY_FORBIDDEN'; end if;
  return v_role;
end;
$function$;

create function public.payout_request_hash(p_value jsonb)
returns text language sql immutable set search_path = public, pg_temp
as $function$
  select encode(extensions.digest(convert_to(coalesce(p_value, '{}'::jsonb)::text, 'utf8'), 'sha256'), 'hex');
$function$;

create function public.allocate_cycle_prize_component(p_component_id uuid)
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

create function public.manage_cycle_prize_pool(
  p_actor_discord_user_id text,
  p_request_id uuid,
  p_cycle_id bigint,
  p_expected_version bigint,
  p_operation text,
  p_amount_lamports bigint,
  p_component_kind text,
  p_replaces_component_public_id uuid,
  p_reason text
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $function$
declare
  v_role text;
  v_cycle public.voting_cycles%rowtype;
  v_pool public.cycle_prize_pools%rowtype;
  v_component public.cycle_prize_pool_components%rowtype;
  v_replaced public.cycle_prize_pool_components%rowtype;
  v_hash text;
  v_request public.payout_mutation_requests%rowtype;
  v_response jsonb;
  v_event text;
begin
  v_role := public.assert_winners_payout_capability(p_actor_discord_user_id, 'winners.manage_payouts');
  if p_request_id is null or p_cycle_id is null or p_cycle_id <= 0 or p_expected_version < 0
    or p_operation not in ('set', 'clear', 'add_component', 'replace_component')
  then raise exception using message = 'PAYOUT_INPUT_INVALID'; end if;
  v_hash := public.payout_request_hash(jsonb_build_object(
    'cycleId', p_cycle_id, 'expectedVersion', p_expected_version, 'operation', p_operation,
    'amountLamports', p_amount_lamports, 'componentKind', p_component_kind,
    'replacesComponent', p_replaces_component_public_id, 'reason', nullif(btrim(coalesce(p_reason, '')), '')
  ));
  select * into v_request from public.payout_mutation_requests
  where actor_discord_user_id = p_actor_discord_user_id and request_id = p_request_id and action = 'manage_pool';
  if found then
    if v_request.request_hash <> v_hash then raise exception using message = 'PAYOUT_REQUEST_REUSED'; end if;
    return v_request.response || jsonb_build_object('replayed', true);
  end if;
  select * into v_cycle from public.voting_cycles where id = p_cycle_id for update;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  select * into v_pool from public.cycle_prize_pools where cycle_id = p_cycle_id for update;

  if p_operation in ('set', 'clear') then
    if v_cycle.status = 'finished' then return jsonb_build_object('outcome', 'state_conflict'); end if;
    if p_operation = 'set' and (p_amount_lamports is null or p_amount_lamports <= 0) then
      raise exception using message = 'PAYOUT_INPUT_INVALID';
    end if;
    if found then
      if v_pool.state <> 'running' or v_pool.row_version <> p_expected_version then return jsonb_build_object('outcome', 'stale'); end if;
      update public.cycle_prize_pools set
        announced_lamports = case when p_operation = 'set' then p_amount_lamports else null end,
        row_version = row_version + 1, updated_at = transaction_timestamp()
      where cycle_id = p_cycle_id returning * into v_pool;
      v_event := case when p_operation = 'set' then 'pool_changed' else 'pool_cleared' end;
    else
      if p_expected_version <> 0 then return jsonb_build_object('outcome', 'stale'); end if;
      insert into public.cycle_prize_pools(cycle_id, announced_lamports)
      values (p_cycle_id, case when p_operation = 'set' then p_amount_lamports else null end)
      returning * into v_pool;
      v_event := case when p_operation = 'set' then 'pool_created' else 'pool_cleared' end;
    end if;
    insert into public.payout_events(event_type, actor_discord_user_id, target_type, target_public_id, target_version, request_id, reason, details)
    values (v_event, p_actor_discord_user_id, 'pool', v_pool.public_id, v_pool.row_version, p_request_id,
      nullif(btrim(coalesce(p_reason, '')), ''),
      jsonb_build_object('amountLamports', coalesce(v_pool.announced_lamports::text, null), 'cycleId', p_cycle_id));
  else
    if not found or v_cycle.status <> 'finished' or v_pool.row_version <> p_expected_version then
      return jsonb_build_object('outcome', 'stale');
    end if;
    if p_amount_lamports is null or p_amount_lamports <= 0 or nullif(btrim(coalesce(p_reason, '')), '') is null then
      raise exception using message = 'PAYOUT_INPUT_INVALID';
    end if;
    if p_operation = 'add_component' then
      if p_component_kind not in ('determination', 'supplement') then raise exception using message = 'PAYOUT_INPUT_INVALID'; end if;
      if p_component_kind = 'determination' and exists (
        select 1 from public.cycle_prize_pool_components where cycle_id = p_cycle_id and component_kind in ('base', 'determination')
      ) then return jsonb_build_object('outcome', 'state_conflict'); end if;
    else
      if p_component_kind <> 'replacement' or p_replaces_component_public_id is null then raise exception using message = 'PAYOUT_INPUT_INVALID'; end if;
      select * into v_replaced from public.cycle_prize_pool_components
      where public_id = p_replaces_component_public_id and cycle_id = p_cycle_id;
      if not found or exists (
        select 1 from public.payout_plans plan
        join public.cycle_prize_allocations allocation on allocation.id = plan.allocation_id
        where allocation.component_id = v_replaced.id
      ) then return jsonb_build_object('outcome', 'state_conflict'); end if;
    end if;
    insert into public.cycle_prize_pool_components(
      cycle_id, component_version, component_kind, amount_lamports, replaces_component_id,
      actor_discord_user_id, reason
    ) values (
      p_cycle_id,
      coalesce((select max(component_version) + 1 from public.cycle_prize_pool_components where cycle_id = p_cycle_id), 1),
      p_component_kind, p_amount_lamports, v_replaced.id, p_actor_discord_user_id, btrim(p_reason)
    ) returning * into v_component;
    perform public.allocate_cycle_prize_component(v_component.id);
    update public.cycle_prize_pools set state = 'locked', row_version = row_version + 1, updated_at = transaction_timestamp()
    where cycle_id = p_cycle_id returning * into v_pool;
    insert into public.payout_events(event_type, actor_discord_user_id, target_type, target_public_id, target_version, request_id, reason, details)
    values ('pool_component_added', p_actor_discord_user_id, 'component', v_component.public_id,
      v_component.component_version, p_request_id, btrim(p_reason),
      jsonb_build_object('kind', v_component.component_kind, 'amountLamports', v_component.amount_lamports::text));
  end if;
  v_response := jsonb_build_object('outcome', 'ok', 'cycleId', p_cycle_id, 'rowVersion', v_pool.row_version,
    'state', v_pool.state, 'announcedLamports', v_pool.announced_lamports::text,
    'componentPublicId', v_component.public_id, 'replayed', false);
  insert into public.payout_mutation_requests values (p_actor_discord_user_id, p_request_id, 'manage_pool', v_hash, v_response, transaction_timestamp());
  return v_response;
end;
$function$;

alter function public.finalize_cycle(bigint, text) rename to finalize_cycle_without_prize_pool;

create function public.finalize_cycle(p_cycle_id bigint, p_actor_discord_user_id text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $function$
declare
  v_result jsonb;
  v_pool public.cycle_prize_pools%rowtype;
  v_component public.cycle_prize_pool_components%rowtype;
  v_finalized_at timestamptz;
  v_allocations integer := 0;
begin
  v_result := public.finalize_cycle_without_prize_pool(p_cycle_id, p_actor_discord_user_id);
  select finalized_at into v_finalized_at from public.voting_cycles where id = p_cycle_id for update;
  if v_finalized_at is null then raise exception using message = 'PAYOUT_FINALIZATION_TIME_MISSING'; end if;
  select * into v_pool from public.cycle_prize_pools where cycle_id = p_cycle_id for update;
  if not found then
    insert into public.cycle_prize_pools(cycle_id, state, finalized_at)
    values (p_cycle_id, 'amount_pending', v_finalized_at) returning * into v_pool;
    insert into public.payout_events(event_type, actor_discord_user_id, target_type, target_public_id, target_version, details)
    values ('pool_amount_pending', p_actor_discord_user_id, 'pool', v_pool.public_id, v_pool.row_version, jsonb_build_object('cycleId', p_cycle_id));
  elsif v_pool.state = 'running' then
    update public.cycle_prize_pools set
      state = case when announced_lamports is not null or exists (
        select 1 from public.cycle_prize_pool_components component where component.cycle_id = p_cycle_id
      ) then 'locked' else 'amount_pending' end,
      finalized_at = v_finalized_at, row_version = row_version + 1, updated_at = v_finalized_at
    where cycle_id = p_cycle_id returning * into v_pool;
    if v_pool.announced_lamports is not null and not exists (
      select 1 from public.cycle_prize_pool_components where cycle_id = p_cycle_id and component_kind = 'base'
    ) then
      insert into public.cycle_prize_pool_components(
        cycle_id, component_version, component_kind, amount_lamports, actor_discord_user_id, locked_at
      ) values (p_cycle_id, 1, 'base', v_pool.announced_lamports, p_actor_discord_user_id, v_finalized_at)
      returning * into v_component;
      insert into public.payout_events(event_type, actor_discord_user_id, target_type, target_public_id, target_version, details)
      values ('pool_locked', p_actor_discord_user_id, 'component', v_component.public_id, 1,
        jsonb_build_object('amountLamports', v_component.amount_lamports::text, 'cycleId', p_cycle_id));
    elsif v_pool.state = 'amount_pending' then
      insert into public.payout_events(event_type, actor_discord_user_id, target_type, target_public_id, target_version, details)
      values ('pool_amount_pending', p_actor_discord_user_id, 'pool', v_pool.public_id, v_pool.row_version, jsonb_build_object('cycleId', p_cycle_id));
    end if;
  end if;
  for v_component in select * from public.cycle_prize_pool_components where cycle_id = p_cycle_id order by component_version loop
    v_allocations := v_allocations + public.allocate_cycle_prize_component(v_component.id);
  end loop;
  return v_result || jsonb_build_object('prizePoolState', v_pool.state,
    'prizePoolLamports', v_pool.announced_lamports::text, 'prizeAllocationCount', v_allocations);
end;
$function$;

insert into public.cycle_prize_pools(cycle_id, state, finalized_at, created_at, updated_at)
select cycle.id, 'amount_pending', cycle.finalized_at, cycle.finalized_at, cycle.finalized_at
from public.voting_cycles cycle
where cycle.status = 'finished' and cycle.finalized_at is not null
on conflict (cycle_id) do nothing;

create function public.prepare_payout_plan(
  p_actor_discord_user_id text,
  p_request_id uuid,
  p_allocation_public_id uuid,
  p_expected_claim_version bigint
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $function$
declare
  v_role text;
  v_allocation public.cycle_prize_allocations%rowtype;
  v_claim public.winner_claims%rowtype;
  v_plan public.payout_plans%rowtype;
  v_hash text;
  v_request public.payout_mutation_requests%rowtype;
  v_response jsonb;
begin
  v_role := public.assert_winners_payout_capability(p_actor_discord_user_id, 'winners.manage_payouts');
  if p_request_id is null or p_allocation_public_id is null or p_expected_claim_version <= 0 then
    raise exception using message = 'PAYOUT_INPUT_INVALID';
  end if;
  v_hash := public.payout_request_hash(jsonb_build_object('allocation', p_allocation_public_id, 'claimVersion', p_expected_claim_version));
  select * into v_request from public.payout_mutation_requests
  where actor_discord_user_id = p_actor_discord_user_id and request_id = p_request_id and action = 'prepare_plan';
  if found then
    if v_request.request_hash <> v_hash then raise exception using message = 'PAYOUT_REQUEST_REUSED'; end if;
    return v_request.response || jsonb_build_object('replayed', true);
  end if;
  select * into v_allocation from public.cycle_prize_allocations where public_id = p_allocation_public_id for update;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  if exists (
    select 1 from public.cycle_prize_pool_components replacement
    where replacement.replaces_component_id = v_allocation.component_id
  ) then return jsonb_build_object('outcome', 'component_replaced'); end if;
  select * into v_claim from public.winner_claims where id = v_allocation.claim_id for update;
  if not found or v_claim.version <> p_expected_claim_version then return jsonb_build_object('outcome', 'claim_stale'); end if;
  if (v_allocation.payout_choice = 'donate' and v_claim.status <> 'not_required')
    or (v_allocation.payout_choice in ('keep', 'split') and (v_claim.status <> 'confirmed' or not public.is_valid_sol_recipient_address(v_claim.confirmed_recipient)))
  then return jsonb_build_object('outcome', 'claim_not_ready'); end if;
  select * into v_plan from public.payout_plans
  where allocation_id = v_allocation.id and state not in ('aborted', 'replaced') for update;
  if found then
    v_response := jsonb_build_object('outcome', 'prepared', 'planPublicId', v_plan.public_id, 'rowVersion', v_plan.row_version, 'replayed', true);
  else
    insert into public.payout_plans(allocation_id, created_by)
    values (v_allocation.id, p_actor_discord_user_id) returning * into v_plan;
    if v_allocation.winner_lamports > 0 then
      insert into public.payout_lines(
        plan_id, line_kind, amount_lamports, winner_claim_id, winner_recipient
      ) values (v_plan.id, 'winner', v_allocation.winner_lamports, v_claim.id, v_claim.confirmed_recipient);
    end if;
    if v_allocation.donation_lamports > 0 then
      insert into public.payout_lines(
        plan_id, line_kind, amount_lamports,
        organization_source_type, organization_revision_id, organization_effective_version,
        organization_effective_state, organization_name, organization_website_url
      ) values (
        v_plan.id, 'donation', v_allocation.donation_lamports,
        v_allocation.organization_source_type, v_allocation.organization_revision_id,
        v_allocation.organization_effective_version, v_allocation.organization_effective_state,
        v_allocation.organization_name, v_allocation.organization_website_url
      );
    end if;
    insert into public.payout_events(event_type, actor_discord_user_id, target_type, target_public_id, target_version, request_id, details)
    values ('plan_prepared', p_actor_discord_user_id, 'plan', v_plan.public_id, v_plan.row_version, p_request_id,
      jsonb_build_object('allocationPublicId', v_allocation.public_id, 'grossLamports', v_allocation.gross_lamports::text));
    v_response := jsonb_build_object('outcome', 'prepared', 'planPublicId', v_plan.public_id, 'rowVersion', v_plan.row_version, 'replayed', false);
  end if;
  insert into public.payout_mutation_requests values (p_actor_discord_user_id, p_request_id, 'prepare_plan', v_hash, v_response, transaction_timestamp());
  return v_response;
end;
$function$;

create function public.manage_payout_plan(
  p_actor_discord_user_id text,
  p_request_id uuid,
  p_plan_public_id uuid,
  p_expected_plan_version bigint,
  p_operation text,
  p_payload jsonb
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $function$
declare
  v_role text;
  v_plan public.payout_plans%rowtype;
  v_new_plan public.payout_plans%rowtype;
  v_line public.payout_lines%rowtype;
  v_poll public.community_polls%rowtype;
  v_link public.payout_poll_links%rowtype;
  v_option public.community_poll_options%rowtype;
  v_mapping jsonb;
  v_hash text;
  v_request public.payout_mutation_requests%rowtype;
  v_response jsonb;
  v_reason text := nullif(btrim(coalesce(p_payload ->> 'reason', '')), '');
  v_recipient text := btrim(coalesce(p_payload ->> 'recipient', ''));
  v_line_public_id uuid;
  v_poll_public_id uuid;
  v_target_cycle_id bigint;
  v_component public.cycle_prize_pool_components%rowtype;
  v_target_pool public.cycle_prize_pools%rowtype;
  v_target_cycle public.voting_cycles%rowtype;
  v_organization public.donation_organizations%rowtype;
  v_revision public.donation_organization_revisions%rowtype;
  v_return_claim public.payout_return_claims%rowtype;
  v_line_found boolean;
  v_follow_up_poll_id uuid;
begin
  v_role := public.assert_winners_payout_capability(p_actor_discord_user_id, 'winners.manage_payouts');
  if p_request_id is null or p_plan_public_id is null or p_expected_plan_version <= 0
    or p_operation not in ('set_donation_recipient', 'lock', 'publish', 'abort', 'replace', 'mark_unavailable', 'link_poll', 'apply_poll_outcome')
    or jsonb_typeof(coalesce(p_payload, '{}'::jsonb)) <> 'object'
  then raise exception using message = 'PAYOUT_INPUT_INVALID'; end if;
  v_hash := public.payout_request_hash(jsonb_build_object('plan', p_plan_public_id, 'expectedVersion', p_expected_plan_version, 'operation', p_operation, 'payload', p_payload));
  select * into v_request from public.payout_mutation_requests
  where actor_discord_user_id = p_actor_discord_user_id and request_id = p_request_id and action = 'manage_plan';
  if found then
    if v_request.request_hash <> v_hash then raise exception using message = 'PAYOUT_REQUEST_REUSED'; end if;
    return v_request.response || jsonb_build_object('replayed', true);
  end if;
  select * into v_plan from public.payout_plans where public_id = p_plan_public_id for update;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  if v_plan.row_version <> p_expected_plan_version then return jsonb_build_object('outcome', 'stale'); end if;

  if p_operation = 'set_donation_recipient' then
    if v_plan.state <> 'draft' or not public.is_valid_sol_recipient_address(v_recipient) then return jsonb_build_object('outcome', 'state_conflict'); end if;
    v_line_public_id := (p_payload ->> 'linePublicId')::uuid;
    select * into v_line from public.payout_lines where public_id = v_line_public_id and plan_id = v_plan.id and line_kind = 'donation' for update;
    if not found or v_line.state <> 'prepared' then return jsonb_build_object('outcome', 'state_conflict'); end if;
    update public.payout_lines set donation_operation_recipient = v_recipient, row_version = row_version + 1, updated_at = transaction_timestamp()
    where id = v_line.id returning * into v_line;
    insert into public.payout_events(event_type, actor_discord_user_id, target_type, target_public_id, target_version, request_id)
    values ('donation_recipient_set', p_actor_discord_user_id, 'line', v_line.public_id, v_line.row_version, p_request_id);
  elsif p_operation = 'lock' then
    if v_plan.state <> 'draft' or exists (
      select 1 from public.payout_lines line where line.plan_id = v_plan.id and line.state = 'prepared'
        and ((line.line_kind = 'winner' and not public.is_valid_sol_recipient_address(line.winner_recipient))
          or (line.line_kind = 'donation' and not public.is_valid_sol_recipient_address(line.donation_operation_recipient)))
    ) then return jsonb_build_object('outcome', 'state_conflict'); end if;
    update public.payout_lines set state = 'locked', row_version = row_version + 1, updated_at = transaction_timestamp()
    where plan_id = v_plan.id and state = 'prepared';
    update public.payout_plans set state = 'locked', row_version = row_version + 1, locked_at = transaction_timestamp()
    where id = v_plan.id returning * into v_plan;
    insert into public.payout_events(event_type, actor_discord_user_id, target_type, target_public_id, target_version, request_id)
    values ('plan_locked', p_actor_discord_user_id, 'plan', v_plan.public_id, v_plan.row_version, p_request_id);
  elsif p_operation = 'publish' then
    if v_plan.state <> 'locked' or exists (
      select 1 from public.payout_lines line
      where line.plan_id = v_plan.id
        and line.state not in ('verified', 'rolled_over', 'redirected', 'replaced')
        and not (
          line.state = 'return_claim' and (
            exists (select 1 from public.payout_return_claims claim where claim.source_payout_line_id = line.id and claim.status in ('declined', 'expired'))
            or exists (select 1 from public.payout_lines replacement where replacement.replacement_for_line_id = line.id and replacement.state = 'verified')
          )
        )
    ) then return jsonb_build_object('outcome', 'state_conflict'); end if;
    update public.payout_plans set state = 'published', row_version = row_version + 1, published_at = transaction_timestamp()
    where id = v_plan.id returning * into v_plan;
    insert into public.payout_events(event_type, actor_discord_user_id, target_type, target_public_id, target_version, request_id)
    values ('plan_published', p_actor_discord_user_id, 'plan', v_plan.public_id, v_plan.row_version, p_request_id);
  elsif p_operation = 'abort' then
    if v_plan.state not in ('draft', 'locked') or v_reason is null then return jsonb_build_object('outcome', 'state_conflict'); end if;
    update public.payout_plans set state = 'aborted', row_version = row_version + 1, closed_at = transaction_timestamp()
    where id = v_plan.id returning * into v_plan;
    insert into public.payout_events(event_type, actor_discord_user_id, target_type, target_public_id, target_version, request_id, reason)
    values ('plan_aborted', p_actor_discord_user_id, 'plan', v_plan.public_id, v_plan.row_version, p_request_id, v_reason);
  elsif p_operation = 'replace' then
    if v_plan.state not in ('draft', 'locked', 'published') or v_reason is null or exists (
      select 1 from public.payout_lines line join public.payout_transactions transaction on transaction.payout_line_id = line.id
      where line.plan_id = v_plan.id
    ) then return jsonb_build_object('outcome', 'state_conflict'); end if;
    update public.payout_plans set state = 'replaced', row_version = row_version + 1, closed_at = transaction_timestamp()
    where id = v_plan.id returning * into v_plan;
    insert into public.payout_plans(allocation_id, plan_version, replacement_for_plan_id, created_by)
    values (v_plan.allocation_id, v_plan.plan_version + 1, v_plan.id, p_actor_discord_user_id) returning * into v_new_plan;
    insert into public.payout_lines(
      plan_id, line_kind, amount_lamports, winner_claim_id, winner_recipient,
      organization_source_type, organization_revision_id, organization_effective_version,
      organization_effective_state, organization_name, organization_website_url,
      donation_operation_recipient, replacement_for_line_id
    )
    select v_new_plan.id, line.line_kind, line.amount_lamports, line.winner_claim_id, line.winner_recipient,
      line.organization_source_type, line.organization_revision_id, line.organization_effective_version,
      line.organization_effective_state, line.organization_name, line.organization_website_url,
      line.donation_operation_recipient, line.id
    from public.payout_lines line where line.plan_id = v_plan.id and line.replacement_for_line_id is null;
    update public.payout_lines set state = 'replaced', row_version = row_version + 1, updated_at = transaction_timestamp()
    where plan_id = v_plan.id and state <> 'replaced';
    insert into public.payout_events(event_type, actor_discord_user_id, target_type, target_public_id, target_version, request_id, reason, details)
    values ('plan_replaced', p_actor_discord_user_id, 'plan', v_plan.public_id, v_plan.row_version, p_request_id, v_reason,
      jsonb_build_object('replacementPlanPublicId', v_new_plan.public_id));
    v_plan := v_new_plan;
  elsif p_operation = 'mark_unavailable' then
    if v_reason is null then raise exception using message = 'PAYOUT_REASON_REQUIRED'; end if;
    v_line_public_id := (p_payload ->> 'linePublicId')::uuid;
    select * into v_line from public.payout_lines where public_id = v_line_public_id and plan_id = v_plan.id and line_kind = 'donation' for update;
    if not found or v_line.state not in ('prepared', 'locked') then return jsonb_build_object('outcome', 'state_conflict'); end if;
    update public.payout_lines set state = 'unavailable', unavailable_reason = v_reason, row_version = row_version + 1, updated_at = transaction_timestamp()
    where id = v_line.id returning * into v_line;
    insert into public.payout_events(event_type, actor_discord_user_id, target_type, target_public_id, target_version, request_id, reason)
    values ('donation_unavailable', p_actor_discord_user_id, 'line', v_line.public_id, v_line.row_version, p_request_id, v_reason);
  elsif p_operation = 'link_poll' then
    v_line_public_id := (p_payload ->> 'linePublicId')::uuid;
    v_poll_public_id := (p_payload ->> 'pollPublicId')::uuid;
    select * into v_line from public.payout_lines where public_id = v_line_public_id and plan_id = v_plan.id and line_kind = 'donation' for update;
    v_line_found := found;
    select * into v_poll from public.community_polls where public_id = v_poll_public_id for share;
    if not v_line_found or not found or v_line.state <> 'unavailable' or v_poll.status not in ('active', 'closed')
      or jsonb_typeof(p_payload -> 'optionMappings') <> 'array' or jsonb_array_length(p_payload -> 'optionMappings') < 1
    then return jsonb_build_object('outcome', 'state_conflict'); end if;
    if exists (select 1 from public.payout_poll_links link where link.payout_line_id = v_line.id and link.applied_at is null)
      or exists (
        select 1 from public.payout_poll_links previous
        where previous.payout_line_id = v_line.id and previous.follow_up_poll_id is not null
          and previous.follow_up_poll_id <> v_poll.id
          and previous.applied_at = (select max(applied_at) from public.payout_poll_links where payout_line_id = v_line.id)
      )
    then return jsonb_build_object('outcome', 'state_conflict'); end if;
    if exists (
      select 1 from jsonb_array_elements(p_payload -> 'optionMappings') mapping
      where mapping ->> 'disposition' not in ('rollover', 'alternative_organization', 'return_to_winner', 'follow_up_poll')
        or not exists (select 1 from public.community_poll_options option where option.poll_id = v_poll.id and option.public_id = (mapping ->> 'optionPublicId')::uuid)
    ) then raise exception using message = 'PAYOUT_POLL_MAPPING_INVALID'; end if;
    insert into public.payout_poll_links(payout_line_id, poll_id, poll_version, option_mappings, linked_by)
    values (v_line.id, v_poll.id, v_poll.row_version, p_payload -> 'optionMappings', p_actor_discord_user_id)
    returning * into v_link;
    update public.payout_lines set state = 'community_pending', row_version = row_version + 1, updated_at = transaction_timestamp()
    where id = v_line.id returning * into v_line;
    insert into public.payout_events(event_type, actor_discord_user_id, target_type, target_public_id, target_version, request_id, details)
    values ('poll_linked', p_actor_discord_user_id, 'line', v_line.public_id, v_line.row_version, p_request_id,
      jsonb_build_object('pollPublicId', v_poll.public_id, 'pollVersion', v_poll.row_version));
  else
    v_line_public_id := (p_payload ->> 'linePublicId')::uuid;
    select * into v_line from public.payout_lines where public_id = v_line_public_id and plan_id = v_plan.id and line_kind = 'donation' for update;
    v_line_found := found;
    if not v_line_found or v_line.state <> 'community_pending' then return jsonb_build_object('outcome', 'state_conflict'); end if;
    select * into v_link from public.payout_poll_links
    where payout_line_id = v_line.id and applied_at is null order by linked_at desc limit 1 for update;
    if not found or v_link.applied_at is not null then return jsonb_build_object('outcome', 'state_conflict'); end if;
    select * into v_poll from public.community_polls where id = v_link.poll_id for share;
    if not found or v_poll.status <> 'closed' or v_poll.outcome <> 'winner'
      or nullif(p_payload ->> 'expectedPollVersion', '') is null
      or v_poll.row_version <> (p_payload ->> 'expectedPollVersion')::bigint
      or v_poll.row_version < v_link.poll_version
    then
      return jsonb_build_object('outcome', 'poll_not_ready');
    end if;
    select * into v_option from public.community_poll_options where id = v_poll.winning_option_id and poll_id = v_poll.id;
    select mapping into v_mapping from jsonb_array_elements(v_link.option_mappings) mapping
    where (mapping ->> 'optionPublicId')::uuid = v_option.public_id;
    if v_mapping is null then raise exception using message = 'PAYOUT_POLL_MAPPING_INVALID'; end if;
    if v_mapping ->> 'disposition' = 'rollover' then
      v_target_cycle_id := (v_mapping ->> 'targetCycleId')::bigint;
      select * into v_target_cycle from public.voting_cycles where id = v_target_cycle_id and id > (
        select allocation.cycle_id from public.payout_plans plan join public.cycle_prize_allocations allocation on allocation.id = plan.allocation_id where plan.id = v_plan.id
      ) for update;
      if not found then raise exception using message = 'PAYOUT_ROLLOVER_TARGET_INVALID'; end if;
      select * into v_target_pool from public.cycle_prize_pools where cycle_id = v_target_cycle_id for update;
      if not found then
        insert into public.cycle_prize_pools(cycle_id, state, finalized_at)
        values (v_target_cycle_id, case when v_target_cycle.status = 'finished' then 'locked' else 'running' end,
          case when v_target_cycle.status = 'finished' then v_target_cycle.finalized_at end) returning * into v_target_pool;
      end if;
      insert into public.cycle_prize_pool_components(cycle_id, component_version, component_kind, amount_lamports, source_payout_line_id, actor_discord_user_id, reason)
      values (v_target_cycle_id, coalesce((select max(component_version) + 1 from public.cycle_prize_pool_components where cycle_id = v_target_cycle_id), 1),
        'rollover', v_line.amount_lamports, v_line.id, p_actor_discord_user_id, 'Binding Community Vote outcome') returning * into v_component;
      perform public.allocate_cycle_prize_component(v_component.id);
      update public.cycle_prize_pools set state = case when v_target_cycle.status = 'finished' then 'locked' else state end,
        row_version = row_version + 1, updated_at = transaction_timestamp() where cycle_id = v_target_cycle_id;
      update public.payout_lines set state = 'rolled_over', row_version = row_version + 1, updated_at = transaction_timestamp() where id = v_line.id returning * into v_line;
      insert into public.payout_events(event_type, actor_discord_user_id, target_type, target_public_id, target_version, request_id, details)
      values ('rollover_created', p_actor_discord_user_id, 'component', v_component.public_id, v_component.component_version, p_request_id,
        jsonb_build_object('sourceLinePublicId', v_line.public_id, 'targetCycleId', v_target_cycle_id, 'amountLamports', v_line.amount_lamports::text));
    elsif v_mapping ->> 'disposition' = 'alternative_organization' then
      select * into v_organization from public.donation_organizations
      where public_key = (v_mapping ->> 'organizationPublicKey') and state = 'active';
      if not found then raise exception using message = 'PAYOUT_ORGANIZATION_INVALID'; end if;
      select * into v_revision from public.donation_organization_revisions where id = v_organization.published_revision_id and provider_status = 'available';
      if not found then raise exception using message = 'PAYOUT_ORGANIZATION_INVALID'; end if;
      insert into public.payout_lines(plan_id, line_kind, amount_lamports, organization_source_type, organization_revision_id,
        organization_effective_version, organization_effective_state, organization_name, organization_website_url, replacement_for_line_id)
      values (v_plan.id, 'donation', v_line.amount_lamports, 'catalog', v_revision.id, v_revision.revision_number,
        'verified', v_revision.display_name, v_revision.official_website_url, v_line.id);
      update public.payout_lines set state = 'redirected', row_version = row_version + 1, updated_at = transaction_timestamp() where id = v_line.id returning * into v_line;
      insert into public.payout_events(event_type, actor_discord_user_id, target_type, target_public_id, target_version, request_id, details)
      values ('organization_redirected', p_actor_discord_user_id, 'line', v_line.public_id, v_line.row_version, p_request_id,
        jsonb_build_object('organizationPublicKey', v_organization.public_key, 'organizationName', v_revision.display_name));
    elsif v_mapping ->> 'disposition' = 'return_to_winner' then
      insert into public.payout_return_claims(source_payout_line_id, cycle_id, submission_id, winner_discord_user_id, amount_lamports, deadline_at)
      select v_line.id, allocation.cycle_id, allocation.submission_id, allocation.winner_discord_user_id, v_line.amount_lamports,
        transaction_timestamp() + interval '24 hours'
      from public.payout_plans plan join public.cycle_prize_allocations allocation on allocation.id = plan.allocation_id
      where plan.id = v_plan.id returning * into v_return_claim;
      update public.payout_lines set state = 'return_claim', row_version = row_version + 1, updated_at = transaction_timestamp() where id = v_line.id returning * into v_line;
      insert into public.payout_events(event_type, actor_discord_user_id, target_type, target_public_id, target_version, request_id, details)
      values ('return_claim_created', p_actor_discord_user_id, 'return_claim', v_return_claim.public_id, v_return_claim.row_version, p_request_id,
        jsonb_build_object('amountLamports', v_return_claim.amount_lamports::text, 'deadlineAt', v_return_claim.deadline_at));
    else
      if nullif(v_mapping ->> 'followUpPollPublicId', '') is null or not exists (
        select 1 from public.community_polls where public_id = (v_mapping ->> 'followUpPollPublicId')::uuid
      ) then raise exception using message = 'PAYOUT_FOLLOW_UP_INVALID'; end if;
      select id into v_follow_up_poll_id from public.community_polls where public_id = (v_mapping ->> 'followUpPollPublicId')::uuid;
      update public.payout_lines set state = 'unavailable', row_version = row_version + 1, updated_at = transaction_timestamp()
      where id = v_line.id returning * into v_line;
      insert into public.payout_events(event_type, actor_discord_user_id, target_type, target_public_id, target_version, request_id, details)
      values ('follow_up_linked', p_actor_discord_user_id, 'line', v_line.public_id, v_line.row_version, p_request_id,
        jsonb_build_object('followUpPollPublicId', v_mapping ->> 'followUpPollPublicId'));
    end if;
    update public.payout_poll_links set applied_option_id = v_option.id, follow_up_poll_id = v_follow_up_poll_id,
      applied_at = transaction_timestamp(), applied_by = p_actor_discord_user_id where id = v_link.id;
    insert into public.payout_events(event_type, actor_discord_user_id, target_type, target_public_id, target_version, request_id, details)
    values ('poll_outcome_applied', p_actor_discord_user_id, 'line', v_line.public_id, v_line.row_version, p_request_id,
      jsonb_build_object('pollPublicId', v_poll.public_id, 'optionPublicId', v_option.public_id, 'disposition', v_mapping ->> 'disposition'));
  end if;
  if p_operation in ('set_donation_recipient', 'mark_unavailable', 'link_poll', 'apply_poll_outcome') then
    update public.payout_plans set row_version = row_version + 1
    where id = v_plan.id returning * into v_plan;
  end if;
  v_response := jsonb_build_object('outcome', 'ok', 'planPublicId', v_plan.public_id, 'rowVersion', v_plan.row_version,
    'state', v_plan.state, 'replacementPlanPublicId', v_new_plan.public_id, 'replayed', false);
  insert into public.payout_mutation_requests values (p_actor_discord_user_id, p_request_id, 'manage_plan', v_hash, v_response, transaction_timestamp());
  return v_response;
end;
$function$;

create function public.record_payout_transaction(
  p_actor_discord_user_id text,
  p_request_id uuid,
  p_line_public_id uuid,
  p_expected_line_version bigint,
  p_signature text,
  p_evidence_level text,
  p_provider_reference text,
  p_verification_slot bigint,
  p_verified_mainnet boolean,
  p_verified_success boolean,
  p_verified_recipient text,
  p_verified_lamports bigint,
  p_replaces_transaction_public_id uuid
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $function$
declare
  v_role text;
  v_line public.payout_lines%rowtype;
  v_plan public.payout_plans%rowtype;
  v_transaction public.payout_transactions%rowtype;
  v_replaced public.payout_transactions%rowtype;
  v_signature text := btrim(coalesce(p_signature, ''));
  v_recipient text;
  v_hash text;
  v_request public.payout_mutation_requests%rowtype;
  v_response jsonb;
  v_version bigint;
begin
  v_role := public.assert_winners_payout_capability(p_actor_discord_user_id, 'winners.manage_payouts');
  v_hash := public.payout_request_hash(jsonb_build_object(
    'line', p_line_public_id, 'expectedVersion', p_expected_line_version, 'signature', v_signature,
    'evidenceLevel', p_evidence_level, 'providerReference', nullif(btrim(coalesce(p_provider_reference, '')), ''),
    'verificationSlot', p_verification_slot, 'mainnet', p_verified_mainnet, 'success', p_verified_success,
    'recipient', p_verified_recipient, 'lamports', p_verified_lamports, 'replaces', p_replaces_transaction_public_id
  ));
  select * into v_request from public.payout_mutation_requests
  where actor_discord_user_id = p_actor_discord_user_id and request_id = p_request_id and action = 'record_transaction';
  if found then
    if v_request.request_hash <> v_hash then raise exception using message = 'PAYOUT_REQUEST_REUSED'; end if;
    return v_request.response || jsonb_build_object('replayed', true);
  end if;
  select * into v_line from public.payout_lines where public_id = p_line_public_id for update;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  select * into v_plan from public.payout_plans where id = v_line.plan_id for update;
  if v_line.row_version <> p_expected_line_version or v_line.state not in ('locked', 'verified')
    or v_plan.state not in ('locked', 'published') or v_signature !~ '^[1-9A-HJ-NP-Za-km-z]{80,100}$'
    or p_evidence_level not in ('on_chain_verified', 'operator_confirmed_provider')
  then return jsonb_build_object('outcome', 'state_conflict'); end if;
  v_recipient := case when v_line.line_kind = 'winner' then v_line.winner_recipient else v_line.donation_operation_recipient end;
  if not public.is_valid_sol_recipient_address(v_recipient) then return jsonb_build_object('outcome', 'recipient_invalid'); end if;
  if p_evidence_level = 'on_chain_verified' and (
    p_verified_mainnet is distinct from true or p_verified_success is distinct from true
    or p_verified_recipient is distinct from v_recipient or p_verified_lamports is distinct from v_line.amount_lamports
    or p_verification_slot is null or p_verification_slot <= 0
  ) then return jsonb_build_object('outcome', 'verification_mismatch'); end if;
  if p_evidence_level = 'operator_confirmed_provider' and (
    v_line.line_kind <> 'donation' or nullif(btrim(coalesce(p_provider_reference, '')), '') is null
  ) then return jsonb_build_object('outcome', 'provider_confirmation_invalid'); end if;
  if p_replaces_transaction_public_id is not null then
    select * into v_replaced from public.payout_transactions
    where public_id = p_replaces_transaction_public_id and payout_line_id = v_line.id;
    if not found then return jsonb_build_object('outcome', 'replacement_invalid'); end if;
  end if;
  v_version := coalesce((select max(transaction_version) + 1 from public.payout_transactions where payout_line_id = v_line.id), 1);
  insert into public.payout_transactions(
    payout_line_id, transaction_version, signature, canonical_explorer_url, evidence_level,
    expected_recipient, expected_lamports, provider_reference, verification_slot,
    replaces_transaction_id, recorded_by
  ) values (
    v_line.id, v_version, v_signature,
    'https://explorer.solana.com/tx/' || v_signature || '?cluster=mainnet-beta',
    p_evidence_level, v_recipient, v_line.amount_lamports,
    nullif(btrim(coalesce(p_provider_reference, '')), ''),
    case when p_evidence_level = 'on_chain_verified' then p_verification_slot end,
    v_replaced.id, p_actor_discord_user_id
  ) returning * into v_transaction;
  update public.payout_lines set current_transaction_id = v_transaction.id, state = 'verified',
    row_version = row_version + 1, updated_at = transaction_timestamp()
  where id = v_line.id returning * into v_line;
  insert into public.payout_events(event_type, actor_discord_user_id, target_type, target_public_id, target_version, request_id, details)
  values ('transaction_issued', p_actor_discord_user_id, 'transaction', v_transaction.public_id, v_transaction.transaction_version, p_request_id,
    jsonb_build_object('linePublicId', v_line.public_id, 'signature', v_transaction.signature));
  insert into public.payout_events(event_type, actor_discord_user_id, target_type, target_public_id, target_version, request_id, details)
  values ('transaction_verified', p_actor_discord_user_id, 'transaction', v_transaction.public_id, v_transaction.transaction_version, p_request_id,
    jsonb_build_object('evidenceLevel', v_transaction.evidence_level, 'canonicalExplorerUrl', v_transaction.canonical_explorer_url));
  v_response := jsonb_build_object('outcome', 'verified', 'transactionPublicId', v_transaction.public_id,
    'linePublicId', v_line.public_id, 'lineVersion', v_line.row_version,
    'evidenceLevel', v_transaction.evidence_level, 'canonicalExplorerUrl', v_transaction.canonical_explorer_url, 'replayed', false);
  insert into public.payout_mutation_requests values (p_actor_discord_user_id, p_request_id, 'record_transaction', v_hash, v_response, transaction_timestamp());
  return v_response;
exception when unique_violation then
  raise exception using errcode = '23505', message = 'PAYOUT_SIGNATURE_ALREADY_USED';
end;
$function$;

create function public.attach_payout_private_evidence(
  p_actor_discord_user_id text,
  p_request_id uuid,
  p_transaction_public_id uuid,
  p_r2_key text,
  p_byte_size integer,
  p_width integer,
  p_height integer
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $function$
declare
  v_role text;
  v_transaction public.payout_transactions%rowtype;
  v_evidence public.payout_private_evidence%rowtype;
  v_hash text;
  v_request public.payout_mutation_requests%rowtype;
  v_response jsonb;
begin
  v_role := public.assert_winners_payout_capability(p_actor_discord_user_id, 'winners.manage_payouts');
  v_hash := public.payout_request_hash(jsonb_build_object('transaction', p_transaction_public_id, 'r2Key', p_r2_key,
    'bytes', p_byte_size, 'width', p_width, 'height', p_height));
  select * into v_request from public.payout_mutation_requests
  where actor_discord_user_id = p_actor_discord_user_id and request_id = p_request_id and action = 'attach_evidence';
  if found then
    if v_request.request_hash <> v_hash then raise exception using message = 'PAYOUT_REQUEST_REUSED'; end if;
    return v_request.response || jsonb_build_object('replayed', true);
  end if;
  select * into v_transaction from public.payout_transactions where public_id = p_transaction_public_id;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  insert into public.payout_private_evidence(payout_transaction_id, r2_key, byte_size, width, height, uploaded_by)
  values (v_transaction.id, p_r2_key, p_byte_size, p_width, p_height, p_actor_discord_user_id)
  returning * into v_evidence;
  insert into public.payout_events(event_type, actor_discord_user_id, target_type, target_public_id, target_version, request_id, details)
  values ('evidence_attached', p_actor_discord_user_id, 'transaction', v_transaction.public_id,
    v_transaction.transaction_version, p_request_id,
    jsonb_build_object('evidencePublicId', v_evidence.public_id, 'byteSize', v_evidence.byte_size,
      'width', v_evidence.width, 'height', v_evidence.height));
  v_response := jsonb_build_object('outcome', 'attached', 'evidencePublicId', v_evidence.public_id, 'replayed', false);
  insert into public.payout_mutation_requests values (p_actor_discord_user_id, p_request_id, 'attach_evidence', v_hash, v_response, transaction_timestamp());
  return v_response;
end;
$function$;

create function public.process_due_payout_return_claims(p_claim_public_id uuid default null)
returns integer language plpgsql security definer set search_path = public, pg_temp
as $function$
declare
  v_claim public.payout_return_claims%rowtype;
  v_count integer := 0;
begin
  for v_claim in select * from public.payout_return_claims
    where status = 'unclaimed' and deadline_at <= transaction_timestamp()
      and (p_claim_public_id is null or public_id = p_claim_public_id)
    order by deadline_at, id for update
  loop
    update public.payout_return_claims set status = 'expired', row_version = row_version + 1,
      deadline_at = null, expired_at = transaction_timestamp(), updated_at = transaction_timestamp()
    where id = v_claim.id returning * into v_claim;
    insert into public.payout_events(event_type, target_type, target_public_id, target_version, details)
    values ('return_claim_expired', 'return_claim', v_claim.public_id, v_claim.row_version,
      jsonb_build_object('amountLamports', v_claim.amount_lamports::text));
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$function$;

create function public.get_own_payout_return_claims(p_session_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $function$
declare
  v_user_id text;
  v_items jsonb;
begin
  v_user_id := public.require_account_session(p_session_id);
  perform public.process_due_payout_return_claims(null);
  select coalesce(jsonb_agg(jsonb_build_object(
    'claimPublicId', claim.public_id, 'rowVersion', claim.row_version,
    'cycleId', claim.cycle_id, 'cycleNumber', cycle.public_number,
    'submissionId', claim.submission_id, 'amountLamports', claim.amount_lamports::text,
    'status', claim.status, 'deadlineAt', claim.deadline_at, 'confirmedAt', claim.confirmed_at,
    'declinedAt', claim.declined_at, 'expiredAt', claim.expired_at
  ) order by claim.created_at desc), '[]'::jsonb) into v_items
  from public.payout_return_claims claim join public.voting_cycles cycle on cycle.id = claim.cycle_id
  where claim.winner_discord_user_id = v_user_id;
  return jsonb_build_object('outcome', 'ok', 'databaseTime', transaction_timestamp(), 'items', v_items);
end;
$function$;

create function public.mutate_own_payout_return_claim(
  p_session_id uuid,
  p_claim_public_id uuid,
  p_request_id uuid,
  p_expected_version bigint,
  p_action text,
  p_manual_recipient text
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $function$
declare
  v_user_id text;
  v_claim public.payout_return_claims%rowtype;
  v_request public.payout_return_claim_requests%rowtype;
  v_hash text;
  v_response jsonb;
  v_recipient text;
  v_source text;
begin
  v_user_id := public.require_account_session(p_session_id);
  if p_request_id is null or p_expected_version <= 0 or p_action not in ('confirm', 'decline') then
    raise exception using message = 'PAYOUT_RETURN_CLAIM_INPUT_INVALID';
  end if;
  perform public.process_due_payout_return_claims(p_claim_public_id);
  select * into v_claim from public.payout_return_claims where public_id = p_claim_public_id and winner_discord_user_id = v_user_id for update;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  v_hash := public.payout_request_hash(jsonb_build_object('claim', p_claim_public_id, 'version', p_expected_version,
    'action', p_action, 'manualRecipient', nullif(btrim(coalesce(p_manual_recipient, '')), '')));
  select * into v_request from public.payout_return_claim_requests where claim_id = v_claim.id and request_id = p_request_id;
  if found then
    if v_request.request_hash <> v_hash then raise exception using message = 'PAYOUT_RETURN_CLAIM_REQUEST_REUSED'; end if;
    return v_request.response || jsonb_build_object('replayed', true);
  end if;
  if v_claim.row_version <> p_expected_version or v_claim.status <> 'unclaimed' or v_claim.deadline_at <= transaction_timestamp() then
    return jsonb_build_object('outcome', 'state_conflict');
  end if;
  if p_action = 'confirm' then
    select wallet.wallet_address into v_recipient
    from public.account_sol_profile_wallets wallet
    where wallet.discord_user_id = v_user_id
      and public.is_valid_sol_recipient_address(wallet.wallet_address)
      and exists (select 1 from public.account_totp_factors factor where factor.discord_user_id = v_user_id);
    if found then v_source := 'profile'; else v_recipient := btrim(coalesce(p_manual_recipient, '')); v_source := 'manual_return'; end if;
    if not public.is_valid_sol_recipient_address(v_recipient) then return jsonb_build_object('outcome', 'recipient_invalid'); end if;
    update public.payout_return_claims set status = 'confirmed', row_version = row_version + 1,
      deadline_at = null, confirmed_recipient = v_recipient, confirmed_recipient_source = v_source,
      confirmed_at = transaction_timestamp(), updated_at = transaction_timestamp()
    where id = v_claim.id returning * into v_claim;
    insert into public.payout_lines(
      plan_id, line_kind, amount_lamports, state, winner_claim_id,
      winner_recipient, replacement_for_line_id
    )
    select source_line.plan_id, 'winner', v_claim.amount_lamports, 'locked', allocation.claim_id,
      v_recipient, source_line.id
    from public.payout_lines source_line
    join public.payout_plans plan on plan.id = source_line.plan_id
    join public.cycle_prize_allocations allocation on allocation.id = plan.allocation_id
    where source_line.id = v_claim.source_payout_line_id;
    update public.payout_plans set row_version = row_version + 1
    where id = (select plan_id from public.payout_lines where id = v_claim.source_payout_line_id);
    insert into public.payout_events(event_type, actor_discord_user_id, target_type, target_public_id, target_version, request_id, details)
    values ('return_claim_confirmed', v_user_id, 'return_claim', v_claim.public_id, v_claim.row_version, p_request_id,
      jsonb_build_object('recipientSource', v_source, 'amountLamports', v_claim.amount_lamports::text));
  else
    update public.payout_return_claims set status = 'declined', row_version = row_version + 1,
      deadline_at = null, declined_at = transaction_timestamp(), updated_at = transaction_timestamp()
    where id = v_claim.id returning * into v_claim;
    insert into public.payout_events(event_type, actor_discord_user_id, target_type, target_public_id, target_version, request_id, details)
    values ('return_claim_declined', v_user_id, 'return_claim', v_claim.public_id, v_claim.row_version, p_request_id,
      jsonb_build_object('amountLamports', v_claim.amount_lamports::text));
  end if;
  v_response := jsonb_build_object('outcome', v_claim.status, 'claimPublicId', v_claim.public_id,
    'rowVersion', v_claim.row_version, 'replayed', false);
  insert into public.payout_return_claim_requests values (v_claim.id, p_request_id, p_action, v_hash, v_response, transaction_timestamp());
  return v_response;
end;
$function$;

create function public.get_current_cycle_prize_pool()
returns jsonb language sql stable security definer set search_path = public, pg_temp
as $function$
  with current_cycle as (
    select cycle.id, cycle.public_number
    from public.voting_cycles cycle
    where cycle.status in ('submission_open', 'submission_closed', 'voting_open', 'voting_closed', 'paused', 'active', 'finalizing', 'completed')
    order by cycle.id desc limit 1
  ), total as (
    select pool.cycle_id, pool.announced_lamports,
      coalesce(sum(component.amount_lamports) filter (
        where component.component_kind = 'rollover'
          and not exists (select 1 from public.cycle_prize_pool_components replacement where replacement.replaces_component_id = component.id)
      ), 0)::bigint as rollover_lamports
    from public.cycle_prize_pools pool
    left join public.cycle_prize_pool_components component on component.cycle_id = pool.cycle_id
    group by pool.cycle_id, pool.announced_lamports
  )
  select case when current_cycle.id is null then null else jsonb_build_object(
    'cycleId', current_cycle.id,
    'cycleNumber', current_cycle.public_number,
    'totalLamports', case
      when total.announced_lamports is null and coalesce(total.rollover_lamports, 0) = 0 then null
      else (coalesce(total.announced_lamports, 0) + coalesce(total.rollover_lamports, 0))::text
    end
  ) end
  from current_cycle left join total on total.cycle_id = current_cycle.id;
$function$;

create function public.get_team_payout_context(p_actor_discord_user_id text, p_include_management boolean default false)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp
as $function$
declare
  v_role text;
  v_pools jsonb;
  v_allocations jsonb;
  v_plans jsonb;
begin
  v_role := public.assert_winners_payout_capability(p_actor_discord_user_id, 'winners.payouts.view');
  if p_include_management then perform public.assert_winners_payout_capability(p_actor_discord_user_id, 'winners.manage_payouts'); end if;
  perform public.process_due_payout_return_claims(null);
  select coalesce(jsonb_agg(jsonb_build_object(
    'cycleId', cycle.id, 'cycleNumber', cycle.public_number, 'cycleStatus', cycle.status,
    'rowVersion', coalesce(pool.row_version, 0), 'state', coalesce(pool.state, 'running'),
    'announcedLamports', pool.announced_lamports::text, 'finalizedAt', pool.finalized_at,
    'components', coalesce((select jsonb_agg(jsonb_build_object(
      'componentPublicId', component.public_id, 'version', component.component_version,
      'kind', component.component_kind, 'amountLamports', component.amount_lamports::text,
      'active', not exists (select 1 from public.cycle_prize_pool_components replacement where replacement.replaces_component_id = component.id),
      'replacesComponentPublicId', replaced.public_id, 'lockedAt', component.locked_at
    ) order by component.component_version)
    from public.cycle_prize_pool_components component
    left join public.cycle_prize_pool_components replaced on replaced.id = component.replaces_component_id
    where component.cycle_id = cycle.id), '[]'::jsonb)
  ) order by cycle.id desc), '[]'::jsonb) into v_pools
  from public.voting_cycles cycle left join public.cycle_prize_pools pool on pool.cycle_id = cycle.id
  where pool.cycle_id is not null or cycle.status <> 'finished';

  select coalesce(jsonb_agg(jsonb_build_object(
    'allocationPublicId', allocation.public_id, 'componentPublicId', component.public_id,
    'componentActive', not exists (select 1 from public.cycle_prize_pool_components replacement where replacement.replaces_component_id = component.id),
    'cycleId', allocation.cycle_id, 'cycleNumber', cycle.public_number,
    'submissionId', allocation.submission_id, 'claimId', allocation.claim_id,
    'winnerDiscordUserId', allocation.winner_discord_user_id,
    'claimVersion', claim.version, 'claimStatus', claim.status,
    'payoutChoice', allocation.payout_choice, 'splitPercent', allocation.split_percent,
    'grossLamports', allocation.gross_lamports::text,
    'winnerLamports', allocation.winner_lamports::text, 'donationLamports', allocation.donation_lamports::text,
    'organizationState', allocation.organization_effective_state,
    'organizationName', allocation.organization_name,
    'organizationWebsiteUrl', allocation.organization_website_url,
    'planPublicId', plan.public_id, 'planState', plan.state, 'planRowVersion', plan.row_version
  ) order by cycle.id desc, component.component_version, allocation.stable_tie_key), '[]'::jsonb) into v_allocations
  from public.cycle_prize_allocations allocation
  join public.cycle_prize_pool_components component on component.id = allocation.component_id
  join public.voting_cycles cycle on cycle.id = allocation.cycle_id
  join public.winner_claims claim on claim.id = allocation.claim_id
  left join public.payout_plans plan on plan.allocation_id = allocation.id and plan.state not in ('aborted', 'replaced');

  select coalesce(jsonb_agg(jsonb_build_object(
    'planPublicId', plan.public_id, 'planVersion', plan.plan_version, 'rowVersion', plan.row_version,
    'state', plan.state, 'allocationPublicId', allocation.public_id,
    'cycleId', allocation.cycle_id, 'cycleNumber', cycle.public_number,
    'submissionId', allocation.submission_id, 'winnerDiscordUserId', allocation.winner_discord_user_id,
    'createdAt', plan.created_at, 'lockedAt', plan.locked_at, 'publishedAt', plan.published_at,
    'lines', coalesce((select jsonb_agg(jsonb_build_object(
      'linePublicId', line.public_id, 'lineKind', line.line_kind,
      'amountLamports', line.amount_lamports::text, 'rowVersion', line.row_version,
      'state', line.state,
      'recipient', case when p_include_management then coalesce(line.winner_recipient, line.donation_operation_recipient) end,
      'organizationName', line.organization_name, 'organizationState', line.organization_effective_state,
      'unavailableReason', line.unavailable_reason,
      'transaction', case when transaction.id is null then null else jsonb_build_object(
        'transactionPublicId', transaction.public_id, 'signature', transaction.signature,
        'canonicalExplorerUrl', transaction.canonical_explorer_url,
        'evidenceLevel', transaction.evidence_level, 'recordedAt', transaction.recorded_at,
        'privateEvidence', case when p_include_management then coalesce((select jsonb_agg(jsonb_build_object(
          'evidencePublicId', evidence.public_id, 'byteSize', evidence.byte_size,
          'width', evidence.width, 'height', evidence.height, 'uploadedAt', evidence.uploaded_at
        )) from public.payout_private_evidence evidence where evidence.payout_transaction_id = transaction.id), '[]'::jsonb) else '[]'::jsonb end
      ) end,
      'returnClaim', case when return_claim.id is null then null else jsonb_build_object(
        'claimPublicId', return_claim.public_id, 'status', return_claim.status,
        'rowVersion', return_claim.row_version, 'deadlineAt', return_claim.deadline_at,
        'confirmedRecipient', case when p_include_management and return_claim.status = 'confirmed' then return_claim.confirmed_recipient end
      ) end,
      'pollLinks', coalesce((select jsonb_agg(jsonb_build_object(
        'linkPublicId', link.public_id, 'pollPublicId', poll.public_id,
        'pollVersionAtLink', link.poll_version, 'currentPollVersion', poll.row_version,
        'pollStatus', poll.status, 'appliedAt', link.applied_at,
        'followUpPollPublicId', follow_up.public_id
      ) order by link.linked_at)
      from public.payout_poll_links link join public.community_polls poll on poll.id = link.poll_id
      left join public.community_polls follow_up on follow_up.id = link.follow_up_poll_id
      where link.payout_line_id = line.id), '[]'::jsonb)
    ) order by line.created_at, line.public_id)
    from public.payout_lines line
    left join public.payout_transactions transaction on transaction.id = line.current_transaction_id
    left join public.payout_return_claims return_claim on return_claim.source_payout_line_id = line.id
    where line.plan_id = plan.id), '[]'::jsonb)
  ) order by cycle.id desc, plan.created_at desc), '[]'::jsonb) into v_plans
  from public.payout_plans plan
  join public.cycle_prize_allocations allocation on allocation.id = plan.allocation_id
  join public.voting_cycles cycle on cycle.id = allocation.cycle_id;
  return jsonb_build_object('outcome', 'ok', 'databaseTime', transaction_timestamp(),
    'pools', v_pools, 'allocations', v_allocations, 'plans', v_plans);
end;
$function$;

create function public.get_team_payout_logs(p_actor_discord_user_id text, p_limit integer default 200)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $function$
declare
  v_role text;
  v_items jsonb;
begin
  v_role := public.assert_winners_payout_capability(p_actor_discord_user_id, 'winners.payout_logs.view');
  if p_limit not between 1 and 500 then raise exception using message = 'PAYOUT_INPUT_INVALID'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'eventId', event.id, 'eventType', event.event_type, 'actorDiscordUserId', event.actor_discord_user_id,
    'targetType', event.target_type, 'targetPublicId', event.target_public_id,
    'targetVersion', event.target_version, 'requestId', event.request_id,
    'reason', event.reason, 'details', event.details, 'occurredAt', event.occurred_at
  ) order by event.occurred_at desc, event.id desc), '[]'::jsonb) into v_items
  from (select * from public.payout_events order by occurred_at desc, id desc limit p_limit) event;
  return jsonb_build_object('outcome', 'ok', 'items', v_items);
end;
$function$;

create function public.get_payout_private_evidence_source(p_actor_discord_user_id text, p_evidence_public_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $function$
declare
  v_role text;
  v_source jsonb;
begin
  v_role := public.assert_winners_payout_capability(p_actor_discord_user_id, 'winners.manage_payouts');
  select jsonb_build_object('r2Key', r2_key, 'byteSize', byte_size, 'width', width, 'height', height)
  into v_source from public.payout_private_evidence where public_id = p_evidence_public_id;
  return v_source;
end;
$function$;

alter table public.cycle_prize_pools enable row level security;
alter table public.cycle_prize_pool_components enable row level security;
alter table public.cycle_prize_allocations enable row level security;
alter table public.payout_plans enable row level security;
alter table public.payout_lines enable row level security;
alter table public.payout_transactions enable row level security;
alter table public.payout_private_evidence enable row level security;
alter table public.payout_poll_links enable row level security;
alter table public.payout_return_claims enable row level security;
alter table public.payout_events enable row level security;
alter table public.payout_mutation_requests enable row level security;
alter table public.payout_return_claim_requests enable row level security;

revoke all on table public.cycle_prize_pools, public.cycle_prize_pool_components,
  public.cycle_prize_allocations, public.payout_plans, public.payout_lines,
  public.payout_transactions, public.payout_private_evidence, public.payout_poll_links,
  public.payout_return_claims, public.payout_events, public.payout_mutation_requests,
  public.payout_return_claim_requests from public, anon, authenticated, discord_bot, service_role;
revoke all on sequence public.payout_events_id_seq from public, anon, authenticated, discord_bot, service_role;

alter table public.cycle_prize_pools owner to postgres;
alter table public.cycle_prize_pool_components owner to postgres;
alter table public.cycle_prize_allocations owner to postgres;
alter table public.payout_plans owner to postgres;
alter table public.payout_lines owner to postgres;
alter table public.payout_transactions owner to postgres;
alter table public.payout_private_evidence owner to postgres;
alter table public.payout_poll_links owner to postgres;
alter table public.payout_return_claims owner to postgres;
alter table public.payout_events owner to postgres;
alter table public.payout_mutation_requests owner to postgres;
alter table public.payout_return_claim_requests owner to postgres;
alter sequence public.payout_events_id_seq owner to postgres;

alter function public.reject_payout_append_only_rewrite() owner to postgres;
alter function public.assert_winners_payout_capability(text,text) owner to postgres;
alter function public.payout_request_hash(jsonb) owner to postgres;
alter function public.allocate_cycle_prize_component(uuid) owner to postgres;
alter function public.manage_cycle_prize_pool(text,uuid,bigint,bigint,text,bigint,text,uuid,text) owner to postgres;
alter function public.finalize_cycle_without_prize_pool(bigint,text) owner to postgres;
alter function public.finalize_cycle(bigint,text) owner to postgres;
alter function public.prepare_payout_plan(text,uuid,uuid,bigint) owner to postgres;
alter function public.manage_payout_plan(text,uuid,uuid,bigint,text,jsonb) owner to postgres;
alter function public.record_payout_transaction(text,uuid,uuid,bigint,text,text,text,bigint,boolean,boolean,text,bigint,uuid) owner to postgres;
alter function public.attach_payout_private_evidence(text,uuid,uuid,text,integer,integer,integer) owner to postgres;
alter function public.process_due_payout_return_claims(uuid) owner to postgres;
alter function public.get_own_payout_return_claims(uuid) owner to postgres;
alter function public.mutate_own_payout_return_claim(uuid,uuid,uuid,bigint,text,text) owner to postgres;
alter function public.get_current_cycle_prize_pool() owner to postgres;
alter function public.get_team_payout_context(text,boolean) owner to postgres;
alter function public.get_team_payout_logs(text,integer) owner to postgres;
alter function public.get_payout_private_evidence_source(text,uuid) owner to postgres;

revoke all on function public.reject_payout_append_only_rewrite(),
  public.assert_winners_payout_capability(text,text), public.payout_request_hash(jsonb),
  public.allocate_cycle_prize_component(uuid), public.finalize_cycle_without_prize_pool(bigint,text),
  public.finalize_cycle(bigint,text) from public, anon, authenticated, discord_bot, service_role;

revoke all on function
  public.manage_cycle_prize_pool(text,uuid,bigint,bigint,text,bigint,text,uuid,text),
  public.prepare_payout_plan(text,uuid,uuid,bigint),
  public.manage_payout_plan(text,uuid,uuid,bigint,text,jsonb),
  public.record_payout_transaction(text,uuid,uuid,bigint,text,text,text,bigint,boolean,boolean,text,bigint,uuid),
  public.attach_payout_private_evidence(text,uuid,uuid,text,integer,integer,integer),
  public.process_due_payout_return_claims(uuid), public.get_own_payout_return_claims(uuid),
  public.mutate_own_payout_return_claim(uuid,uuid,uuid,bigint,text,text),
  public.get_current_cycle_prize_pool(), public.get_team_payout_context(text,boolean),
  public.get_team_payout_logs(text,integer), public.get_payout_private_evidence_source(text,uuid)
  from public, anon, authenticated, discord_bot, service_role;

grant execute on function
  public.manage_cycle_prize_pool(text,uuid,bigint,bigint,text,bigint,text,uuid,text),
  public.prepare_payout_plan(text,uuid,uuid,bigint),
  public.manage_payout_plan(text,uuid,uuid,bigint,text,jsonb),
  public.record_payout_transaction(text,uuid,uuid,bigint,text,text,text,bigint,boolean,boolean,text,bigint,uuid),
  public.attach_payout_private_evidence(text,uuid,uuid,text,integer,integer,integer),
  public.get_own_payout_return_claims(uuid),
  public.mutate_own_payout_return_claim(uuid,uuid,uuid,bigint,text,text),
  public.get_current_cycle_prize_pool(), public.get_team_payout_context(text,boolean),
  public.get_team_payout_logs(text,integer), public.get_payout_private_evidence_source(text,uuid)
  to service_role;

do $postflight$
begin
  if (select count(*) from public.capability_catalog) <> 43
    or (select count(*) from public.capability_catalog where is_active) <> 39
    or exists (select 1 from public.team_role_capabilities where capability_key in ('winners.manage_payouts', 'winners.payout_logs.view'))
    or to_regprocedure('public.finalize_cycle_without_prize_pool(bigint,text)') is null
    or to_regprocedure('public.finalize_cycle(bigint,text)') is null
    or (select count(*) from public.cycle_prize_pools) <> (select count(*) from public.voting_cycles where status = 'finished')
  then raise exception using errcode = '55000', message = 'PAYOUT_FOUNDATION_POSTFLIGHT_MISMATCH'; end if;
end;
$postflight$;

comment on table public.cycle_prize_pool_components is 'Immutable exact-Lamport finalized prize-pool components; replacements and rollovers preserve their sources.';
comment on table public.cycle_prize_allocations is 'Deterministic largest-remainder exact-Lamport allocations derived from finalized winner win_share snapshots.';
comment on table public.payout_events is 'Append-only private Payout Logs source. It contains bounded operational facts and no private evidence bytes or Treasury secrets.';

commit;
