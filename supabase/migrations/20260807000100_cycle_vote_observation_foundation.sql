begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $preflight$
declare
  vote_timestamp_type text;
  vote_timestamp_nullable text;
begin
  if to_regclass('public.votes') is null
    or to_regclass('public.voting_cycles') is null
    or to_regclass('public.submissions') is null
    or to_regprocedure('extensions.digest(bytea,text)') is null then
    raise exception using
      errcode = '55000',
      message = 'CYCLE_VOTE_OBSERVATION_DEPENDENCY_MISMATCH';
  end if;

  if to_regclass('public.cycle_vote_signal_policies') is not null
    or to_regclass('public.cycle_vote_signal_policy_state') is not null
    or to_regclass('public.cycle_vote_signal_bindings') is not null
    or to_regclass('public.cycle_vote_observation_snapshots') is not null
    or to_regclass('public.cycle_vote_submission_observations') is not null
    or to_regclass('public.cycle_vote_observation_events') is not null
    or to_regprocedure(
      'public.calculate_cycle_vote_observation_snapshot(bigint,integer)'
    ) is not null then
    raise exception using
      errcode = '55000',
      message = 'CYCLE_VOTE_OBSERVATION_TARGET_ALREADY_PRESENT';
  end if;

  select data_type, is_nullable
  into vote_timestamp_type, vote_timestamp_nullable
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'votes'
    and column_name = 'created_at';

  if vote_timestamp_type <> 'timestamp without time zone'
    or vote_timestamp_nullable <> 'YES' then
    raise exception using
      errcode = '55000',
      message = 'CYCLE_VOTE_OBSERVATION_TIMESTAMP_BASELINE_MISMATCH';
  end if;

  if exists (select 1 from public.votes where created_at is null) then
    raise exception using
      errcode = '55000',
      message = 'CYCLE_VOTE_OBSERVATION_NULL_VOTE_TIMESTAMP';
  end if;
end;
$preflight$;

alter table public.votes
  alter column created_at drop default,
  alter column created_at type timestamptz
    using created_at at time zone 'UTC',
  alter column created_at set default clock_timestamp(),
  alter column created_at set not null;

comment on column public.votes.created_at is
  'Canonical UTC instant assigned by PostgreSQL when an accepted vote is inserted. Historical zoneless values were converted with the separately verified UTC interpretation.';

create table public.cycle_vote_signal_policies (
  id uuid primary key default gen_random_uuid(),
  schema_version integer not null,
  policy_version integer not null unique,
  mode text not null,
  parameters jsonb not null,
  parameter_hash text not null unique,
  created_at timestamptz not null default transaction_timestamp(),
  created_by text not null,
  published_at timestamptz not null default transaction_timestamp(),
  published_by text not null,
  retired_at timestamptz,
  constraint cycle_vote_signal_policies_schema_version_check
    check (schema_version = 1),
  constraint cycle_vote_signal_policies_policy_version_check
    check (policy_version > 0),
  constraint cycle_vote_signal_policies_mode_check
    check (mode in ('aggregate_only', 'review_markers')),
  constraint cycle_vote_signal_policies_parameter_hash_check
    check (parameter_hash ~ '^[0-9a-f]{64}$'),
  constraint cycle_vote_signal_policies_actor_check
    check (
      btrim(created_by) <> ''
      and btrim(published_by) <> ''
    )
);

comment on table public.cycle_vote_signal_policies is
  'Immutable Owner-only policy revisions. The observation foundation seeds aggregate_only v1 and exposes no policy mutation surface.';

create table public.cycle_vote_signal_policy_state (
  id boolean primary key default true,
  active_policy_id uuid not null
    references public.cycle_vote_signal_policies(id),
  activated_at timestamptz not null default transaction_timestamp(),
  activated_by text not null,
  constraint cycle_vote_signal_policy_state_singleton_check check (id),
  constraint cycle_vote_signal_policy_state_actor_check
    check (btrim(activated_by) <> '')
);

comment on table public.cycle_vote_signal_policy_state is
  'Singleton pointer used only for future cycle bindings. Changing it never changes an existing binding.';

create table public.cycle_vote_signal_bindings (
  cycle_id bigint not null
    references public.voting_cycles(id) on delete cascade,
  reset_count integer not null,
  policy_id uuid not null
    references public.cycle_vote_signal_policies(id),
  schema_version integer not null,
  policy_version integer not null,
  mode text not null,
  parameters jsonb not null,
  parameter_hash text not null,
  voting_started_at timestamptz not null,
  frozen_at timestamptz not null default transaction_timestamp(),
  frozen_by_actor_type text not null default 'database_transition',
  frozen_by_actor_id text,
  primary key (cycle_id, reset_count),
  constraint cycle_vote_signal_bindings_reset_count_check
    check (reset_count >= 0),
  constraint cycle_vote_signal_bindings_mode_check
    check (mode in ('aggregate_only', 'review_markers')),
  constraint cycle_vote_signal_bindings_parameter_hash_check
    check (parameter_hash ~ '^[0-9a-f]{64}$'),
  constraint cycle_vote_signal_bindings_actor_type_check
    check (btrim(frozen_by_actor_type) <> '')
);

comment on table public.cycle_vote_signal_bindings is
  'Immutable policy and UTC-start snapshot for one logical cycle attempt identified by cycle_id plus reset_count.';

create table public.cycle_vote_observation_snapshots (
  cycle_id bigint not null,
  reset_count integer not null,
  status text not null default 'pending',
  voting_started_at timestamptz not null,
  voting_ended_at timestamptz not null,
  policy_version integer not null,
  policy_hash text not null,
  vote_count integer,
  distinct_voter_count integer,
  submission_count integer,
  result_hash text,
  error_code text,
  requested_at timestamptz not null default transaction_timestamp(),
  calculation_started_at timestamptz,
  ready_at timestamptz,
  primary key (cycle_id, reset_count),
  foreign key (cycle_id, reset_count)
    references public.cycle_vote_signal_bindings(cycle_id, reset_count)
    on delete cascade,
  constraint cycle_vote_observation_snapshots_status_check
    check (status in ('pending', 'calculating', 'ready', 'failed')),
  constraint cycle_vote_observation_snapshots_counts_check
    check (
      (vote_count is null or vote_count >= 0)
      and (distinct_voter_count is null or distinct_voter_count >= 0)
      and (submission_count is null or submission_count >= 0)
    ),
  constraint cycle_vote_observation_snapshots_result_hash_check
    check (result_hash is null or result_hash ~ '^[0-9a-f]{64}$'),
  constraint cycle_vote_observation_snapshots_shape_check
    check (
      (status = 'ready'
        and vote_count is not null
        and distinct_voter_count is not null
        and submission_count is not null
        and result_hash is not null
        and error_code is null
        and ready_at is not null)
      or
      (status <> 'ready'
        and result_hash is null
        and ready_at is null)
    )
);

comment on table public.cycle_vote_observation_snapshots is
  'Technical aggregate-only snapshot state. Pending or failed observations never block cycle finalization.';
comment on column public.cycle_vote_observation_snapshots.error_code is
  'Allowlisted technical category only; never a raw PostgreSQL error or user value.';

create table public.cycle_vote_submission_observations (
  cycle_id bigint not null,
  reset_count integer not null,
  submission_id bigint not null,
  total_votes integer not null,
  cycle_votes integer not null,
  first_vote_at timestamptz,
  last_vote_at timestamptz,
  peak_5m_votes integer not null,
  peak_5m_started_at timestamptz,
  last_5m_votes integer not null,
  last_15m_votes integer not null,
  last_60m_votes integer not null,
  nonempty_5m_buckets jsonb not null default '[]'::jsonb,
  primary key (cycle_id, reset_count, submission_id),
  foreign key (cycle_id, reset_count)
    references public.cycle_vote_observation_snapshots(cycle_id, reset_count)
    on delete cascade,
  constraint cycle_vote_submission_observations_counts_check
    check (
      total_votes >= 0
      and cycle_votes >= 0
      and peak_5m_votes >= 0
      and last_5m_votes >= 0
      and last_15m_votes >= 0
      and last_60m_votes >= 0
      and total_votes <= cycle_votes
      and peak_5m_votes <= total_votes
      and last_5m_votes <= last_15m_votes
      and last_15m_votes <= last_60m_votes
      and last_60m_votes <= total_votes
    ),
  constraint cycle_vote_submission_observations_time_shape_check
    check (
      (total_votes = 0
        and first_vote_at is null
        and last_vote_at is null
        and peak_5m_started_at is null)
      or
      (total_votes > 0
        and first_vote_at is not null
        and last_vote_at is not null
        and peak_5m_started_at is not null)
    ),
  constraint cycle_vote_submission_observations_buckets_check
    check (jsonb_typeof(nonempty_5m_buckets) = 'array')
);

comment on table public.cycle_vote_submission_observations is
  'Privacy-bounded per-submission aggregates. Contains no voter identifier, marker, score, network data, or browser data.';

create table public.cycle_vote_observation_events (
  id uuid primary key default gen_random_uuid(),
  cycle_id bigint not null
    references public.voting_cycles(id) on delete cascade,
  reset_count integer not null,
  event_type text not null,
  policy_version integer,
  snapshot_status text,
  error_code text,
  occurred_at timestamptz not null default clock_timestamp(),
  constraint cycle_vote_observation_events_reset_count_check
    check (reset_count >= 0),
  constraint cycle_vote_observation_events_type_check
    check (event_type in (
      'policy_frozen',
      'snapshot_queued',
      'snapshot_calculation_started',
      'snapshot_ready',
      'snapshot_failed',
      'snapshot_discarded_on_reset'
    )),
  constraint cycle_vote_observation_events_status_check
    check (
      snapshot_status is null
      or snapshot_status in ('pending', 'calculating', 'ready', 'failed')
    )
);

comment on table public.cycle_vote_observation_events is
  'Append-only technical audit for policy freeze and aggregate snapshot lifecycle. Contains no voter identifier or raw error.';

create index cycle_vote_observation_snapshots_status_requested_idx
  on public.cycle_vote_observation_snapshots (status, requested_at);

create index cycle_vote_submission_observations_vote_order_idx
  on public.cycle_vote_submission_observations (
    cycle_id,
    reset_count,
    total_votes desc,
    submission_id
  );

create index cycle_vote_observation_events_cycle_attempt_idx
  on public.cycle_vote_observation_events (
    cycle_id,
    reset_count,
    occurred_at,
    id
  );

create or replace function public.prevent_cycle_vote_observation_history_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception using
    errcode = '55000',
    message = 'CYCLE_VOTE_OBSERVATION_HISTORY_IMMUTABLE';
end;
$$;

create trigger cycle_vote_signal_policies_immutable
before update or delete on public.cycle_vote_signal_policies
for each row execute function
  public.prevent_cycle_vote_observation_history_mutation();

create trigger cycle_vote_signal_bindings_immutable
before update or delete on public.cycle_vote_signal_bindings
for each row execute function
  public.prevent_cycle_vote_observation_history_mutation();

create trigger cycle_vote_observation_events_append_only
before update or delete on public.cycle_vote_observation_events
for each row execute function
  public.prevent_cycle_vote_observation_history_mutation();

create or replace function public.bind_cycle_vote_signal_policy()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  active_policy public.cycle_vote_signal_policies%rowtype;
begin
  if new.status::text <> 'voting_open'
    or old.status::text = 'voting_open' then
    return new;
  end if;

  if new.voting_starts_at is null then
    raise exception using
      errcode = '55000',
      message = 'CYCLE_VOTE_OBSERVATION_START_MISSING';
  end if;

  if exists (
    select 1
    from public.cycle_vote_signal_bindings binding
    where binding.cycle_id = new.id
      and binding.reset_count = new.reset_count
  ) then
    return new;
  end if;

  select policy.*
  into active_policy
  from public.cycle_vote_signal_policy_state state
  join public.cycle_vote_signal_policies policy
    on policy.id = state.active_policy_id
  where state.id = true
    and policy.retired_at is null;

  if not found then
    raise exception using
      errcode = '55000',
      message = 'CYCLE_VOTE_OBSERVATION_ACTIVE_POLICY_MISSING';
  end if;

  insert into public.cycle_vote_signal_bindings (
    cycle_id,
    reset_count,
    policy_id,
    schema_version,
    policy_version,
    mode,
    parameters,
    parameter_hash,
    voting_started_at
  ) values (
    new.id,
    new.reset_count,
    active_policy.id,
    active_policy.schema_version,
    active_policy.policy_version,
    active_policy.mode,
    active_policy.parameters,
    active_policy.parameter_hash,
    new.voting_starts_at
  )
  on conflict (cycle_id, reset_count) do nothing;

  insert into public.cycle_vote_observation_events (
    cycle_id,
    reset_count,
    event_type,
    policy_version
  ) values (
    new.id,
    new.reset_count,
    'policy_frozen',
    active_policy.policy_version
  );

  return new;
end;
$$;

create trigger voting_cycles_bind_vote_signal_policy
after update of status on public.voting_cycles
for each row execute function public.bind_cycle_vote_signal_policy();

create or replace function public.queue_cycle_vote_observation_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  binding public.cycle_vote_signal_bindings%rowtype;
begin
  if new.status::text = 'voting_closed'
    and old.status::text <> 'voting_closed' then
    select *
    into binding
    from public.cycle_vote_signal_bindings
    where cycle_id = new.id
      and reset_count = new.reset_count;

    if found and new.voting_ends_at is not null then
      insert into public.cycle_vote_observation_snapshots (
        cycle_id,
        reset_count,
        voting_started_at,
        voting_ended_at,
        policy_version,
        policy_hash
      ) values (
        new.id,
        new.reset_count,
        binding.voting_started_at,
        new.voting_ends_at,
        binding.policy_version,
        binding.parameter_hash
      )
      on conflict (cycle_id, reset_count) do nothing;

      insert into public.cycle_vote_observation_events (
        cycle_id,
        reset_count,
        event_type,
        policy_version,
        snapshot_status
      ) values (
        new.id,
        new.reset_count,
        'snapshot_queued',
        binding.policy_version,
        'pending'
      );
    end if;
  elsif new.status::text = 'draft'
    and new.reset_count > old.reset_count then
    insert into public.cycle_vote_observation_events (
      cycle_id,
      reset_count,
      event_type,
      snapshot_status
    )
    select
      old.id,
      old.reset_count,
      'snapshot_discarded_on_reset',
      snapshot.status
    from public.cycle_vote_observation_snapshots snapshot
    where snapshot.cycle_id = old.id
      and snapshot.reset_count = old.reset_count;

    delete from public.cycle_vote_observation_snapshots
    where cycle_id = old.id
      and reset_count = old.reset_count;
  end if;

  return new;
exception
  when others then
    -- Observation availability must never block close, reset, or finalization.
    return new;
end;
$$;

create trigger voting_cycles_queue_vote_observation
after update of status, reset_count on public.voting_cycles
for each row execute function public.queue_cycle_vote_observation_snapshot();

create or replace function public.calculate_cycle_vote_observation_snapshot(
  p_cycle_id bigint,
  p_reset_count integer
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  snapshot public.cycle_vote_observation_snapshots%rowtype;
  current_cycle public.voting_cycles%rowtype;
  calculated_vote_count integer;
  calculated_voter_count integer;
  calculated_submission_count integer;
  calculated_result_hash text;
  failure_code text := 'snapshot_calculation_failed';
begin
  if p_cycle_id is null or p_cycle_id <= 0
    or p_reset_count is null or p_reset_count < 0 then
    return 'invalid_snapshot_key';
  end if;

  perform set_config('TimeZone', 'UTC', true);

  perform pg_advisory_xact_lock(
    hashtextextended(
      'cycle-vote-observation:' || p_cycle_id::text || ':' || p_reset_count::text,
      0
    )
  );

  select *
  into snapshot
  from public.cycle_vote_observation_snapshots
  where cycle_id = p_cycle_id
    and reset_count = p_reset_count
  for update;

  if not found then
    return 'snapshot_not_found';
  end if;

  if snapshot.status = 'ready' then
    return 'ready';
  end if;

  update public.cycle_vote_observation_snapshots
  set status = 'calculating',
      error_code = null,
      calculation_started_at = clock_timestamp(),
      vote_count = null,
      distinct_voter_count = null,
      submission_count = null,
      result_hash = null,
      ready_at = null
  where cycle_id = p_cycle_id
    and reset_count = p_reset_count;

  insert into public.cycle_vote_observation_events (
    cycle_id,
    reset_count,
    event_type,
    policy_version,
    snapshot_status
  ) values (
    p_cycle_id,
    p_reset_count,
    'snapshot_calculation_started',
    snapshot.policy_version,
    'calculating'
  );

  begin
    select *
    into current_cycle
    from public.voting_cycles
    where id = p_cycle_id;

    failure_code := 'cycle_attempt_changed';
    if not found or current_cycle.reset_count <> p_reset_count then
      raise exception using message = failure_code;
    end if;

    failure_code := 'cycle_not_closed';
    if current_cycle.status::text not in (
      'voting_closed', 'finalizing', 'completed', 'finished', 'archived'
    ) then
      raise exception using message = failure_code;
    end if;

    failure_code := 'invalid_time_bounds';
    if snapshot.voting_started_at is null
      or snapshot.voting_ended_at is null
      or snapshot.voting_ended_at < snapshot.voting_started_at then
      raise exception using message = failure_code;
    end if;

    failure_code := 'vote_outside_bounds';
    if exists (
      select 1
      from public.votes vote
      where vote.cycle_id = p_cycle_id
        and (
          vote.created_at < snapshot.voting_started_at
          or vote.created_at > snapshot.voting_ended_at
        )
    ) then
      raise exception using message = failure_code;
    end if;

    delete from public.cycle_vote_submission_observations
    where cycle_id = p_cycle_id
      and reset_count = p_reset_count;

    with cycle_totals as (
      select
        count(*)::integer as vote_count,
        count(distinct vote.discord_user_id)::integer as voter_count
      from public.votes vote
      where vote.cycle_id = p_cycle_id
    ), submission_totals as (
      select
        submission.id as submission_id,
        count(vote.id)::integer as total_votes,
        min(vote.created_at) as first_vote_at,
        max(vote.created_at) as last_vote_at,
        count(vote.id) filter (
          where vote.created_at > greatest(
            snapshot.voting_started_at,
            snapshot.voting_ended_at - interval '5 minutes'
          )
            and vote.created_at <= snapshot.voting_ended_at
        )::integer as last_5m_votes,
        count(vote.id) filter (
          where vote.created_at > greatest(
            snapshot.voting_started_at,
            snapshot.voting_ended_at - interval '15 minutes'
          )
            and vote.created_at <= snapshot.voting_ended_at
        )::integer as last_15m_votes,
        count(vote.id) filter (
          where vote.created_at > greatest(
            snapshot.voting_started_at,
            snapshot.voting_ended_at - interval '60 minutes'
          )
            and vote.created_at <= snapshot.voting_ended_at
        )::integer as last_60m_votes
      from public.submissions submission
      left join public.votes vote
        on vote.cycle_id = p_cycle_id
        and vote.submission_id = submission.id
      where submission.cycle_id = p_cycle_id
      group by submission.id
    ), peak_candidates as (
      select
        anchor.submission_id,
        anchor.created_at as peak_started_at,
        count(*) over (
          partition by anchor.submission_id
          order by anchor.created_at
          range between current row
            and interval '299.999999 seconds' following
        )::integer as peak_votes
      from public.votes anchor
      where anchor.cycle_id = p_cycle_id
    ), peaks as (
      select distinct on (submission_id)
        submission_id,
        peak_votes,
        peak_started_at
      from peak_candidates
      order by submission_id, peak_votes desc, peak_started_at, submission_id
    ), bucket_counts as (
      select
        vote.submission_id,
        floor(
          extract(epoch from (vote.created_at - snapshot.voting_started_at))
          / 300
        )::integer as bucket_index,
        count(*)::integer as bucket_votes
      from public.votes vote
      where vote.cycle_id = p_cycle_id
      group by vote.submission_id, bucket_index
    ), buckets as (
      select
        submission_id,
        jsonb_agg(
          jsonb_build_object(
            'index', bucket_index,
            'votes', bucket_votes,
            'startedAt', snapshot.voting_started_at
              + make_interval(secs => bucket_index * 300)
          )
          order by bucket_index
        ) as nonempty_buckets
      from bucket_counts
      group by submission_id
    )
    insert into public.cycle_vote_submission_observations (
      cycle_id,
      reset_count,
      submission_id,
      total_votes,
      cycle_votes,
      first_vote_at,
      last_vote_at,
      peak_5m_votes,
      peak_5m_started_at,
      last_5m_votes,
      last_15m_votes,
      last_60m_votes,
      nonempty_5m_buckets
    )
    select
      p_cycle_id,
      p_reset_count,
      totals.submission_id,
      totals.total_votes,
      cycle_totals.vote_count,
      totals.first_vote_at,
      totals.last_vote_at,
      coalesce(peaks.peak_votes, 0),
      peaks.peak_started_at,
      totals.last_5m_votes,
      totals.last_15m_votes,
      totals.last_60m_votes,
      coalesce(buckets.nonempty_buckets, '[]'::jsonb)
    from submission_totals totals
    cross join cycle_totals
    left join peaks on peaks.submission_id = totals.submission_id
    left join buckets on buckets.submission_id = totals.submission_id;

    select
      count(*)::integer,
      count(distinct vote.discord_user_id)::integer
    into calculated_vote_count, calculated_voter_count
    from public.votes vote
    where vote.cycle_id = p_cycle_id;

    select count(*)::integer
    into calculated_submission_count
    from public.cycle_vote_submission_observations observation
    where observation.cycle_id = p_cycle_id
      and observation.reset_count = p_reset_count;

    select encode(
      extensions.digest(
        convert_to(
          jsonb_build_object(
            'cycleId', p_cycle_id,
            'resetCount', p_reset_count,
            'votingStartedAt', snapshot.voting_started_at,
            'votingEndedAt', snapshot.voting_ended_at,
            'policyVersion', snapshot.policy_version,
            'policyHash', snapshot.policy_hash,
            'voteCount', calculated_vote_count,
            'distinctVoterCount', calculated_voter_count,
            'submissionCount', calculated_submission_count,
            'observations', coalesce(
              (
                select jsonb_agg(to_jsonb(observation) order by submission_id)
                from public.cycle_vote_submission_observations observation
                where observation.cycle_id = p_cycle_id
                  and observation.reset_count = p_reset_count
              ),
              '[]'::jsonb
            )
          )::text,
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    ) into calculated_result_hash;

    update public.cycle_vote_observation_snapshots
    set status = 'ready',
        vote_count = calculated_vote_count,
        distinct_voter_count = calculated_voter_count,
        submission_count = calculated_submission_count,
        result_hash = calculated_result_hash,
        error_code = null,
        ready_at = clock_timestamp()
    where cycle_id = p_cycle_id
      and reset_count = p_reset_count;

    insert into public.cycle_vote_observation_events (
      cycle_id,
      reset_count,
      event_type,
      policy_version,
      snapshot_status
    ) values (
      p_cycle_id,
      p_reset_count,
      'snapshot_ready',
      snapshot.policy_version,
      'ready'
    );

    return 'ready';
  exception
    when others then
      delete from public.cycle_vote_submission_observations
      where cycle_id = p_cycle_id
        and reset_count = p_reset_count;

      update public.cycle_vote_observation_snapshots
      set status = 'failed',
          vote_count = null,
          distinct_voter_count = null,
          submission_count = null,
          result_hash = null,
          error_code = failure_code,
          ready_at = null
      where cycle_id = p_cycle_id
        and reset_count = p_reset_count;

      insert into public.cycle_vote_observation_events (
        cycle_id,
        reset_count,
        event_type,
        policy_version,
        snapshot_status,
        error_code
      ) values (
        p_cycle_id,
        p_reset_count,
        'snapshot_failed',
        snapshot.policy_version,
        'failed',
        failure_code
      );

      return failure_code;
  end;
end;
$$;

alter table public.cycle_vote_signal_policies enable row level security;
alter table public.cycle_vote_signal_policy_state enable row level security;
alter table public.cycle_vote_signal_bindings enable row level security;
alter table public.cycle_vote_observation_snapshots enable row level security;
alter table public.cycle_vote_submission_observations enable row level security;
alter table public.cycle_vote_observation_events enable row level security;

revoke all on table public.cycle_vote_signal_policies
  from public, anon, authenticated;
revoke all on table public.cycle_vote_signal_policy_state
  from public, anon, authenticated;
revoke all on table public.cycle_vote_signal_bindings
  from public, anon, authenticated;
revoke all on table public.cycle_vote_observation_snapshots
  from public, anon, authenticated;
revoke all on table public.cycle_vote_submission_observations
  from public, anon, authenticated;
revoke all on table public.cycle_vote_observation_events
  from public, anon, authenticated;

grant select on table public.cycle_vote_signal_policies to service_role;
grant select on table public.cycle_vote_signal_policy_state to service_role;
grant select on table public.cycle_vote_signal_bindings to service_role;
grant select on table public.cycle_vote_observation_snapshots to service_role;
grant select on table public.cycle_vote_submission_observations to service_role;
grant select on table public.cycle_vote_observation_events to service_role;

revoke all on function public.prevent_cycle_vote_observation_history_mutation()
  from public, anon, authenticated, service_role;
revoke all on function public.bind_cycle_vote_signal_policy()
  from public, anon, authenticated, service_role;
revoke all on function public.queue_cycle_vote_observation_snapshot()
  from public, anon, authenticated, service_role;
revoke all on function public.calculate_cycle_vote_observation_snapshot(bigint, integer)
  from public, anon, authenticated;
grant execute on function public.calculate_cycle_vote_observation_snapshot(bigint, integer)
  to service_role;

insert into public.cycle_vote_signal_policies (
  schema_version,
  policy_version,
  mode,
  parameters,
  parameter_hash,
  created_by,
  published_by
)
select
  1,
  1,
  'aggregate_only',
  policy.parameters,
  encode(
    extensions.digest(convert_to(policy.parameters::text, 'UTF8'), 'sha256'),
    'hex'
  ),
  'migration:20260807000100',
  'migration:20260807000100'
from (
  select jsonb_build_object(
    'bucket_seconds', 300,
    'peak_window_seconds', 300,
    'recent_window_seconds', jsonb_build_array(300, 900, 3600)
  ) as parameters
) policy;

insert into public.cycle_vote_signal_policy_state (
  id,
  active_policy_id,
  activated_by
)
select
  true,
  id,
  'migration:20260807000100'
from public.cycle_vote_signal_policies
where policy_version = 1;

do $postflight$
declare
  relation_name text;
  function_name text;
  relation_row record;
  function_row record;
begin
  if (select count(*) from public.cycle_vote_signal_policies) <> 1
    or (select count(*) from public.cycle_vote_signal_policy_state) <> 1
    or not exists (
      select 1
      from public.cycle_vote_signal_policies
      where policy_version = 1
        and schema_version = 1
        and mode = 'aggregate_only'
        and parameters = jsonb_build_object(
          'bucket_seconds', 300,
          'peak_window_seconds', 300,
          'recent_window_seconds', jsonb_build_array(300, 900, 3600)
        )
    ) then
    raise exception using
      errcode = '55000',
      message = 'CYCLE_VOTE_OBSERVATION_DATA_POSTFLIGHT_MISMATCH';
  end if;

  foreach relation_name in array array[
    'cycle_vote_signal_policies',
    'cycle_vote_signal_policy_state',
    'cycle_vote_signal_bindings',
    'cycle_vote_observation_snapshots',
    'cycle_vote_submission_observations',
    'cycle_vote_observation_events'
  ] loop
    select c.relrowsecurity
    into relation_row
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = relation_name;

    if not found or not relation_row.relrowsecurity then
      raise exception using
        errcode = '55000',
        message = 'CYCLE_VOTE_OBSERVATION_SECURITY_POSTFLIGHT_MISMATCH';
    end if;
  end loop;

  foreach function_name in array array[
    'prevent_cycle_vote_observation_history_mutation()',
    'bind_cycle_vote_signal_policy()',
    'queue_cycle_vote_observation_snapshot()',
    'calculate_cycle_vote_observation_snapshot(bigint,integer)'
  ] loop
    select
      pg_get_userbyid(p.proowner) as owner_name,
      p.prosecdef,
      p.proconfig
    into function_row
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.oid = ('public.' || function_name)::regprocedure;

    if not found
      or function_row.owner_name <> 'postgres'
      or not function_row.prosecdef
      or function_row.proconfig is distinct from
        array['search_path=public, pg_temp']::text[] then
      raise exception using
        errcode = '55000',
        message = 'CYCLE_VOTE_OBSERVATION_FUNCTION_POSTFLIGHT_MISMATCH';
    end if;
  end loop;
end;
$postflight$;

commit;
