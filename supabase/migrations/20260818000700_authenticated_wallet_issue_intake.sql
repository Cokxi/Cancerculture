begin;

do $baseline$
begin
  if to_regclass('public.wallet_issue_intakes') is not null
    or to_regclass('public.wallet_issue_intake_requests') is not null
    or to_regclass('public.wallet_issue_resolution_requests') is not null
    or to_regprocedure('public.finalize_cycle_without_wallet_issue_intakes(bigint,text)') is not null
    or to_regprocedure('public.finalize_cycle(bigint,text)') is null
    or to_regprocedure('public.require_account_session(uuid)') is null
    or to_regprocedure('public.is_valid_sol_recipient_address(text)') is null
    or to_regprocedure('public.upsert_team_inbox_case(text,text,bigint,text,text)') is null
    or to_regprocedure('public.assert_team_inbox_topic_access(text,text,boolean)') is null
    or to_regprocedure('public.enqueue_account_notification_event(text,text,text,text,text,boolean)') is null
    or to_regclass('public.winner_claims') is null
    or to_regclass('public.winner_recipient_corrections') is null
    or to_regclass('public.team_inbox_cases') is null
    or not exists (
      select 1
      from public.team_inbox_topic_catalog
      where topic_key = 'wallet_issues'
        and not is_active
        and not accepts_new_cases
        and required_read_capabilities =
          array['winners.payouts.view', 'winners.recipient_corrections.manage']::text[]
        and required_action_capabilities =
          array['winners.payouts.view', 'winners.recipient_corrections.manage']::text[]
    )
    or exists (
      select 1 from public.notification_category_catalog
      where category_key = 'wallet_issues'
    )
    or (select count(*) from public.capability_catalog) <> 39
    or (select count(*) from public.capability_catalog where is_active) <> 35
  then
    raise exception using
      errcode = '55000',
      message = 'WALLET_ISSUE_INTAKE_BASELINE_MISMATCH';
  end if;
end;
$baseline$;

insert into public.notification_category_catalog (
  category_key, display_name, required_in_product, is_active,
  description, default_in_product_enabled,
  in_product_available, push_available
) values (
  'wallet_issues', 'Wallet Issues', false, true,
  'Get updates about a reported recipient issue for a winning Submission.',
  true, true, true
);

insert into public.push_subscription_preferences (
  subscription_id, category_key, enabled
)
select subscription.id, 'wallet_issues', false
from public.push_subscriptions subscription
on conflict (subscription_id, category_key) do nothing;

alter table public.notification_events
  drop constraint notification_event_type_check,
  drop constraint notification_event_category_check;

alter table public.notification_events
  add constraint notification_event_type_check
    check (event_type in (
      'winner_claim_required',
      'winner_donation_finalized',
      'submission_disqualified',
      'submission_reinstated',
      'cycle_results_ready',
      'wallet_issue_received',
      'wallet_issue_correction_ready',
      'wallet_issue_resolved'
    )),
  add constraint notification_event_category_check
    check (
      (event_type in ('winner_claim_required', 'winner_donation_finalized')
        and category_key = 'winners_claims')
      or (event_type in ('submission_disqualified', 'submission_reinstated')
        and category_key = 'submission_moderation')
      or (event_type = 'cycle_results_ready'
        and category_key = 'cycles_voting')
      or (event_type in (
          'wallet_issue_received',
          'wallet_issue_correction_ready',
          'wallet_issue_resolved'
        ) and category_key = 'wallet_issues')
    );

alter table public.winner_claim_events
  drop constraint winner_claim_events_action_check;

alter table public.winner_claim_events
  add constraint winner_claim_events_action_check
    check (action in (
      'confirmed', 'declined', 'expired', 'correction_pending',
      'correction_ready', 'correction_incorrect', 'wallet_issue_no_action'
    ));

create table public.wallet_issue_intakes (
  id uuid primary key default gen_random_uuid(),
  cycle_id bigint not null references public.voting_cycles(id) on delete restrict,
  submission_id bigint not null references public.submissions(id) on delete restrict,
  owner_discord_user_id text not null,
  desired_recipient text not null,
  description text not null,
  status text not null default 'held',
  version bigint not null default 1,
  winner_claim_id uuid unique references public.winner_claims(id) on delete restrict,
  team_inbox_case_id uuid unique references public.team_inbox_cases(id) on delete restrict,
  resolution_outcome text,
  screenshot_data bytea,
  screenshot_mime text,
  screenshot_sha256 text,
  screenshot_size integer,
  submitted_at timestamptz not null default transaction_timestamp(),
  evaluated_at timestamptz,
  promoted_at timestamptz,
  resolved_at timestamptz,
  delete_after timestamptz,
  screenshot_purged_at timestamptz,
  unique (cycle_id, submission_id),
  constraint wallet_issue_intake_owner_check
    check (owner_discord_user_id ~ '^[0-9]{1,100}$'),
  constraint wallet_issue_intake_recipient_check
    check (public.is_valid_sol_recipient_address(desired_recipient)),
  constraint wallet_issue_intake_description_check
    check (char_length(btrim(description)) between 20 and 1000),
  constraint wallet_issue_intake_status_check
    check (status in ('held', 'promoted', 'not_relevant', 'resolved')),
  constraint wallet_issue_intake_version_check
    check (version > 0),
  constraint wallet_issue_intake_resolution_check
    check (
      (status = 'held'
        and evaluated_at is null and promoted_at is null and resolved_at is null
        and delete_after is null and winner_claim_id is null
        and team_inbox_case_id is null and resolution_outcome is null)
      or (status = 'promoted'
        and evaluated_at is not null and promoted_at is not null and resolved_at is null
        and delete_after is null and winner_claim_id is not null
        and team_inbox_case_id is not null and resolution_outcome is null)
      or (status = 'not_relevant'
        and evaluated_at is not null and promoted_at is null and resolved_at is null
        and delete_after is not null and winner_claim_id is null
        and team_inbox_case_id is null and resolution_outcome is null)
      or (status = 'resolved'
        and evaluated_at is not null and promoted_at is not null and resolved_at is not null
        and delete_after is null and winner_claim_id is not null
        and team_inbox_case_id is not null
        and resolution_outcome in ('accept_correction', 'no_action'))
    ),
  constraint wallet_issue_intake_screenshot_check
    check (
      (screenshot_data is null and screenshot_mime is null
        and screenshot_sha256 is null and screenshot_size is null
        and screenshot_purged_at is null)
      or (screenshot_data is not null and screenshot_mime = 'image/webp'
        and screenshot_sha256 ~ '^[0-9a-f]{64}$'
        and screenshot_size = octet_length(screenshot_data)
        and screenshot_size between 1 and 3145728
        and screenshot_purged_at is null)
      or (screenshot_data is null and screenshot_mime = 'image/webp'
        and screenshot_sha256 ~ '^[0-9a-f]{64}$'
        and screenshot_size between 1 and 3145728
        and screenshot_purged_at is not null)
    )
);

create index wallet_issue_intakes_owner_idx
  on public.wallet_issue_intakes(owner_discord_user_id, submitted_at desc, id desc);
create index wallet_issue_intakes_monitor_idx
  on public.wallet_issue_intakes(status, submitted_at desc, id desc);
create index wallet_issue_intakes_purge_idx
  on public.wallet_issue_intakes(delete_after, id)
  where status = 'not_relevant';

create table public.wallet_issue_intake_requests (
  request_id uuid primary key,
  intake_id uuid not null references public.wallet_issue_intakes(id) on delete cascade,
  owner_discord_user_id text not null,
  submission_id bigint not null,
  request_hash text not null,
  result jsonb not null,
  created_at timestamptz not null default transaction_timestamp(),
  constraint wallet_issue_intake_request_owner_check
    check (owner_discord_user_id ~ '^[0-9]{1,100}$'),
  constraint wallet_issue_intake_request_hash_check
    check (request_hash ~ '^[0-9a-f]{64}$')
);

create table public.wallet_issue_resolution_requests (
  request_id uuid primary key,
  intake_id uuid not null references public.wallet_issue_intakes(id) on delete restrict,
  case_id uuid not null references public.team_inbox_cases(id) on delete restrict,
  actor_discord_user_id text not null,
  resolution text not null,
  request_hash text not null,
  result jsonb not null,
  created_at timestamptz not null default transaction_timestamp(),
  constraint wallet_issue_resolution_request_actor_check
    check (actor_discord_user_id ~ '^[0-9]{1,100}$'),
  constraint wallet_issue_resolution_request_action_check
    check (resolution in ('accept_correction', 'no_action')),
  constraint wallet_issue_resolution_request_hash_check
    check (request_hash ~ '^[0-9a-f]{64}$')
);

alter table public.wallet_issue_intakes enable row level security;
alter table public.wallet_issue_intake_requests enable row level security;
alter table public.wallet_issue_resolution_requests enable row level security;

revoke all on table public.wallet_issue_intakes
  from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.wallet_issue_intake_requests
  from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.wallet_issue_resolution_requests
  from public, anon, authenticated, discord_bot, service_role;

create function public.protect_wallet_issue_intake_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  if old.status <> 'not_relevant'
    or old.delete_after is null
    or old.delete_after > transaction_timestamp()
  then
    raise exception using
      errcode = '55000',
      message = 'WALLET_ISSUE_INTAKE_HISTORY_PROTECTED';
  end if;
  return old;
end;
$function$;

create trigger wallet_issue_intakes_protected_delete
before delete on public.wallet_issue_intakes
for each row execute function public.protect_wallet_issue_intake_delete();

create function public.get_own_wallet_issue_intake_request(
  p_session_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner_id text;
  v_request public.wallet_issue_intake_requests%rowtype;
begin
  v_owner_id := public.require_account_session(p_session_id);
  select * into v_request
  from public.wallet_issue_intake_requests
  where request_id = p_request_id
    and owner_discord_user_id = v_owner_id;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  return v_request.result || jsonb_build_object('idempotentReplay', true);
end;
$function$;

create function public.assert_own_wallet_issue_intake_open(
  p_session_id uuid,
  p_submission_id bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner_id text;
  v_submission public.submissions%rowtype;
  v_cycle public.voting_cycles%rowtype;
  v_private public.submission_private_data%rowtype;
  v_existing public.wallet_issue_intakes%rowtype;
begin
  v_owner_id := public.require_account_session(p_session_id);
  select * into v_existing
  from public.wallet_issue_intakes
  where submission_id = p_submission_id;
  if found then
    if v_existing.owner_discord_user_id <> v_owner_id then
      raise exception using errcode = '42501', message = 'WALLET_ISSUE_INTAKE_FORBIDDEN';
    end if;
    return jsonb_build_object(
      'outcome', 'existing', 'intakeId', v_existing.id,
      'status', v_existing.status, 'submittedAt', v_existing.submitted_at
    );
  end if;

  select * into v_submission from public.submissions
  where id = p_submission_id;
  if not found or v_submission.discord_user_id <> v_owner_id then
    raise exception using errcode = '42501', message = 'WALLET_ISSUE_INTAKE_FORBIDDEN';
  end if;
  select * into v_cycle from public.voting_cycles where id = v_submission.cycle_id;
  if not found
    or v_cycle.finalized_at is not null
    or v_cycle.status::text not in (
      'active', 'submission_open', 'submission_closed',
      'voting_open', 'voting_closed', 'paused'
    )
    or v_cycle.id <> (
      select current_cycle.id
      from public.voting_cycles current_cycle
      where current_cycle.finalized_at is null
        and current_cycle.status::text in (
          'active', 'submission_open', 'submission_closed',
          'voting_open', 'voting_closed', 'paused'
        )
      order by current_cycle.id desc
      limit 1
    )
  then
    raise exception using errcode = '55000', message = 'WALLET_ISSUE_INTAKE_CLOSED';
  end if;
  select * into v_private
  from public.submission_private_data private_data
  where private_data.submission_id = p_submission_id
  order by private_data.id desc
  limit 1;
  if not found or v_private.payout_choice not in ('keep', 'split') then
    raise exception using errcode = '55000', message = 'WALLET_ISSUE_INTAKE_NOT_APPLICABLE';
  end if;
  return jsonb_build_object(
    'outcome', 'open', 'cycleId', v_cycle.id,
    'submissionId', v_submission.id
  );
end;
$function$;

create function public.create_own_wallet_issue_intake(
  p_session_id uuid,
  p_submission_id bigint,
  p_request_id uuid,
  p_desired_recipient text,
  p_description text,
  p_screenshot_data bytea default null,
  p_screenshot_mime text default null,
  p_screenshot_sha256 text default null,
  p_screenshot_size integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner_id text;
  v_open jsonb;
  v_intake public.wallet_issue_intakes%rowtype;
  v_existing_request public.wallet_issue_intake_requests%rowtype;
  v_request_hash text;
  v_result jsonb;
begin
  v_owner_id := public.require_account_session(p_session_id);
  if p_request_id is null
    or not public.is_valid_sol_recipient_address(p_desired_recipient)
    or char_length(btrim(p_description)) not between 20 and 1000
    or not (
      (p_screenshot_data is null and p_screenshot_mime is null
        and p_screenshot_sha256 is null and p_screenshot_size is null)
      or (p_screenshot_data is not null and p_screenshot_mime = 'image/webp'
        and p_screenshot_sha256 ~ '^[0-9a-f]{64}$'
        and p_screenshot_size = octet_length(p_screenshot_data)
        and p_screenshot_size between 1 and 3145728)
    )
  then
    raise exception using errcode = '22023', message = 'WALLET_ISSUE_INTAKE_INPUT_INVALID';
  end if;
  v_request_hash := encode(extensions.digest(concat_ws(
    '|', p_submission_id::text, p_desired_recipient, btrim(p_description),
    coalesce(p_screenshot_sha256, ''), coalesce(p_screenshot_size::text, '')
  ), 'sha256'), 'hex');
  perform pg_advisory_xact_lock(hashtextextended(
    'wallet-issue-intake-request:' || p_request_id::text, 0
  ));
  select * into v_existing_request
  from public.wallet_issue_intake_requests
  where request_id = p_request_id;
  if found then
    if v_existing_request.owner_discord_user_id <> v_owner_id
      or v_existing_request.submission_id <> p_submission_id
      or v_existing_request.request_hash <> v_request_hash
    then
      raise exception using errcode = '22023', message = 'WALLET_ISSUE_IDEMPOTENCY_MISMATCH';
    end if;
    return v_existing_request.result || jsonb_build_object('idempotentReplay', true);
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'wallet-issue-submission:' || p_submission_id::text, 0
  ));
  v_open := public.assert_own_wallet_issue_intake_open(p_session_id, p_submission_id);
  if v_open ->> 'outcome' = 'existing' then
    select * into strict v_intake from public.wallet_issue_intakes
    where submission_id = p_submission_id;
  else
    if exists (
      select 1 from public.wallet_issue_intakes recent
      where recent.owner_discord_user_id = v_owner_id
        and recent.submitted_at > transaction_timestamp() - interval '60 seconds'
    ) then
      raise exception using errcode = '55000', message = 'WALLET_ISSUE_INTAKE_COOLDOWN';
    end if;
    insert into public.wallet_issue_intakes (
      cycle_id, submission_id, owner_discord_user_id,
      desired_recipient, description,
      screenshot_data, screenshot_mime, screenshot_sha256, screenshot_size
    ) values (
      (v_open ->> 'cycleId')::bigint, p_submission_id, v_owner_id,
      btrim(p_desired_recipient), btrim(p_description),
      p_screenshot_data, p_screenshot_mime, p_screenshot_sha256, p_screenshot_size
    ) returning * into v_intake;
  end if;
  v_result := jsonb_build_object(
    'outcome', case when v_open ->> 'outcome' = 'existing' then 'existing' else 'created' end,
    'intakeId', v_intake.id, 'status', v_intake.status,
    'submittedAt', v_intake.submitted_at, 'idempotentReplay', false
  );
  insert into public.wallet_issue_intake_requests (
    request_id, intake_id, owner_discord_user_id,
    submission_id, request_hash, result
  ) values (
    p_request_id, v_intake.id, v_owner_id,
    p_submission_id, v_request_hash, v_result
  );
  return v_result;
end;
$function$;

create function public.get_own_wallet_issue_intakes(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner_id text;
  v_items jsonb;
begin
  v_owner_id := public.require_account_session(p_session_id);
  select coalesce(jsonb_agg(jsonb_build_object(
    'intakeId', intake.id,
    'cycleId', intake.cycle_id,
    'submissionId', intake.submission_id,
    'status', intake.status,
    'submittedAt', intake.submitted_at
  ) order by intake.submitted_at desc, intake.id desc), '[]'::jsonb)
  into v_items
  from public.wallet_issue_intakes intake
  where intake.owner_discord_user_id = v_owner_id;
  return jsonb_build_object('items', v_items);
end;
$function$;

create function public.purge_due_wallet_issue_intakes()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_deleted integer;
begin
  delete from public.wallet_issue_intakes
  where status = 'not_relevant'
    and delete_after <= transaction_timestamp();
  get diagnostics v_deleted = row_count;
  return jsonb_build_object(
    'outcome', 'ok', 'deletedCount', v_deleted,
    'processedAt', transaction_timestamp()
  );
end;
$function$;

create function public.resolve_wallet_issue_current_candidate(
  p_claim_id uuid,
  p_owner_discord_user_id text
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
begin
  select * into v_claim from public.winner_claims
  where id = p_claim_id
    and winner_discord_user_id = p_owner_discord_user_id;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  select wallet.wallet_address, wallet.version
  into v_address, v_source_version
  from public.account_sol_profile_wallets wallet
  where wallet.discord_user_id = p_owner_discord_user_id
    and public.is_valid_sol_recipient_address(wallet.wallet_address)
    and exists (
      select 1 from public.account_totp_factors factor
      where factor.discord_user_id = p_owner_discord_user_id
    );
  if found then
    v_source := 'profile';
  else
    select correction.proposed_recipient, correction.version
    into v_address, v_source_version
    from public.winner_recipient_corrections correction
    where correction.claim_id = p_claim_id and correction.status = 'ready'
    order by correction.version desc limit 1;
    if found then
      v_source := 'correction';
    else
      select private_data.wallet_address into v_address
      from public.submission_private_data private_data
      where private_data.submission_id = v_claim.submission_id
      order by private_data.id desc limit 1;
      v_source := 'submission';
      v_source_version := null;
    end if;
  end if;
  if not public.is_valid_sol_recipient_address(v_address) then
    return jsonb_build_object('outcome', 'recipient_unavailable');
  end if;
  return jsonb_build_object(
    'outcome', 'ready', 'address', v_address,
    'source', v_source, 'sourceVersion', v_source_version
  );
end;
$function$;

create function public.get_team_wallet_issue_intakes(
  p_actor_discord_user_id text,
  p_before_submitted_at timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 25
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_items jsonb;
begin
  perform public.assert_team_inbox_topic_access(
    p_actor_discord_user_id, 'wallet_issues', false
  );
  if p_limit not between 1 and 50
    or ((p_before_submitted_at is null) <> (p_before_id is null))
  then
    raise exception using errcode = '22023', message = 'WALLET_ISSUE_MONITOR_INPUT_INVALID';
  end if;
  perform public.purge_due_wallet_issue_intakes();
  select coalesce(jsonb_agg(item.payload order by item.submitted_at desc, item.id desc), '[]'::jsonb)
  into v_items
  from (
    select intake.submitted_at, intake.id, jsonb_build_object(
      'intakeId', intake.id,
      'cycleNumber', cycle.public_number,
      'submissionId', intake.submission_id,
      'username', coalesce(nullif(btrim(user_row.current_discord_username), ''), 'Account'),
      'status', intake.status,
      'desiredRecipient', intake.desired_recipient,
      'description', intake.description,
      'screenshotAvailable', intake.screenshot_data is not null,
      'submittedAt', intake.submitted_at,
      'evaluatedAt', intake.evaluated_at,
      'deleteAfter', intake.delete_after,
      'caseId', intake.team_inbox_case_id
    ) payload
    from public.wallet_issue_intakes intake
    join public.voting_cycles cycle on cycle.id = intake.cycle_id
    left join public.user_logs user_row
      on user_row.discord_user_id = intake.owner_discord_user_id
    where p_before_submitted_at is null
      or (intake.submitted_at, intake.id) < (p_before_submitted_at, p_before_id)
    order by intake.submitted_at desc, intake.id desc
    limit p_limit + 1
  ) item;
  return jsonb_build_object('items', v_items);
end;
$function$;

create function public.get_team_wallet_issue_case_detail(
  p_actor_discord_user_id text,
  p_case_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_case public.team_inbox_cases%rowtype;
  v_intake public.wallet_issue_intakes%rowtype;
  v_claim public.winner_claims%rowtype;
  v_candidate jsonb;
begin
  select * into v_case from public.team_inbox_cases where id = p_case_id;
  if not found or v_case.topic_key <> 'wallet_issues' then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  perform public.assert_team_inbox_topic_access(
    p_actor_discord_user_id, 'wallet_issues', false
  );
  select * into v_intake from public.wallet_issue_intakes
  where team_inbox_case_id = p_case_id;
  if not found or v_intake.status not in ('promoted', 'resolved') then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  select * into strict v_claim from public.winner_claims
  where id = v_intake.winner_claim_id;
  v_candidate := public.resolve_wallet_issue_current_candidate(
    v_claim.id, v_intake.owner_discord_user_id
  );
  return jsonb_build_object(
    'outcome', 'found',
    'intake', jsonb_build_object(
      'intakeId', v_intake.id,
      'cycleId', v_intake.cycle_id,
      'submissionId', v_intake.submission_id,
      'desiredRecipient', v_intake.desired_recipient,
      'description', v_intake.description,
      'status', v_intake.status,
      'version', v_intake.version,
      'screenshotAvailable', v_intake.screenshot_data is not null,
      'submittedAt', v_intake.submitted_at,
      'resolutionOutcome', v_intake.resolution_outcome
    ),
    'claim', jsonb_build_object(
      'claimId', v_claim.id, 'status', v_claim.status,
      'version', v_claim.version, 'deadlineAt', v_claim.claim_deadline_at
    ),
    'caseSourceVersion', v_case.source_version,
    'caseRowVersion', v_case.row_version,
    'caseWorkVersion', v_case.work_version,
    'currentCandidate', case when v_candidate ->> 'outcome' = 'ready'
      then jsonb_build_object(
        'address', v_candidate ->> 'address',
        'source', v_candidate ->> 'source'
      ) else null end
  );
end;
$function$;

create function public.get_team_wallet_issue_screenshot(
  p_actor_discord_user_id text,
  p_intake_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_intake public.wallet_issue_intakes%rowtype;
begin
  perform public.assert_team_inbox_topic_access(
    p_actor_discord_user_id, 'wallet_issues', false
  );
  select * into v_intake from public.wallet_issue_intakes where id = p_intake_id;
  if not found or v_intake.screenshot_data is null then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  return jsonb_build_object(
    'outcome', 'found', 'mime', v_intake.screenshot_mime,
    'data', encode(v_intake.screenshot_data, 'base64'),
    'sha256', v_intake.screenshot_sha256
  );
end;
$function$;

create function public.resolve_wallet_issue_case(
  p_actor_discord_user_id text,
  p_case_id uuid,
  p_request_id uuid,
  p_resolution text,
  p_expected_case_row_version bigint,
  p_expected_case_work_version bigint,
  p_expected_source_version bigint,
  p_expected_intake_version bigint,
  p_expected_claim_version bigint,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor_id text := btrim(p_actor_discord_user_id);
  v_case public.team_inbox_cases%rowtype;
  v_intake public.wallet_issue_intakes%rowtype;
  v_claim public.winner_claims%rowtype;
  v_existing public.wallet_issue_resolution_requests%rowtype;
  v_role text;
  v_actor_display text;
  v_candidate jsonb;
  v_current_candidate text;
  v_correction_version bigint;
  v_now timestamptz := transaction_timestamp();
  v_request_hash text;
  v_result jsonb;
  v_notification_id uuid;
begin
  if p_request_id is null
    or p_resolution not in ('accept_correction', 'no_action')
    or p_expected_case_row_version <= 0
    or p_expected_case_work_version <= 0
    or p_expected_source_version <= 0
    or p_expected_intake_version <= 0
    or p_expected_claim_version <= 0
    or (p_note is not null and char_length(btrim(p_note)) not between 3 and 1000)
  then
    raise exception using errcode = '22023', message = 'WALLET_ISSUE_RESOLUTION_INPUT_INVALID';
  end if;
  v_request_hash := encode(extensions.digest(concat_ws(
    '|', p_case_id::text, p_resolution,
    p_expected_case_row_version::text, p_expected_case_work_version::text,
    p_expected_source_version::text, p_expected_intake_version::text,
    p_expected_claim_version::text, coalesce(btrim(p_note), '')
  ), 'sha256'), 'hex');
  perform pg_advisory_xact_lock(hashtextextended(
    'wallet-issue-resolution:' || p_request_id::text, 0
  ));
  select * into v_existing from public.wallet_issue_resolution_requests
  where request_id = p_request_id;
  if found then
    if v_existing.actor_discord_user_id <> v_actor_id
      or v_existing.case_id <> p_case_id
      or v_existing.resolution <> p_resolution
      or v_existing.request_hash <> v_request_hash
    then
      raise exception using errcode = '22023', message = 'WALLET_ISSUE_RESOLUTION_REPLAY_MISMATCH';
    end if;
    return v_existing.result || jsonb_build_object('idempotentReplay', true);
  end if;

  select * into v_case from public.team_inbox_cases
  where id = p_case_id for update;
  if not found or v_case.topic_key <> 'wallet_issues' then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  v_role := public.assert_team_inbox_topic_access(v_actor_id, 'wallet_issues', true);
  if v_case.status <> 'in_progress'
    or v_case.assignee_discord_user_id <> v_actor_id
  then
    raise exception using errcode = '42501', message = 'TEAM_INBOX_ASSIGNEE_REQUIRED';
  end if;
  if v_case.row_version <> p_expected_case_row_version
    or v_case.work_version <> p_expected_case_work_version
    or v_case.source_version <> p_expected_source_version
  then
    return jsonb_build_object('outcome', 'stale');
  end if;
  select * into v_intake from public.wallet_issue_intakes
  where team_inbox_case_id = p_case_id for update;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  select * into v_claim from public.winner_claims
  where id = v_intake.winner_claim_id for update;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  if v_intake.status <> 'promoted'
    or v_intake.version <> p_expected_intake_version
    or v_claim.version <> p_expected_claim_version
    or v_claim.status <> 'correction_pending'
  then
    return jsonb_build_object('outcome', 'stale');
  end if;

  v_candidate := public.resolve_wallet_issue_current_candidate(
    v_claim.id, v_intake.owner_discord_user_id
  );
  v_current_candidate := case when v_candidate ->> 'outcome' = 'ready'
    then v_candidate ->> 'address' else null end;
  if p_resolution = 'no_action'
    and v_current_candidate is distinct from v_intake.desired_recipient
  then
    v_result := jsonb_build_object('outcome', 'candidate_mismatch');
    insert into public.wallet_issue_resolution_requests (
      request_id, intake_id, case_id, actor_discord_user_id,
      resolution, request_hash, result
    ) values (
      p_request_id, v_intake.id, p_case_id, v_actor_id,
      p_resolution, v_request_hash, v_result
    );
    return v_result || jsonb_build_object('idempotentReplay', false);
  end if;

  if p_resolution = 'accept_correction' then
    select coalesce(max(correction.version), 0) + 1
    into v_correction_version
    from public.winner_recipient_corrections correction
    where correction.claim_id = v_claim.id;
    update public.winner_recipient_corrections
    set status = 'superseded', resolved_at = v_now
    where claim_id = v_claim.id and status in ('pending', 'ready');
    insert into public.winner_recipient_corrections (
      claim_id, version, case_reference, reported_at,
      proposed_recipient, status, actor_discord_user_id,
      created_at
    ) values (
      v_claim.id, v_correction_version,
      'wallet-issue:' || v_intake.id::text, v_intake.submitted_at,
      v_intake.desired_recipient, 'ready', v_actor_id,
      v_now
    );
  end if;

  update public.winner_claims
  set status = 'unclaimed', version = version + 1,
      claim_deadline_at = v_now + interval '24 hours',
      correction_ready_at = case when p_resolution = 'accept_correction'
        then v_now else correction_ready_at end,
      expired_at = null, updated_at = v_now
  where id = v_claim.id;
  update public.winner_public_profiles
  set wallet_address = null, claim_expired = false
  where cycle_id = v_claim.cycle_id and submission_id = v_claim.submission_id;
  insert into public.winner_claim_events (
    claim_id, actor_type, actor_discord_user_id, action,
    from_status, to_status, correction_version,
    case_reference, occurred_at
  ) values (
    v_claim.id, 'team', v_actor_id,
    case when p_resolution = 'accept_correction'
      then 'correction_ready' else 'wallet_issue_no_action' end,
    'correction_pending', 'unclaimed',
    case when p_resolution = 'accept_correction' then v_correction_version else null end,
    'wallet-issue:' || v_intake.id::text, v_now
  );

  update public.wallet_issue_intakes
  set status = 'resolved', version = version + 1,
      resolution_outcome = p_resolution, resolved_at = v_now,
      screenshot_data = null,
      screenshot_purged_at = case when screenshot_mime is not null
        then v_now else null end
  where id = v_intake.id
  returning * into v_intake;

  v_notification_id := public.enqueue_account_notification_event(
    'wallet-issue-resolution:' || v_intake.id::text,
    case when p_resolution = 'accept_correction'
      then 'wallet_issue_correction_ready' else 'wallet_issue_resolved' end,
    'wallet_issues', v_intake.owner_discord_user_id,
    '/my-profile/winnings/' || v_claim.id::text,
    public.resolve_account_notification_visibility(
      v_intake.owner_discord_user_id, 'wallet_issues'
    )
  );
  select coalesce(nullif(btrim(current_discord_username), ''), 'Team member')
  into v_actor_display from public.user_logs where discord_user_id = v_actor_id;
  update public.team_inbox_cases
  set status = 'solved', source_version = v_intake.version,
      row_version = row_version + 1, solved_at = v_now, updated_at = v_now
  where id = v_case.id returning * into v_case;
  insert into public.team_inbox_timeline_events (
    case_id, event_type, work_version, row_version,
    actor_discord_user_id, actor_display_snapshot, actor_role_snapshot,
    capability_context, source_version, outcome_code, bounded_note, created_at
  ) values
    (v_case.id, 'topic_action', v_case.work_version, v_case.row_version,
      v_actor_id, coalesce(v_actor_display, 'Team member'), v_role,
      jsonb_build_object('topicKey', 'wallet_issues', 'access', 'action'),
      v_intake.version, p_resolution, nullif(btrim(p_note), ''), v_now),
    (v_case.id, 'notification_queued', v_case.work_version, v_case.row_version,
      v_actor_id, coalesce(v_actor_display, 'Team member'), v_role,
      jsonb_build_object('topicKey', 'wallet_issues', 'access', 'action'),
      v_intake.version, 'owner_notification_queued', null, v_now),
    (v_case.id, 'solved', v_case.work_version, v_case.row_version,
      v_actor_id, coalesce(v_actor_display, 'Team member'), v_role,
      jsonb_build_object('topicKey', 'wallet_issues', 'access', 'action'),
      v_intake.version, p_resolution, nullif(btrim(p_note), ''), v_now);

  v_result := jsonb_build_object(
    'outcome', 'resolved', 'resolution', p_resolution,
    'claimStatus', 'unclaimed', 'claimVersion', v_claim.version + 1,
    'deadlineAt', v_now + interval '24 hours',
    'caseRowVersion', v_case.row_version,
    'intakeVersion', v_intake.version,
    'notificationId', v_notification_id
  );
  insert into public.wallet_issue_resolution_requests (
    request_id, intake_id, case_id, actor_discord_user_id,
    resolution, request_hash, result
  ) values (
    p_request_id, v_intake.id, p_case_id, v_actor_id,
    p_resolution, v_request_hash, v_result
  );
  return v_result || jsonb_build_object('idempotentReplay', false);
end;
$function$;

create or replace function public.produce_winner_claim_notification()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  if new.status <> 'not_required' and exists (
    select 1 from public.wallet_issue_intakes intake
    where intake.cycle_id = new.cycle_id
      and intake.submission_id = new.submission_id
      and intake.status = 'held'
  ) then
    return new;
  end if;
  perform public.enqueue_account_notification_event(
    'winner_claim:' || new.id::text,
    case when new.status = 'not_required'
      then 'winner_donation_finalized' else 'winner_claim_required' end,
    'winners_claims', new.winner_discord_user_id,
    '/my-profile/winnings/' || new.id::text, true
  );
  return new;
end;
$function$;

update public.team_inbox_topic_catalog
set is_active = true,
    accepts_new_cases = true,
    activated_at = transaction_timestamp()
where topic_key = 'wallet_issues';

alter function public.finalize_cycle(bigint, text)
  rename to finalize_cycle_without_wallet_issue_intakes;

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
  v_intake public.wallet_issue_intakes%rowtype;
  v_claim public.winner_claims%rowtype;
  v_case_result jsonb;
  v_case_id uuid;
  v_username text;
  v_promoted integer := 0;
  v_not_relevant integer := 0;
begin
  v_result := public.finalize_cycle_without_wallet_issue_intakes(
    p_cycle_id, p_actor_discord_user_id
  );
  select finalized_at into v_finalized_at
  from public.voting_cycles where id = p_cycle_id for update;
  if v_finalized_at is null then
    raise exception using message = 'WALLET_ISSUE_FINALIZATION_TIME_MISSING';
  end if;

  for v_intake in
    select * from public.wallet_issue_intakes
    where cycle_id = p_cycle_id and status = 'held'
    order by submitted_at, id
    for update
  loop
    select * into v_claim from public.winner_claims claim
    where claim.cycle_id = v_intake.cycle_id
      and claim.submission_id = v_intake.submission_id
      and claim.payout_choice in ('keep', 'split')
    for update;
    if found then
      if v_claim.status <> 'unclaimed' then
        raise exception using message = 'WALLET_ISSUE_WINNER_CLAIM_STATE_MISMATCH';
      end if;
      update public.winner_claims
      set status = 'correction_pending', version = version + 1,
          claim_deadline_at = null, updated_at = v_finalized_at
      where id = v_claim.id;
      insert into public.winner_claim_events (
        claim_id, actor_type, action, from_status, to_status,
        case_reference, occurred_at
      ) values (
        v_claim.id, 'system', 'correction_pending',
        'unclaimed', 'correction_pending',
        'wallet-issue:' || v_intake.id::text, v_finalized_at
      );
      select coalesce(nullif(btrim(current_discord_username), ''), 'Account')
      into v_username from public.user_logs
      where discord_user_id = v_intake.owner_discord_user_id;
      v_case_result := public.upsert_team_inbox_case(
        'wallet_issues', 'wallet-issue-intake:' || v_intake.id::text,
        v_intake.version + 1, v_intake.owner_discord_user_id,
        coalesce(v_username, 'Account')
      );
      v_case_id := (v_case_result ->> 'caseId')::uuid;
      update public.wallet_issue_intakes
      set status = 'promoted', version = version + 1,
          winner_claim_id = v_claim.id,
          team_inbox_case_id = v_case_id,
          evaluated_at = v_finalized_at,
          promoted_at = v_finalized_at
      where id = v_intake.id
      returning * into v_intake;
      perform public.enqueue_account_notification_event(
        'wallet-issue-received:' || v_intake.id::text,
        'wallet_issue_received', 'wallet_issues',
        v_intake.owner_discord_user_id,
        '/my-profile/winnings/' || v_claim.id::text,
        public.resolve_account_notification_visibility(
          v_intake.owner_discord_user_id, 'wallet_issues'
        )
      );
      insert into public.team_inbox_timeline_events (
        case_id, event_type, work_version, row_version,
        capability_context, source_version, outcome_code, created_at
      )
      select case_row.id, 'notification_queued',
        case_row.work_version, case_row.row_version,
        jsonb_build_object('topicKey', 'wallet_issues', 'producer', 'finalization'),
        case_row.source_version, 'owner_notification_queued', v_finalized_at
      from public.team_inbox_cases case_row where case_row.id = v_case_id;
      v_promoted := v_promoted + 1;
    else
      update public.wallet_issue_intakes
      set status = 'not_relevant', version = version + 1,
          evaluated_at = v_finalized_at,
          delete_after = v_finalized_at + interval '14 days'
      where id = v_intake.id;
      v_not_relevant := v_not_relevant + 1;
    end if;
  end loop;
  perform public.purge_due_wallet_issue_intakes();
  return v_result || jsonb_build_object(
    'walletIssuePromotedCount', v_promoted,
    'walletIssueNotRelevantCount', v_not_relevant
  );
end;
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
          when 'winner_donation_finalized' then 'Winner result finalized'
          when 'submission_disqualified' then 'Submission disqualified'
          when 'submission_reinstated' then 'Submission restored'
          when 'wallet_issue_received' then 'Wallet issue received'
          when 'wallet_issue_correction_ready' then 'Wallet correction ready'
          when 'wallet_issue_resolved' then 'Wallet issue resolved'
          else 'Cycle results are ready'
        end,
        'body', case event.event_type
          when 'winner_claim_required' then 'Review and confirm your winner claim.'
          when 'winner_donation_finalized' then 'View your finalized winner result.'
          when 'submission_disqualified' then 'View your moderation history for details.'
          when 'submission_reinstated' then 'View your moderation history for details.'
          when 'wallet_issue_received' then 'Your winning-Submission report is ready for Team review.'
          when 'wallet_issue_correction_ready' then 'Review the full recipient and confirm your Claim within 24 hours.'
          when 'wallet_issue_resolved' then 'Review the current recipient and confirm your Claim within 24 hours.'
          else 'View the finalized Cycle results.'
        end,
        'actionLabel', case event.event_type
          when 'winner_claim_required' then 'Review claim'
          when 'winner_donation_finalized' then 'View result'
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

alter table public.wallet_issue_intakes owner to postgres;
alter table public.wallet_issue_intake_requests owner to postgres;
alter table public.wallet_issue_resolution_requests owner to postgres;

alter function public.protect_wallet_issue_intake_delete() owner to postgres;
alter function public.get_own_wallet_issue_intake_request(uuid,uuid) owner to postgres;
alter function public.assert_own_wallet_issue_intake_open(uuid,bigint) owner to postgres;
alter function public.create_own_wallet_issue_intake(uuid,bigint,uuid,text,text,bytea,text,text,integer) owner to postgres;
alter function public.get_own_wallet_issue_intakes(uuid) owner to postgres;
alter function public.purge_due_wallet_issue_intakes() owner to postgres;
alter function public.resolve_wallet_issue_current_candidate(uuid,text) owner to postgres;
alter function public.get_team_wallet_issue_intakes(text,timestamptz,uuid,integer) owner to postgres;
alter function public.get_team_wallet_issue_case_detail(text,uuid) owner to postgres;
alter function public.get_team_wallet_issue_screenshot(text,uuid) owner to postgres;
alter function public.resolve_wallet_issue_case(text,uuid,uuid,text,bigint,bigint,bigint,bigint,bigint,text) owner to postgres;
alter function public.produce_winner_claim_notification() owner to postgres;
alter function public.finalize_cycle_without_wallet_issue_intakes(bigint,text) owner to postgres;
alter function public.finalize_cycle(bigint,text) owner to postgres;
alter function public.get_own_notifications(uuid,timestamptz,uuid,integer) owner to postgres;

revoke all on function public.protect_wallet_issue_intake_delete()
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_own_wallet_issue_intake_request(uuid,uuid)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.assert_own_wallet_issue_intake_open(uuid,bigint)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.create_own_wallet_issue_intake(uuid,bigint,uuid,text,text,bytea,text,text,integer)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_own_wallet_issue_intakes(uuid)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.purge_due_wallet_issue_intakes()
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.resolve_wallet_issue_current_candidate(uuid,text)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_team_wallet_issue_intakes(text,timestamptz,uuid,integer)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_team_wallet_issue_case_detail(text,uuid)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_team_wallet_issue_screenshot(text,uuid)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.resolve_wallet_issue_case(text,uuid,uuid,text,bigint,bigint,bigint,bigint,bigint,text)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.finalize_cycle_without_wallet_issue_intakes(bigint,text)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.finalize_cycle(bigint,text)
  from public, anon, authenticated, discord_bot, service_role;

grant execute on function public.get_own_wallet_issue_intake_request(uuid,uuid) to service_role;
grant execute on function public.assert_own_wallet_issue_intake_open(uuid,bigint) to service_role;
grant execute on function public.create_own_wallet_issue_intake(uuid,bigint,uuid,text,text,bytea,text,text,integer) to service_role;
grant execute on function public.get_own_wallet_issue_intakes(uuid) to service_role;
grant execute on function public.purge_due_wallet_issue_intakes() to service_role;
grant execute on function public.get_team_wallet_issue_intakes(text,timestamptz,uuid,integer) to service_role;
grant execute on function public.get_team_wallet_issue_case_detail(text,uuid) to service_role;
grant execute on function public.get_team_wallet_issue_screenshot(text,uuid) to service_role;
grant execute on function public.resolve_wallet_issue_case(text,uuid,uuid,text,bigint,bigint,bigint,bigint,bigint,text) to service_role;

do $postflight$
declare
  v_signature text;
begin
  if (select count(*) from public.capability_catalog) <> 39
    or (select count(*) from public.capability_catalog where is_active) <> 35
    or exists (
      select 1 from public.team_role_capabilities
      where capability_key = 'winners.recipient_corrections.manage'
    )
    or not exists (
      select 1 from public.team_inbox_topic_catalog
      where topic_key = 'wallet_issues' and is_active and accepts_new_cases
    )
    or not exists (
      select 1 from public.notification_category_catalog
      where category_key = 'wallet_issues' and is_active
        and default_in_product_enabled and in_product_available and push_available
    )
  then
    raise exception using errcode = '55000', message = 'WALLET_ISSUE_INTAKE_POSTFLIGHT_MISMATCH';
  end if;
  foreach v_signature in array array[
    'public.get_own_wallet_issue_intake_request(uuid,uuid)',
    'public.assert_own_wallet_issue_intake_open(uuid,bigint)',
    'public.create_own_wallet_issue_intake(uuid,bigint,uuid,text,text,bytea,text,text,integer)',
    'public.get_own_wallet_issue_intakes(uuid)',
    'public.purge_due_wallet_issue_intakes()',
    'public.get_team_wallet_issue_intakes(text,timestamp with time zone,uuid,integer)',
    'public.get_team_wallet_issue_case_detail(text,uuid)',
    'public.get_team_wallet_issue_screenshot(text,uuid)',
    'public.resolve_wallet_issue_case(text,uuid,uuid,text,bigint,bigint,bigint,bigint,bigint,text)'
  ]
  loop
    if not has_function_privilege('service_role', v_signature, 'EXECUTE')
      or has_function_privilege('anon', v_signature, 'EXECUTE')
      or has_function_privilege('authenticated', v_signature, 'EXECUTE')
      or has_function_privilege('discord_bot', v_signature, 'EXECUTE')
    then
      raise exception using errcode = '55000', message = 'WALLET_ISSUE_FUNCTION_ACL_MISMATCH';
    end if;
  end loop;
  if has_function_privilege(
      'service_role', 'public.resolve_wallet_issue_current_candidate(uuid,text)', 'EXECUTE'
    )
    or has_function_privilege(
      'service_role', 'public.finalize_cycle(bigint,text)', 'EXECUTE'
    )
  then
    raise exception using errcode = '55000', message = 'WALLET_ISSUE_HELPER_ACL_MISMATCH';
  end if;
end;
$postflight$;

comment on table public.wallet_issue_intakes is
  'Private per-Submission Wallet Issue intake held until Cycle finalization; irrelevant rows and screenshot bytes expire after 14 days.';
comment on function public.finalize_cycle(bigint,text) is
  'Preserves canonical Cycle finalization and atomically promotes only held Wallet Issue intakes for the exact winning Submission.';

commit;
