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
