\set ON_ERROR_STOP on

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $contract$
declare
  v_base bigint := 980000000000000000 + floor(random() * 1000000000000000)::bigint;
  v_author text := v_base::text;
  v_target text := (v_base + 1)::text;
  v_author_profile uuid := gen_random_uuid();
  v_target_profile uuid := gen_random_uuid();
  v_author_session uuid := gen_random_uuid();
  v_target_session uuid := gen_random_uuid();
  v_submission_id bigint;
  v_request uuid := gen_random_uuid();
  v_reply_request uuid := gen_random_uuid();
  v_edit_request uuid := gen_random_uuid();
  v_delete_request uuid := gen_random_uuid();
  v_root_public_id uuid;
  v_reply_public_id uuid;
  v_result jsonb;
  v_replay jsonb;
  v_page jsonb;
  v_banned_rejected boolean := false;
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
    and result.final_vote_count = 0
  order by submission.id
  limit 1;

  if v_submission_id is null then
    raise exception 'COMMUNITY_COMMENTS_DEV_ZERO_VOTE_FIXTURE_UNAVAILABLE';
  end if;

  insert into public.user_logs (
    discord_user_id, current_discord_username, current_display_name,
    public_profile_id, is_banned
  ) values
    (v_author, 'comment-foundation-author', 'Comment Author', v_author_profile, false),
    (v_target, 'comment-foundation-target', 'Mention Target', v_target_profile, false);
  insert into public.sessions(id, discord_user_id) values
    (v_author_session, v_author),
    (v_target_session, v_target);

  if exists (
    select 1 from public.discord_member_state
    where discord_user_id in (v_author, v_target)
  ) or public.require_account_session(v_author_session) <> v_author then
    raise exception 'COMMUNITY_COMMENTS_DEV_WEBSITE_SESSION_FIXTURE_INVALID';
  end if;

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
    ('edit', 1, 3600, 100, 60, 100);

  v_page := public.get_community_comment_thread_page(
    v_submission_id, 'top', null, null, null, null, 20
  );
  if v_page ->> 'outcome' <> 'ok'
    or v_page ->> 'threadVersion' <> '0'
  then
    raise exception 'COMMUNITY_COMMENTS_DEV_ANONYMOUS_ZERO_VOTE_READ_FAILED: %', v_page;
  end if;

  v_result := public.create_community_comment_root(
    v_author_session, v_submission_id, 0,
    'https://example.com must fail', '[]'::jsonb,
    gen_random_uuid(), repeat('a', 64), false
  );
  if v_result ->> 'outcome' <> 'text_or_mentions_invalid' then
    raise exception 'COMMUNITY_COMMENTS_DEV_EXTERNAL_LINK_ACCEPTED: %', v_result;
  end if;

  v_result := public.create_community_comment_root(
    v_author_session, v_submission_id, 0,
    'Hello @Target 😀',
    jsonb_build_array(jsonb_build_object(
      'targetPublicProfileId', v_target_profile,
      'startIndex', 6,
      'endIndex', 13
    )),
    v_request, repeat('b', 64), false
  );
  if v_result ->> 'outcome' <> 'created'
    or v_result ->> 'replayed' <> 'false'
    or v_result #>> '{comment,body}' <> 'Hello @Target 😀'
    or v_result #>> '{comment,author,publicProfileId}' <> v_author_profile::text
    or v_result #>> '{comment,mentions,0,targetPublicProfileId}' <> v_target_profile::text
    or (v_result #> '{comment}') ? 'discordUserId'
  then
    raise exception 'COMMUNITY_COMMENTS_DEV_ROOT_CREATE_FAILED: %', v_result;
  end if;
  v_root_public_id := (v_result #>> '{comment,publicCommentId}')::uuid;

  v_replay := public.create_community_comment_root(
    v_author_session, v_submission_id, 0,
    'Hello @Target 😀',
    jsonb_build_array(jsonb_build_object(
      'targetPublicProfileId', v_target_profile,
      'startIndex', 6,
      'endIndex', 13
    )),
    v_request, repeat('b', 64), false
  );
  if v_replay ->> 'outcome' <> 'created'
    or v_replay ->> 'replayed' <> 'true'
    or v_replay #>> '{comment,publicCommentId}' <> v_root_public_id::text
  then
    raise exception 'COMMUNITY_COMMENTS_DEV_STABLE_REPLAY_FAILED: %', v_replay;
  end if;

  v_replay := public.create_community_comment_root(
    v_author_session, v_submission_id, 1,
    'Changed replay payload', '[]'::jsonb,
    v_request, repeat('c', 64), false
  );
  if v_replay ->> 'outcome' <> 'idempotency_conflict' then
    raise exception 'COMMUNITY_COMMENTS_DEV_IDEMPOTENCY_CONFLICT_FAILED: %', v_replay;
  end if;

  v_result := public.create_community_comment_root(
    v_author_session, v_submission_id, 0,
    'Stale concurrent writer', '[]'::jsonb,
    gen_random_uuid(), repeat('d', 64), false
  );
  if v_result ->> 'outcome' <> 'stale_thread'
    or v_result ->> 'threadVersion' <> '1'
  then
    raise exception 'COMMUNITY_COMMENTS_DEV_STALE_THREAD_FAILED: %', v_result;
  end if;

  v_result := public.create_community_comment_reply(
    v_target_session, v_root_public_id, v_root_public_id,
    1, 1, 'A real reply', '[]'::jsonb,
    v_reply_request, repeat('e', 64), false
  );
  if v_result ->> 'outcome' <> 'created'
    or v_result #>> '{comment,rootPublicCommentId}' <> v_root_public_id::text
  then
    raise exception 'COMMUNITY_COMMENTS_DEV_REPLY_CREATE_FAILED: %', v_result;
  end if;
  v_reply_public_id := (v_result #>> '{comment,publicCommentId}')::uuid;

  v_page := public.get_community_comment_thread_page(
    v_submission_id, 'newest', null, null, null, null, 20
  );
  if jsonb_array_length(v_page -> 'items') <> 1
    or jsonb_array_length(v_page #> '{items,0,replyPreview}') <> 1
    or v_page #>> '{items,0,replyPreview,0,publicCommentId}' <> v_reply_public_id::text
  then
    raise exception 'COMMUNITY_COMMENTS_DEV_REPLY_PREVIEW_FAILED: %', v_page;
  end if;

  v_page := public.get_community_comment_replies(
    v_root_public_id, null, null, null, 20
  );
  if v_page ->> 'outcome' <> 'ok'
    or v_page ->> 'submissionId' <> v_submission_id::text
    or jsonb_array_length(v_page -> 'items') <> 1
    or v_page #>> '{items,0,publicCommentId}' <> v_reply_public_id::text
  then
    raise exception 'COMMUNITY_COMMENTS_DEV_REPLY_PAGE_FAILED: %', v_page;
  end if;

  v_page := public.get_community_comment_deep_link(v_reply_public_id);
  if v_page ->> 'outcome' <> 'ok'
    or v_page ->> 'targetPublicCommentId' <> v_reply_public_id::text
    or v_page #>> '{root,publicCommentId}' <> v_root_public_id::text
    or v_page ->> 'windowLimit' <> '20'
    or jsonb_array_length(v_page -> 'replies') > 20
  then
    raise exception 'COMMUNITY_COMMENTS_DEV_DEEP_LINK_WINDOW_FAILED: %', v_page;
  end if;

  v_page := public.get_community_comments_batch(
    array[v_root_public_id, v_reply_public_id]
  );
  if v_page ->> 'outcome' <> 'ok'
    or jsonb_array_length(v_page -> 'items') <> 2
    or (v_page #> '{items,0}') ? 'discordUserId'
  then
    raise exception 'COMMUNITY_COMMENTS_DEV_BATCH_PRIVACY_FAILED: %', v_page;
  end if;

  begin
    perform public.get_community_comments_batch(
      array_fill(v_root_public_id, array[101])
    );
    raise exception 'COMMUNITY_COMMENTS_DEV_BATCH_LIMIT_ACCEPTED';
  exception when sqlstate '22023' then
    if sqlerrm <> 'COMMUNITY_COMMENT_BATCH_INPUT_INVALID' then raise; end if;
  end;

  v_result := public.edit_community_comment(
    v_author_session, v_root_public_id, 1,
    'Edited @Target',
    jsonb_build_array(jsonb_build_object(
      'targetPublicProfileId', v_target_profile,
      'startIndex', 7,
      'endIndex', 14
    )),
    v_edit_request, repeat('f', 64), false
  );
  if v_result ->> 'outcome' <> 'edited'
    or v_result #>> '{comment,version}' <> '2'
    or v_result #>> '{comment,body}' <> 'Edited @Target'
  then
    raise exception 'COMMUNITY_COMMENTS_DEV_EDIT_FAILED: %', v_result;
  end if;

  if (select count(*) from public.community_comment_text_versions version_row
      join public.community_comments comment_row on comment_row.id = version_row.comment_id
      where comment_row.public_comment_id = v_root_public_id) <> 2
    or (select count(*) from public.community_comment_mention_lifecycle lifecycle
        join public.community_comments comment_row on comment_row.id = lifecycle.comment_id
        where comment_row.public_comment_id = v_root_public_id) <> 1
  then
    raise exception 'COMMUNITY_COMMENTS_DEV_APPEND_ONLY_LIFECYCLE_FAILED';
  end if;

  v_result := public.edit_community_comment(
    v_author_session, v_root_public_id, 1,
    'Stale edit', '[]'::jsonb,
    gen_random_uuid(), repeat('0', 64), false
  );
  if v_result ->> 'outcome' <> 'stale_comment' or v_result ->> 'version' <> '2' then
    raise exception 'COMMUNITY_COMMENTS_DEV_STALE_EDIT_FAILED: %', v_result;
  end if;

  v_result := public.delete_community_comment(
    v_author_session, v_root_public_id, 2, v_delete_request, true
  );
  if v_result ->> 'outcome' <> 'author_deleted'
    or v_result ->> 'branchClosed' <> 'true'
    or v_result #>> '{comment,tombstone}' <> 'author_deleted'
    or (v_result #> '{comment}') ? 'body' is false
    or v_result #> '{comment,body}' <> 'null'::jsonb
    or jsonb_array_length(v_result #> '{comment,mentions}') <> 0
  then
    raise exception 'COMMUNITY_COMMENTS_DEV_TOMBSTONE_FAILED: %', v_result;
  end if;

  v_replay := public.delete_community_comment(
    v_author_session, v_root_public_id, 2, v_delete_request, true
  );
  if v_replay ->> 'outcome' <> 'author_deleted'
    or v_replay ->> 'replayed' <> 'true'
  then
    raise exception 'COMMUNITY_COMMENTS_DEV_DELETE_REPLAY_FAILED: %', v_replay;
  end if;

  v_result := public.create_community_comment_reply(
    v_target_session, v_root_public_id, v_root_public_id,
    3, 3, 'Closed branch reply', '[]'::jsonb,
    gen_random_uuid(), repeat('1', 64), false
  );
  if v_result ->> 'outcome' <> 'branch_closed' then
    raise exception 'COMMUNITY_COMMENTS_DEV_DELETED_ROOT_BRANCH_OPEN: %', v_result;
  end if;

  begin
    update public.community_comment_text_versions
    set normalized_body = 'history rewrite'
    where comment_id = (
      select id from public.community_comments where public_comment_id = v_root_public_id
    ) and version = 1;
    raise exception 'COMMUNITY_COMMENTS_DEV_HISTORY_REWRITE_ACCEPTED';
  exception when sqlstate '55000' then
    if sqlerrm <> 'COMMUNITY_COMMENT_HISTORY_IS_APPEND_ONLY' then raise; end if;
  end;

  update public.user_logs set is_banned = true where discord_user_id = v_target;
  v_result := null;
  begin
    v_result := public.create_community_comment_root(
      v_target_session, v_submission_id, 4,
      'Banned author', '[]'::jsonb,
      gen_random_uuid(), repeat('2', 64), false
    );
    v_banned_rejected := v_result ->> 'outcome' <> 'created';
  exception when others then
    v_banned_rejected := true;
  end;
  if not v_banned_rejected then
    raise exception 'COMMUNITY_COMMENTS_DEV_BANNED_SESSION_NOT_REJECTED';
  end if;

  update public.community_comment_settings set release_state = 'read_only' where singleton;
  v_result := public.create_community_comment_root(
    v_author_session, v_submission_id, 4,
    'Read only writer', '[]'::jsonb,
    gen_random_uuid(), repeat('3', 64), false
  );
  if v_result ->> 'outcome' <> 'read_only' then
    raise exception 'COMMUNITY_COMMENTS_DEV_READ_ONLY_WRITE_ACCEPTED: %', v_result;
  end if;

  update public.community_comment_settings set release_state = 'off' where singleton;
  v_page := public.get_community_comment_thread_page(
    v_submission_id, 'top', null, null, null, null, 20
  );
  if v_page ->> 'outcome' <> 'feature_off' then
    raise exception 'COMMUNITY_COMMENTS_DEV_OFF_READ_ACCEPTED: %', v_page;
  end if;
end;
$contract$;

rollback;
