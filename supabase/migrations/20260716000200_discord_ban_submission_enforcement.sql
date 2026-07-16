begin;

alter table public.submissions
  add column if not exists public_visibility_source text not null default 'manual',
  add column if not exists discord_ban_hidden_at timestamptz,
  add column if not exists discord_ban_hidden_observed_at timestamptz,
  add column if not exists public_republished_at timestamptz,
  add column if not exists public_republished_by_discord_user_id text,
  add column if not exists public_republish_reason text,
  add column if not exists public_republish_review_confirmed boolean
    not null default false;

alter table public.submissions
  drop constraint if exists submissions_public_visibility_source_check,
  drop constraint if exists submissions_public_republish_metadata_check,
  drop constraint if exists submissions_public_republish_reason_check;

alter table public.submissions
  add constraint submissions_public_visibility_source_check
    check (
      public_visibility_source in (
        'manual',
        'discord_ban',
        'manual_republish'
      )
    ),
  add constraint submissions_public_republish_reason_check
    check (
      public_republish_reason is null
      or length(btrim(public_republish_reason)) between 10 and 1000
    ),
  add constraint submissions_public_republish_metadata_check
    check (
      (
        public_republished_at is null
        and public_republished_by_discord_user_id is null
        and public_republish_reason is null
        and public_republish_review_confirmed = false
      )
      or (
        public_republished_at is not null
        and public_republished_by_discord_user_id is not null
        and public_republish_reason is not null
        and public_republish_review_confirmed = true
      )
    );

create index if not exists submissions_discord_user_visibility_idx
  on public.submissions (
    discord_user_id,
    public_visibility_status,
    cycle_id
  );

create index if not exists submissions_discord_ban_hidden_idx
  on public.submissions (discord_ban_hidden_at desc, id)
  where public_visibility_source = 'discord_ban';

create or replace view public.public_submissions_with_votes as
select
  s.id,
  s.cycle_id,
  s.discord_user_id,
  s.r2_key,
  count(v.id) as vote_count,
  rank() over (
    partition by s.cycle_id
    order by count(v.id) desc
  ) as rank
from public.submissions s
left join public.votes v
  on v.submission_id = s.id
where coalesce(s.is_disqualified, false) = false
  and s.public_visibility_status = 'visible'
group by
  s.id,
  s.cycle_id,
  s.discord_user_id,
  s.r2_key;

revoke all on table public.public_submissions_with_votes
  from public, anon, authenticated;
grant select on table public.public_submissions_with_votes
  to service_role;

create or replace function public.enforce_discord_ban_submissions(
  p_discord_user_id text,
  p_observed_at timestamptz,
  p_source text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cycle_id bigint;
  v_hidden_count integer := 0;
  v_disqualified_count integer := 0;
  v_changed_count integer := 0;
  v_now timestamptz := transaction_timestamp();
begin
  if p_discord_user_id is null
    or btrim(p_discord_user_id) = ''
    or p_observed_at is null
    or p_source is null
    or length(btrim(p_source)) not between 1 and 80
  then
    raise exception using message = 'INVALID_DISCORD_BAN_ENFORCEMENT';
  end if;

  for v_cycle_id in
    select distinct submission.cycle_id
    from public.submissions submission
    where submission.discord_user_id = p_discord_user_id
      and submission.cycle_id is not null
    order by submission.cycle_id
  loop
    perform pg_advisory_xact_lock(
      hashtextextended(
        'cycle-finalization:' || v_cycle_id::text,
        0
      )
    );
    perform pg_advisory_xact_lock(
      hashtextextended(
        'cycle-reset:' || v_cycle_id::text,
        0
      )
    );
  end loop;

  perform 1
  from public.voting_cycles cycle
  where cycle.id in (
    select submission.cycle_id
    from public.submissions submission
    where submission.discord_user_id = p_discord_user_id
      and submission.cycle_id is not null
  )
  order by cycle.id
  for update;

  perform 1
  from public.submissions submission
  where submission.discord_user_id = p_discord_user_id
  order by submission.id
  for update;

  select
    count(*) filter (
      where submission.public_visibility_status <> 'removed'
    )::integer,
    count(*) filter (
      where coalesce(submission.is_disqualified, false) = false
        and cycle.status::text in (
          'draft',
          'active',
          'submission_open',
          'submission_closed',
          'voting_open',
          'voting_closed',
          'paused',
          'finalizing'
        )
    )::integer,
    count(*) filter (
      where submission.public_visibility_status <> 'removed'
        or submission.public_visibility_source <> 'discord_ban'
        or submission.public_republished_at is not null
        or (
          coalesce(submission.is_disqualified, false) = false
          and cycle.status::text in (
            'draft',
            'active',
            'submission_open',
            'submission_closed',
            'voting_open',
            'voting_closed',
            'paused',
            'finalizing'
          )
        )
    )::integer
  into
    v_hidden_count,
    v_disqualified_count,
    v_changed_count
  from public.submissions submission
  left join public.voting_cycles cycle
    on cycle.id = submission.cycle_id
  where submission.discord_user_id = p_discord_user_id;

  update public.submissions submission
  set
    public_visibility_status = 'removed',
    public_visibility_reason_code = 'discord_ban',
    public_visibility_reason_text = null,
    public_visibility_updated_at = v_now,
    public_visibility_updated_by_discord_user_id = null,
    public_visibility_updated_by_discord_username = 'Discord sync',
    public_visibility_source = 'discord_ban',
    discord_ban_hidden_at = v_now,
    discord_ban_hidden_observed_at = greatest(
      coalesce(
        submission.discord_ban_hidden_observed_at,
        '-infinity'::timestamptz
      ),
      p_observed_at
    ),
    public_republished_at = null,
    public_republished_by_discord_user_id = null,
    public_republish_reason = null,
    public_republish_review_confirmed = false,
    is_disqualified = case
      when cycle.status::text in (
        'draft',
        'active',
        'submission_open',
        'submission_closed',
        'voting_open',
        'voting_closed',
        'paused',
        'finalizing'
      )
      then true
      else submission.is_disqualified
    end,
    disqualification_type = case
      when coalesce(submission.is_disqualified, false) = false
        and cycle.status::text in (
          'draft',
          'active',
          'submission_open',
          'submission_closed',
          'voting_open',
          'voting_closed',
          'paused',
          'finalizing'
        )
      then 'discord_ban'
      else submission.disqualification_type
    end,
    disqualification_reason_code = case
      when coalesce(submission.is_disqualified, false) = false
        and cycle.status::text in (
          'draft',
          'active',
          'submission_open',
          'submission_closed',
          'voting_open',
          'voting_closed',
          'paused',
          'finalizing'
        )
      then 'discord_ban'
      else submission.disqualification_reason_code
    end,
    disqualification_reason_text = case
      when coalesce(submission.is_disqualified, false) = false
        and cycle.status::text in (
          'draft',
          'active',
          'submission_open',
          'submission_closed',
          'voting_open',
          'voting_closed',
          'paused',
          'finalizing'
        )
      then null
      else submission.disqualification_reason_text
    end,
    disqualified_at = case
      when coalesce(submission.is_disqualified, false) = false
        and cycle.status::text in (
          'draft',
          'active',
          'submission_open',
          'submission_closed',
          'voting_open',
          'voting_closed',
          'paused',
          'finalizing'
        )
      then v_now
      else submission.disqualified_at
    end,
    disqualified_by_discord_user_id = case
      when coalesce(submission.is_disqualified, false) = false
        and cycle.status::text in (
          'draft',
          'active',
          'submission_open',
          'submission_closed',
          'voting_open',
          'voting_closed',
          'paused',
          'finalizing'
        )
      then null
      else submission.disqualified_by_discord_user_id
    end,
    disqualified_by_discord_username = case
      when coalesce(submission.is_disqualified, false) = false
        and cycle.status::text in (
          'draft',
          'active',
          'submission_open',
          'submission_closed',
          'voting_open',
          'voting_closed',
          'paused',
          'finalizing'
        )
      then 'Discord sync'
      else submission.disqualified_by_discord_username
    end
  from public.voting_cycles cycle
  where submission.discord_user_id = p_discord_user_id
    and cycle.id = submission.cycle_id;

  update public.submissions submission
  set
    public_visibility_status = 'removed',
    public_visibility_reason_code = 'discord_ban',
    public_visibility_reason_text = null,
    public_visibility_updated_at = v_now,
    public_visibility_updated_by_discord_user_id = null,
    public_visibility_updated_by_discord_username = 'Discord sync',
    public_visibility_source = 'discord_ban',
    discord_ban_hidden_at = v_now,
    discord_ban_hidden_observed_at = greatest(
      coalesce(
        submission.discord_ban_hidden_observed_at,
        '-infinity'::timestamptz
      ),
      p_observed_at
    ),
    public_republished_at = null,
    public_republished_by_discord_user_id = null,
    public_republish_reason = null,
    public_republish_review_confirmed = false
  where submission.discord_user_id = p_discord_user_id
    and submission.cycle_id is null;

  if v_changed_count > 0 then
    insert into public.admin_action_logs (
      actor_type,
      actor_id,
      action,
      target_type,
      target_id,
      meta
    ) values (
      'discord_sync',
      'membership_endpoint',
      'discord_ban_submissions_enforced',
      'discord_user',
      p_discord_user_id,
      jsonb_build_object(
        'source', left(btrim(p_source), 80),
        'observedAt', p_observed_at,
        'hiddenSubmissions', v_hidden_count,
        'disqualifiedSubmissions', v_disqualified_count
      )
    );
  end if;

  return jsonb_build_object(
    'outcome', case
      when v_changed_count > 0 then 'applied'
      else 'no_change'
    end,
    'hiddenSubmissions', v_hidden_count,
    'disqualifiedSubmissions', v_disqualified_count
  );
end;
$$;

create or replace function public.enforce_discord_ban_submissions_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.discord_ban_active
    and (
      tg_op = 'INSERT'
      or not coalesce(old.discord_ban_active, false)
    )
  then
    perform public.enforce_discord_ban_submissions(
      new.discord_user_id,
      coalesce(
        new.discord_ban_observed_at,
        new.discord_banned_at,
        transaction_timestamp()
      ),
      'discord_ban_state_transition'
    );
  end if;

  return new;
end;
$$;

drop trigger if exists discord_member_state_submission_enforcement_trigger
  on public.discord_member_state;

create trigger discord_member_state_submission_enforcement_trigger
after insert or update of discord_ban_active
on public.discord_member_state
for each row
execute function public.enforce_discord_ban_submissions_trigger();

create or replace function public.protect_discord_ban_republish()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.public_visibility_source = 'discord_ban'
    and old.public_visibility_status = 'removed'
    and new.public_visibility_status = 'visible'
    and current_setting(
      'cancerculture.discord_ban_republish',
      true
    ) is distinct from 'authorized'
  then
    raise exception using
      message = 'DISCORD_BAN_REPUBLISH_REQUIRES_REVIEW';
  end if;

  return new;
end;
$$;

drop trigger if exists submissions_discord_ban_republish_guard_trigger
  on public.submissions;

create trigger submissions_discord_ban_republish_guard_trigger
before update of public_visibility_status
on public.submissions
for each row
execute function public.protect_discord_ban_republish();

create or replace function public.republish_discord_ban_submission(
  p_submission_id bigint,
  p_actor_discord_user_id text,
  p_reason text,
  p_manual_review_confirmed boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_submission public.submissions%rowtype;
  v_membership public.discord_member_state%rowtype;
  v_now timestamptz := transaction_timestamp();
begin
  if p_submission_id is null or p_submission_id <= 0 then
    raise exception using message = 'INVALID_SUBMISSION_ID';
  end if;

  if p_actor_discord_user_id is null
    or btrim(p_actor_discord_user_id) = ''
  then
    raise exception using message = 'INVALID_REPUBLISH_ACTOR';
  end if;

  if p_reason is null
    or length(btrim(p_reason)) not between 10 and 1000
  then
    raise exception using message = 'REPUBLISH_REASON_REQUIRED';
  end if;

  if p_manual_review_confirmed is distinct from true then
    raise exception using message = 'MANUAL_REVIEW_CONFIRMATION_REQUIRED';
  end if;

  select *
  into v_submission
  from public.submissions
  where id = p_submission_id;

  if not found then
    raise exception using message = 'SUBMISSION_NOT_FOUND';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'discord-member:' || v_submission.discord_user_id,
      0
    )
  );

  select *
  into v_membership
  from public.discord_member_state
  where discord_user_id = v_submission.discord_user_id
  for update;

  if not found then
    raise exception using message = 'MEMBERSHIP_STATE_MISSING';
  end if;

  if v_membership.discord_ban_active then
    raise exception using message = 'DISCORD_BAN_STILL_ACTIVE';
  end if;

  select *
  into v_submission
  from public.submissions
  where id = p_submission_id
  for update;

  if v_submission.public_visibility_source <> 'discord_ban' then
    if v_submission.public_visibility_status = 'visible'
      and v_submission.public_republished_at is not null
    then
      return jsonb_build_object(
        'outcome', 'already_republished',
        'submissionId', v_submission.id,
        'competitionDisqualified',
          coalesce(v_submission.is_disqualified, false)
      );
    end if;

    raise exception using message = 'SUBMISSION_NOT_DISCORD_BAN_HIDDEN';
  end if;

  perform set_config(
    'cancerculture.discord_ban_republish',
    'authorized',
    true
  );

  update public.submissions
  set
    public_visibility_status = 'visible',
    public_visibility_reason_code = null,
    public_visibility_reason_text = null,
    public_visibility_updated_at = v_now,
    public_visibility_updated_by_discord_user_id =
      p_actor_discord_user_id,
    public_visibility_updated_by_discord_username = null,
    public_visibility_source = 'manual_republish',
    public_republished_at = v_now,
    public_republished_by_discord_user_id =
      p_actor_discord_user_id,
    public_republish_reason = btrim(p_reason),
    public_republish_review_confirmed = true
  where id = p_submission_id
  returning * into v_submission;

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
    'discord_ban_submission_republished',
    'submission',
    p_submission_id::text,
    jsonb_build_object(
      'reason', btrim(p_reason),
      'manualReviewConfirmed', true,
      'competitionStillDisqualified',
        coalesce(v_submission.is_disqualified, false)
    )
  );

  return jsonb_build_object(
    'outcome', 'republished',
    'submissionId', v_submission.id,
    'competitionDisqualified',
      coalesce(v_submission.is_disqualified, false)
  );
end;
$$;

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

revoke all on function public.enforce_discord_ban_submissions(text, timestamptz, text)
  from public, anon, authenticated, discord_bot;
revoke all on function public.enforce_discord_ban_submissions_trigger()
  from public, anon, authenticated, discord_bot;
revoke all on function public.protect_discord_ban_republish()
  from public, anon, authenticated, discord_bot;
revoke all on function public.republish_discord_ban_submission(bigint, text, text, boolean)
  from public, anon, authenticated, discord_bot;
revoke all on function public.cast_cycle_vote(bigint, bigint, text)
  from public, anon, authenticated, discord_bot;

grant execute on function public.republish_discord_ban_submission(bigint, text, text, boolean)
  to service_role;
grant execute on function public.cast_cycle_vote(bigint, bigint, text)
  to service_role;

do $$
declare
  v_banned_user record;
begin
  for v_banned_user in
    select
      discord_user_id,
      coalesce(
        discord_ban_observed_at,
        discord_banned_at,
        transaction_timestamp()
      ) as observed_at
    from public.discord_member_state
    where discord_ban_active = true
    order by discord_user_id
  loop
    perform public.enforce_discord_ban_submissions(
      v_banned_user.discord_user_id,
      v_banned_user.observed_at,
      'migration_backfill'
    );
  end loop;
end;
$$;

comment on function public.enforce_discord_ban_submissions(text, timestamptz, text) is
  'Hides every Submission for one Discord-banned user and disqualifies only non-finalized competition entries without deleting media or historical result snapshots.';
comment on function public.republish_discord_ban_submission(bigint, text, text, boolean) is
  'Admin-only manual visibility restoration after Discord unban; never restores competition eligibility or historical results.';

commit;
