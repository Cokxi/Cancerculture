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
