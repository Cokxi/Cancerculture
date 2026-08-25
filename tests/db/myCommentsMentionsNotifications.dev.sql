begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $test$
declare
  v_admin_session uuid;
  v_session_a uuid;
  v_session_b uuid;
  v_session_c uuid;
  v_actor_a text;
  v_actor_b text;
  v_actor_c text;
  v_profile_a uuid;
  v_profile_b uuid;
  v_profile_c uuid;
  v_submission_id bigint;
  v_thread_version bigint;
  v_result jsonb;
  v_replay jsonb;
  v_root_public_id uuid;
  v_reply_public_id uuid;
  v_second_root_public_id uuid;
  v_reply_request uuid := gen_random_uuid();
  v_mention_id uuid;
  v_self_mention_id uuid;
  v_notification_id uuid;
  v_snapshot timestamptz := transaction_timestamp();
  v_page jsonb;
  v_event_count bigint;
  v_future_mention_id uuid;
begin
  if public.get_community_comment_release_state() <> 'off'
    or exists (
      select 1 from public.community_comment_abuse_policy_states
      where active_policy_version is not null
    )
    or exists (
      select 1 from public.community_comment_spam_policy_state
      where active_policy_version is not null
    )
  then
    raise exception 'MY_COMMENTS_MENTIONS_DEV_BASELINE_NOT_CLOSED';
  end if;

  select selected.id into v_admin_session
  from (
    select session_row.id
    from public.sessions session_row
    join public.user_logs user_log on user_log.discord_user_id = session_row.discord_user_id
    join public.team_members member on member.discord_user_id = session_row.discord_user_id
    where session_row.revoked_at is null and member.role = 'admin' and not user_log.is_banned
    order by session_row.created_at desc limit 1
  ) selected;

  with actors as (
    select distinct on (session_row.discord_user_id)
      session_row.id, session_row.discord_user_id, user_log.public_profile_id
    from public.sessions session_row
    join public.user_logs user_log on user_log.discord_user_id = session_row.discord_user_id
    left join public.discord_member_state member_state
      on member_state.discord_user_id = session_row.discord_user_id
    where session_row.revoked_at is null
      and user_log.public_profile_id is not null
      and not user_log.is_banned
      and not coalesce(member_state.discord_ban_active, false)
    order by session_row.discord_user_id, session_row.created_at desc
  ), numbered as (
    select *, row_number() over (order by discord_user_id) as rn from actors
  )
  select
    (array_agg(id order by rn))[1],
    (array_agg(discord_user_id order by rn))[1],
    (array_agg(public_profile_id order by rn))[1],
    (array_agg(id order by rn))[2],
    (array_agg(discord_user_id order by rn))[2],
    (array_agg(public_profile_id order by rn))[2],
    (array_agg(id order by rn))[3],
    (array_agg(discord_user_id order by rn))[3],
    (array_agg(public_profile_id order by rn))[3]
  into v_session_a, v_actor_a, v_profile_a,
       v_session_b, v_actor_b, v_profile_b,
       v_session_c, v_actor_c, v_profile_c
  from numbered where rn <= 3;

  if v_admin_session is null or v_session_a is null or v_session_b is null or v_session_c is null then
    raise exception 'MY_COMMENTS_MENTIONS_DEV_SESSIONS_UNAVAILABLE';
  end if;

  select thread.submission_id, thread.version
  into v_submission_id, v_thread_version
  from public.community_comment_threads thread
  where public.is_community_comment_submission_eligible(thread.submission_id)
  order by thread.submission_id limit 1;
  if v_submission_id is null then raise exception 'MY_COMMENTS_MENTIONS_DEV_SUBMISSION_UNAVAILABLE'; end if;

  for v_result in
    select public.manage_community_comment_abuse_policy(
      v_admin_session, state.action, state.state_version, true,
      policy.window_seconds, policy.max_actions, policy.cooldown_seconds,
      policy.turnstile_after, gen_random_uuid()
    )
    from public.community_comment_abuse_policy_states state
    cross join lateral (
      select source.window_seconds, source.max_actions,
        source.cooldown_seconds, source.turnstile_after
      from public.community_comment_abuse_policies source
      where source.action = state.action
      order by source.policy_version desc limit 1
    ) policy
    where state.action in ('root', 'reply', 'edit')
  loop
    if v_result->>'outcome' <> 'activated' then
      raise exception 'MY_COMMENTS_MENTIONS_DEV_POLICY_ACTIVATION_FAILED: %', v_result;
    end if;
  end loop;

  select public.manage_community_comment_release_state(
    v_admin_session, 'open', setting.version, gen_random_uuid()
  ) into v_result
  from public.community_comment_settings setting where singleton;
  if v_result->>'outcome' not in ('updated', 'unchanged') then
    raise exception 'MY_COMMENTS_MENTIONS_DEV_RELEASE_OPEN_FAILED: %', v_result;
  end if;

  v_result := public.create_community_comment_root(
    v_session_b, v_submission_id, v_thread_version,
    'Fantasy notification target root', '[]'::jsonb,
    gen_random_uuid(), encode(extensions.digest(convert_to('Fantasy notification target root','utf8'),'sha256'),'hex'), false
  );
  if v_result->>'outcome' <> 'created' then raise exception 'MY_COMMENTS_MENTIONS_DEV_ROOT_FAILED: %', v_result; end if;
  v_root_public_id := (v_result#>>'{comment,publicCommentId}')::uuid;

  v_result := public.create_community_comment_reply(
    v_session_a, v_root_public_id, v_root_public_id, 1, 1,
    'Fantasy reply @target and @other plus @self.',
    jsonb_build_array(
      jsonb_build_object('targetPublicProfileId', v_profile_b, 'startIndex', 14, 'endIndex', 21),
      jsonb_build_object('targetPublicProfileId', v_profile_c, 'startIndex', 26, 'endIndex', 32),
      jsonb_build_object('targetPublicProfileId', v_profile_a, 'startIndex', 38, 'endIndex', 43)
    ),
    v_reply_request,
    encode(extensions.digest(convert_to('Fantasy reply @target and @other plus @self.','utf8'),'sha256'),'hex'), false
  );
  if v_result->>'outcome' <> 'created' then raise exception 'MY_COMMENTS_MENTIONS_DEV_REPLY_FAILED: %', v_result; end if;
  v_reply_public_id := (v_result#>>'{comment,publicCommentId}')::uuid;

  if (select count(*) from public.notification_events event
      where event.producer_key = 'comment-reply:' || v_reply_public_id::text
        and event.event_type = 'comment_reply'
        and event.owner_discord_user_id = v_actor_b) <> 1
    or (select count(*) from public.notification_events event
        where event.event_type = 'comment_mention'
          and event.producer_key in (
            select 'comment-mention:' || lifecycle.id::text
            from public.community_comment_mention_lifecycle lifecycle
            join public.community_comments comment_row on comment_row.id = lifecycle.comment_id
            where comment_row.public_comment_id = v_reply_public_id
          )) <> 1
    or exists (
      select 1 from public.notification_events event
      where event.event_type = 'comment_mention'
        and event.owner_discord_user_id in (v_actor_a, v_actor_b)
        and event.producer_key in (
          select 'comment-mention:' || lifecycle.id::text
          from public.community_comment_mention_lifecycle lifecycle
          join public.community_comments comment_row on comment_row.id = lifecycle.comment_id
          where comment_row.public_comment_id = v_reply_public_id
        )
    )
  then
    raise exception 'MY_COMMENTS_MENTIONS_DEV_REPLY_MENTION_PRIORITY_FAILED';
  end if;

  select lifecycle.id into v_self_mention_id
  from public.community_comment_mention_lifecycle lifecycle
  join public.community_comments comment_row on comment_row.id = lifecycle.comment_id
  where comment_row.public_comment_id = v_reply_public_id
    and lifecycle.target_discord_user_id = v_actor_a;
  if exists (
      select 1 from jsonb_array_elements(
        public.get_own_community_mentions(v_session_a, null, null, null, 20)->'items'
      ) item where item->>'mentionId' = v_self_mention_id::text
    )
    or public.mark_own_community_mention_viewed(
      v_session_a, v_self_mention_id, 0, gen_random_uuid()
    )->>'outcome' <> 'not_found'
    or public.dismiss_own_community_mention(
      v_session_a, v_self_mention_id, 0, gen_random_uuid()
    )->>'outcome' <> 'not_found'
  then
    raise exception 'MY_COMMENTS_MENTIONS_DEV_SELF_MENTION_PROJECTION_FAILED';
  end if;

  if not exists (
      select 1 from public.account_notifications notification
      join public.notification_events event on event.id = notification.event_id
      where event.producer_key = 'comment-reply:' || v_reply_public_id::text
        and notification.owner_discord_user_id = v_actor_b
        and notification.visible_in_product and notification.read_at is null
    )
    or not exists (
      select 1 from public.account_notifications notification
      join public.notification_events event on event.id = notification.event_id
      where event.event_type = 'comment_mention'
        and event.owner_discord_user_id = v_actor_c
        and notification.visible_in_product and notification.read_at is null
    )
    or exists (
      select 1 from public.push_delivery_jobs job
      join public.notification_events event on event.id = job.event_id
      where event.producer_key like 'comment-%'
    )
  then
    raise exception 'MY_COMMENTS_MENTIONS_DEV_DEFAULT_CHANNELS_FAILED';
  end if;

  v_replay := public.create_community_comment_reply(
    v_session_a, v_root_public_id, v_root_public_id, 1, 1,
    'Fantasy reply @target and @other plus @self.',
    jsonb_build_array(
      jsonb_build_object('targetPublicProfileId', v_profile_b, 'startIndex', 14, 'endIndex', 21),
      jsonb_build_object('targetPublicProfileId', v_profile_c, 'startIndex', 26, 'endIndex', 32),
      jsonb_build_object('targetPublicProfileId', v_profile_a, 'startIndex', 38, 'endIndex', 43)
    ), v_reply_request,
    encode(extensions.digest(convert_to('Fantasy reply @target and @other plus @self.','utf8'),'sha256'),'hex'), false
  );
  if v_replay->>'replayed' <> 'true' then raise exception 'MY_COMMENTS_MENTIONS_DEV_REPLY_REPLAY_FAILED: %', v_replay; end if;

  v_replay := public.create_community_comment_reply(
    v_session_a, v_root_public_id, v_root_public_id, 1, 1,
    'Fantasy conflicting replay', '[]'::jsonb, v_reply_request,
    encode(extensions.digest(convert_to('Fantasy conflicting replay','utf8'),'sha256'),'hex'), false
  );
  if v_replay->>'outcome' <> 'idempotency_conflict' then raise exception 'MY_COMMENTS_MENTIONS_DEV_REPLY_CONFLICT_FAILED: %', v_replay; end if;

  v_result := public.edit_community_comment(
    v_session_a, v_reply_public_id, 1,
    'Fantasy edited @target and @other plus @self.',
    jsonb_build_array(
      jsonb_build_object('targetPublicProfileId', v_profile_b, 'startIndex', 15, 'endIndex', 22),
      jsonb_build_object('targetPublicProfileId', v_profile_c, 'startIndex', 27, 'endIndex', 33),
      jsonb_build_object('targetPublicProfileId', v_profile_a, 'startIndex', 39, 'endIndex', 44)
    ), gen_random_uuid(),
    encode(extensions.digest(convert_to('Fantasy edited @target and @other plus @self.','utf8'),'sha256'),'hex'), false
  );
  if v_result->>'outcome' <> 'edited' then raise exception 'MY_COMMENTS_MENTIONS_DEV_EDIT_FAILED: %', v_result; end if;
  if (select count(*) from public.notification_events event
      where event.producer_key = 'comment-reply:' || v_reply_public_id::text
        or event.producer_key in (
          select 'comment-mention:' || lifecycle.id::text
          from public.community_comment_mention_lifecycle lifecycle
          join public.community_comments comment_row on comment_row.id = lifecycle.comment_id
          where comment_row.public_comment_id = v_reply_public_id
        )) <> 2
  then raise exception 'MY_COMMENTS_MENTIONS_DEV_EDIT_DUPLICATED_EVENTS'; end if;

  select count(*) into v_event_count from public.notification_events where event_type = 'comment_reply';
  v_result := public.create_community_comment_reply(
    v_session_a, v_root_public_id, v_root_public_id, 1, 1,
    'Fantasy invalid @mention',
    jsonb_build_array(jsonb_build_object(
      'targetPublicProfileId', v_profile_c, 'startIndex', 0, 'endIndex', 8
    )), gen_random_uuid(), repeat('1',64), false
  );
  if v_result->>'outcome' <> 'text_or_mentions_invalid'
    or (select count(*) from public.notification_events where event_type = 'comment_reply') <> v_event_count
  then raise exception 'MY_COMMENTS_MENTIONS_DEV_ATOMIC_ROLLBACK_FAILED: %', v_result; end if;

  v_page := public.get_own_community_comments(v_session_a, null, null, null, 20);
  if v_page->>'snapshotAt' is null
    or not exists (select 1 from jsonb_array_elements(v_page->'items') item where item->>'publicCommentId' = v_reply_public_id::text)
    or (v_page::text like '%discordUserId%' or v_page::text like '%submissionId%' or v_page::text like '%commentId%')
  then raise exception 'MY_COMMENTS_MENTIONS_DEV_COMMENTS_PROJECTION_FAILED: %', v_page; end if;

  select lifecycle.id into v_mention_id
  from public.community_comment_mention_lifecycle lifecycle
  join public.community_comments comment_row on comment_row.id = lifecycle.comment_id
  where comment_row.public_comment_id = v_reply_public_id
    and lifecycle.target_discord_user_id = v_actor_c;
  v_page := public.get_own_community_mentions(v_session_c, null, null, null, 20);
  if not exists (
      select 1
      from jsonb_array_elements(v_page->'items') item
      where item->>'mentionId' = v_mention_id::text
        and item->>'stateVersion' = '0'
    )
  then raise exception 'MY_COMMENTS_MENTIONS_DEV_MENTIONS_PROJECTION_FAILED: %', v_page; end if;

  v_result := public.mark_own_community_mention_viewed(
    v_session_c, v_mention_id, 0, gen_random_uuid()
  );
  if v_result->>'outcome' <> 'viewed' or v_result->>'stateVersion' <> '1' then
    raise exception 'MY_COMMENTS_MENTIONS_DEV_VIEW_FAILED: %', v_result;
  end if;

  select notification.id into v_notification_id
  from public.account_notifications notification
  join public.notification_events event on event.id = notification.event_id
  where event.event_type = 'comment_mention' and event.owner_discord_user_id = v_actor_c
  order by notification.created_at desc limit 1;
  perform public.mark_own_notification_read(v_session_c, v_notification_id);
  if not exists (
      select 1 from public.community_comment_mention_owner_states state
      where state.comment_id = (select comment_id from public.community_comment_mention_lifecycle where id = v_mention_id)
        and state.owner_discord_user_id = v_actor_c and state.viewed_at is not null
    )
    or not exists (
      select 1 from public.account_notifications where id = v_notification_id and read_at is not null
    )
  then raise exception 'MY_COMMENTS_MENTIONS_DEV_INDEPENDENT_READ_STATE_FAILED'; end if;

  v_result := public.dismiss_own_community_mention(v_session_c, v_mention_id, 1, gen_random_uuid());
  if v_result->>'outcome' <> 'dismissed' or exists (
    select 1 from jsonb_array_elements(public.get_own_community_mentions(v_session_c,null,null,null,20)->'items') item
    where item->>'mentionId' = v_mention_id::text
  ) then raise exception 'MY_COMMENTS_MENTIONS_DEV_DISMISS_FAILED: %', v_result; end if;
  if not exists (select 1 from public.notification_events event where event.id = (select event_id from public.account_notifications where id = v_notification_id)) then
    raise exception 'MY_COMMENTS_MENTIONS_DEV_DISMISS_DELETED_EVENT';
  end if;

  v_thread_version := (select version from public.community_comment_threads where submission_id = v_submission_id);
  v_result := public.create_community_comment_root(
    v_session_a, v_submission_id, v_thread_version,
    'Fantasy future snapshot host', '[]'::jsonb, gen_random_uuid(), repeat('2',64), false
  );
  if v_result->>'outcome' <> 'created' then raise exception 'MY_COMMENTS_MENTIONS_DEV_SECOND_ROOT_FAILED'; end if;
  v_second_root_public_id := (v_result#>>'{comment,publicCommentId}')::uuid;

  insert into public.community_comment_mention_lifecycle(
    comment_id, target_discord_user_id, first_text_version, first_mentioned_at
  )
  select comment_row.id, v_actor_c, 1, v_snapshot - interval '1 second'
  from public.community_comments comment_row where comment_row.public_comment_id = v_root_public_id;
  insert into public.community_comment_mention_lifecycle(
    comment_id, target_discord_user_id, first_text_version, first_mentioned_at
  )
  select comment_row.id, v_actor_c, 1, v_snapshot + interval '1 second'
  from public.community_comments comment_row where comment_row.public_comment_id = v_second_root_public_id
  returning id into v_future_mention_id;

  v_result := public.mark_all_own_community_mentions_viewed(v_session_c, v_snapshot, gen_random_uuid());
  if v_result->>'outcome' <> 'viewed'
    or exists (
      select 1 from public.community_comment_mention_owner_states state
      join public.community_comment_mention_lifecycle lifecycle
        on lifecycle.comment_id = state.comment_id
       and lifecycle.target_discord_user_id = state.owner_discord_user_id
      where lifecycle.id = v_future_mention_id and state.viewed_at is not null
    )
    or not exists (
      select 1 from public.community_comment_mention_owner_states state
      join public.community_comment_mention_lifecycle lifecycle
        on lifecycle.comment_id = state.comment_id
       and lifecycle.target_discord_user_id = state.owner_discord_user_id
      where lifecycle.target_discord_user_id = v_actor_c
        and lifecycle.first_mentioned_at < v_snapshot and state.viewed_at is not null
    )
  then raise exception 'MY_COMMENTS_MENTIONS_DEV_SNAPSHOT_MARK_ALL_FAILED: %', v_result; end if;

  if (select count(*) from public.notification_category_catalog
      where category_key in ('comment_replies','comment_mentions')
        and default_in_product_enabled and in_product_available and push_available) <> 2
    or exists (
      select 1 from public.push_subscription_preferences
      where category_key in ('comment_replies','comment_mentions') and enabled
    )
  then raise exception 'MY_COMMENTS_MENTIONS_DEV_CATEGORY_DEFAULTS_FAILED'; end if;
end;
$test$;

select json_build_object(
  'result', 'my_comments_mentions_notifications_ok',
  'replyPriority', true,
  'selfSuppression', true,
  'editDedupe', true,
  'atomicRollback', true,
  'ownerPrivacy', true,
  'snapshotMarkAll', true,
  'dismissPreservesEvent', true,
  'notificationReadIndependent', true
);

rollback;
