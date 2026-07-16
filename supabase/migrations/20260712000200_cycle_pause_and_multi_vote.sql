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
