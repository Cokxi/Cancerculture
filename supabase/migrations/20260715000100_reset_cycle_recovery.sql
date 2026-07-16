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
