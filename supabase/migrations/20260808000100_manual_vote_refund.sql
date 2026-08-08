begin;

set local lock_timeout = '5s';
set local statement_timeout = '45s';

do $preflight$
begin
  if (select count(*) from public.capability_catalog) <> 28
    or (select count(*) from public.capability_catalog where is_active) <> 26
    or (
      select count(*)
      from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 26 then
    raise exception using
      errcode = '55000',
      message = 'VOTE_REFUND_CAPABILITY_BASELINE_MISMATCH';
  end if;

  if to_regclass('public.votes') is null
    or to_regclass('public.submissions') is null
    or to_regclass('public.voting_cycles') is null
    or to_regclass('public.team_members') is null
    or to_regclass('public.team_roles') is null
    or to_regclass('public.team_role_capabilities') is null
    or to_regclass('public.user_logs') is null
    or to_regprocedure('extensions.digest(bytea,text)') is null
    or not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'votes'
        and column_name = 'created_at'
        and data_type = 'timestamp with time zone'
        and is_nullable = 'NO'
    ) then
    raise exception using
      errcode = '55000',
      message = 'VOTE_REFUND_DEPENDENCY_MISMATCH';
  end if;

  if exists (
      select 1
      from public.capability_catalog
      where key in ('votes.refund_disqualified', 'logs.vote_refunds.view')
    )
    or exists (
      select 1
      from public.team_role_capabilities
      where capability_key in (
        'votes.refund_disqualified',
        'logs.vote_refunds.view'
      )
    )
    or to_regclass('public.vote_refund_events') is not null
    or to_regclass('public.vote_refund_items') is not null
    or to_regclass('public.vote_refund_candidates') is not null
    or to_regprocedure(
      'public.refund_disqualified_votes(text,bigint,integer,integer,jsonb,text,uuid)'
    ) is not null then
    raise exception using
      errcode = '55000',
      message = 'VOTE_REFUND_TARGET_ALREADY_PRESENT';
  end if;
end;
$preflight$;

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
values
(
  'votes.refund_disqualified',
  'Refund Disqualified Submission Votes',
  'Selectively refund canonical votes from explicitly selected disqualified submissions only during the current open voting phase.',
  'Vote Moderation',
  array[
    'View current-voting disqualified submissions and the refundable vote counts required for this action.',
    'Select one or more disqualified submissions and atomically refund only their current canonical votes.',
    'Return one available vote slot per refunded vote under the cycle''s unchanged votes-per-user setting.'
  ]::text[],
  array[
    'Automatically refunding votes when a submission is disqualified or refunding every disqualified submission without explicit selection.',
    'Disqualifying or reinstating submissions, restoring refunded votes, changing vote limits, editing votes, or repairing historical cycles.',
    'Refunding eligible submissions or acting during paused, closed, finalizing, finished, draft, or historical cycle states.',
    'Viewing refund history, individual voter identities, raw vote logs, observation details, or abuse-detection signals.'
  ]::text[],
  'critical',
  true,
  true,
  1,
  'bd49530c7905d71661f47b343ca8de9251d47c6c7712e84494563075ba8e68ab'
),
(
  'logs.vote_refunds.view',
  'View Vote Refund History',
  'View the redacted append-only history of successful manual vote refunds without access to individual voter records.',
  'Logs',
  array[
    'View paginated successful manual vote-refund events.',
    'View each event''s actor, cycle attempt, selected submission references, refunded vote counts, broad reason category, and timestamp.'
  ]::text[],
  array[
    'Executing vote refunds or changing submissions, cycles, or votes.',
    'Viewing voter identifiers, original vote identifiers or timestamps, free-text reasons, request hashes, idempotency data, or raw payloads.',
    'Viewing vote-attempt, cluster, network, device, abuse-detection, observation, or unrelated logs.'
  ]::text[],
  'high',
  true,
  true,
  1,
  'd973a6edb746cd7740a5dd8142b34aad2be21ed60d66d0cf64a1ee2df1a67619'
);

create table public.vote_refund_events (
  idempotency_key uuid primary key,
  operation_version integer not null default 1,
  request_hash text not null,
  actor_discord_user_id text not null,
  actor_role text not null,
  actor_discord_username text not null,
  required_capability text not null,
  cycle_id bigint not null,
  reset_count integer not null,
  votes_per_user integer not null,
  selection_count integer not null,
  refunded_vote_count integer not null,
  affected_voter_count integer not null,
  selected_submission_ids bigint[] not null,
  submission_refunds jsonb not null,
  reason_code text not null,
  reason_text text not null,
  result jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint vote_refund_events_operation_version_check
    check (operation_version = 1),
  constraint vote_refund_events_request_hash_check
    check (request_hash ~ '^[0-9a-f]{64}$'),
  constraint vote_refund_events_actor_check
    check (
      char_length(btrim(actor_discord_user_id)) between 1 and 100
      and char_length(btrim(actor_role)) between 1 and 100
      and char_length(btrim(actor_discord_username)) between 1 and 200
    ),
  constraint vote_refund_events_capability_check
    check (required_capability = 'votes.refund_disqualified'),
  constraint vote_refund_events_cycle_check
    check (
      cycle_id > 0
      and reset_count >= 0
      and votes_per_user between 1 and 10
    ),
  constraint vote_refund_events_count_check
    check (
      selection_count between 1 and 100
      and refunded_vote_count between 1 and 10000
      and affected_voter_count between 1 and refunded_vote_count
      and cardinality(selected_submission_ids) = selection_count
    ),
  constraint vote_refund_events_submission_ids_check
    check (0 < all(selected_submission_ids)),
  constraint vote_refund_events_submission_refunds_check
    check (jsonb_typeof(submission_refunds) = 'array'),
  constraint vote_refund_events_reason_check
    check (
      reason_code = 'confirmed_disqualification'
      and char_length(btrim(reason_text)) between 3 and 1000
    ),
  constraint vote_refund_events_result_check
    check (jsonb_typeof(result) = 'object')
);

create table public.vote_refund_items (
  refund_id uuid not null
    references public.vote_refund_events(idempotency_key) on delete restrict,
  original_vote_id bigint not null,
  cycle_id bigint not null,
  reset_count integer not null,
  submission_id bigint not null,
  voter_discord_user_id text not null,
  vote_created_at timestamptz not null,
  primary key (refund_id, original_vote_id),
  unique (original_vote_id),
  constraint vote_refund_items_identity_check
    check (
      original_vote_id > 0
      and cycle_id > 0
      and reset_count >= 0
      and submission_id > 0
      and char_length(btrim(voter_discord_user_id)) between 1 and 100
    )
);

alter table public.vote_refund_events owner to postgres;
alter table public.vote_refund_items owner to postgres;
alter table public.vote_refund_events enable row level security;
alter table public.vote_refund_items enable row level security;

create function public.protect_vote_refund_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  raise exception using
    errcode = '55000',
    message = 'VOTE_REFUND_AUDIT_IS_APPEND_ONLY';
end;
$function$;

alter function public.protect_vote_refund_audit() owner to postgres;
revoke all on function public.protect_vote_refund_audit()
  from public, anon, authenticated, discord_bot, service_role;

create trigger vote_refund_events_append_only
before update or delete on public.vote_refund_events
for each row execute function public.protect_vote_refund_audit();

create trigger vote_refund_items_append_only
before update or delete on public.vote_refund_items
for each row execute function public.protect_vote_refund_audit();

create index vote_refund_events_history_idx
  on public.vote_refund_events (created_at desc, idempotency_key desc);
create index vote_refund_events_cycle_attempt_idx
  on public.vote_refund_events (cycle_id, reset_count, created_at desc);
create index vote_refund_items_refund_submission_idx
  on public.vote_refund_items (refund_id, submission_id, original_vote_id);

create view public.vote_refund_candidates
with (security_invoker = true, security_barrier = true)
as
select
  submission.cycle_id,
  submission.id as submission_id,
  submission.r2_key,
  submission.disqualification_type,
  submission.disqualified_at,
  count(vote.id)::integer as refundable_vote_count
from public.submissions submission
join public.votes vote
  on vote.cycle_id = submission.cycle_id
 and vote.submission_id = submission.id
where coalesce(submission.is_disqualified, false)
  and submission.disqualified_at is not null
group by
  submission.cycle_id,
  submission.id,
  submission.r2_key,
  submission.disqualification_type,
  submission.disqualified_at
having count(vote.id) > 0;

alter view public.vote_refund_candidates owner to postgres;

create function public.refund_disqualified_votes(
  p_actor_discord_user_id text,
  p_cycle_id bigint,
  p_expected_reset_count integer,
  p_expected_votes_per_user integer,
  p_selections jsonb,
  p_reason_text text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor_id text := btrim(p_actor_discord_user_id);
  v_reason_text text := btrim(p_reason_text);
  v_required_capability constant text := 'votes.refund_disqualified';
  v_expected_capability_hash constant text :=
    'bd49530c7905d71661f47b343ca8de9251d47c6c7712e84494563075ba8e68ab';
  v_actor_role text;
  v_actor_username text;
  v_cycle public.voting_cycles%rowtype;
  v_submission public.submissions%rowtype;
  v_item jsonb;
  v_submission_ids bigint[] := '{}'::bigint[];
  v_expected_counts integer[] := '{}'::integer[];
  v_expected_disqualified_times timestamptz[] := '{}'::timestamptz[];
  v_submission_id bigint;
  v_expected_count integer;
  v_expected_disqualified_at timestamptz;
  v_canonical_selections jsonb;
  v_request_payload jsonb;
  v_request_hash text;
  v_existing_hash text;
  v_existing_result jsonb;
  v_submission_refunds jsonb := '[]'::jsonb;
  v_refunded_vote_count integer := 0;
  v_affected_voter_count integer := 0;
  v_inserted_item_count integer := 0;
  v_deleted_vote_count integer := 0;
  v_result jsonb;
  v_index integer;
begin
  if p_idempotency_key is null
    or nullif(v_actor_id, '') is null
    or char_length(v_actor_id) > 100
    or p_cycle_id is null
    or p_cycle_id <= 0
    or p_expected_reset_count is null
    or p_expected_reset_count < 0
    or p_expected_votes_per_user is null
    or p_expected_votes_per_user not between 1 and 10
    or jsonb_typeof(p_selections) <> 'array'
    or jsonb_array_length(p_selections) not between 1 and 100
    or nullif(v_reason_text, '') is null
    or char_length(v_reason_text) not between 3 and 1000 then
    raise exception using
      errcode = '22023',
      message = 'INVALID_VOTE_REFUND_REQUEST';
  end if;

  for v_item in select value from jsonb_array_elements(p_selections)
  loop
    if jsonb_typeof(v_item) <> 'object'
      or (select count(*) from jsonb_object_keys(v_item)) <> 3
      or exists (
        select 1
        from jsonb_object_keys(v_item) key
        where key not in (
          'submissionId',
          'expectedVoteCount',
          'expectedDisqualifiedAt'
        )
      )
      or jsonb_typeof(v_item -> 'submissionId') <> 'number'
      or (v_item ->> 'submissionId') !~ '^[1-9][0-9]{0,18}$'
      or jsonb_typeof(v_item -> 'expectedVoteCount') <> 'number'
      or (v_item ->> 'expectedVoteCount') !~ '^[1-9][0-9]{0,4}$'
      or jsonb_typeof(v_item -> 'expectedDisqualifiedAt') <> 'string'
      or char_length(v_item ->> 'expectedDisqualifiedAt') not between 10 and 64
    then
      raise exception using
        errcode = '22023',
        message = 'INVALID_VOTE_REFUND_REQUEST';
    end if;

    v_submission_id := (v_item ->> 'submissionId')::bigint;
    v_expected_count := (v_item ->> 'expectedVoteCount')::integer;
    if v_expected_count > 10000 then
      raise exception using
        errcode = '54000',
        message = 'VOTE_REFUND_LIMIT_EXCEEDED';
    end if;

    begin
      v_expected_disqualified_at :=
        (v_item ->> 'expectedDisqualifiedAt')::timestamptz;
    exception when others then
      raise exception using
        errcode = '22023',
        message = 'INVALID_VOTE_REFUND_REQUEST';
    end;

    if v_submission_id = any(v_submission_ids) then
      raise exception using
        errcode = '22023',
        message = 'INVALID_VOTE_REFUND_REQUEST';
    end if;

    v_submission_ids := array_append(v_submission_ids, v_submission_id);
    v_expected_counts := array_append(v_expected_counts, v_expected_count);
    v_expected_disqualified_times := array_append(
      v_expected_disqualified_times,
      v_expected_disqualified_at
    );
  end loop;

  if (select sum(value) from unnest(v_expected_counts) value) > 10000 then
    raise exception using
      errcode = '54000',
      message = 'VOTE_REFUND_LIMIT_EXCEEDED';
  end if;

  select
    array_agg(selection.submission_id order by selection.submission_id),
    array_agg(selection.expected_vote_count order by selection.submission_id),
    array_agg(
      selection.expected_disqualified_at
      order by selection.submission_id
    )
  into
    v_submission_ids,
    v_expected_counts,
    v_expected_disqualified_times
  from unnest(
    v_submission_ids,
    v_expected_counts,
    v_expected_disqualified_times
  ) selection(
    submission_id,
    expected_vote_count,
    expected_disqualified_at
  );

  select jsonb_agg(
    jsonb_build_object(
      'submissionId', selection.submission_id,
      'expectedVoteCount', selection.expected_vote_count,
      'expectedDisqualifiedAt', selection.expected_disqualified_at
    )
    order by selection.submission_id
  )
  into v_canonical_selections
  from unnest(
    v_submission_ids,
    v_expected_counts,
    v_expected_disqualified_times
  ) selection(
    submission_id,
    expected_vote_count,
    expected_disqualified_at
  );

  v_request_payload := jsonb_build_object(
    'operationVersion', 1,
    'actorDiscordUserId', v_actor_id,
    'cycleId', p_cycle_id,
    'expectedResetCount', p_expected_reset_count,
    'expectedVotesPerUser', p_expected_votes_per_user,
    'selections', v_canonical_selections,
    'reasonCode', 'confirmed_disqualification',
    'reasonText', v_reason_text
  );
  v_request_hash := encode(
    extensions.digest(
      convert_to(v_request_payload::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  perform pg_advisory_xact_lock(
    hashtextextended('vote-refund:' || p_idempotency_key::text, 0)
  );

  select request_hash, result
  into v_existing_hash, v_existing_result
  from public.vote_refund_events
  where idempotency_key = p_idempotency_key;

  if found then
    if v_existing_hash = v_request_hash then
      return jsonb_set(v_existing_result, '{replayed}', 'true'::jsonb);
    end if;

    raise exception using
      errcode = 'PT409',
      message = 'VOTE_REFUND_IDEMPOTENCY_CONFLICT';
  end if;

  if not exists (
    select 1
    from public.capability_catalog capability
    where capability.key = v_required_capability
      and capability.is_active
      and capability.assignable_to_non_admin
      and capability.implementation_version = 1
      and capability.definition_hash = v_expected_capability_hash
  ) then
    raise exception using
      errcode = '55000',
      message = 'VOTE_REFUND_AUTHORIZATION_DEPENDENCY_UNAVAILABLE';
  end if;

  select
    member.role,
    coalesce(
      nullif(btrim(actor_log.current_discord_username), ''),
      nullif(btrim(member.discord_username), ''),
      v_actor_id
    )
  into v_actor_role, v_actor_username
  from public.team_members member
  join public.team_roles role
    on role.key = member.role
   and role.is_active
  left join public.user_logs actor_log
    on actor_log.discord_user_id = member.discord_user_id
  where member.discord_user_id = v_actor_id;

  if not found
    or (
      v_actor_role <> 'admin'
      and not exists (
        select 1
        from public.team_role_capabilities grant_row
        where grant_row.role_key = v_actor_role
          and grant_row.capability_key = v_required_capability
      )
    ) then
    raise exception using
      errcode = '42501',
      message = 'VOTE_REFUND_FORBIDDEN';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('cycle-phase-automation-global', 0)
  );

  select cycle.*
  into v_cycle
  from public.voting_cycles cycle
  where cycle.id = p_cycle_id
  for update;

  if not found then
    raise exception using
      errcode = 'PT409',
      message = 'VOTE_REFUND_CYCLE_NOT_FOUND';
  end if;

  if v_cycle.status::text <> 'voting_open' then
    raise exception using
      errcode = 'PT409',
      message = 'VOTE_REFUND_PHASE_CLOSED';
  end if;

  if v_cycle.reset_count <> p_expected_reset_count then
    raise exception using
      errcode = 'PT409',
      message = 'VOTE_REFUND_CYCLE_ATTEMPT_CONFLICT';
  end if;

  if v_cycle.votes_per_user <> p_expected_votes_per_user then
    raise exception using
      errcode = 'PT409',
      message = 'VOTE_REFUND_VOTE_LIMIT_CONFLICT';
  end if;

  for v_index in 1..cardinality(v_submission_ids)
  loop
    select submission.*
    into v_submission
    from public.submissions submission
    where submission.id = v_submission_ids[v_index]
    for update;

    if not found then
      raise exception using
        errcode = 'PT409',
        message = 'VOTE_REFUND_SUBMISSION_NOT_FOUND';
    end if;

    if v_submission.cycle_id is distinct from p_cycle_id then
      raise exception using
        errcode = 'PT409',
        message = 'VOTE_REFUND_SUBMISSION_CYCLE_CONFLICT';
    end if;

    if not coalesce(v_submission.is_disqualified, false) then
      raise exception using
        errcode = 'PT409',
        message = 'VOTE_REFUND_SUBMISSION_NOT_DISQUALIFIED';
    end if;

    if v_submission.disqualified_at is distinct from
      v_expected_disqualified_times[v_index] then
      raise exception using
        errcode = 'PT409',
        message = 'VOTE_REFUND_DISQUALIFICATION_CONFLICT';
    end if;

    select count(*)::integer
    into v_expected_count
    from public.votes vote
    where vote.cycle_id = p_cycle_id
      and vote.submission_id = v_submission.id;

    if v_expected_count = 0 then
      raise exception using
        errcode = 'PT409',
        message = 'VOTE_REFUND_NOTHING_TO_REFUND';
    end if;

    if v_expected_count <> v_expected_counts[v_index] then
      raise exception using
        errcode = 'PT409',
        message = 'VOTE_REFUND_COUNT_CONFLICT';
    end if;

    v_refunded_vote_count := v_refunded_vote_count + v_expected_count;
    v_submission_refunds := v_submission_refunds || jsonb_build_array(
      jsonb_build_object(
        'submissionId', v_submission.id,
        'refundedVoteCount', v_expected_count
      )
    );
  end loop;

  if v_refunded_vote_count > 10000 then
    raise exception using
      errcode = '54000',
      message = 'VOTE_REFUND_LIMIT_EXCEEDED';
  end if;

  perform vote.id
  from public.votes vote
  where vote.cycle_id = p_cycle_id
    and vote.submission_id = any(v_submission_ids)
  order by vote.id
  for update;

  select count(distinct vote.discord_user_id)::integer
  into v_affected_voter_count
  from public.votes vote
  where vote.cycle_id = p_cycle_id
    and vote.submission_id = any(v_submission_ids);

  v_result := jsonb_build_object(
    'requestId', p_idempotency_key,
    'cycleId', p_cycle_id,
    'resetCount', v_cycle.reset_count,
    'votesPerUser', v_cycle.votes_per_user,
    'selectionCount', cardinality(v_submission_ids),
    'refundedVoteCount', v_refunded_vote_count,
    'affectedVoterCount', v_affected_voter_count,
    'submissionRefunds', v_submission_refunds,
    'replayed', false
  );

  insert into public.vote_refund_events (
    idempotency_key,
    operation_version,
    request_hash,
    actor_discord_user_id,
    actor_role,
    actor_discord_username,
    required_capability,
    cycle_id,
    reset_count,
    votes_per_user,
    selection_count,
    refunded_vote_count,
    affected_voter_count,
    selected_submission_ids,
    submission_refunds,
    reason_code,
    reason_text,
    result
  ) values (
    p_idempotency_key,
    1,
    v_request_hash,
    v_actor_id,
    v_actor_role,
    v_actor_username,
    v_required_capability,
    p_cycle_id,
    v_cycle.reset_count,
    v_cycle.votes_per_user,
    cardinality(v_submission_ids),
    v_refunded_vote_count,
    v_affected_voter_count,
    v_submission_ids,
    v_submission_refunds,
    'confirmed_disqualification',
    v_reason_text,
    v_result
  );

  insert into public.vote_refund_items (
    refund_id,
    original_vote_id,
    cycle_id,
    reset_count,
    submission_id,
    voter_discord_user_id,
    vote_created_at
  )
  select
    p_idempotency_key,
    vote.id,
    vote.cycle_id,
    v_cycle.reset_count,
    vote.submission_id,
    vote.discord_user_id,
    vote.created_at
  from public.votes vote
  where vote.cycle_id = p_cycle_id
    and vote.submission_id = any(v_submission_ids)
  order by vote.id;
  get diagnostics v_inserted_item_count = row_count;

  delete from public.votes vote
  where vote.cycle_id = p_cycle_id
    and vote.submission_id = any(v_submission_ids);
  get diagnostics v_deleted_vote_count = row_count;

  if v_inserted_item_count <> v_refunded_vote_count
    or v_deleted_vote_count <> v_refunded_vote_count then
    raise exception using
      errcode = '55000',
      message = 'VOTE_REFUND_ATOMIC_COUNT_MISMATCH';
  end if;

  return v_result;
end;
$function$;

alter function public.refund_disqualified_votes(
  text, bigint, integer, integer, jsonb, text, uuid
) owner to postgres;

revoke all on table public.vote_refund_events
  from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.vote_refund_items
  from public, anon, authenticated, discord_bot, service_role;
grant select on table public.vote_refund_events to service_role;
grant select on table public.vote_refund_items to service_role;

revoke all on table public.vote_refund_candidates
  from public, anon, authenticated, discord_bot, service_role;
grant select on table public.vote_refund_candidates to service_role;

revoke all on function public.refund_disqualified_votes(
  text, bigint, integer, integer, jsonb, text, uuid
) from public, anon, authenticated, discord_bot, service_role;
grant execute on function public.refund_disqualified_votes(
  text, bigint, integer, integer, jsonb, text, uuid
) to service_role;

revoke all on table public.votes from service_role;
grant select on table public.votes to service_role;
revoke all on sequence public.votes_id_seq from service_role;

do $postflight$
declare
  v_refund_signature regprocedure :=
    'public.refund_disqualified_votes(text,bigint,integer,integer,jsonb,text,uuid)'::regprocedure;
begin
  if (select count(*) from public.capability_catalog) <> 30
    or (select count(*) from public.capability_catalog where is_active) <> 28
    or (
      select count(*)
      from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 28
    or not exists (
      select 1
      from public.capability_catalog
      where key = 'votes.refund_disqualified'
        and risk_level = 'critical'
        and is_active
        and assignable_to_non_admin
        and implementation_version = 1
        and definition_hash =
          'bd49530c7905d71661f47b343ca8de9251d47c6c7712e84494563075ba8e68ab'
    )
    or not exists (
      select 1
      from public.capability_catalog
      where key = 'logs.vote_refunds.view'
        and risk_level = 'high'
        and is_active
        and assignable_to_non_admin
        and implementation_version = 1
        and definition_hash =
          'd973a6edb746cd7740a5dd8142b34aad2be21ed60d66d0cf64a1ee2df1a67619'
    )
    or exists (
      select 1
      from public.team_role_capabilities
      where capability_key in (
        'votes.refund_disqualified',
        'logs.vote_refunds.view'
      )
    ) then
    raise exception using
      errcode = '55000',
      message = 'VOTE_REFUND_CAPABILITY_POSTFLIGHT_MISMATCH';
  end if;

  if (
      select count(*)
      from pg_proc procedure_row
      join pg_namespace namespace_row
        on namespace_row.oid = procedure_row.pronamespace
      where namespace_row.nspname = 'public'
        and procedure_row.proname = 'refund_disqualified_votes'
    ) <> 1
    or not exists (
      select 1
      from pg_proc procedure_row
      where procedure_row.oid = v_refund_signature
        and pg_get_userbyid(procedure_row.proowner) = 'postgres'
        and procedure_row.prosecdef
        and procedure_row.proconfig = array['search_path=public, pg_temp']
    )
    or exists (
      select 1
      from pg_proc procedure_row
      cross join lateral aclexplode(
        coalesce(
          procedure_row.proacl,
          acldefault('f', procedure_row.proowner)
        )
      ) privilege_row
      where procedure_row.oid = v_refund_signature
        and privilege_row.grantee = 0
        and privilege_row.privilege_type = 'EXECUTE'
    )
    or has_function_privilege('anon', v_refund_signature, 'EXECUTE')
    or has_function_privilege('authenticated', v_refund_signature, 'EXECUTE')
    or has_function_privilege('discord_bot', v_refund_signature, 'EXECUTE')
    or not has_function_privilege('service_role', v_refund_signature, 'EXECUTE')
  then
    raise exception using
      errcode = '55000',
      message = 'VOTE_REFUND_FUNCTION_POSTFLIGHT_MISMATCH';
  end if;

  if not exists (
      select 1
      from pg_class relation
      where relation.oid = 'public.vote_refund_events'::regclass
        and relation.relrowsecurity
        and pg_get_userbyid(relation.relowner) = 'postgres'
    )
    or not exists (
      select 1
      from pg_class relation
      where relation.oid = 'public.vote_refund_items'::regclass
        and relation.relrowsecurity
        and pg_get_userbyid(relation.relowner) = 'postgres'
    )
    or (
      select count(*)
      from information_schema.role_table_grants grant_row
      where grant_row.table_schema = 'public'
        and grant_row.table_name in (
          'vote_refund_events',
          'vote_refund_items',
          'vote_refund_candidates'
        )
        and grant_row.grantee = 'service_role'
        and grant_row.privilege_type = 'SELECT'
    ) <> 3
    or exists (
      select 1
      from information_schema.role_table_grants grant_row
      where grant_row.table_schema = 'public'
        and grant_row.table_name in (
          'vote_refund_events',
          'vote_refund_items',
          'vote_refund_candidates'
        )
        and (
          grant_row.grantee in ('anon', 'authenticated', 'discord_bot')
          or (
            grant_row.grantee = 'service_role'
            and grant_row.privilege_type <> 'SELECT'
          )
        )
    )
    or (
      select count(*)
      from information_schema.role_table_grants grant_row
      where grant_row.table_schema = 'public'
        and grant_row.table_name = 'votes'
        and grant_row.grantee = 'service_role'
    ) <> 1
    or not has_table_privilege('service_role', 'public.votes', 'SELECT')
    or has_table_privilege('service_role', 'public.votes', 'INSERT')
    or has_table_privilege('service_role', 'public.votes', 'UPDATE')
    or has_table_privilege('service_role', 'public.votes', 'DELETE')
  then
    raise exception using
      errcode = '55000',
      message = 'VOTE_REFUND_ACL_POSTFLIGHT_MISMATCH';
  end if;

  if (
      select count(*)
      from pg_trigger trigger_row
      where trigger_row.tgrelid in (
        'public.vote_refund_events'::regclass,
        'public.vote_refund_items'::regclass
      )
        and not trigger_row.tgisinternal
        and trigger_row.tgenabled = 'O'
    ) <> 2 then
    raise exception using
      errcode = '55000',
      message = 'VOTE_REFUND_APPEND_ONLY_POSTFLIGHT_MISMATCH';
  end if;
end;
$postflight$;

comment on table public.vote_refund_events is
  'Append-only idempotency ledger and batch audit for successful selective manual vote refunds.';
comment on table public.vote_refund_items is
  'Append-only server-only copy of every canonical vote removed by a successful manual refund.';
comment on view public.vote_refund_candidates is
  'Server-only current data projection of disqualified submissions that still hold refundable canonical votes.';
comment on function public.refund_disqualified_votes(
  text, bigint, integer, integer, jsonb, text, uuid
) is
  'Atomically authorizes and refunds only explicitly selected disqualified-submission votes in voting_open, preserving a complete append-only audit copy; service role only.';

commit;
