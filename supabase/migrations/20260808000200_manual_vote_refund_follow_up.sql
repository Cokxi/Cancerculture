begin;

set local lock_timeout = '5s';
set local statement_timeout = '45s';

do $preflight$
begin
  if (select count(*) from public.capability_catalog) <> 30
    or not exists (
      select 1
      from public.capability_catalog
      where key = 'logs.vote_refunds.view'
        and is_active
        and assignable_to_non_admin
        and implementation_version = 1
        and definition_hash =
          'd973a6edb746cd7740a5dd8142b34aad2be21ed60d66d0cf64a1ee2df1a67619'
    )
    or not exists (
      select 1
      from public.capability_catalog
      where key = 'votes.refund_disqualified'
        and is_active
        and assignable_to_non_admin
        and implementation_version = 1
        and definition_hash =
          'bd49530c7905d71661f47b343ca8de9251d47c6c7712e84494563075ba8e68ab'
    )
    or to_regclass('public.vote_refund_events') is null
    or to_regclass('public.vote_refund_items') is null
    or to_regprocedure(
      'public.refund_disqualified_votes(text,bigint,integer,integer,jsonb,text,uuid)'
    ) is null
    or exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'submissions'
        and column_name in ('vote_refund_id', 'vote_refunded_at')
    )
    or to_regclass('public.vote_refund_submission_audit') is not null
    or to_regprocedure(
      'public.protect_submission_vote_refund_state()'
    ) is not null then
    raise exception using
      errcode = '55000',
      message = 'VOTE_REFUND_FOLLOW_UP_BASELINE_MISMATCH';
  end if;

  if exists (
      select item.submission_id
      from public.vote_refund_items item
      group by item.submission_id
      having count(distinct item.refund_id) > 1
    )
    or exists (
      select 1
      from public.vote_refund_items item
      join public.submissions submission on submission.id = item.submission_id
      where submission.cycle_id is distinct from item.cycle_id
        or not coalesce(submission.is_disqualified, false)
    ) then
    raise exception using
      errcode = '55000',
      message = 'VOTE_REFUND_FOLLOW_UP_DATA_CONFLICT';
  end if;
end;
$preflight$;

alter table public.vote_refund_events
  alter column reason_text drop not null,
  drop constraint vote_refund_events_reason_check,
  add constraint vote_refund_events_reason_check
    check (
      reason_code = 'confirmed_disqualification'
      and (
        reason_text is null
        or char_length(btrim(reason_text)) between 3 and 1000
      )
    );

alter table public.submissions
  add column vote_refund_id uuid,
  add column vote_refunded_at timestamptz,
  add constraint submissions_vote_refund_pair_check
    check (
      (vote_refund_id is null and vote_refunded_at is null)
      or (vote_refund_id is not null and vote_refunded_at is not null)
    ),
  add constraint submissions_vote_refund_event_fkey
    foreign key (vote_refund_id)
    references public.vote_refund_events(idempotency_key)
    on delete restrict;

with refund_context as (
  select distinct on (item.submission_id)
    item.submission_id,
    item.refund_id,
    event.created_at
  from public.vote_refund_items item
  join public.vote_refund_events event
    on event.idempotency_key = item.refund_id
  order by item.submission_id, event.created_at, item.refund_id
)
update public.submissions submission
set vote_refund_id = refund_context.refund_id,
    vote_refunded_at = refund_context.created_at
from refund_context
where submission.id = refund_context.submission_id;

create index submissions_vote_refund_id_idx
  on public.submissions (vote_refund_id)
  where vote_refund_id is not null;

create function public.protect_submission_vote_refund_state()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $function$
begin
  if tg_op = 'INSERT' then
    if new.vote_refund_id is not null
      or new.vote_refunded_at is not null then
      raise exception using
        errcode = '55000',
        message = 'INVALID_SUBMISSION_VOTE_REFUND_MARKER';
    end if;
    return new;
  end if;

  if old.vote_refund_id is not null then
    if new.vote_refund_id is distinct from old.vote_refund_id
      or new.vote_refunded_at is distinct from old.vote_refunded_at
      or new.is_disqualified is distinct from true then
      raise exception using
        errcode = 'PT409',
        message = 'VOTE_REFUNDED_SUBMISSION_REINSTATEMENT_BLOCKED';
    end if;
    return new;
  end if;

  if new.vote_refund_id is not null then
    if new.vote_refunded_at is null
      or new.is_disqualified is distinct from true
      or not exists (
        select 1
        from public.vote_refund_events event
        join public.vote_refund_items item
          on item.refund_id = event.idempotency_key
         and item.submission_id = new.id
         and item.cycle_id = new.cycle_id
        where event.idempotency_key = new.vote_refund_id
          and event.created_at = new.vote_refunded_at
      ) then
      raise exception using
        errcode = '55000',
        message = 'INVALID_SUBMISSION_VOTE_REFUND_MARKER';
    end if;
  elsif new.vote_refunded_at is not null then
    raise exception using
      errcode = '55000',
      message = 'INVALID_SUBMISSION_VOTE_REFUND_MARKER';
  end if;

  return new;
end;
$function$;

alter function public.protect_submission_vote_refund_state() owner to postgres;
revoke all on function public.protect_submission_vote_refund_state()
  from public, anon, authenticated, discord_bot, service_role;

create trigger submissions_vote_refund_insert_guard
before insert on public.submissions
for each row execute function public.protect_submission_vote_refund_state();

create trigger submissions_vote_refund_update_guard
before update of is_disqualified, vote_refund_id, vote_refunded_at
on public.submissions
for each row execute function public.protect_submission_vote_refund_state();

create view public.vote_refund_submission_audit
with (security_invoker = true, security_barrier = true)
as
select
  item.refund_id,
  item.cycle_id,
  item.reset_count,
  item.submission_id,
  count(*)::integer as refunded_vote_count,
  array_agg(
    distinct item.voter_discord_user_id
    order by item.voter_discord_user_id
  ) as refunded_voter_ids
from public.vote_refund_items item
group by
  item.refund_id,
  item.cycle_id,
  item.reset_count,
  item.submission_id;

alter view public.vote_refund_submission_audit owner to postgres;
revoke all on table public.vote_refund_submission_audit
  from public, anon, authenticated, discord_bot, service_role;
grant select on table public.vote_refund_submission_audit to service_role;

update public.capability_catalog
set description =
      'View the redacted append-only history of successful manual vote refunds, with individual refunded voters available only when Vote Logs access is also granted.',
    included_actions = array[
      'View successful manual vote refunds grouped by cycle attempt and submission.',
      'View each refunded submission''s current thumbnail when available, submitter, refund actor, refunded vote count, broad reason category, and timestamp.',
      'View individual refunded voter identities only together with the separate View Vote Logs capability.'
    ]::text[],
    excluded_actions = array[
      'Executing vote refunds or changing submissions, cycles, or votes.',
      'Viewing individual refunded voters without the separate View Vote Logs capability.',
      'Viewing free-text audit notes unless the caller is Owner.',
      'Viewing original vote identifiers or timestamps, request hashes, idempotency data, or raw payloads.',
      'Viewing vote-attempt, cluster, network, device, abuse-detection, observation, or unrelated logs.'
    ]::text[],
    implementation_version = 2,
    definition_hash =
      'f3e1102733e29e8338b95f831e89f9f09f7f7af70ce4dfcfce51cba450c358b2'
where key = 'logs.vote_refunds.view'
  and implementation_version = 1
  and definition_hash =
    'd973a6edb746cd7740a5dd8142b34aad2be21ed60d66d0cf64a1ee2df1a67619';

create or replace function public.refund_disqualified_votes(
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
  v_reason_text text := nullif(btrim(coalesce(p_reason_text, '')), '');
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
  v_marked_submission_count integer := 0;
  v_deleted_vote_count integer := 0;
  v_refunded_at timestamptz;
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
    or p_selections is null
    or jsonb_typeof(p_selections) <> 'array'
    or jsonb_array_length(p_selections) not between 1 and 100
    or (
      v_reason_text is not null
      and char_length(v_reason_text) not between 3 and 1000
    ) then
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

    if v_submission.vote_refund_id is not null then
      raise exception using
        errcode = 'PT409',
        message = 'VOTE_REFUND_NOTHING_TO_REFUND';
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
  v_refunded_at := clock_timestamp();

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
    result,
    created_at
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
    v_result,
    v_refunded_at
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

  update public.submissions submission
  set vote_refund_id = p_idempotency_key,
      vote_refunded_at = v_refunded_at
  where submission.cycle_id = p_cycle_id
    and submission.id = any(v_submission_ids)
    and submission.is_disqualified
    and submission.vote_refund_id is null;
  get diagnostics v_marked_submission_count = row_count;

  delete from public.votes vote
  where vote.cycle_id = p_cycle_id
    and vote.submission_id = any(v_submission_ids);
  get diagnostics v_deleted_vote_count = row_count;

  if v_inserted_item_count <> v_refunded_vote_count
    or v_marked_submission_count <> cardinality(v_submission_ids)
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
revoke all on function public.refund_disqualified_votes(
  text, bigint, integer, integer, jsonb, text, uuid
) from public, anon, authenticated, discord_bot, service_role;
grant execute on function public.refund_disqualified_votes(
  text, bigint, integer, integer, jsonb, text, uuid
) to service_role;

do $postflight$
declare
  v_refund_signature regprocedure :=
    'public.refund_disqualified_votes(text,bigint,integer,integer,jsonb,text,uuid)'::regprocedure;
begin
  if not exists (
      select 1
      from public.capability_catalog
      where key = 'logs.vote_refunds.view'
        and is_active
        and assignable_to_non_admin
        and implementation_version = 2
        and definition_hash =
          'f3e1102733e29e8338b95f831e89f9f09f7f7af70ce4dfcfce51cba450c358b2'
    )
    or not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'submissions'
        and column_name = 'vote_refund_id'
        and data_type = 'uuid'
        and is_nullable = 'YES'
    )
    or not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'submissions'
        and column_name = 'vote_refunded_at'
        and data_type = 'timestamp with time zone'
        and is_nullable = 'YES'
    )
    or to_regclass('public.vote_refund_submission_audit') is null
    or not exists (
      select 1
      from pg_class relation
      where relation.oid = 'public.vote_refund_submission_audit'::regclass
        and relation.relkind = 'v'
        and relation.reloptions @> array[
          'security_invoker=true',
          'security_barrier=true'
        ]
        and pg_get_userbyid(relation.relowner) = 'postgres'
    )
    or not has_table_privilege(
      'service_role',
      'public.vote_refund_submission_audit',
      'SELECT'
    )
    or has_table_privilege(
      'authenticated',
      'public.vote_refund_submission_audit',
      'SELECT'
    ) then
    raise exception using
      errcode = '55000',
      message = 'VOTE_REFUND_FOLLOW_UP_SCHEMA_POSTFLIGHT_MISMATCH';
  end if;

  if (
      select count(*)
      from pg_trigger trigger_row
      where trigger_row.tgrelid = 'public.submissions'::regclass
        and trigger_row.tgname in (
          'submissions_vote_refund_insert_guard',
          'submissions_vote_refund_update_guard'
        )
        and not trigger_row.tgisinternal
        and trigger_row.tgenabled = 'O'
    ) <> 2
    or exists (
      select 1
      from public.submissions submission
      where (submission.vote_refund_id is null) <>
        (submission.vote_refunded_at is null)
    )
    or exists (
      select 1
      from public.vote_refund_items item
      join public.submissions submission on submission.id = item.submission_id
      where submission.vote_refund_id is distinct from item.refund_id
        or submission.vote_refunded_at is null
        or not coalesce(submission.is_disqualified, false)
    ) then
    raise exception using
      errcode = '55000',
      message = 'VOTE_REFUND_FOLLOW_UP_MARKER_POSTFLIGHT_MISMATCH';
  end if;

  if not exists (
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
      message = 'VOTE_REFUND_FOLLOW_UP_FUNCTION_POSTFLIGHT_MISMATCH';
  end if;
end;
$postflight$;

comment on column public.submissions.vote_refund_id is
  'Immutable successful vote-refund event marker; once set, the submission can never be reinstated.';
comment on column public.submissions.vote_refunded_at is
  'Timestamp shared with the successful vote-refund event that permanently closes reinstatement.';
comment on view public.vote_refund_submission_audit is
  'Server-only per-refund/per-submission aggregate of refunded voter identities; application access additionally requires Vote Logs capability.';
comment on function public.protect_submission_vote_refund_state() is
  'Rejects forged or changed refund markers and permanently blocks reinstatement after a successful vote refund.';
comment on function public.refund_disqualified_votes(
  text, bigint, integer, integer, jsonb, text, uuid
) is
  'Atomically authorizes and refunds explicitly selected disqualified-submission votes, marks each submission permanently non-reinstatable, and accepts an optional audit note; service role only.';

commit;
