-- LIVE catch-up package C: Cycle infrastructure
-- Mechanically composed from reviewed Cycle/finalization/reset/automation/compatibility migrations.
-- The final Ban-aware Vote RPC is extracted from migration 20260716000200.
-- Historical migration files remain unchanged.

do $$
begin
  alter type public.voting_cycle_status add value if not exists 'paused';
end $$;

alter table public.voting_cycles
  add column if not exists paused_from_status text,
  add column if not exists phase_paused_at timestamptz,
  add column if not exists phase_paused_remaining_seconds integer,
  add column if not exists phase_pause_reason text;

alter table public.voting_cycles
  drop constraint if exists voting_cycles_votes_per_user_check;

alter table public.voting_cycles
  add constraint voting_cycles_votes_per_user_check
  check (votes_per_user between 1 and 10);

alter table public.voting_cycles
  drop constraint if exists voting_cycles_paused_from_status_check;

alter table public.voting_cycles
  add constraint voting_cycles_paused_from_status_check
  check (
    paused_from_status is null
    or paused_from_status in ('submission_open', 'voting_open')
  );

alter table public.voting_cycles
  drop constraint if exists voting_cycles_paused_remaining_seconds_check;

alter table public.voting_cycles
  add constraint voting_cycles_paused_remaining_seconds_check
  check (
    phase_paused_remaining_seconds is null
    or phase_paused_remaining_seconds >= 0
  );

comment on column public.voting_cycles.paused_from_status is
  'Active phase that should be restored when an admin resumes a paused cycle.';
comment on column public.voting_cycles.phase_paused_at is
  'Timestamp at which the current submission or voting phase was paused.';
comment on column public.voting_cycles.phase_paused_remaining_seconds is
  'Frozen countdown remainder. Null means the paused phase had no timer.';
comment on column public.voting_cycles.phase_pause_reason is
  'Optional admin-facing reason for pausing the current phase.';

drop index if exists public.votes_cycle_id_discord_user_id_uidx;

create unique index if not exists votes_cycle_submission_user_uidx
  on public.votes (cycle_id, submission_id, discord_user_id)
  nulls not distinct;

alter table public.votes
  alter column created_at set default now();

create or replace function public.cast_cycle_vote(
  p_cycle_id bigint,
  p_submission_id bigint,
  p_discord_user_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  cycle_row public.voting_cycles%rowtype;
  submission_owner_id text;
  current_vote_count integer;
begin
  if p_discord_user_id is null or btrim(p_discord_user_id) = '' then
    raise exception using message = 'INVALID_DISCORD_USER';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_cycle_id::text || ':' || p_discord_user_id, 0)
  );

  select *
  into cycle_row
  from public.voting_cycles
  where id = p_cycle_id
  for update;

  if not found or cycle_row.status::text <> 'voting_open' then
    raise exception using message = 'NO_ACTIVE_VOTING_PHASE';
  end if;

  select discord_user_id
  into submission_owner_id
  from public.submissions
  where id = p_submission_id
    and cycle_id = p_cycle_id
    and coalesce(is_disqualified, false) = false
    and public_visibility_status = 'visible';

  if not found then
    raise exception using message = 'SUBMISSION_NOT_FOUND';
  end if;

  if cycle_row.allow_self_vote = false
    and submission_owner_id = p_discord_user_id
  then
    raise exception using message = 'SELF_VOTE';
  end if;

  if exists (
    select 1
    from public.votes
    where cycle_id = p_cycle_id
      and submission_id = p_submission_id
      and discord_user_id = p_discord_user_id
  ) then
    raise exception using message = 'DUPLICATE_SUBMISSION_VOTE';
  end if;

  select count(*)::integer
  into current_vote_count
  from public.votes
  where cycle_id = p_cycle_id
    and discord_user_id = p_discord_user_id;

  if current_vote_count >= cycle_row.votes_per_user then
    raise exception using message = 'VOTE_LIMIT_REACHED';
  end if;

  insert into public.votes (
    cycle_id,
    submission_id,
    discord_user_id
  ) values (
    p_cycle_id,
    p_submission_id,
    p_discord_user_id
  );

  current_vote_count := current_vote_count + 1;

  return jsonb_build_object(
    'voteCount', current_vote_count,
    'votesPerUser', cycle_row.votes_per_user,
    'hasVoted', current_vote_count >= cycle_row.votes_per_user
  );
end;
$$;

revoke all on function public.cast_cycle_vote(bigint, bigint, text)
  from public;
grant execute on function public.cast_cycle_vote(bigint, bigint, text)
  to service_role;

comment on function public.cast_cycle_vote(bigint, bigint, text) is
  'Atomically enforces voting_open, per-cycle vote limits, no self-votes, and one vote per submission.';

begin;

alter table public.cycle_results
  add column if not exists final_vote_count integer,
  add column if not exists rank_in_cycle integer,
  add column if not exists tie_group integer,
  add column if not exists finalized_at timestamptz,
  add column if not exists feed_eligible boolean,
  add column if not exists public_visibility_status_at_finalization text;

comment on column public.cycle_results.final_vote_count is
  'Immutable vote total captured by finalize_cycle.';
comment on column public.cycle_results.rank_in_cycle is
  'Immutable dense rank captured by finalize_cycle.';
comment on column public.cycle_results.tie_group is
  'Dense tie group captured by finalize_cycle; currently equal to rank_in_cycle.';
comment on column public.cycle_results.finalized_at is
  'Timestamp shared by every result snapshot from one finalization.';
comment on column public.cycle_results.feed_eligible is
  'Competition-level feed eligibility. Current public visibility must still be checked separately.';
comment on column public.cycle_results.public_visibility_status_at_finalization is
  'Visibility snapshot for audit context; current submissions.public_visibility_status remains authoritative for display.';

create index if not exists cycle_results_cycle_rank_submission_idx
  on public.cycle_results (cycle_id, rank_in_cycle, submission_id);

create index if not exists cycle_results_feed_cursor_idx
  on public.cycle_results (
    finalized_at desc,
    cycle_id desc,
    rank_in_cycle,
    submission_id
  )
  where feed_eligible = true;

create or replace function public.finalize_cycle(
  p_cycle_id bigint,
  p_actor_discord_user_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_initial_status text;
  v_finalized_at timestamptz := transaction_timestamp();
  v_ranked_submission_count integer := 0;
  v_winner_count integer := 0;
  v_highest_rank integer := 0;
begin
  if p_cycle_id is null or p_cycle_id <= 0 then
    raise exception using message = 'INVALID_CYCLE_ID';
  end if;

  if p_actor_discord_user_id is null
    or btrim(p_actor_discord_user_id) = ''
  then
    raise exception using message = 'INVALID_FINALIZATION_ACTOR';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('cycle-finalization:' || p_cycle_id::text, 0)
  );

  select status::text
  into v_initial_status
  from public.voting_cycles
  where id = p_cycle_id
  for update;

  if not found then
    raise exception using message = 'CYCLE_NOT_FOUND';
  end if;

  if v_initial_status = 'finished' then
    select
      count(*)::integer,
      count(*) filter (where is_winner = true)::integer,
      coalesce(max(rank_in_cycle), 0)::integer
    into
      v_ranked_submission_count,
      v_winner_count,
      v_highest_rank
    from public.cycle_results
    where cycle_id = p_cycle_id;

    if v_ranked_submission_count = 0
      or exists (
        select 1
        from public.cycle_results
        where cycle_id = p_cycle_id
          and (
            final_vote_count is null
            or rank_in_cycle is null
            or tie_group is null
            or finalized_at is null
            or feed_eligible is null
            or public_visibility_status_at_finalization is null
          )
      )
    then
      raise exception using
        message = 'FINALIZED_RESULT_SNAPSHOT_INCOMPLETE';
    end if;

    return jsonb_build_object(
      'cycleId', p_cycle_id,
      'finalStatus', 'finished',
      'rankedSubmissionCount', v_ranked_submission_count,
      'winnerCount', v_winner_count,
      'highestRank', v_highest_rank,
      'alreadyFinalized', true
    );
  end if;

  if v_initial_status not in (
    'voting_closed',
    'finalizing',
    'active'
  ) then
    raise exception using
      message = 'INVALID_CYCLE_STATE',
      detail = 'Cycle status is ' || v_initial_status;
  end if;

  update public.voting_cycles
  set status = 'finalizing'
  where id = p_cycle_id;

  insert into public.cycle_events (
    cycle_id,
    event_type,
    actor_type,
    actor_discord_user_id,
    payload
  )
  select
    p_cycle_id,
    'cycle_finalizing',
    'admin',
    p_actor_discord_user_id,
    jsonb_build_object(
      'phase', 'finalizing',
      'recovery', v_initial_status = 'finalizing'
    )
  where not exists (
    select 1
    from public.cycle_events
    where cycle_id = p_cycle_id
      and event_type = 'cycle_finalizing'
  );

  delete from public.winner_public_profiles
  where cycle_id = p_cycle_id;

  delete from public.cycle_results
  where cycle_id = p_cycle_id;

  with vote_totals as (
    select
      s.id as submission_id,
      count(v.id)::integer as final_vote_count,
      coalesce(
        nullif(btrim(s.public_visibility_status), ''),
        'visible'
      ) as visibility_status
    from public.submissions s
    left join public.votes v
      on v.cycle_id = p_cycle_id
      and v.submission_id = s.id
    where s.cycle_id = p_cycle_id
      and coalesce(s.is_disqualified, false) = false
    group by s.id, s.public_visibility_status
  ), ranked as (
    select
      submission_id,
      final_vote_count,
      dense_rank() over (
        order by final_vote_count desc
      )::integer as dense_rank,
      visibility_status
    from vote_totals
  )
  insert into public.cycle_results (
    cycle_id,
    submission_id,
    vote_count,
    is_winner,
    rank,
    final_vote_count,
    rank_in_cycle,
    tie_group,
    finalized_at,
    feed_eligible,
    public_visibility_status_at_finalization
  )
  select
    p_cycle_id,
    submission_id,
    final_vote_count,
    dense_rank = 1,
    dense_rank,
    final_vote_count,
    dense_rank,
    dense_rank,
    v_finalized_at,
    true,
    visibility_status
  from ranked;

  get diagnostics v_ranked_submission_count = row_count;

  if v_ranked_submission_count = 0 then
    raise exception using
      message = 'NO_COMPETITION_ELIGIBLE_SUBMISSIONS';
  end if;

  select
    count(*) filter (where rank_in_cycle = 1)::integer,
    coalesce(max(rank_in_cycle), 0)::integer
  into v_winner_count, v_highest_rank
  from public.cycle_results
  where cycle_id = p_cycle_id;

  if v_winner_count = 0 then
    raise exception using message = 'NO_FINALIZATION_WINNER';
  end if;

  if exists (
    select 1
    from public.cycle_results cr
    where cr.cycle_id = p_cycle_id
      and cr.rank_in_cycle = 1
      and not exists (
        select 1
        from public.submission_private_data spd
        where spd.submission_id = cr.submission_id
      )
  ) then
    raise exception using message = 'WINNER_PRIVATE_DATA_MISSING';
  end if;

  insert into public.winner_public_profiles (
    cycle_id,
    submission_id,
    x_username,
    wallet_address,
    payout_choice,
    split_percent,
    charity,
    win_share,
    wall,
    vote_count,
    r2_key
  )
  select
    p_cycle_id,
    cr.submission_id,
    coalesce(
      private_data.x_username,
      s.discord_username_at_upload,
      'unknown'
    ),
    private_data.wallet_address,
    private_data.payout_choice,
    private_data.split_percent,
    private_data.charity,
    1.0 / v_winner_count,
    case
      when private_data.payout_choice = 'donate' then 'fame'
      when private_data.payout_choice = 'split'
        and coalesce(private_data.split_percent, 100) < 100
      then 'fame'
      else 'shame'
    end,
    cr.final_vote_count,
    s.r2_key
  from public.cycle_results cr
  join public.submissions s
    on s.id = cr.submission_id
  join lateral (
    select
      spd.x_username,
      spd.wallet_address,
      spd.payout_choice,
      spd.split_percent,
      spd.charity
    from public.submission_private_data spd
    where spd.submission_id = cr.submission_id
    order by spd.id desc
    limit 1
  ) as private_data on true
  where cr.cycle_id = p_cycle_id
    and cr.rank_in_cycle = 1;

  update public.voting_cycles
  set
    status = 'finished',
    winners_published = true,
    finalized_at = v_finalized_at,
    results_published_at = v_finalized_at,
    ended_at = coalesce(ended_at, v_finalized_at)
  where id = p_cycle_id;

  update public.cycle_sponsorships
  set
    ends_at = coalesce(ends_at, v_finalized_at),
    updated_at = v_finalized_at
  where cycle_id = p_cycle_id;

  update public.app_config
  set value = null
  where key in ('cycle_end_at', 'cycle_theme');

  insert into public.cycle_events (
    cycle_id,
    event_type,
    actor_type,
    actor_discord_user_id,
    payload
  )
  select
    p_cycle_id,
    'cycle_completed',
    'admin',
    p_actor_discord_user_id,
    jsonb_build_object(
      'phase', 'finished',
      'finalized_at', v_finalized_at,
      'ranked_submissions', v_ranked_submission_count,
      'winners', v_winner_count,
      'highest_rank', v_highest_rank
    )
  where not exists (
    select 1
    from public.cycle_events
    where cycle_id = p_cycle_id
      and event_type = 'cycle_completed'
  );

  insert into public.admin_action_logs (
    actor_type,
    actor_id,
    action,
    target_type,
    target_id,
    meta
  )
  select
    'admin',
    p_actor_discord_user_id,
    'cycle_finalized',
    'cycle',
    p_cycle_id::text,
    jsonb_build_object(
      'ranked_submissions', v_ranked_submission_count,
      'winners', v_winner_count,
      'highest_rank', v_highest_rank,
      'finalized_at', v_finalized_at
    )
  where not exists (
    select 1
    from public.admin_action_logs
    where action = 'cycle_finalized'
      and target_type = 'cycle'
      and target_id = p_cycle_id::text
  );

  return jsonb_build_object(
    'cycleId', p_cycle_id,
    'finalStatus', 'finished',
    'rankedSubmissionCount', v_ranked_submission_count,
    'winnerCount', v_winner_count,
    'highestRank', v_highest_rank,
    'alreadyFinalized', false
  );
end;
$$;

revoke all on function public.finalize_cycle(bigint, text)
  from public;
grant execute on function public.finalize_cycle(bigint, text)
  to service_role;

comment on function public.finalize_cycle(bigint, text) is
  'Transactionally finalizes one voting_closed/finalizing cycle, with active accepted only for legacy compatibility.';

commit;

begin;

alter table public.voting_cycles
  add column if not exists reset_count integer not null default 0,
  add column if not exists reset_at timestamptz;

alter table public.voting_cycles
  drop constraint if exists voting_cycles_reset_count_check;

alter table public.voting_cycles
  add constraint voting_cycles_reset_count_check
  check (reset_count >= 0);

comment on column public.voting_cycles.reset_count is
  'Number of completed Admin recovery resets for this reusable cycle row.';
comment on column public.voting_cycles.reset_at is
  'Non-null only while this row is the clean draft produced by the latest reset. Cleared when that draft is restarted.';

create table if not exists public.media_cleanup_queue (
  id bigint generated always as identity primary key,
  storage_provider text not null,
  storage_key text not null,
  reason text not null,
  status text not null default 'pending',
  attempts integer not null default 0,
  last_error_code text,
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  constraint media_cleanup_queue_storage_provider_check
    check (storage_provider in ('r2')),
  constraint media_cleanup_queue_status_check
    check (status in ('pending', 'completed', 'failed')),
  constraint media_cleanup_queue_attempts_check
    check (attempts >= 0),
  constraint media_cleanup_queue_storage_key_not_blank_check
    check (btrim(storage_key) <> ''),
  constraint media_cleanup_queue_reason_not_blank_check
    check (btrim(reason) <> ''),
  constraint media_cleanup_queue_storage_key_unique
    unique (storage_provider, storage_key)
);

comment on table public.media_cleanup_queue is
  'Server-only retry ledger for storage objects whose database references have already been removed.';
comment on column public.media_cleanup_queue.storage_key is
  'Canonical provider object key only; never a signed or public URL.';
comment on column public.media_cleanup_queue.last_error_code is
  'Sanitized dependency error code only; never credentials, URLs, or raw provider messages.';

create index if not exists media_cleanup_queue_retry_idx
  on public.media_cleanup_queue (status, created_at)
  where status in ('pending', 'failed');

alter table public.media_cleanup_queue enable row level security;

revoke all on table public.media_cleanup_queue from public, anon, authenticated;
grant select, insert, update, delete on table public.media_cleanup_queue to service_role;
grant usage, select on sequence public.media_cleanup_queue_id_seq to service_role;

create or replace function public.reset_cycle(
  p_cycle_id bigint,
  p_actor_discord_user_id text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cycle public.voting_cycles%rowtype;
  v_previous_status text;
  v_reset_at timestamptz := transaction_timestamp();
  v_submission_ids bigint[] := '{}'::bigint[];
  v_r2_keys text[] := '{}'::text[];
  v_cleanup_queue_ids bigint[] := '{}'::bigint[];
  v_removed_submissions integer := 0;
  v_removed_votes integer := 0;
  v_affected_submitters integer := 0;
  v_removed_results integer := 0;
  v_removed_winner_rows integer := 0;
  v_has_attempt_dependencies boolean := false;
  v_cleanup_reason text;
begin
  if p_cycle_id is null or p_cycle_id <= 0 then
    raise exception using message = 'INVALID_CYCLE_ID';
  end if;

  if p_actor_discord_user_id is null
    or btrim(p_actor_discord_user_id) = ''
  then
    raise exception using message = 'INVALID_RESET_ACTOR';
  end if;

  if p_reason is null or btrim(p_reason) = '' then
    raise exception using message = 'RESET_REASON_REQUIRED';
  end if;

  if length(btrim(p_reason)) > 1000 then
    raise exception using message = 'RESET_REASON_TOO_LONG';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('cycle-reset:' || p_cycle_id::text, 0)
  );

  select *
  into v_cycle
  from public.voting_cycles
  where id = p_cycle_id
  for update;

  if not found then
    raise exception using message = 'CYCLE_NOT_FOUND';
  end if;

  v_previous_status := v_cycle.status::text;
  v_cleanup_reason := 'cycle_reset:' || p_cycle_id::text;

  if v_previous_status not in (
    'draft',
    'submission_open',
    'submission_closed',
    'voting_open',
    'voting_closed',
    'paused',
    'finalizing',
    'active'
  ) then
    raise exception using
      message = 'CYCLE_STATE_NOT_RESETTABLE',
      detail = 'Cycle status is ' || v_previous_status;
  end if;

  select
    coalesce(array_agg(s.id order by s.id), '{}'::bigint[]),
    count(*)::integer,
    count(distinct s.discord_user_id)::integer
  into
    v_submission_ids,
    v_removed_submissions,
    v_affected_submitters
  from public.submissions s
  where s.cycle_id = p_cycle_id;

  select count(*)::integer
  into v_removed_votes
  from public.votes
  where cycle_id = p_cycle_id;

  select count(*)::integer
  into v_removed_results
  from public.cycle_results
  where cycle_id = p_cycle_id;

  select count(*)::integer
  into v_removed_winner_rows
  from public.winner_public_profiles
  where cycle_id = p_cycle_id;

  select
    exists (
      select 1 from public.cycle_events where cycle_id = p_cycle_id
    )
    or exists (
      select 1 from public.cycle_reminders where cycle_id = p_cycle_id
    )
    or exists (
      select 1 from public.cycle_sponsorships where cycle_id = p_cycle_id
    )
    or exists (
      select 1 from public.user_cycle_acceptance where cycle_id = p_cycle_id
    )
  into v_has_attempt_dependencies;

  if v_previous_status = 'draft'
    and v_cycle.reset_at is not null
    and v_removed_submissions = 0
    and v_removed_votes = 0
    and v_removed_results = 0
    and v_removed_winner_rows = 0
    and not v_has_attempt_dependencies
  then
    select coalesce(array_agg(id order by id), '{}'::bigint[])
    into v_cleanup_queue_ids
    from public.media_cleanup_queue
    where reason = v_cleanup_reason
      and status in ('pending', 'failed');

    return jsonb_build_object(
      'cycleId', p_cycle_id,
      'cycleNumber', p_cycle_id,
      'previousStatus', 'draft',
      'status', 'draft',
      'removedSubmissions', 0,
      'removedVotes', 0,
      'affectedSubmitters', 0,
      'removedResults', 0,
      'removedWinnerRows', 0,
      'r2KeysPendingCleanup', cardinality(v_cleanup_queue_ids),
      'r2CleanupQueueIds', to_jsonb(v_cleanup_queue_ids),
      'alreadyReset', true,
      'resetCount', v_cycle.reset_count
    );
  end if;

  with candidate_keys as (
    select s.r2_key as storage_key
    from public.submissions s
    where s.cycle_id = p_cycle_id
      and s.r2_key ~ ('^' || p_cycle_id::text || '/[0-9A-Fa-f-]{36}[.]webp$')

    union

    select w.r2_key
    from public.winner_public_profiles w
    where w.cycle_id = p_cycle_id
      and w.r2_key ~ ('^' || p_cycle_id::text || '/[0-9A-Fa-f-]{36}[.]webp$')

    union

    select cs.banner_r2_key
    from public.cycle_sponsorships cs
    where cs.cycle_id = p_cycle_id
      and cs.banner_r2_key ~ '^sponsored-cycles/drafts/[0-9A-Fa-f-]{36}[.]webp$'

    union

    select v_cycle.sponsor_banner_key
    where v_cycle.sponsor_banner_key ~ '^sponsored-cycles/drafts/[0-9A-Fa-f-]{36}[.]webp$'
  ), unshared_keys as (
    select candidate.storage_key
    from candidate_keys candidate
    where not exists (
      select 1
      from public.submissions other_submission
      where other_submission.cycle_id is distinct from p_cycle_id
        and other_submission.r2_key = candidate.storage_key
    )
      and not exists (
        select 1
        from public.winner_public_profiles other_winner
        where other_winner.cycle_id <> p_cycle_id
          and other_winner.r2_key = candidate.storage_key
      )
      and not exists (
        select 1
        from public.cycle_sponsorships other_sponsorship
        where other_sponsorship.cycle_id <> p_cycle_id
          and other_sponsorship.banner_r2_key = candidate.storage_key
      )
      and not exists (
        select 1
        from public.voting_cycles other_cycle
        where other_cycle.id <> p_cycle_id
          and other_cycle.sponsor_banner_key = candidate.storage_key
      )
      and not exists (
        select 1
        from public.app_config config
        where config.key in (
          'next_cycle_sponsor_banner_r2_key',
          'next_cycle_sponsor_banner_key'
        )
          and config.value = candidate.storage_key
      )
      and not exists (
        select 1
        from public.app_config legacy_meta
        where legacy_meta.key like 'cycle_sponsor_meta_%'
          and legacy_meta.key <> 'cycle_sponsor_meta_' || p_cycle_id::text
          and legacy_meta.value like '%' || candidate.storage_key || '%'
      )
      and not exists (
        select 1
        from public.next_cycle_config next_config
        where next_config.sponsor_banner_key = candidate.storage_key
      )
  )
  select coalesce(array_agg(storage_key order by storage_key), '{}'::text[])
  into v_r2_keys
  from unshared_keys;

  insert into public.media_cleanup_queue (
    storage_provider,
    storage_key,
    reason,
    status
  )
  select
    'r2',
    storage_key,
    v_cleanup_reason,
    'pending'
  from unnest(v_r2_keys) as queued_key(storage_key)
  on conflict (storage_provider, storage_key) do nothing;

  select coalesce(array_agg(id order by id), '{}'::bigint[])
  into v_cleanup_queue_ids
  from public.media_cleanup_queue
  where storage_provider = 'r2'
    and storage_key = any(v_r2_keys)
    and status in ('pending', 'failed');

  delete from public.cycle_reminders
  where cycle_id = p_cycle_id;

  delete from public.cycle_events
  where cycle_id = p_cycle_id;

  delete from public.winner_public_profiles
  where cycle_id = p_cycle_id;

  delete from public.cycle_results
  where cycle_id = p_cycle_id;

  delete from public.votes
  where cycle_id = p_cycle_id;

  delete from public.submission_social_links
  where submission_id = any(v_submission_ids);

  delete from public.submission_private_data
  where submission_id = any(v_submission_ids);

  delete from public.submissions
  where cycle_id = p_cycle_id;

  delete from public.user_cycle_acceptance
  where cycle_id = p_cycle_id;

  update public.voting_cycles
  set
    status = 'draft',
    starts_at = null,
    ends_at = null,
    created_by_discord_id = null,
    ended_at = null,
    finalized_at = null,
    winners_published = false,
    theme = null,
    title = null,
    is_sponsored = false,
    sponsor_name = null,
    sponsor_link = null,
    reward_description = null,
    sponsor_banner_key = null,
    rule_template_id = null,
    submission_starts_at = null,
    submission_ends_at = null,
    voting_starts_at = null,
    voting_ends_at = null,
    results_published_at = null,
    archived_at = null,
    submission_warn_threshold = null,
    submission_warned_at = null,
    submission_auto_close_enabled = false,
    submission_auto_close_threshold = null,
    submission_auto_closed_at = null,
    votes_per_user = 2,
    allow_self_vote = false,
    sponsorship_id = null,
    sponsor_name_snapshot = null,
    sponsor_link_snapshot = null,
    sponsor_banner_url_snapshot = null,
    paused_from_status = null,
    phase_paused_at = null,
    phase_paused_remaining_seconds = null,
    phase_pause_reason = null,
    reset_count = reset_count + 1,
    reset_at = v_reset_at
  where id = p_cycle_id;

  delete from public.sponsor_tracking_events
  where sponsorship_id in (
    select id
    from public.cycle_sponsorships
    where cycle_id = p_cycle_id
  );

  delete from public.cycle_sponsorships
  where cycle_id = p_cycle_id;

  delete from public.app_config
  where key = 'cycle_sponsor_meta_' || p_cycle_id::text;

  update public.app_config
  set value = null
  where key in ('cycle_end_at', 'cycle_theme');

  insert into public.admin_action_logs (
    actor_type,
    actor_id,
    action,
    target_type,
    target_id,
    meta
  ) values (
    'admin',
    p_actor_discord_user_id,
    'cycle_reset',
    'cycle',
    p_cycle_id::text,
    jsonb_build_object(
      'cycle_id', p_cycle_id,
      'cycle_number', p_cycle_id,
      'reason', btrim(p_reason),
      'previous_status', v_previous_status,
      'removed_submissions', v_removed_submissions,
      'removed_votes', v_removed_votes,
      'affected_submitters', v_affected_submitters,
      'removed_results', v_removed_results,
      'removed_winner_rows', v_removed_winner_rows,
      'r2_keys_pending_cleanup', cardinality(v_cleanup_queue_ids),
      'reset_at', v_reset_at,
      'reset_count', v_cycle.reset_count + 1
    )
  );

  return jsonb_build_object(
    'cycleId', p_cycle_id,
    'cycleNumber', p_cycle_id,
    'previousStatus', v_previous_status,
    'status', 'draft',
    'removedSubmissions', v_removed_submissions,
    'removedVotes', v_removed_votes,
    'affectedSubmitters', v_affected_submitters,
    'removedResults', v_removed_results,
    'removedWinnerRows', v_removed_winner_rows,
    'r2KeysPendingCleanup', cardinality(v_cleanup_queue_ids),
    'r2CleanupQueueIds', to_jsonb(v_cleanup_queue_ids),
    'alreadyReset', false,
    'resetCount', v_cycle.reset_count + 1
  );
end;
$$;

revoke all on function public.reset_cycle(bigint, text, text) from public;
grant execute on function public.reset_cycle(bigint, text, text) to service_role;

comment on function public.reset_cycle(bigint, text, text) is
  'Atomically removes one unfinished cycle attempt, enqueues canonical unshared media keys, and returns the same cycle row to a reusable draft without a public cycle event.';

commit;

begin;

do $$
declare
  v_current_cycle_count integer;
begin
  select count(*)::integer
  into v_current_cycle_count
  from public.voting_cycles
  where status in (
    'active',
    'submission_open',
    'submission_closed',
    'voting_open',
    'voting_closed',
    'paused',
    'finalizing'
  );

  if v_current_cycle_count > 1 then
    raise exception using
      message = 'CURRENT_CYCLE_INVARIANT_VIOLATION',
      detail = 'Resolve duplicate unfinished/current cycles before applying this migration.';
  end if;
end;
$$;

create unique index if not exists voting_cycles_one_current_idx
  on public.voting_cycles ((1))
  where status in (
    'active',
    'submission_open',
    'submission_closed',
    'voting_open',
    'voting_closed',
    'paused',
    'finalizing'
  );

comment on index public.voting_cycles_one_current_idx is
  'Defense in depth: at most one legacy/current unfinished cycle may exist. Draft and terminal states are intentionally excluded.';

create or replace function public.start_cycle(
  p_cycle_id bigint,
  p_actor_discord_user_id text,
  p_settings jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_current public.voting_cycles%rowtype;
  v_cycle public.voting_cycles%rowtype;
  v_now timestamptz := transaction_timestamp();
  v_actor_discord_id bigint;
  v_theme text;
  v_theme_source text;
  v_reward_description text;
  v_is_sponsored boolean := false;
  v_sponsor_name text;
  v_sponsor_link text;
  v_sponsor_banner_r2_key text;
  v_sponsor_banner_url text;
  v_sponsorship_id bigint;
  v_created_cycle boolean := false;
  v_reused_draft boolean := false;
  v_reused_reset_draft boolean := false;
begin
  if p_cycle_id is not null and p_cycle_id <= 0 then
    raise exception using message = 'INVALID_CYCLE_ID';
  end if;

  if p_actor_discord_user_id is null
    or btrim(p_actor_discord_user_id) = ''
  then
    raise exception using message = 'INVALID_START_ACTOR';
  end if;

  begin
    v_actor_discord_id := btrim(p_actor_discord_user_id)::bigint;
  exception
    when invalid_text_representation or numeric_value_out_of_range then
      raise exception using message = 'INVALID_START_ACTOR';
  end;

  if p_settings is null or jsonb_typeof(p_settings) <> 'object' then
    raise exception using message = 'INVALID_START_SETTINGS';
  end if;

  if p_settings #> '{sponsored,enabled}' is not null
    and jsonb_typeof(p_settings #> '{sponsored,enabled}') <> 'boolean'
  then
    raise exception using message = 'INVALID_SPONSOR_SETTINGS';
  end if;

  v_theme := nullif(btrim(p_settings ->> 'theme'), '');
  v_theme_source := coalesce(
    nullif(btrim(p_settings ->> 'themeSource'), ''),
    'none'
  );
  v_reward_description := nullif(
    btrim(p_settings ->> 'rewardDescription'),
    ''
  );
  v_is_sponsored := coalesce(
    (p_settings #>> '{sponsored,enabled}')::boolean,
    false
  );
  v_sponsor_name := nullif(
    btrim(p_settings #>> '{sponsored,companyName}'),
    ''
  );
  v_sponsor_link := nullif(
    btrim(p_settings #>> '{sponsored,sponsorLink}'),
    ''
  );
  v_sponsor_banner_r2_key := nullif(
    btrim(p_settings #>> '{sponsored,bannerR2Key}'),
    ''
  );
  v_sponsor_banner_url := nullif(
    btrim(p_settings #>> '{sponsored,bannerUrl}'),
    ''
  );

  if v_theme_source not in ('manual', 'next_cycle_theme', 'none') then
    raise exception using message = 'INVALID_THEME_SOURCE';
  end if;

  if v_is_sponsored and (
    v_sponsor_name is null
    or v_sponsor_link is null
    or v_sponsor_banner_r2_key is null
  ) then
    raise exception using message = 'INCOMPLETE_SPONSOR_SETTINGS';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('cycle-start-global', 0)
  );

  select *
  into v_current
  from public.voting_cycles
  where status in (
    'active',
    'submission_open',
    'submission_closed',
    'voting_open',
    'voting_closed',
    'paused',
    'finalizing'
  )
  order by id desc
  limit 1
  for update;

  if found then
    if p_cycle_id = v_current.id
      and v_current.status in ('submission_open', 'active')
    then
      return jsonb_build_object(
        'cycleId', v_current.id,
        'cycleNumber', v_current.id,
        'status', v_current.status::text,
        'startedAt', coalesce(
          v_current.submission_starts_at,
          v_current.starts_at
        ),
        'alreadyStarted', true,
        'createdCycle', false,
        'reusedDraft', true,
        'reusedResetDraft', v_current.reset_count > 0,
        'resetCount', v_current.reset_count
      );
    end if;

    raise exception using
      message = 'CURRENT_CYCLE_EXISTS',
      detail = 'An unfinished/current cycle already exists.';
  end if;

  if p_cycle_id is not null then
    select *
    into v_cycle
    from public.voting_cycles
    where id = p_cycle_id
    for update;

    if not found then
      raise exception using message = 'CYCLE_NOT_FOUND';
    end if;
  else
    select *
    into v_cycle
    from public.voting_cycles
    where status = 'draft'
    order by (reset_at is not null) desc, id desc
    limit 1
    for update;
  end if;

  if found then
    if v_cycle.status <> 'draft' then
      raise exception using
        message = 'CYCLE_NOT_STARTABLE',
        detail = 'Requested cycle status is ' || v_cycle.status::text;
    end if;

    if exists (
      select 1 from public.submissions where cycle_id = v_cycle.id
    )
      or exists (
        select 1 from public.votes where cycle_id = v_cycle.id
      )
      or exists (
        select 1 from public.cycle_results where cycle_id = v_cycle.id
      )
      or exists (
        select 1 from public.winner_public_profiles where cycle_id = v_cycle.id
      )
      or exists (
        select 1 from public.cycle_events where cycle_id = v_cycle.id
      )
      or exists (
        select 1 from public.cycle_reminders where cycle_id = v_cycle.id
      )
      or exists (
        select 1 from public.user_cycle_acceptance where cycle_id = v_cycle.id
      )
    then
      raise exception using message = 'CYCLE_DRAFT_NOT_CLEAN';
    end if;

    v_reused_draft := true;
    v_reused_reset_draft := v_cycle.reset_at is not null;

    update public.voting_cycles
    set
      status = 'submission_open',
      starts_at = v_now,
      ends_at = null,
      created_by_discord_id = v_actor_discord_id,
      ended_at = null,
      finalized_at = null,
      winners_published = false,
      theme = v_theme,
      title = null,
      is_sponsored = v_is_sponsored,
      sponsor_name = case when v_is_sponsored then v_sponsor_name else null end,
      sponsor_link = case when v_is_sponsored then v_sponsor_link else null end,
      reward_description = v_reward_description,
      sponsor_banner_key = case
        when v_is_sponsored then v_sponsor_banner_r2_key
        else null
      end,
      rule_template_id = null,
      submission_starts_at = v_now,
      submission_ends_at = null,
      voting_starts_at = null,
      voting_ends_at = null,
      results_published_at = null,
      archived_at = null,
      submission_warn_threshold = null,
      submission_warned_at = null,
      submission_auto_close_enabled = false,
      submission_auto_close_threshold = null,
      submission_auto_closed_at = null,
      votes_per_user = 2,
      allow_self_vote = false,
      sponsorship_id = null,
      sponsor_name_snapshot = case
        when v_is_sponsored then v_sponsor_name
        else null
      end,
      sponsor_link_snapshot = case
        when v_is_sponsored then v_sponsor_link
        else null
      end,
      sponsor_banner_url_snapshot = case
        when v_is_sponsored then v_sponsor_banner_url
        else null
      end,
      paused_from_status = null,
      phase_paused_at = null,
      phase_paused_remaining_seconds = null,
      phase_pause_reason = null,
      reset_at = null
    where id = v_cycle.id
    returning * into v_cycle;
  else
    insert into public.voting_cycles (
      status,
      starts_at,
      created_by_discord_id,
      theme,
      is_sponsored,
      sponsor_name,
      sponsor_link,
      reward_description,
      sponsor_banner_key,
      submission_starts_at,
      votes_per_user,
      allow_self_vote,
      sponsor_name_snapshot,
      sponsor_link_snapshot,
      sponsor_banner_url_snapshot
    ) values (
      'submission_open',
      v_now,
      v_actor_discord_id,
      v_theme,
      v_is_sponsored,
      case when v_is_sponsored then v_sponsor_name else null end,
      case when v_is_sponsored then v_sponsor_link else null end,
      v_reward_description,
      case when v_is_sponsored then v_sponsor_banner_r2_key else null end,
      v_now,
      2,
      false,
      case when v_is_sponsored then v_sponsor_name else null end,
      case when v_is_sponsored then v_sponsor_link else null end,
      case when v_is_sponsored then v_sponsor_banner_url else null end
    )
    returning * into v_cycle;

    v_created_cycle := true;
  end if;

  delete from public.cycle_sponsorships
  where cycle_id = v_cycle.id;

  if v_is_sponsored then
    insert into public.cycle_sponsorships (
      cycle_id,
      sponsor_name,
      sponsor_link,
      banner_r2_key,
      is_active,
      starts_at,
      ends_at,
      updated_at
    ) values (
      v_cycle.id,
      v_sponsor_name,
      v_sponsor_link,
      v_sponsor_banner_r2_key,
      true,
      v_now,
      null,
      v_now
    )
    returning id into v_sponsorship_id;

    update public.voting_cycles
    set sponsorship_id = v_sponsorship_id
    where id = v_cycle.id
    returning * into v_cycle;
  end if;

  insert into public.cycle_events (
    cycle_id,
    event_type,
    actor_type,
    actor_discord_user_id,
    payload
  ) values (
    v_cycle.id,
    'submission_phase_opened',
    'admin',
    p_actor_discord_user_id,
    jsonb_build_object(
      'phase', 'submission_open',
      'theme', v_theme,
      'reward_description', v_reward_description,
      'ends_at', null,
      'started_at', v_now,
      'reused_draft', v_reused_draft,
      'reused_reset_cycle', v_reused_reset_draft,
      'reset_count', v_cycle.reset_count,
      'sponsored_cycle', case
        when v_is_sponsored then jsonb_build_object(
          'company_name', v_sponsor_name,
          'sponsor_link', v_sponsor_link,
          'banner_r2_key', v_sponsor_banner_r2_key
        )
        else 'null'::jsonb
      end
    )
  );

  insert into public.admin_action_logs (
    actor_type,
    actor_id,
    action,
    target_type,
    target_id,
    meta
  ) values (
    'admin',
    p_actor_discord_user_id,
    'cycle_started',
    'cycle',
    v_cycle.id::text,
    jsonb_build_object(
      'phase', 'submission_open',
      'submission_starts_at', v_now,
      'submission_ends_at', null,
      'ends_at', null,
      'theme', v_theme,
      'theme_source', v_theme_source,
      'reward_description', v_reward_description,
      'reused_draft', v_reused_draft,
      'reused_reset_cycle', v_reused_reset_draft,
      'reset_count', v_cycle.reset_count,
      'sponsored_cycle', case
        when v_is_sponsored then jsonb_build_object(
          'company_name', v_sponsor_name,
          'sponsor_link', v_sponsor_link,
          'banner_r2_key', v_sponsor_banner_r2_key
        )
        else 'null'::jsonb
      end
    )
  );

  insert into public.app_config (key, value)
  values ('cycle_theme', v_theme)
  on conflict (key) do update set value = excluded.value;

  insert into public.app_config (key, value)
  values
    ('next_cycle_theme', null),
    ('next_cycle_reward_description', null),
    ('next_cycle_sponsored_enabled', 'false'),
    ('next_cycle_sponsor_name', null),
    ('next_cycle_sponsor_link', null),
    ('next_cycle_sponsor_banner_r2_key', null),
    ('next_cycle_is_sponsored', 'false')
  on conflict (key) do update set value = excluded.value;

  update public.user_logs
  set upload_fail_count = 0
  where upload_fail_count <> 0;

  return jsonb_build_object(
    'cycleId', v_cycle.id,
    'cycleNumber', v_cycle.id,
    'status', v_cycle.status::text,
    'startedAt', v_cycle.submission_starts_at,
    'alreadyStarted', false,
    'createdCycle', v_created_cycle,
    'reusedDraft', v_reused_draft,
    'reusedResetDraft', v_reused_reset_draft,
    'resetCount', v_cycle.reset_count
  );
end;
$$;

revoke all on function public.start_cycle(bigint, text, jsonb) from public;
grant execute on function public.start_cycle(bigint, text, jsonb) to service_role;

comment on function public.start_cycle(bigint, text, jsonb) is
  'Globally serializes Cycle Start, locks/reuses a clean draft when available, preserves reset history, and atomically writes cycle state, sponsorship, event, audit, and runtime config.';

create or replace function public.process_due_cycle_transitions(
  p_cycle_id bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cycle public.voting_cycles%rowtype;
  v_now timestamptz := transaction_timestamp();
  v_previous_status text;
  v_voting_started_at timestamptz;
  v_submission_ended_at timestamptz;
  v_voting_closed_event_at timestamptz;
  v_repair_codes text[] := '{}'::text[];
  v_changed_rows integer := 0;
  v_step_rows integer := 0;
begin
  if p_cycle_id is not null and p_cycle_id <= 0 then
    raise exception using message = 'INVALID_CYCLE_ID';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('cycle-phase-automation-global', 0)
  );

  if p_cycle_id is not null then
    select *
    into v_cycle
    from public.voting_cycles
    where id = p_cycle_id
    for update;
  else
    select *
    into v_cycle
    from public.voting_cycles
    where status in (
      'active',
      'submission_open',
      'submission_closed',
      'voting_open',
      'voting_closed',
      'paused',
      'finalizing'
    )
    order by id desc
    limit 1
    for update;
  end if;

  if not found then
    return jsonb_build_object(
      'outcome', 'noop',
      'cycleId', null,
      'previousStatus', null,
      'status', null,
      'transition', null,
      'reason', 'no_current_cycle',
      'repairCodes', '[]'::jsonb,
      'eventCreated', false,
      'processedAt', v_now
    );
  end if;

  v_previous_status := v_cycle.status::text;

  if v_previous_status = 'paused' then
    return jsonb_build_object(
      'outcome', 'noop',
      'cycleId', v_cycle.id,
      'previousStatus', v_previous_status,
      'status', v_previous_status,
      'transition', null,
      'reason', 'paused',
      'repairCodes', '[]'::jsonb,
      'eventCreated', false,
      'processedAt', v_now
    );
  end if;

  if v_previous_status = 'active' then
    return jsonb_build_object(
      'outcome', 'diagnostic',
      'cycleId', v_cycle.id,
      'previousStatus', v_previous_status,
      'status', v_previous_status,
      'transition', null,
      'reason', 'legacy_active_phase_is_ambiguous',
      'repairCodes', '[]'::jsonb,
      'eventCreated', false,
      'processedAt', v_now
    );
  end if;

  if v_previous_status = 'submission_open' then
    if v_cycle.voting_ends_at is not null then
      return jsonb_build_object(
        'outcome', 'diagnostic',
        'cycleId', v_cycle.id,
        'previousStatus', v_previous_status,
        'status', v_previous_status,
        'transition', null,
        'reason', 'submission_open_has_voting_end',
        'repairCodes', '[]'::jsonb,
        'eventCreated', false,
        'processedAt', v_now
      );
    end if;

    if v_cycle.submission_ends_at is null then
      return jsonb_build_object(
        'outcome', case
          when v_cycle.voting_starts_at is null then 'noop'
          else 'diagnostic'
        end,
        'cycleId', v_cycle.id,
        'previousStatus', v_previous_status,
        'status', v_previous_status,
        'transition', null,
        'reason', case
          when v_cycle.voting_starts_at is null then 'submission_timer_not_set'
          else 'submission_open_has_voting_start_without_deadline'
        end,
        'repairCodes', '[]'::jsonb,
        'eventCreated', false,
        'processedAt', v_now
      );
    end if;

    if v_cycle.submission_ends_at > v_now then
      return jsonb_build_object(
        'outcome', case
          when v_cycle.voting_starts_at is null then 'noop'
          else 'diagnostic'
        end,
        'cycleId', v_cycle.id,
        'previousStatus', v_previous_status,
        'status', v_previous_status,
        'transition', null,
        'reason', case
          when v_cycle.voting_starts_at is null then 'submission_not_due'
          else 'submission_open_has_early_voting_start'
        end,
        'repairCodes', '[]'::jsonb,
        'eventCreated', false,
        'processedAt', v_now
      );
    end if;

    v_voting_started_at := coalesce(v_cycle.voting_starts_at, v_now);

    if v_cycle.voting_starts_at is not null then
      v_repair_codes := array_append(
        v_repair_codes,
        'preserved_existing_voting_start'
      );
    end if;

    update public.voting_cycles
    set
      status = 'voting_open',
      ends_at = null,
      voting_starts_at = v_voting_started_at,
      voting_ends_at = null,
      paused_from_status = null,
      phase_paused_at = null,
      phase_paused_remaining_seconds = null,
      phase_pause_reason = null
    where id = v_cycle.id;

    update public.cycle_reminders
    set status = 'cancelled'
    where cycle_id = v_cycle.id
      and phase = 'submission_open'
      and status = 'pending';

    update public.app_config
    set value = null
    where key = 'cycle_end_at';

    insert into public.cycle_events (
      cycle_id,
      event_type,
      actor_type,
      payload
    ) values (
      v_cycle.id,
      'voting_phase_opened',
      'system',
      jsonb_build_object(
        'from_phase', 'submission_open',
        'phase', 'voting_open',
        'automatic', true,
        'database_time', v_now,
        'submission_ended_at', v_cycle.submission_ends_at,
        'voting_starts_at', v_voting_started_at,
        'voting_ends_at', null,
        'votes_per_user', v_cycle.votes_per_user,
        'repair_codes', to_jsonb(v_repair_codes)
      )
    );

    return jsonb_build_object(
      'outcome', 'transitioned',
      'cycleId', v_cycle.id,
      'previousStatus', v_previous_status,
      'status', 'voting_open',
      'transition', 'submission_open_to_voting_open',
      'reason', 'submission_deadline_reached',
      'repairCodes', to_jsonb(v_repair_codes),
      'eventCreated', true,
      'processedAt', v_now
    );
  end if;

  if v_previous_status = 'submission_closed' then
    if v_cycle.voting_ends_at is not null then
      return jsonb_build_object(
        'outcome', 'diagnostic',
        'cycleId', v_cycle.id,
        'previousStatus', v_previous_status,
        'status', v_previous_status,
        'transition', null,
        'reason', 'submission_closed_has_voting_end',
        'repairCodes', '[]'::jsonb,
        'eventCreated', false,
        'processedAt', v_now
      );
    end if;

    v_submission_ended_at := coalesce(v_cycle.submission_ends_at, v_now);
    v_voting_started_at := coalesce(v_cycle.voting_starts_at, v_now);

    if v_cycle.submission_ends_at is null then
      v_repair_codes := array_append(
        v_repair_codes,
        'submission_end_recovered_at_processing_time'
      );
    end if;

    if v_cycle.voting_starts_at is null then
      v_repair_codes := array_append(
        v_repair_codes,
        'voting_start_recovered_at_processing_time'
      );
    end if;

    update public.voting_cycles
    set
      status = 'voting_open',
      ends_at = null,
      submission_ends_at = v_submission_ended_at,
      voting_starts_at = v_voting_started_at,
      voting_ends_at = null,
      paused_from_status = null,
      phase_paused_at = null,
      phase_paused_remaining_seconds = null,
      phase_pause_reason = null
    where id = v_cycle.id;

    update public.cycle_reminders
    set status = 'cancelled'
    where cycle_id = v_cycle.id
      and phase = 'submission_open'
      and status = 'pending';

    update public.app_config
    set value = null
    where key = 'cycle_end_at';

    insert into public.cycle_events (
      cycle_id,
      event_type,
      actor_type,
      payload
    ) values (
      v_cycle.id,
      'voting_phase_opened',
      'system',
      jsonb_build_object(
        'from_phase', 'submission_closed',
        'phase', 'voting_open',
        'automatic', true,
        'recovery', true,
        'database_time', v_now,
        'submission_ended_at', v_submission_ended_at,
        'voting_starts_at', v_voting_started_at,
        'voting_ends_at', null,
        'votes_per_user', v_cycle.votes_per_user,
        'repair_codes', to_jsonb(v_repair_codes)
      )
    );

    return jsonb_build_object(
      'outcome', 'transitioned',
      'cycleId', v_cycle.id,
      'previousStatus', v_previous_status,
      'status', 'voting_open',
      'transition', 'submission_closed_to_voting_open',
      'reason', 'recovered_stranded_submission_close',
      'repairCodes', to_jsonb(v_repair_codes),
      'eventCreated', true,
      'processedAt', v_now
    );
  end if;

  if v_previous_status = 'voting_open' then
    if v_cycle.voting_starts_at is null then
      return jsonb_build_object(
        'outcome', 'diagnostic',
        'cycleId', v_cycle.id,
        'previousStatus', v_previous_status,
        'status', v_previous_status,
        'transition', null,
        'reason', 'voting_open_missing_voting_start',
        'repairCodes', '[]'::jsonb,
        'eventCreated', false,
        'processedAt', v_now
      );
    end if;

    if v_cycle.submission_ends_at is null then
      v_submission_ended_at := v_cycle.voting_starts_at;
      v_repair_codes := array_append(
        v_repair_codes,
        'submission_end_aligned_to_voting_start'
      );
    else
      v_submission_ended_at := v_cycle.submission_ends_at;
    end if;

    if v_cycle.ends_at is not null then
      v_repair_codes := array_append(
        v_repair_codes,
        'legacy_cycle_end_cleared'
      );
    end if;

    if v_cycle.voting_ends_at is null
      or v_cycle.voting_ends_at > v_now
    then
      if cardinality(v_repair_codes) > 0 then
        update public.voting_cycles
        set
          ends_at = null,
          submission_ends_at = v_submission_ended_at
        where id = v_cycle.id;

        return jsonb_build_object(
          'outcome', 'repaired',
          'cycleId', v_cycle.id,
          'previousStatus', v_previous_status,
          'status', v_previous_status,
          'transition', null,
          'reason', 'voting_open_normalized',
          'repairCodes', to_jsonb(v_repair_codes),
          'eventCreated', false,
          'processedAt', v_now
        );
      end if;

      return jsonb_build_object(
        'outcome', 'noop',
        'cycleId', v_cycle.id,
        'previousStatus', v_previous_status,
        'status', v_previous_status,
        'transition', null,
        'reason', case
          when v_cycle.voting_ends_at is null then 'voting_timer_not_set'
          else 'voting_not_due'
        end,
        'repairCodes', '[]'::jsonb,
        'eventCreated', false,
        'processedAt', v_now
      );
    end if;

    update public.voting_cycles
    set
      status = 'voting_closed',
      ends_at = null,
      submission_ends_at = v_submission_ended_at,
      paused_from_status = null,
      phase_paused_at = null,
      phase_paused_remaining_seconds = null,
      phase_pause_reason = null
    where id = v_cycle.id;

    update public.cycle_reminders
    set status = 'cancelled'
    where cycle_id = v_cycle.id
      and phase = 'voting_open'
      and status = 'pending';

    update public.app_config
    set value = null
    where key = 'cycle_end_at';

    insert into public.cycle_events (
      cycle_id,
      event_type,
      actor_type,
      payload
    ) values (
      v_cycle.id,
      'voting_phase_closed',
      'system',
      jsonb_build_object(
        'from_phase', 'voting_open',
        'phase', 'voting_closed',
        'automatic', true,
        'database_time', v_now,
        'voting_ended_at', v_cycle.voting_ends_at,
        'repair_codes', to_jsonb(v_repair_codes)
      )
    );

    return jsonb_build_object(
      'outcome', 'transitioned',
      'cycleId', v_cycle.id,
      'previousStatus', v_previous_status,
      'status', 'voting_closed',
      'transition', 'voting_open_to_voting_closed',
      'reason', 'voting_deadline_reached',
      'repairCodes', to_jsonb(v_repair_codes),
      'eventCreated', true,
      'processedAt', v_now
    );
  end if;

  if v_previous_status = 'voting_closed' then
    select max(created_at)
    into v_voting_closed_event_at
    from public.cycle_events
    where cycle_id = v_cycle.id
      and event_type = 'voting_phase_closed';

    if v_cycle.ends_at is not null then
      v_repair_codes := array_append(
        v_repair_codes,
        'legacy_cycle_end_cleared'
      );
    end if;

    if v_cycle.submission_ends_at is null
      and v_cycle.voting_starts_at is not null
    then
      v_repair_codes := array_append(
        v_repair_codes,
        'submission_end_aligned_to_voting_start'
      );
    end if;

    if v_voting_closed_event_at is not null and (
      v_cycle.voting_ends_at is null
      or v_cycle.voting_ends_at > v_voting_closed_event_at
    ) then
      v_repair_codes := array_append(
        v_repair_codes,
        'voting_end_aligned_to_close_event'
      );
    end if;

    if cardinality(v_repair_codes) > 0 then
      update public.voting_cycles
      set
        ends_at = null,
        submission_ends_at = case
          when submission_ends_at is null and voting_starts_at is not null
            then voting_starts_at
          else submission_ends_at
        end,
        voting_ends_at = case
          when v_voting_closed_event_at is not null and (
            voting_ends_at is null
            or voting_ends_at > v_voting_closed_event_at
          ) then v_voting_closed_event_at
          else voting_ends_at
        end
      where id = v_cycle.id;

      get diagnostics v_changed_rows = row_count;
    end if;

    update public.cycle_reminders
    set status = 'cancelled'
    where cycle_id = v_cycle.id
      and phase = 'voting_open'
      and status = 'pending';

    get diagnostics v_step_rows = row_count;
    v_changed_rows := v_changed_rows + v_step_rows;

    update public.app_config
    set value = null
    where key = 'cycle_end_at'
      and value is not null;

    get diagnostics v_step_rows = row_count;
    v_changed_rows := v_changed_rows + v_step_rows;

    return jsonb_build_object(
      'outcome', case when v_changed_rows > 0 then 'repaired' else 'noop' end,
      'cycleId', v_cycle.id,
      'previousStatus', v_previous_status,
      'status', v_previous_status,
      'transition', null,
      'reason', case
        when v_changed_rows > 0 then 'voting_closed_normalized'
        else 'voting_already_closed'
      end,
      'repairCodes', to_jsonb(v_repair_codes),
      'eventCreated', false,
      'processedAt', v_now
    );
  end if;

  return jsonb_build_object(
    'outcome', 'noop',
    'cycleId', v_cycle.id,
    'previousStatus', v_previous_status,
    'status', v_previous_status,
    'transition', null,
    'reason', 'status_not_automated',
    'repairCodes', '[]'::jsonb,
    'eventCreated', false,
    'processedAt', v_now
  );
end;
$$;

revoke all on function public.process_due_cycle_transitions(bigint) from public;
grant execute on function public.process_due_cycle_transitions(bigint) to service_role;

comment on function public.process_due_cycle_transitions(bigint) is
  'Uses database time plus a global advisory lock and row lock for idempotent automatic phase transitions. It repairs only explicit canonical cases; ambiguous legacy or contradictory states return diagnostics without mutation.';

commit;

begin;

drop trigger if exists votes_discord_access_trigger
  on public.votes;

drop trigger if exists submissions_discord_access_trigger
  on public.submissions;

create or replace function public.cast_cycle_vote(
  p_cycle_id bigint,
  p_submission_id bigint,
  p_discord_user_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  cycle_row public.voting_cycles%rowtype;
  submission_owner_id text;
  current_vote_count integer;
  v_user_banned boolean;
  v_membership public.discord_member_state%rowtype;
begin
  if p_discord_user_id is null or btrim(p_discord_user_id) = '' then
    raise exception using message = 'INVALID_DISCORD_USER';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('discord-member:' || p_discord_user_id, 0)
  );

  select is_banned
  into v_user_banned
  from public.user_logs
  where discord_user_id = p_discord_user_id;

  if not found then
    raise exception using message = 'AUTH_DEPENDENCY_UNAVAILABLE';
  end if;

  select *
  into v_membership
  from public.discord_member_state
  where discord_user_id = p_discord_user_id;

  if not found then
    raise exception using message = 'NOT_IN_DISCORD';
  end if;

  if v_membership.discord_ban_active then
    raise exception using message = 'DISCORD_BANNED';
  end if;

  if v_user_banned then
    raise exception using message = 'WEBSITE_BANNED';
  end if;

  if not v_membership.is_in_discord then
    raise exception using message = 'NOT_IN_DISCORD';
  end if;

  if v_membership.discord_joined_at is null
    or v_membership.discord_joined_at > now() - interval '10 minutes'
  then
    raise exception using message = 'JOINED_TOO_RECENTLY';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_cycle_id::text || ':' || p_discord_user_id, 0)
  );

  select *
  into cycle_row
  from public.voting_cycles
  where id = p_cycle_id
  for update;

  if not found or cycle_row.status::text <> 'voting_open' then
    raise exception using message = 'NO_ACTIVE_VOTING_PHASE';
  end if;

  select discord_user_id
  into submission_owner_id
  from public.submissions
  where id = p_submission_id
    and cycle_id = p_cycle_id
    and coalesce(is_disqualified, false) = false
    and public_visibility_status = 'visible';

  if not found then
    raise exception using message = 'SUBMISSION_NOT_FOUND';
  end if;

  if cycle_row.allow_self_vote = false
    and submission_owner_id = p_discord_user_id
  then
    raise exception using message = 'SELF_VOTE';
  end if;

  if exists (
    select 1
    from public.votes
    where cycle_id = p_cycle_id
      and submission_id = p_submission_id
      and discord_user_id = p_discord_user_id
  ) then
    raise exception using message = 'DUPLICATE_SUBMISSION_VOTE';
  end if;

  select count(*)::integer
  into current_vote_count
  from public.votes
  where cycle_id = p_cycle_id
    and discord_user_id = p_discord_user_id;

  if current_vote_count >= cycle_row.votes_per_user then
    raise exception using message = 'VOTE_LIMIT_REACHED';
  end if;

  insert into public.votes (
    cycle_id,
    submission_id,
    discord_user_id
  ) values (
    p_cycle_id,
    p_submission_id,
    p_discord_user_id
  );

  current_vote_count := current_vote_count + 1;

  return jsonb_build_object(
    'voteCount', current_vote_count,
    'votesPerUser', cycle_row.votes_per_user,
    'hasVoted', current_vote_count >= cycle_row.votes_per_user
  );
end;
$$;

revoke all on function public.cast_cycle_vote(bigint, bigint, text)
  from public, anon, authenticated;
grant execute on function public.cast_cycle_vote(bigint, bigint, text)
  to service_role;

comment on function public.cast_cycle_vote(bigint, bigint, text) is
  'Atomically enforces fail-closed Website/Discord access plus voting phase, limits, no self-votes, and one vote per submission.';

commit;

begin;
create or replace function public.cast_cycle_vote(
  p_cycle_id bigint,
  p_submission_id bigint,
  p_discord_user_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  cycle_row public.voting_cycles%rowtype;
  submission_row public.submissions%rowtype;
  current_vote_count integer;
  v_user_banned boolean;
  v_membership public.discord_member_state%rowtype;
begin
  if p_discord_user_id is null or btrim(p_discord_user_id) = '' then
    raise exception using message = 'INVALID_DISCORD_USER';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('discord-member:' || p_discord_user_id, 0)
  );

  select is_banned
  into v_user_banned
  from public.user_logs
  where discord_user_id = p_discord_user_id;

  if not found then
    raise exception using message = 'AUTH_DEPENDENCY_UNAVAILABLE';
  end if;

  select *
  into v_membership
  from public.discord_member_state
  where discord_user_id = p_discord_user_id;

  if not found then
    raise exception using message = 'NOT_IN_DISCORD';
  end if;

  if v_membership.discord_ban_active then
    raise exception using message = 'DISCORD_BANNED';
  end if;

  if v_user_banned then
    raise exception using message = 'WEBSITE_BANNED';
  end if;

  if not v_membership.is_in_discord then
    raise exception using message = 'NOT_IN_DISCORD';
  end if;

  if v_membership.discord_joined_at is null
    or v_membership.discord_joined_at > now() - interval '10 minutes'
  then
    raise exception using message = 'JOINED_TOO_RECENTLY';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_cycle_id::text || ':' || p_discord_user_id, 0)
  );

  select *
  into cycle_row
  from public.voting_cycles
  where id = p_cycle_id
  for update;

  if not found or cycle_row.status::text <> 'voting_open' then
    raise exception using message = 'NO_ACTIVE_VOTING_PHASE';
  end if;

  select *
  into submission_row
  from public.submissions
  where id = p_submission_id
    and cycle_id = p_cycle_id
  for update;

  if not found then
    raise exception using message = 'SUBMISSION_NOT_FOUND';
  end if;

  if coalesce(submission_row.is_disqualified, false)
    or submission_row.public_visibility_status <> 'visible'
  then
    raise exception using
      message = 'SUBMISSION_NOT_COMPETITION_ELIGIBLE';
  end if;

  if cycle_row.allow_self_vote = false
    and submission_row.discord_user_id = p_discord_user_id
  then
    raise exception using message = 'SELF_VOTE';
  end if;

  if exists (
    select 1
    from public.votes
    where cycle_id = p_cycle_id
      and submission_id = p_submission_id
      and discord_user_id = p_discord_user_id
  ) then
    raise exception using message = 'DUPLICATE_SUBMISSION_VOTE';
  end if;

  select count(*)::integer
  into current_vote_count
  from public.votes
  where cycle_id = p_cycle_id
    and discord_user_id = p_discord_user_id;

  if current_vote_count >= cycle_row.votes_per_user then
    raise exception using message = 'VOTE_LIMIT_REACHED';
  end if;

  insert into public.votes (
    cycle_id,
    submission_id,
    discord_user_id
  ) values (
    p_cycle_id,
    p_submission_id,
    p_discord_user_id
  );

  current_vote_count := current_vote_count + 1;

  return jsonb_build_object(
    'voteCount', current_vote_count,
    'votesPerUser', cycle_row.votes_per_user,
    'hasVoted', current_vote_count >= cycle_row.votes_per_user
  );
end;
$$;

revoke all on function public.cast_cycle_vote(bigint, bigint, text)
  from public, anon, authenticated, discord_bot;

grant execute on function public.republish_discord_ban_submission(bigint, text, text, boolean)
  to service_role;
grant execute on function public.cast_cycle_vote(bigint, bigint, text)
  to service_role;
commit;
