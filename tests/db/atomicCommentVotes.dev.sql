\set ON_ERROR_STOP on

begin;

set local lock_timeout = '5s';
set local statement_timeout = '90s';

do $contract$
declare
  v_base bigint := 970000000000000000 + floor(random() * 1000000000000000)::bigint;
  v_actor text := v_base::text;
  v_other text := (v_base + 1)::text;
  v_actor_profile uuid := gen_random_uuid();
  v_other_profile uuid := gen_random_uuid();
  v_actor_session uuid := gen_random_uuid();
  v_other_session uuid := gen_random_uuid();
  v_submission_id bigint;
  v_root_one uuid;
  v_root_two uuid;
  v_root_three uuid;
  v_reply_one uuid;
  v_request uuid := gen_random_uuid();
  v_tombstone_vote_request uuid := gen_random_uuid();
  v_result jsonb;
  v_replay jsonb;
  v_page_one jsonb;
  v_page_two jsonb;
  v_newest_before jsonb;
  v_viewer jsonb;
  v_snapshot timestamptz;
  v_cursor_score integer;
  v_cursor_created timestamptz;
  v_cursor_id uuid;
  v_future_root uuid;
  v_future_comment_id uuid;
  v_now timestamptz := transaction_timestamp();
  v_rejected boolean := false;
begin
  select submission.id into v_submission_id
  from public.submissions submission
  join public.voting_cycles cycle on cycle.id = submission.cycle_id
  join public.cycle_results result
    on result.submission_id = submission.id and result.cycle_id = submission.cycle_id
  where submission.public_visibility_status = 'visible'
    and not coalesce(submission.is_disqualified, false)
    and cycle.status = 'finished'
    and cycle.public_number is not null
    and cycle.finalized_at is not null
    and result.finalized_at is not null
    and result.rank_in_cycle is not null
  order by submission.id
  limit 1;

  if v_submission_id is null then
    raise exception 'ATOMIC_COMMENT_VOTES_DEV_FIXTURE_UNAVAILABLE';
  end if;

  insert into public.user_logs (
    discord_user_id, current_discord_username, current_display_name,
    public_profile_id, is_banned
  ) values
    (v_actor, 'comment-vote-actor', 'Vote Actor', v_actor_profile, false),
    (v_other, 'comment-vote-other', 'Vote Other', v_other_profile, false);
  insert into public.sessions(id, discord_user_id) values
    (v_actor_session, v_actor),
    (v_other_session, v_other);

  update public.community_comment_settings
  set release_state = 'open', version = version + 1,
      updated_at = transaction_timestamp()
  where singleton;
  insert into public.community_comment_abuse_policies (
    action, policy_version, window_seconds, max_actions,
    cooldown_seconds, turnstile_after
  ) values
    ('root', 1, 3600, 100, 60, 100),
    ('reply', 1, 3600, 100, 60, 100),
    ('vote', 1, 3600, 100, 60, 100);

  v_result := public.create_community_comment_root(
    v_actor_session, v_submission_id, 0, 'Root one', '[]'::jsonb,
    gen_random_uuid(), repeat('1', 64), false
  );
  v_root_one := (v_result #>> '{comment,publicCommentId}')::uuid;
  v_result := public.create_community_comment_root(
    v_other_session, v_submission_id, 1, 'Root two', '[]'::jsonb,
    gen_random_uuid(), repeat('2', 64), false
  );
  v_root_two := (v_result #>> '{comment,publicCommentId}')::uuid;
  v_result := public.create_community_comment_root(
    v_actor_session, v_submission_id, 2, 'Root three', '[]'::jsonb,
    gen_random_uuid(), repeat('3', 64), false
  );
  v_root_three := (v_result #>> '{comment,publicCommentId}')::uuid;

  if v_root_one is null or v_root_two is null or v_root_three is null
    or v_result #>> '{comment,voteCounts,up}' <> '0'
    or v_result #>> '{comment,voteCounts,down}' <> '0'
  then
    raise exception 'ATOMIC_COMMENT_VOTES_DEV_ANONYMOUS_COUNTS_FAILED: %', v_result;
  end if;

  v_result := public.create_community_comment_reply(
    v_other_session, v_root_three, v_root_three, 1, 1,
    'Chronological reply', '[]'::jsonb, gen_random_uuid(), repeat('4', 64), false
  );
  v_reply_one := (v_result #>> '{comment,publicCommentId}')::uuid;

  v_result := public.set_community_comment_vote(
    v_actor_session, v_root_one, 'up', 0, v_request, repeat('a', 64), false
  );
  if v_result ->> 'outcome' <> 'voted'
    or v_result ->> 'replayed' <> 'false'
    or v_result #>> '{projection,viewerState}' <> 'up'
    or v_result #>> '{projection,viewerVersion}' <> '1'
    or v_result #>> '{projection,voteCounts,up}' <> '1'
    or v_result #>> '{projection,voteCounts,down}' <> '0'
  then
    raise exception 'ATOMIC_COMMENT_VOTES_DEV_NEUTRAL_TO_UP_FAILED: %', v_result;
  end if;

  v_replay := public.set_community_comment_vote(
    v_actor_session, v_root_one, 'up', 0, v_request, repeat('a', 64), false
  );
  if v_replay ->> 'outcome' <> 'voted'
    or v_replay ->> 'replayed' <> 'true'
    or v_replay #>> '{projection,viewerVersion}' <> '1'
  then
    raise exception 'ATOMIC_COMMENT_VOTES_DEV_REPLAY_FAILED: %', v_replay;
  end if;

  v_replay := public.set_community_comment_vote(
    v_actor_session, v_root_one, 'down', 1, v_request, repeat('b', 64), false
  );
  if v_replay ->> 'outcome' <> 'idempotency_conflict' then
    raise exception 'ATOMIC_COMMENT_VOTES_DEV_IDEMPOTENCY_CONFLICT_FAILED: %', v_replay;
  end if;

  v_result := public.set_community_comment_vote(
    v_actor_session, v_root_one, 'down', 0, gen_random_uuid(), repeat('c', 64), false
  );
  if v_result ->> 'outcome' <> 'stale_vote'
    or v_result #>> '{current,viewerVersion}' <> '1'
  then
    raise exception 'ATOMIC_COMMENT_VOTES_DEV_STALE_VERSION_FAILED: %', v_result;
  end if;

  v_result := public.set_community_comment_vote(
    v_actor_session, v_root_one, null, 1, gen_random_uuid(), repeat('d', 64), false
  );
  if v_result #>> '{projection,viewerState}' is not null
    or v_result #>> '{projection,viewerVersion}' <> '2'
    or v_result #>> '{projection,voteCounts,up}' <> '0'
  then
    raise exception 'ATOMIC_COMMENT_VOTES_DEV_UP_TO_NEUTRAL_FAILED: %', v_result;
  end if;

  v_result := public.set_community_comment_vote(
    v_actor_session, v_root_one, 'up', 2, gen_random_uuid(), repeat('e', 64), false
  );
  if v_result #>> '{projection,viewerState}' <> 'up'
    or v_result #>> '{projection,viewerVersion}' <> '3'
  then
    raise exception 'ATOMIC_COMMENT_VOTES_DEV_NEUTRAL_TO_UP_AGAIN_FAILED: %', v_result;
  end if;

  v_result := public.set_community_comment_vote(
    v_actor_session, v_root_one, 'down', 3, gen_random_uuid(), repeat('f', 64), false
  );
  if v_result #>> '{projection,viewerState}' <> 'down'
    or v_result #>> '{projection,viewerVersion}' <> '4'
  then
    raise exception 'ATOMIC_COMMENT_VOTES_DEV_UP_TO_DOWN_FAILED: %', v_result;
  end if;

  v_result := public.set_community_comment_vote(
    v_actor_session, v_root_one, 'up', 4, gen_random_uuid(), repeat('0', 64), false
  );
  if v_result #>> '{projection,viewerState}' <> 'up'
    or v_result #>> '{projection,viewerVersion}' <> '5'
  then
    raise exception 'ATOMIC_COMMENT_VOTES_DEV_DOWN_TO_UP_FAILED: %', v_result;
  end if;

  v_result := public.set_community_comment_vote(
    v_other_session, v_root_one, 'down', 0, gen_random_uuid(), repeat('9', 64), false
  );
  if v_result #>> '{projection,voteCounts,up}' <> '1'
    or v_result #>> '{projection,voteCounts,down}' <> '1'
  then
    raise exception 'ATOMIC_COMMENT_VOTES_DEV_INDEPENDENT_USERS_COUNTS_FAILED: %', v_result;
  end if;

  v_result := public.set_community_comment_vote(
    v_other_session, v_root_one, null, 1, gen_random_uuid(), repeat('2', 64), false
  );
  if v_result #>> '{projection,voteCounts,up}' <> '1'
    or v_result #>> '{projection,voteCounts,down}' <> '0'
  then
    raise exception 'ATOMIC_COMMENT_VOTES_DEV_DOWN_TO_NEUTRAL_FAILED: %', v_result;
  end if;

  v_result := public.set_community_comment_vote(
    v_actor_session, v_reply_one, 'up', 0, gen_random_uuid(), repeat('8', 64), false
  );
  if v_result #>> '{projection,voteCounts,up}' <> '1' then
    raise exception 'ATOMIC_COMMENT_VOTES_DEV_REPLY_VOTE_FAILED: %', v_result;
  end if;

  v_result := public.set_community_comment_vote(
    v_actor_session, v_root_two, null, 0,
    v_tombstone_vote_request, repeat('1', 64), false
  );
  if v_result ->> 'outcome' <> 'voted'
    or v_result #>> '{projection,viewerVersion}' <> '0'
  then
    raise exception 'ATOMIC_COMMENT_VOTES_DEV_NEUTRAL_RECEIPT_FAILED: %', v_result;
  end if;

  v_viewer := public.get_community_comment_vote_viewer_state(
    v_actor_session,
    array[v_root_one, v_root_one, v_root_two, v_root_three, gen_random_uuid()]
  );
  if v_viewer ->> 'outcome' <> 'ok'
    or jsonb_array_length(v_viewer -> 'items') <> 3
    or v_viewer #>> '{items,0,state}' <> 'up'
    or v_viewer #>> '{items,0,version}' <> '5'
    or (v_viewer #> '{items,0}') ? 'discordUserId'
  then
    raise exception 'ATOMIC_COMMENT_VOTES_DEV_VIEWER_BATCH_FAILED: %', v_viewer;
  end if;

  begin
    perform public.get_community_comment_vote_viewer_state(
      v_actor_session, array_fill(v_root_one, array[101])
    );
    raise exception 'ATOMIC_COMMENT_VOTES_DEV_VIEWER_BATCH_LIMIT_ACCEPTED';
  exception when sqlstate '22023' then
    if sqlerrm <> 'COMMUNITY_COMMENT_VOTE_VIEWER_INPUT_INVALID' then raise; end if;
  end;

  v_page_one := public.get_community_comment_thread_page(
    v_submission_id, 'top', null, null, null, null, 2
  );
  if v_page_one ->> 'outcome' <> 'ok'
    or jsonb_array_length(v_page_one -> 'items') <> 2
    or v_page_one #>> '{items,0,publicCommentId}' <> v_root_one::text
    or v_page_one #>> '{nextTuple,netScore}' <> '0'
  then
    raise exception 'ATOMIC_COMMENT_VOTES_DEV_TOP_PAGE_ONE_FAILED: %', v_page_one;
  end if;

  select jsonb_agg(item ->> 'publicCommentId' order by ordinality)
  into v_newest_before
  from jsonb_array_elements(
    public.get_community_comment_thread_page(
      v_submission_id, 'newest', null, null, null, null, 20
    ) -> 'items'
  ) with ordinality items(item, ordinality);

  v_snapshot := (v_page_one ->> 'snapshotAt')::timestamptz;
  v_cursor_score := (v_page_one #>> '{nextTuple,netScore}')::integer;
  v_cursor_created := (v_page_one #>> '{nextTuple,createdAt}')::timestamptz;
  v_cursor_id := (v_page_one #>> '{nextTuple,publicCommentId}')::uuid;
  select root_id into strict v_future_root
  from unnest(array[v_root_one, v_root_two, v_root_three]) root_id
  where root_id <> (v_page_one #>> '{items,0,publicCommentId}')::uuid
    and root_id <> (v_page_one #>> '{items,1,publicCommentId}')::uuid;
  select id into strict v_future_comment_id
  from public.community_comments where public_comment_id = v_future_root;

  insert into public.community_comment_votes(
    comment_id, voter_discord_user_id, vote_state, version, updated_at
  ) values
    (v_future_comment_id, v_actor, 'up', 1, v_now + interval '1 second'),
    (v_future_comment_id, v_other, 'up', 1, v_now + interval '1 second');
  insert into public.community_comment_vote_transitions(
    comment_id, voter_discord_user_id, from_state, to_state,
    from_version, to_version, request_id, transitioned_at
  ) values
    (v_future_comment_id, v_actor, null, 'up', 0, 1, gen_random_uuid(), v_now + interval '1 second'),
    (v_future_comment_id, v_other, null, 'up', 0, 1, gen_random_uuid(), v_now + interval '1 second');

  v_page_two := public.get_community_comment_thread_page(
    v_submission_id, 'top', v_snapshot, v_cursor_score,
    v_cursor_created, v_cursor_id, 2
  );
  if jsonb_array_length(v_page_two -> 'items') <> 1
    or v_page_two #>> '{items,0,publicCommentId}' <> v_future_root::text
    or public.get_community_comment_vote_score_at(
      v_future_comment_id, v_now + interval '2 seconds'
    ) <> 2
  then
    raise exception 'ATOMIC_COMMENT_VOTES_DEV_SNAPSHOT_STABILITY_FAILED: %', v_page_two;
  end if;

  select jsonb_agg(item ->> 'publicCommentId' order by ordinality)
  into v_page_one
  from jsonb_array_elements(
    public.get_community_comment_thread_page(
      v_submission_id, 'newest', null, null, null, null, 20
    ) -> 'items'
  ) with ordinality items(item, ordinality);
  if v_page_one <> v_newest_before then
    raise exception 'ATOMIC_COMMENT_VOTES_DEV_NEWEST_ORDER_CHANGED';
  end if;

  v_page_two := public.get_community_comment_replies(
    v_root_three, null, null, null, 20
  );
  if jsonb_array_length(v_page_two -> 'items') <> 1
    or v_page_two #>> '{items,0,publicCommentId}' <> v_reply_one::text
  then
    raise exception 'ATOMIC_COMMENT_VOTES_DEV_REPLY_ORDER_CHANGED: %', v_page_two;
  end if;

  begin
    update public.community_comment_vote_transitions
    set to_state = 'down'
    where id = (
      select min(transition.id)
      from public.community_comment_vote_transitions transition
      where transition.voter_discord_user_id = v_actor
    );
    raise exception 'ATOMIC_COMMENT_VOTES_DEV_HISTORY_REWRITE_ACCEPTED';
  exception when sqlstate '55000' then
    if sqlerrm <> 'COMMUNITY_COMMENT_HISTORY_IS_APPEND_ONLY' then raise; end if;
  end;

  update public.user_logs set is_banned = true where discord_user_id = v_other;
  begin
    perform public.set_community_comment_vote(
      v_other_session, v_root_three, 'down', 1,
      gen_random_uuid(), repeat('7', 64), false
    );
  exception when others then
    v_rejected := true;
  end;
  if not v_rejected then
    raise exception 'ATOMIC_COMMENT_VOTES_DEV_BANNED_SESSION_ACCEPTED';
  end if;
  update public.user_logs set is_banned = false where discord_user_id = v_other;
  v_other_session := gen_random_uuid();
  insert into public.sessions(id, discord_user_id)
  values (v_other_session, v_other);

  v_rejected := false;
  begin
    perform public.set_community_comment_vote(
      gen_random_uuid(), v_root_three, 'down', 0,
      gen_random_uuid(), repeat('6', 64), false
    );
  exception when others then
    v_rejected := true;
  end;
  if not v_rejected then
    raise exception 'ATOMIC_COMMENT_VOTES_DEV_INVALID_SESSION_ACCEPTED';
  end if;

  v_result := public.delete_community_comment(
    v_other_session, v_root_two, 1, gen_random_uuid(), true
  );
  if v_result #> '{comment,voteCounts}' <> 'null'::jsonb then
    raise exception 'ATOMIC_COMMENT_VOTES_DEV_TOMBSTONE_COUNTS_VISIBLE: %', v_result;
  end if;
  v_result := public.set_community_comment_vote(
    v_actor_session, v_root_two, null, 0,
    v_tombstone_vote_request, repeat('1', 64), false
  );
  if v_result ->> 'outcome' <> 'comment_unavailable'
    or v_result ? 'projection'
  then
    raise exception 'ATOMIC_COMMENT_VOTES_DEV_TOMBSTONE_REPLAY_EXPOSED: %', v_result;
  end if;
  v_result := public.set_community_comment_vote(
    v_actor_session, v_root_two, 'up', 0,
    gen_random_uuid(), repeat('5', 64), false
  );
  if v_result ->> 'outcome' <> 'comment_unavailable' then
    raise exception 'ATOMIC_COMMENT_VOTES_DEV_TOMBSTONE_VOTE_ACCEPTED: %', v_result;
  end if;

  update public.community_comment_settings set release_state = 'read_only' where singleton;
  v_result := public.set_community_comment_vote(
    v_actor_session, v_root_three, 'down', 0,
    gen_random_uuid(), repeat('4', 64), false
  );
  if v_result ->> 'outcome' <> 'read_only' then
    raise exception 'ATOMIC_COMMENT_VOTES_DEV_READ_ONLY_WRITE_ACCEPTED: %', v_result;
  end if;
  v_viewer := public.get_community_comment_vote_viewer_state(
    v_actor_session, array[v_root_one]
  );
  if v_viewer ->> 'outcome' <> 'ok' then
    raise exception 'ATOMIC_COMMENT_VOTES_DEV_READ_ONLY_VIEWER_FAILED: %', v_viewer;
  end if;

  update public.community_comment_settings set release_state = 'off' where singleton;
  v_viewer := public.get_community_comment_vote_viewer_state(
    v_actor_session, array[v_root_one]
  );
  if v_viewer ->> 'outcome' <> 'feature_off' then
    raise exception 'ATOMIC_COMMENT_VOTES_DEV_OFF_VIEWER_ACCEPTED: %', v_viewer;
  end if;

  update public.community_comment_settings set release_state = 'open' where singleton;
  update public.submissions set is_disqualified = true where id = v_submission_id;
  v_result := public.set_community_comment_vote(
    v_actor_session, v_root_three, 'down', 0,
    gen_random_uuid(), repeat('3', 64), false
  );
  if v_result ->> 'outcome' <> 'comment_unavailable' then
    raise exception 'ATOMIC_COMMENT_VOTES_DEV_INELIGIBLE_SUBMISSION_ACCEPTED: %', v_result;
  end if;
end;
$contract$;

rollback;
