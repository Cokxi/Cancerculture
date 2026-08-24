begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $preflight$
declare
  v_root_signature constant text :=
    'public.get_community_comment_thread_page(bigint,text,timestamp with time zone,integer,timestamp with time zone,uuid,integer)';
  v_root_definition text;
begin
  select pg_get_functiondef(to_regprocedure(v_root_signature))
  into strict v_root_definition;

  if to_regclass('public.community_comment_votes') is not null
    or to_regclass('public.community_comment_vote_transitions') is not null
    or to_regclass('public.community_comment_vote_requests') is not null
    or to_regprocedure('public.set_community_comment_vote(uuid,uuid,text,bigint,uuid,text,boolean)') is not null
    or to_regprocedure('public.get_community_comment_vote_viewer_state(uuid,uuid[])') is not null
    or (select release_state from public.community_comment_settings where singleton) <> 'off'
    or (select version from public.community_comment_settings where singleton) <> 1
    or exists (select 1 from public.community_comment_abuse_policies)
    or exists (select 1 from public.community_comment_threads)
    or exists (select 1 from public.community_comments)
    or v_root_definition not like '%''releaseState'', v_release_state%'
    or v_root_definition not like '%case when p_sort = ''top'' then 0 end desc%'
  then
    raise exception using
      errcode = '55000',
      message = 'ATOMIC_COMMENT_VOTES_BASELINE_MISMATCH';
  end if;

  if not exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conrelid = 'public.community_comment_abuse_policies'::regclass
      and constraint_row.conname = 'community_comment_abuse_policies_action_check'
      and pg_get_constraintdef(constraint_row.oid) like '%''root''%''reply''%''edit''%'
  ) or not exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conrelid = 'public.community_comment_abuse_buckets'::regclass
      and constraint_row.conname = 'community_comment_abuse_buckets_action_check'
      and pg_get_constraintdef(constraint_row.oid) like '%''root''%''reply''%''edit''%'
  ) or not exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conrelid = 'public.community_comment_abuse_events'::regclass
      and constraint_row.conname = 'community_comment_abuse_events_action_check'
      and pg_get_constraintdef(constraint_row.oid) like '%''root''%''reply''%''edit''%'
  ) then
    raise exception using
      errcode = '55000',
      message = 'ATOMIC_COMMENT_VOTES_ABUSE_BASELINE_MISMATCH';
  end if;
end;
$preflight$;

create table public.community_comment_votes (
  comment_id uuid not null
    references public.community_comments(id) on delete restrict,
  voter_discord_user_id text not null
    references public.user_logs(discord_user_id) on delete restrict,
  vote_state text check (vote_state in ('up', 'down')),
  version bigint not null check (version > 0),
  updated_at timestamptz not null default transaction_timestamp(),
  primary key (comment_id, voter_discord_user_id)
);

create table public.community_comment_vote_transitions (
  id bigint generated always as identity primary key,
  comment_id uuid not null
    references public.community_comments(id) on delete restrict,
  voter_discord_user_id text not null
    references public.user_logs(discord_user_id) on delete restrict,
  from_state text check (from_state in ('up', 'down')),
  to_state text check (to_state in ('up', 'down')),
  from_version bigint not null check (from_version >= 0),
  to_version bigint not null check (to_version > 0),
  request_id uuid not null,
  transitioned_at timestamptz not null default transaction_timestamp(),
  constraint community_comment_vote_transition_change_check
    check (from_state is distinct from to_state),
  constraint community_comment_vote_transition_version_check
    check (to_version = from_version + 1),
  unique (voter_discord_user_id, request_id)
);

create table public.community_comment_vote_requests (
  session_id uuid not null,
  request_id uuid not null,
  voter_discord_user_id text not null
    references public.user_logs(discord_user_id) on delete restrict,
  comment_id uuid not null
    references public.community_comments(id) on delete restrict,
  desired_state text check (desired_state in ('up', 'down')),
  expected_version bigint not null check (expected_version >= 0),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  receipt jsonb not null check (jsonb_typeof(receipt) = 'object'),
  created_at timestamptz not null default transaction_timestamp(),
  primary key (voter_discord_user_id, request_id),
  unique (session_id, request_id)
);

create index community_comment_votes_state_idx
  on public.community_comment_votes(comment_id, vote_state)
  where vote_state is not null;
create index community_comment_vote_transitions_snapshot_idx
  on public.community_comment_vote_transitions(
    comment_id, voter_discord_user_id, transitioned_at desc, id desc
  );
create index community_comment_vote_transitions_voter_idx
  on public.community_comment_vote_transitions(
    voter_discord_user_id, transitioned_at desc, id desc
  );

alter table public.community_comment_votes enable row level security;
alter table public.community_comment_vote_transitions enable row level security;
alter table public.community_comment_vote_requests enable row level security;

revoke all on table public.community_comment_votes,
  public.community_comment_vote_transitions,
  public.community_comment_vote_requests
from public, anon, authenticated, discord_bot, service_role;
revoke all on sequence public.community_comment_vote_transitions_id_seq
from public, anon, authenticated, discord_bot, service_role;

create trigger community_comment_vote_transitions_no_update
before update on public.community_comment_vote_transitions
for each row execute function public.protect_community_comment_append_only();
create trigger community_comment_vote_transitions_no_delete
before delete on public.community_comment_vote_transitions
for each row execute function public.protect_community_comment_append_only();
create trigger community_comment_vote_requests_no_update
before update on public.community_comment_vote_requests
for each row execute function public.protect_community_comment_append_only();
create trigger community_comment_vote_requests_no_delete
before delete on public.community_comment_vote_requests
for each row execute function public.protect_community_comment_append_only();

alter table public.community_comment_abuse_policies
  drop constraint community_comment_abuse_policies_action_check,
  add constraint community_comment_abuse_policies_action_check
    check (action in ('root', 'reply', 'edit', 'vote'));
alter table public.community_comment_abuse_buckets
  drop constraint community_comment_abuse_buckets_action_check,
  add constraint community_comment_abuse_buckets_action_check
    check (action in ('root', 'reply', 'edit', 'vote'));
alter table public.community_comment_abuse_events
  drop constraint community_comment_abuse_events_action_check,
  add constraint community_comment_abuse_events_action_check
    check (action in ('root', 'reply', 'edit', 'vote'));

create or replace function public.apply_community_comment_abuse_budget(
  p_author_discord_user_id text,
  p_action text,
  p_submission_id bigint,
  p_content_digest text,
  p_turnstile_verified boolean,
  p_now timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_policy public.community_comment_abuse_policies%rowtype;
  v_bucket public.community_comment_abuse_buckets%rowtype;
  v_count integer;
  v_repeat integer;
  v_retry_after integer;
begin
  if p_action not in ('root', 'reply', 'edit', 'vote')
    or p_submission_id is null
    or p_submission_id <= 0
    or p_content_digest is null
    or p_content_digest !~ '^[0-9a-f]{64}$'
    or p_turnstile_verified is null
  then
    raise exception using
      errcode = '22023',
      message = 'COMMUNITY_COMMENT_ABUSE_INPUT_INVALID';
  end if;

  select * into v_policy
  from public.community_comment_abuse_policies policy
  where policy.action = p_action
    and policy.active;

  if not found then
    return jsonb_build_object('outcome', 'abuse_configuration_unavailable');
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'community-comment-abuse:' || p_author_discord_user_id || ':' || p_action,
      0
    )
  );

  select * into v_bucket
  from public.community_comment_abuse_buckets bucket
  where bucket.author_discord_user_id = p_author_discord_user_id
    and bucket.action = p_action
  for update;

  if not found then
    insert into public.community_comment_abuse_buckets (
      author_discord_user_id, action, window_started_at, action_count,
      rejected_count, last_content_digest, last_submission_id,
      repeated_content_count, updated_at
    ) values (
      p_author_discord_user_id, p_action, p_now, 0,
      0, null, null, 0, p_now
    ) returning * into v_bucket;
  end if;

  if v_bucket.cooldown_until is not null
    and v_bucket.cooldown_until > p_now
  then
    v_retry_after := greatest(
      1,
      ceil(extract(epoch from (v_bucket.cooldown_until - p_now)))::integer
    );
    insert into public.community_comment_abuse_events (
      author_discord_user_id, action, submission_id, outcome,
      policy_version, created_at
    ) values (
      p_author_discord_user_id, p_action, p_submission_id,
      'cooldown', v_policy.policy_version, p_now
    );
    return jsonb_build_object('outcome', 'cooldown', 'retryAfter', v_retry_after);
  end if;

  if v_bucket.window_started_at
    + make_interval(secs => v_policy.window_seconds) <= p_now
  then
    v_bucket.window_started_at := p_now;
    v_bucket.action_count := 0;
    v_bucket.rejected_count := 0;
    v_bucket.cooldown_until := null;
  end if;

  v_count := v_bucket.action_count + 1;
  v_repeat := case
    when v_bucket.last_content_digest = p_content_digest
      and v_bucket.last_submission_id is distinct from p_submission_id
      then v_bucket.repeated_content_count + 1
    else 0
  end;

  if v_count > v_policy.max_actions then
    update public.community_comment_abuse_buckets
    set action_count = v_count,
        cooldown_until = p_now + make_interval(secs => v_policy.cooldown_seconds),
        last_content_digest = p_content_digest,
        last_submission_id = p_submission_id,
        repeated_content_count = v_repeat,
        version = version + 1,
        updated_at = p_now
    where author_discord_user_id = p_author_discord_user_id
      and action = p_action;

    insert into public.community_comment_abuse_events (
      author_discord_user_id, action, submission_id, outcome,
      policy_version, created_at
    ) values (
      p_author_discord_user_id, p_action, p_submission_id,
      'cooldown', v_policy.policy_version, p_now
    );
    return jsonb_build_object(
      'outcome', 'cooldown', 'retryAfter', v_policy.cooldown_seconds
    );
  end if;

  if v_count > v_policy.turnstile_after and not p_turnstile_verified then
    update public.community_comment_abuse_buckets
    set action_count = v_count,
        rejected_count = rejected_count + 1,
        last_content_digest = p_content_digest,
        last_submission_id = p_submission_id,
        repeated_content_count = v_repeat,
        version = version + 1,
        updated_at = p_now
    where author_discord_user_id = p_author_discord_user_id
      and action = p_action;

    insert into public.community_comment_abuse_events (
      author_discord_user_id, action, submission_id, outcome,
      policy_version, created_at
    ) values (
      p_author_discord_user_id, p_action, p_submission_id,
      'turnstile_required', v_policy.policy_version, p_now
    );
    return jsonb_build_object('outcome', 'turnstile_required');
  end if;

  update public.community_comment_abuse_buckets
  set action_count = v_count,
      last_content_digest = p_content_digest,
      last_submission_id = p_submission_id,
      repeated_content_count = v_repeat,
      version = version + 1,
      updated_at = p_now
  where author_discord_user_id = p_author_discord_user_id
    and action = p_action;

  insert into public.community_comment_abuse_events (
    author_discord_user_id, action, submission_id, outcome,
    policy_version, created_at
  ) values (
    p_author_discord_user_id, p_action, p_submission_id,
    'allowed', v_policy.policy_version, p_now
  );

  return jsonb_build_object('outcome', 'allowed');
end;
$function$;

create function public.get_community_comment_vote_counts_json(
  p_comment_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select case
    when comment_row.author_deleted_at is not null then null
    else jsonb_build_object(
      'up', count(*) filter (where vote.vote_state = 'up')::integer,
      'down', count(*) filter (where vote.vote_state = 'down')::integer
    )
  end
  from public.community_comments comment_row
  left join public.community_comment_votes vote
    on vote.comment_id = comment_row.id
   and vote.vote_state is not null
  where comment_row.id = p_comment_id
  group by comment_row.author_deleted_at;
$function$;

create function public.get_community_comment_vote_score_at(
  p_comment_id uuid,
  p_snapshot_at timestamptz
)
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select case
    when comment_row.author_deleted_at is not null then 0
    else coalesce(sum(
      case latest.to_state when 'up' then 1 when 'down' then -1 else 0 end
    ), 0)::integer
  end
  from public.community_comments comment_row
  left join lateral (
    select distinct on (transition.voter_discord_user_id)
      transition.voter_discord_user_id,
      transition.to_state
    from public.community_comment_vote_transitions transition
    where transition.comment_id = comment_row.id
      and transition.transitioned_at <= p_snapshot_at
    order by transition.voter_discord_user_id,
      transition.transitioned_at desc,
      transition.id desc
  ) latest on true
  where comment_row.id = p_comment_id
  group by comment_row.author_deleted_at;
$function$;

create or replace function public.build_community_comment_public_json(
  p_comment_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select jsonb_build_object(
    'publicCommentId', comment_row.public_comment_id,
    'submissionId', comment_row.submission_id,
    'rootPublicCommentId', root_row.public_comment_id,
    'replyTargetPublicCommentId', target_row.public_comment_id,
    'version', comment_row.object_version,
    'createdAt', comment_row.created_at,
    'edited', comment_row.edited_at is not null,
    'editedAt', comment_row.edited_at,
    'tombstone', case
      when comment_row.author_deleted_at is not null then 'author_deleted'
      else null
    end,
    'body', case
      when comment_row.author_deleted_at is not null then null
      else text_version.normalized_body
    end,
    'author', jsonb_build_object(
      'publicProfileId', author_row.public_profile_id,
      'displayName', coalesce(
        nullif(btrim(author_row.current_guild_nickname), ''),
        nullif(btrim(author_row.current_display_name), ''),
        nullif(btrim(author_row.current_discord_handle), ''),
        nullif(btrim(author_row.current_discord_username), ''),
        'CancerCulture member'
      ),
      'isCreator', submission.discord_user_id = comment_row.author_discord_user_id,
      'isBanned', author_row.is_banned
    ),
    'mentions', case
      when comment_row.author_deleted_at is not null then '[]'::jsonb
      else coalesce(
        (
          select jsonb_agg(
            jsonb_build_object(
              'targetPublicProfileId', target_user.public_profile_id,
              'displayName', coalesce(
                nullif(btrim(target_user.current_guild_nickname), ''),
                nullif(btrim(target_user.current_display_name), ''),
                nullif(btrim(target_user.current_discord_handle), ''),
                nullif(btrim(target_user.current_discord_username), ''),
                'CancerCulture member'
              ),
              'startIndex', mention.start_index,
              'endIndex', mention.end_index
            ) order by mention.start_index, mention.end_index
          )
          from public.community_comment_mentions mention
          join public.user_logs target_user
            on target_user.discord_user_id = mention.target_discord_user_id
          where mention.comment_id = comment_row.id
            and mention.text_version = comment_row.current_text_version
            and target_user.public_profile_id is not null
        ),
        '[]'::jsonb
      )
    end,
    'replyCount', case
      when comment_row.root_comment_id is null then (
        select count(*)::integer
        from public.community_comments reply
        where reply.root_comment_id = comment_row.id
      )
      else 0
    end,
    'voteCounts', public.get_community_comment_vote_counts_json(comment_row.id)
  )
  from public.community_comments comment_row
  join public.community_comment_text_versions text_version
    on text_version.comment_id = comment_row.id
   and text_version.version = comment_row.current_text_version
  join public.user_logs author_row
    on author_row.discord_user_id = comment_row.author_discord_user_id
  join public.submissions submission
    on submission.id = comment_row.submission_id
  left join public.community_comments root_row
    on root_row.id = comment_row.root_comment_id
  left join public.community_comments target_row
    on target_row.id = comment_row.reply_target_comment_id
  where comment_row.id = p_comment_id
    and author_row.public_profile_id is not null;
$function$;

create or replace function public.get_community_comment_thread_page(
  p_submission_id bigint,
  p_sort text,
  p_snapshot_at timestamptz,
  p_after_score integer,
  p_after_created_at timestamptz,
  p_after_public_comment_id uuid,
  p_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_now timestamptz := transaction_timestamp();
  v_snapshot_at timestamptz := coalesce(p_snapshot_at, transaction_timestamp());
  v_release_state text := public.get_community_comment_release_state();
  v_thread public.community_comment_threads%rowtype;
  v_ids uuid[];
  v_page_ids uuid[];
  v_items jsonb := '[]'::jsonb;
  v_has_more boolean := false;
  v_last public.community_comments%rowtype;
  v_last_score integer;
begin
  if p_submission_id is null or p_submission_id <= 0
    or p_sort not in ('top', 'newest')
    or p_limit is null or p_limit not between 1 and 20
    or v_snapshot_at > v_now
    or ((p_after_created_at is null) <> (p_after_public_comment_id is null))
    or (
      p_sort = 'top'
      and (p_after_created_at is null) <> (p_after_score is null)
    )
    or (p_sort = 'newest' and p_after_score is not null)
  then
    raise exception using
      errcode = '22023',
      message = 'COMMUNITY_COMMENT_PAGE_INPUT_INVALID';
  end if;

  if v_release_state = 'off' then
    return jsonb_build_object('outcome', 'feature_off');
  end if;

  if not public.is_community_comment_submission_eligible(p_submission_id) then
    return jsonb_build_object('outcome', 'submission_unavailable');
  end if;

  select * into v_thread
  from public.community_comment_threads thread
  where thread.submission_id = p_submission_id;

  if not found then
    return jsonb_build_object(
      'outcome', 'ok',
      'releaseState', v_release_state,
      'submissionId', p_submission_id,
      'sort', p_sort,
      'snapshotAt', v_snapshot_at,
      'threadVersion', 0,
      'items', '[]'::jsonb,
      'hasMore', false,
      'nextTuple', null
    );
  end if;

  with ranked as (
    select comment_row.id,
      comment_row.created_at,
      comment_row.public_comment_id,
      case when p_sort = 'top' then
        public.get_community_comment_vote_score_at(comment_row.id, v_snapshot_at)
      else 0 end as net_score
    from public.community_comments comment_row
    where comment_row.thread_id = v_thread.id
      and comment_row.root_comment_id is null
      and comment_row.created_at <= v_snapshot_at
  ), candidates as (
    select ranked.id, ranked.created_at, ranked.public_comment_id, ranked.net_score
    from ranked
    where p_after_created_at is null
      or (
        p_sort = 'top'
        and (
          ranked.net_score < p_after_score
          or (
            ranked.net_score = p_after_score
            and ranked.created_at < p_after_created_at
          )
          or (
            ranked.net_score = p_after_score
            and ranked.created_at = p_after_created_at
            and ranked.public_comment_id < p_after_public_comment_id
          )
        )
      )
      or (
        p_sort = 'newest'
        and (
          ranked.created_at < p_after_created_at
          or (
            ranked.created_at = p_after_created_at
            and ranked.public_comment_id < p_after_public_comment_id
          )
        )
      )
    order by
      case when p_sort = 'top' then ranked.net_score end desc,
      ranked.created_at desc,
      ranked.public_comment_id desc
    limit p_limit + 1
  )
  select array_agg(
    candidate.id order by
      case when p_sort = 'top' then candidate.net_score end desc,
      candidate.created_at desc,
      candidate.public_comment_id desc
  )
  into v_ids
  from candidates candidate;

  v_has_more := coalesce(cardinality(v_ids), 0) > p_limit;
  v_page_ids := case
    when v_ids is null then array[]::uuid[]
    else v_ids[1:least(cardinality(v_ids), p_limit)]
  end;

  select coalesce(
    jsonb_agg(
      public.build_community_comment_public_json(root_comment.id)
      || jsonb_build_object(
        'replyPreview', coalesce(
          (
            select jsonb_agg(
              public.build_community_comment_public_json(preview.id)
              order by preview.created_at, preview.public_comment_id
            )
            from (
              select reply.id, reply.created_at, reply.public_comment_id
              from public.community_comments reply
              where reply.root_comment_id = root_comment.id
                and reply.created_at <= v_snapshot_at
              order by reply.created_at desc, reply.public_comment_id desc
              limit 3
            ) preview
          ),
          '[]'::jsonb
        ),
        'replyPreviewHasMore', (
          select count(*) > 3
          from public.community_comments reply
          where reply.root_comment_id = root_comment.id
            and reply.created_at <= v_snapshot_at
        )
      )
      order by array_position(v_page_ids, root_comment.id)
    ),
    '[]'::jsonb
  ) into v_items
  from public.community_comments root_comment
  where root_comment.id = any(v_page_ids);

  if cardinality(v_page_ids) > 0 then
    select * into v_last
    from public.community_comments comment_row
    where comment_row.id = v_page_ids[cardinality(v_page_ids)];
    v_last_score := public.get_community_comment_vote_score_at(
      v_last.id, v_snapshot_at
    );
  end if;

  return jsonb_build_object(
    'outcome', 'ok',
    'releaseState', v_release_state,
    'submissionId', p_submission_id,
    'sort', p_sort,
    'snapshotAt', v_snapshot_at,
    'threadVersion', v_thread.version,
    'items', v_items,
    'hasMore', v_has_more,
    'nextTuple', case
      when v_has_more and v_last.id is not null then jsonb_build_object(
        'netScore', case when p_sort = 'top' then v_last_score else null end,
        'createdAt', v_last.created_at,
        'publicCommentId', v_last.public_comment_id
      )
      else null
    end
  );
end;
$function$;

create function public.get_community_comment_vote_projection(
  p_comment_id uuid,
  p_voter_discord_user_id text
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select jsonb_build_object(
    'publicCommentId', comment_row.public_comment_id,
    'voteCounts', public.get_community_comment_vote_counts_json(comment_row.id),
    'viewerState', vote.vote_state,
    'viewerVersion', coalesce(vote.version, 0)
  )
  from public.community_comments comment_row
  left join public.community_comment_votes vote
    on vote.comment_id = comment_row.id
   and vote.voter_discord_user_id = p_voter_discord_user_id
  where comment_row.id = p_comment_id
    and comment_row.author_deleted_at is null;
$function$;

create function public.get_community_comment_vote_viewer_state(
  p_session_id uuid,
  p_public_comment_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor text;
  v_items jsonb;
begin
  if p_session_id is null
    or p_public_comment_ids is null
    or cardinality(p_public_comment_ids) > 100
    or exists (
      select 1 from unnest(p_public_comment_ids) public_id where public_id is null
    )
  then
    raise exception using
      errcode = '22023',
      message = 'COMMUNITY_COMMENT_VOTE_VIEWER_INPUT_INVALID';
  end if;

  if public.get_community_comment_release_state() = 'off' then
    return jsonb_build_object('outcome', 'feature_off');
  end if;

  v_actor := public.require_account_session(p_session_id);

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'publicCommentId', comment_row.public_comment_id,
        'state', vote.vote_state,
        'version', coalesce(vote.version, 0)
      ) order by requested.first_ordinality
    ),
    '[]'::jsonb
  ) into v_items
  from (
    select public_id, min(ordinality) as first_ordinality
    from unnest(p_public_comment_ids) with ordinality input(public_id, ordinality)
    group by public_id
  ) requested
  join public.community_comments comment_row
    on comment_row.public_comment_id = requested.public_id
  left join public.community_comment_votes vote
    on vote.comment_id = comment_row.id
   and vote.voter_discord_user_id = v_actor
  where comment_row.author_deleted_at is null
    and public.is_community_comment_submission_eligible(comment_row.submission_id);

  return jsonb_build_object('outcome', 'ok', 'items', v_items);
end;
$function$;

create function public.resolve_community_comment_vote_replay(
  p_voter_discord_user_id text,
  p_request_id uuid,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_request public.community_comment_vote_requests%rowtype;
begin
  select * into v_request
  from public.community_comment_vote_requests request
  where request.voter_discord_user_id = p_voter_discord_user_id
    and request.request_id = p_request_id;

  if not found then
    return null;
  end if;
  if v_request.request_hash <> p_request_hash then
    return jsonb_build_object('outcome', 'idempotency_conflict');
  end if;
  return v_request.receipt || jsonb_build_object('replayed', true);
end;
$function$;

create function public.set_community_comment_vote(
  p_session_id uuid,
  p_public_comment_id uuid,
  p_desired_state text,
  p_expected_version bigint,
  p_request_id uuid,
  p_content_digest text,
  p_turnstile_verified boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_now timestamptz := transaction_timestamp();
  v_actor text;
  v_comment public.community_comments%rowtype;
  v_vote public.community_comment_votes%rowtype;
  v_current_state text;
  v_current_version bigint := 0;
  v_hash text;
  v_replay jsonb;
  v_abuse jsonb;
  v_receipt jsonb;
  v_next_version bigint;
begin
  if p_session_id is null
    or p_public_comment_id is null
    or (p_desired_state is not null and p_desired_state not in ('up', 'down'))
    or p_expected_version is null or p_expected_version < 0
    or p_request_id is null
    or p_content_digest is null or p_content_digest !~ '^[0-9a-f]{64}$'
    or p_turnstile_verified is null
  then
    raise exception using
      errcode = '22023',
      message = 'COMMUNITY_COMMENT_VOTE_INPUT_INVALID';
  end if;

  if public.get_community_comment_release_state() = 'off' then
    return jsonb_build_object('outcome', 'feature_off');
  elsif public.get_community_comment_release_state() <> 'open' then
    return jsonb_build_object('outcome', 'read_only');
  end if;

  v_actor := public.require_account_session(p_session_id);
  v_hash := encode(
    extensions.digest(
      convert_to(
        jsonb_build_object(
          'operation', 'vote',
          'publicCommentId', p_public_comment_id,
          'desiredState', p_desired_state,
          'expectedVersion', p_expected_version
        )::text,
        'utf8'
      ),
      'sha256'
    ),
    'hex'
  );

  perform pg_advisory_xact_lock(
    hashtextextended(
      'community-comment-vote-request:' || v_actor || ':' || p_request_id::text,
      0
    )
  );
  perform pg_advisory_xact_lock(
    hashtextextended(
      'community-comment-vote:' || v_actor || ':' || p_public_comment_id::text,
      0
    )
  );

  v_replay := public.resolve_community_comment_vote_replay(
    v_actor, p_request_id, v_hash
  );
  if v_replay is not null then
    return v_replay;
  end if;

  select * into v_comment
  from public.community_comments comment_row
  where comment_row.public_comment_id = p_public_comment_id
  for share;

  if not found
    or v_comment.author_deleted_at is not null
    or not public.is_community_comment_submission_eligible(v_comment.submission_id)
  then
    return jsonb_build_object('outcome', 'comment_unavailable');
  end if;

  select * into v_vote
  from public.community_comment_votes vote
  where vote.comment_id = v_comment.id
    and vote.voter_discord_user_id = v_actor
  for update;

  if found then
    v_current_state := v_vote.vote_state;
    v_current_version := v_vote.version;
  end if;

  if v_current_version <> p_expected_version then
    return jsonb_build_object(
      'outcome', 'stale_vote',
      'current', public.get_community_comment_vote_projection(v_comment.id, v_actor)
    );
  end if;

  v_abuse := public.apply_community_comment_abuse_budget(
    v_actor,
    'vote',
    v_comment.submission_id,
    p_content_digest,
    p_turnstile_verified,
    v_now
  );
  if v_abuse->>'outcome' <> 'allowed' then
    return v_abuse;
  end if;

  if v_current_state is distinct from p_desired_state then
    v_next_version := v_current_version + 1;
    insert into public.community_comment_votes (
      comment_id, voter_discord_user_id, vote_state, version, updated_at
    ) values (
      v_comment.id, v_actor, p_desired_state, v_next_version, v_now
    ) on conflict (comment_id, voter_discord_user_id) do update
    set vote_state = excluded.vote_state,
        version = excluded.version,
        updated_at = excluded.updated_at;

    insert into public.community_comment_vote_transitions (
      comment_id, voter_discord_user_id, from_state, to_state,
      from_version, to_version, request_id, transitioned_at
    ) values (
      v_comment.id, v_actor, v_current_state, p_desired_state,
      v_current_version, v_next_version, p_request_id, v_now
    );
  end if;

  v_receipt := jsonb_build_object(
    'outcome', 'voted',
    'replayed', false,
    'projection', public.get_community_comment_vote_projection(v_comment.id, v_actor)
  );

  insert into public.community_comment_vote_requests (
    session_id, request_id, voter_discord_user_id, comment_id,
    desired_state, expected_version, request_hash, receipt, created_at
  ) values (
    p_session_id, p_request_id, v_actor, v_comment.id,
    p_desired_state, p_expected_version, v_hash, v_receipt, v_now
  );

  return v_receipt;
end;
$function$;

alter table public.community_comment_votes owner to postgres;
alter table public.community_comment_vote_transitions owner to postgres;
alter table public.community_comment_vote_requests owner to postgres;
alter sequence public.community_comment_vote_transitions_id_seq owner to postgres;

alter function public.apply_community_comment_abuse_budget(text,text,bigint,text,boolean,timestamp with time zone) owner to postgres;
alter function public.get_community_comment_vote_counts_json(uuid) owner to postgres;
alter function public.get_community_comment_vote_score_at(uuid,timestamp with time zone) owner to postgres;
alter function public.build_community_comment_public_json(uuid) owner to postgres;
alter function public.get_community_comment_thread_page(bigint,text,timestamp with time zone,integer,timestamp with time zone,uuid,integer) owner to postgres;
alter function public.get_community_comment_vote_projection(uuid,text) owner to postgres;
alter function public.get_community_comment_vote_viewer_state(uuid,uuid[]) owner to postgres;
alter function public.resolve_community_comment_vote_replay(text,uuid,text) owner to postgres;
alter function public.set_community_comment_vote(uuid,uuid,text,bigint,uuid,text,boolean) owner to postgres;

revoke all on function public.get_community_comment_vote_counts_json(uuid)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_community_comment_vote_score_at(uuid,timestamp with time zone)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_community_comment_vote_projection(uuid,text)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_community_comment_vote_viewer_state(uuid,uuid[])
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.resolve_community_comment_vote_replay(text,uuid,text)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.set_community_comment_vote(uuid,uuid,text,bigint,uuid,text,boolean)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.apply_community_comment_abuse_budget(text,text,bigint,text,boolean,timestamp with time zone)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.build_community_comment_public_json(uuid)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_community_comment_thread_page(bigint,text,timestamp with time zone,integer,timestamp with time zone,uuid,integer)
  from public, anon, authenticated, discord_bot, service_role;

grant execute on function public.get_community_comment_thread_page(bigint,text,timestamp with time zone,integer,timestamp with time zone,uuid,integer)
  to service_role;
grant execute on function public.get_community_comment_vote_viewer_state(uuid,uuid[])
  to service_role;
grant execute on function public.set_community_comment_vote(uuid,uuid,text,bigint,uuid,text,boolean)
  to service_role;

do $postflight$
declare
  v_signature text;
  v_table text;
  v_service_signatures text[] := array[
    'public.get_community_comment_vote_viewer_state(uuid,uuid[])',
    'public.set_community_comment_vote(uuid,uuid,text,bigint,uuid,text,boolean)'
  ];
  v_internal_signatures text[] := array[
    'public.get_community_comment_vote_counts_json(uuid)',
    'public.get_community_comment_vote_score_at(uuid,timestamp with time zone)',
    'public.get_community_comment_vote_projection(uuid,text)',
    'public.resolve_community_comment_vote_replay(text,uuid,text)'
  ];
  v_tables text[] := array[
    'community_comment_votes',
    'community_comment_vote_transitions',
    'community_comment_vote_requests'
  ];
begin
  foreach v_signature in array v_service_signatures loop
    if to_regprocedure(v_signature) is null
      or not exists (
        select 1 from pg_proc function_row
        where function_row.oid = to_regprocedure(v_signature)
          and pg_get_userbyid(function_row.proowner) = 'postgres'
          and function_row.prosecdef
          and function_row.proconfig @> array['search_path=public, pg_temp']
      )
      or has_function_privilege('anon', v_signature, 'EXECUTE')
      or has_function_privilege('authenticated', v_signature, 'EXECUTE')
      or has_function_privilege('discord_bot', v_signature, 'EXECUTE')
      or not has_function_privilege('service_role', v_signature, 'EXECUTE')
    then
      raise exception using
        errcode = '55000',
        message = 'ATOMIC_COMMENT_VOTES_SERVICE_SECURITY_MISMATCH',
        detail = v_signature;
    end if;
  end loop;

  foreach v_signature in array v_internal_signatures loop
    if to_regprocedure(v_signature) is null
      or not exists (
        select 1 from pg_proc function_row
        where function_row.oid = to_regprocedure(v_signature)
          and pg_get_userbyid(function_row.proowner) = 'postgres'
          and function_row.prosecdef
          and function_row.proconfig @> array['search_path=public, pg_temp']
      )
      or has_function_privilege('anon', v_signature, 'EXECUTE')
      or has_function_privilege('authenticated', v_signature, 'EXECUTE')
      or has_function_privilege('discord_bot', v_signature, 'EXECUTE')
      or has_function_privilege('service_role', v_signature, 'EXECUTE')
    then
      raise exception using
        errcode = '55000',
        message = 'ATOMIC_COMMENT_VOTES_INTERNAL_SECURITY_MISMATCH',
        detail = v_signature;
    end if;
  end loop;

  foreach v_table in array v_tables loop
    if not exists (
      select 1 from pg_class table_row
      where table_row.oid = format('public.%I', v_table)::regclass
        and table_row.relrowsecurity
        and pg_get_userbyid(table_row.relowner) = 'postgres'
    )
      or exists (
        select 1 from pg_policy policy
        where policy.polrelid = format('public.%I', v_table)::regclass
      )
      or has_table_privilege('anon', format('public.%I', v_table), 'SELECT')
      or has_table_privilege('authenticated', format('public.%I', v_table), 'SELECT')
      or has_table_privilege('discord_bot', format('public.%I', v_table), 'SELECT')
      or has_table_privilege('service_role', format('public.%I', v_table), 'SELECT')
      or has_table_privilege('service_role', format('public.%I', v_table), 'INSERT')
      or has_table_privilege('service_role', format('public.%I', v_table), 'UPDATE')
      or has_table_privilege('service_role', format('public.%I', v_table), 'DELETE')
    then
      raise exception using
        errcode = '55000',
        message = 'ATOMIC_COMMENT_VOTES_TABLE_SECURITY_MISMATCH',
        detail = v_table;
    end if;
  end loop;

  if (
    select count(*)
    from pg_proc function_row
    join pg_namespace namespace on namespace.oid = function_row.pronamespace
    where namespace.nspname = 'public'
      and function_row.proname = 'set_community_comment_vote'
  ) <> 1 or (
    select count(*)
    from pg_proc function_row
    join pg_namespace namespace on namespace.oid = function_row.pronamespace
    where namespace.nspname = 'public'
      and function_row.proname = 'get_community_comment_vote_viewer_state'
  ) <> 1 or not exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conrelid = 'public.community_comment_abuse_policies'::regclass
      and constraint_row.conname = 'community_comment_abuse_policies_action_check'
      and pg_get_constraintdef(constraint_row.oid) like '%''vote''%'
  ) or (select release_state from public.community_comment_settings where singleton) <> 'off'
    or (select version from public.community_comment_settings where singleton) <> 1
    or exists (select 1 from public.community_comment_abuse_policies)
    or exists (select 1 from public.community_comment_threads)
    or exists (select 1 from public.community_comments)
    or exists (select 1 from public.community_comment_votes)
    or exists (select 1 from public.community_comment_vote_transitions)
    or exists (select 1 from public.community_comment_vote_requests)
    or has_sequence_privilege(
      'service_role', 'public.community_comment_vote_transitions_id_seq', 'USAGE'
    )
  then
    raise exception using
      errcode = '55000',
      message = 'ATOMIC_COMMENT_VOTES_POSTFLIGHT_MISMATCH';
  end if;
end;
$postflight$;

comment on table public.community_comment_votes is
  'Protected current per-user/per-Comment Up, Down or neutral projection with a monotonic personal version.';
comment on table public.community_comment_vote_transitions is
  'Append-only Comment Vote transition history used for audit and snapshot-stable Top ranking.';
comment on table public.community_comment_vote_requests is
  'Append-only Comment Vote idempotency requests and server-confirmed receipts.';
comment on function public.set_community_comment_vote(uuid,uuid,text,bigint,uuid,text,boolean) is
  'Atomically applies an Up, Down or neutral Comment Vote using Website-session, eligibility, expected-version, idempotency, pair serialization and private vote-budget checks.';
comment on function public.get_community_comment_vote_viewer_state(uuid,uuid[]) is
  'Returns only the authenticated viewer state/version for at most 100 deduplicated public eligible Comment IDs.';
comment on function public.get_community_comment_vote_score_at(uuid,timestamp with time zone) is
  'Derives internal Up-minus-Down ranking from append-only transitions as of one signed Top snapshot; the net value is never public UI data.';

commit;
