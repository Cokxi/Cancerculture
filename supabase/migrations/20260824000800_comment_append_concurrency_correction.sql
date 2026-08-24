begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $preflight$
declare
  v_root_definition text;
  v_reply_definition text;
begin
  if (select release_state from public.community_comment_settings where singleton) <> 'off'
    or to_regprocedure('public.create_community_comment_root(uuid,bigint,bigint,text,jsonb,uuid,text,boolean)') is null
    or to_regprocedure('public.create_community_comment_reply(uuid,uuid,uuid,bigint,bigint,text,jsonb,uuid,text,boolean)') is null
    or not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'community_comments'
        and column_name = 'team_removed_at'
    )
  then
    raise exception using
      errcode = '55000',
      message = 'COMMENT_APPEND_CONCURRENCY_BASELINE_MISMATCH';
  end if;

  v_root_definition := pg_get_functiondef(to_regprocedure(
    'public.create_community_comment_root(uuid,bigint,bigint,text,jsonb,uuid,text,boolean)'
  ));
  v_reply_definition := pg_get_functiondef(to_regprocedure(
    'public.create_community_comment_reply(uuid,uuid,uuid,bigint,bigint,text,jsonb,uuid,text,boolean)'
  ));

  if v_root_definition not like '%v_thread.version <> p_expected_thread_version%'
    or v_reply_definition not like '%v_root.object_version <> p_expected_root_version%'
    or v_reply_definition not like '%v_target.object_version <> p_expected_target_version%'
    or pg_get_userbyid((select proowner from pg_proc where oid = to_regprocedure(
      'public.create_community_comment_root(uuid,bigint,bigint,text,jsonb,uuid,text,boolean)'
    ))) <> 'postgres'
    or pg_get_userbyid((select proowner from pg_proc where oid = to_regprocedure(
      'public.create_community_comment_reply(uuid,uuid,uuid,bigint,bigint,text,jsonb,uuid,text,boolean)'
    ))) <> 'postgres'
  then
    raise exception using
      errcode = '55000',
      message = 'COMMENT_APPEND_CONCURRENCY_FUNCTION_BASELINE_MISMATCH';
  end if;
end;
$preflight$;

create or replace function public.create_community_comment_root(
  p_session_id uuid,
  p_submission_id bigint,
  p_expected_thread_version bigint,
  p_normalized_body text,
  p_mentions jsonb,
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
  v_thread public.community_comment_threads%rowtype;
  v_comment public.community_comments%rowtype;
  v_request public.community_comment_mutation_requests%rowtype;
  v_hash text;
  v_legacy_hash text;
  v_abuse jsonb;
  v_receipt jsonb;
begin
  if p_session_id is null
    or p_submission_id is null or p_submission_id <= 0
    or p_expected_thread_version is null or p_expected_thread_version < 0
    or p_request_id is null
    or p_mentions is null
  then
    raise exception using
      errcode = '22023',
      message = 'COMMUNITY_COMMENT_ROOT_INPUT_INVALID';
  end if;

  if public.get_community_comment_release_state() = 'off' then
    return jsonb_build_object('outcome', 'feature_off');
  elsif public.get_community_comment_release_state() <> 'open' then
    return jsonb_build_object('outcome', 'read_only');
  end if;

  v_actor := public.require_account_session(p_session_id);
  if not exists (
    select 1 from public.user_logs user_log
    where user_log.discord_user_id = v_actor
      and user_log.public_profile_id is not null
  ) then
    return jsonb_build_object('outcome', 'author_profile_unavailable');
  end if;

  -- Append identity deliberately excludes the advisory thread version. The
  -- thread row is still locked and incremented atomically below.
  v_hash := encode(
    extensions.digest(
      convert_to(
        jsonb_build_object(
          'operation', 'create_root',
          'submissionId', p_submission_id,
          'body', p_normalized_body,
          'mentions', p_mentions
        )::text,
        'utf8'
      ),
      'sha256'
    ),
    'hex'
  );
  v_legacy_hash := encode(
    extensions.digest(
      convert_to(
        jsonb_build_object(
          'operation', 'create_root',
          'submissionId', p_submission_id,
          'expectedThreadVersion', p_expected_thread_version,
          'body', p_normalized_body,
          'mentions', p_mentions
        )::text,
        'utf8'
      ),
      'sha256'
    ),
    'hex'
  );

  perform pg_advisory_xact_lock(
    hashtextextended(
      'community-comment-request:' || v_actor || ':' || p_request_id::text,
      0
    )
  );

  if not public.is_community_comment_submission_eligible(p_submission_id) then
    return jsonb_build_object('outcome', 'submission_unavailable');
  end if;

  insert into public.community_comment_threads(submission_id)
  values (p_submission_id)
  on conflict (submission_id) do nothing;

  select * into strict v_thread
  from public.community_comment_threads thread
  where thread.submission_id = p_submission_id
  for update;

  select * into v_request
  from public.community_comment_mutation_requests request
  where request.actor_discord_user_id = v_actor
    and request.request_id = p_request_id;
  if found then
    if v_request.operation <> 'create_root'
      or v_request.request_hash not in (v_hash, v_legacy_hash)
    then
      return jsonb_build_object('outcome', 'idempotency_conflict');
    end if;
    return v_request.receipt || jsonb_build_object('replayed', true);
  end if;

  v_abuse := public.apply_community_comment_abuse_budget(
    v_actor,
    'root',
    p_submission_id,
    p_content_digest,
    p_turnstile_verified,
    v_now
  );
  if v_abuse->>'outcome' <> 'allowed' then
    return v_abuse;
  end if;

  begin
    perform public.validate_community_comment_body(p_normalized_body);

    insert into public.community_comments (
      thread_id,
      submission_id,
      author_discord_user_id,
      created_at
    ) values (
      v_thread.id,
      p_submission_id,
      v_actor,
      v_now
    ) returning * into v_comment;

    insert into public.community_comment_text_versions (
      comment_id, version, transition, normalized_body, created_at
    ) values (
      v_comment.id, 1, 'created', p_normalized_body, v_now
    );

    perform public.replace_community_comment_mentions(
      v_comment.id, 1, p_normalized_body, p_mentions, v_now
    );

    update public.community_comment_threads
    set version = version + 1, updated_at = v_now
    where id = v_thread.id
    returning * into v_thread;

    insert into public.community_comment_mutation_events (
      comment_id, actor_discord_user_id, event_type, request_id,
      from_object_version, to_object_version, created_at
    ) values (
      v_comment.id, v_actor, 'created', p_request_id,
      null, 1, v_now
    );

    v_receipt := jsonb_build_object(
      'outcome', 'created',
      'replayed', false,
      'threadVersion', v_thread.version,
      'comment', public.build_community_comment_public_json(v_comment.id)
    );

    insert into public.community_comment_mutation_requests (
      session_id, request_id, actor_discord_user_id,
      operation, request_hash, receipt, created_at
    ) values (
      p_session_id, p_request_id, v_actor,
      'create_root', v_hash, v_receipt, v_now
    );
  exception when sqlstate '22023' then
    perform public.mark_community_comment_rejected_input(
      v_actor, 'root', p_submission_id, v_now
    );
    return jsonb_build_object('outcome', 'text_or_mentions_invalid');
  end;

  return v_receipt;
end;
$function$;

create or replace function public.create_community_comment_reply(
  p_session_id uuid,
  p_root_public_comment_id uuid,
  p_target_public_comment_id uuid,
  p_expected_root_version bigint,
  p_expected_target_version bigint,
  p_normalized_body text,
  p_mentions jsonb,
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
  v_root public.community_comments%rowtype;
  v_target public.community_comments%rowtype;
  v_thread public.community_comment_threads%rowtype;
  v_comment public.community_comments%rowtype;
  v_request public.community_comment_mutation_requests%rowtype;
  v_hash text;
  v_legacy_hash text;
  v_abuse jsonb;
  v_receipt jsonb;
begin
  if p_session_id is null
    or p_root_public_comment_id is null
    or p_target_public_comment_id is null
    or p_expected_root_version is null or p_expected_root_version <= 0
    or p_expected_target_version is null or p_expected_target_version <= 0
    or p_request_id is null
    or p_mentions is null
  then
    raise exception using
      errcode = '22023',
      message = 'COMMUNITY_COMMENT_REPLY_INPUT_INVALID';
  end if;

  if public.get_community_comment_release_state() = 'off' then
    return jsonb_build_object('outcome', 'feature_off');
  elsif public.get_community_comment_release_state() <> 'open' then
    return jsonb_build_object('outcome', 'read_only');
  end if;

  v_actor := public.require_account_session(p_session_id);
  if not exists (
    select 1 from public.user_logs user_log
    where user_log.discord_user_id = v_actor
      and user_log.public_profile_id is not null
  ) then
    return jsonb_build_object('outcome', 'author_profile_unavailable');
  end if;

  -- Root and target versions are advisory client observations for append. The
  -- current rows are locked and their live branch/target state is authoritative.
  v_hash := encode(
    extensions.digest(
      convert_to(
        jsonb_build_object(
          'operation', 'create_reply',
          'rootPublicCommentId', p_root_public_comment_id,
          'targetPublicCommentId', p_target_public_comment_id,
          'body', p_normalized_body,
          'mentions', p_mentions
        )::text,
        'utf8'
      ),
      'sha256'
    ),
    'hex'
  );
  v_legacy_hash := encode(
    extensions.digest(
      convert_to(
        jsonb_build_object(
          'operation', 'create_reply',
          'rootPublicCommentId', p_root_public_comment_id,
          'targetPublicCommentId', p_target_public_comment_id,
          'expectedRootVersion', p_expected_root_version,
          'expectedTargetVersion', p_expected_target_version,
          'body', p_normalized_body,
          'mentions', p_mentions
        )::text,
        'utf8'
      ),
      'sha256'
    ),
    'hex'
  );

  perform pg_advisory_xact_lock(
    hashtextextended(
      'community-comment-request:' || v_actor || ':' || p_request_id::text,
      0
    )
  );

  select * into v_root
  from public.community_comments comment_row
  where comment_row.public_comment_id = p_root_public_comment_id
    and comment_row.root_comment_id is null;
  if not found then
    return jsonb_build_object('outcome', 'root_unavailable');
  end if;

  select * into v_target
  from public.community_comments comment_row
  where comment_row.public_comment_id = p_target_public_comment_id;
  if not found then
    return jsonb_build_object('outcome', 'target_unavailable');
  end if;

  perform 1
  from public.community_comments comment_row
  where comment_row.id = any(array[v_root.id, v_target.id])
  order by comment_row.id
  for update;

  select * into strict v_root
  from public.community_comments comment_row
  where comment_row.id = v_root.id;
  select * into strict v_target
  from public.community_comments comment_row
  where comment_row.id = v_target.id;

  if v_target.thread_id <> v_root.thread_id
    or v_target.submission_id <> v_root.submission_id
    or (
      v_target.id <> v_root.id
      and v_target.root_comment_id is distinct from v_root.id
    )
  then
    return jsonb_build_object('outcome', 'target_unavailable');
  end if;

  if not public.is_community_comment_submission_eligible(v_root.submission_id) then
    return jsonb_build_object('outcome', 'submission_unavailable');
  end if;

  if v_root.author_deleted_at is not null
    or v_root.team_removed_at is not null
  then
    return jsonb_build_object('outcome', 'branch_closed');
  end if;
  if v_target.author_deleted_at is not null
    or v_target.team_removed_at is not null
  then
    return jsonb_build_object('outcome', 'target_unavailable');
  end if;

  select * into strict v_thread
  from public.community_comment_threads thread
  where thread.id = v_root.thread_id
  for update;

  select * into v_request
  from public.community_comment_mutation_requests request
  where request.actor_discord_user_id = v_actor
    and request.request_id = p_request_id;
  if found then
    if v_request.operation <> 'create_reply'
      or v_request.request_hash not in (v_hash, v_legacy_hash)
    then
      return jsonb_build_object('outcome', 'idempotency_conflict');
    end if;
    return v_request.receipt || jsonb_build_object('replayed', true);
  end if;

  v_abuse := public.apply_community_comment_abuse_budget(
    v_actor,
    'reply',
    v_root.submission_id,
    p_content_digest,
    p_turnstile_verified,
    v_now
  );
  if v_abuse->>'outcome' <> 'allowed' then
    return v_abuse;
  end if;

  begin
    perform public.validate_community_comment_body(p_normalized_body);

    insert into public.community_comments (
      thread_id,
      submission_id,
      author_discord_user_id,
      root_comment_id,
      reply_target_comment_id,
      created_at
    ) values (
      v_root.thread_id,
      v_root.submission_id,
      v_actor,
      v_root.id,
      v_target.id,
      v_now
    ) returning * into v_comment;

    insert into public.community_comment_text_versions (
      comment_id, version, transition, normalized_body, created_at
    ) values (
      v_comment.id, 1, 'created', p_normalized_body, v_now
    );

    perform public.replace_community_comment_mentions(
      v_comment.id, 1, p_normalized_body, p_mentions, v_now
    );

    update public.community_comment_threads
    set version = version + 1, updated_at = v_now
    where id = v_thread.id
    returning * into v_thread;

    insert into public.community_comment_mutation_events (
      comment_id, actor_discord_user_id, event_type, request_id,
      from_object_version, to_object_version, created_at
    ) values (
      v_comment.id, v_actor, 'created', p_request_id,
      null, 1, v_now
    );

    v_receipt := jsonb_build_object(
      'outcome', 'created',
      'replayed', false,
      'threadVersion', v_thread.version,
      'rootVersion', v_root.object_version,
      'comment', public.build_community_comment_public_json(v_comment.id)
    );

    insert into public.community_comment_mutation_requests (
      session_id, request_id, actor_discord_user_id,
      operation, request_hash, receipt, created_at
    ) values (
      p_session_id, p_request_id, v_actor,
      'create_reply', v_hash, v_receipt, v_now
    );
  exception when sqlstate '22023' then
    perform public.mark_community_comment_rejected_input(
      v_actor, 'reply', v_root.submission_id, v_now
    );
    return jsonb_build_object('outcome', 'text_or_mentions_invalid');
  end;

  return v_receipt;
end;
$function$;

alter function public.create_community_comment_root(uuid,bigint,bigint,text,jsonb,uuid,text,boolean)
  owner to postgres;
alter function public.create_community_comment_reply(uuid,uuid,uuid,bigint,bigint,text,jsonb,uuid,text,boolean)
  owner to postgres;

revoke all on function public.create_community_comment_root(uuid,bigint,bigint,text,jsonb,uuid,text,boolean)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.create_community_comment_reply(uuid,uuid,uuid,bigint,bigint,text,jsonb,uuid,text,boolean)
  from public, anon, authenticated, discord_bot, service_role;
grant execute on function public.create_community_comment_root(uuid,bigint,bigint,text,jsonb,uuid,text,boolean)
  to service_role;
grant execute on function public.create_community_comment_reply(uuid,uuid,uuid,bigint,bigint,text,jsonb,uuid,text,boolean)
  to service_role;

do $postflight$
declare
  v_root_definition text := pg_get_functiondef(to_regprocedure(
    'public.create_community_comment_root(uuid,bigint,bigint,text,jsonb,uuid,text,boolean)'
  ));
  v_reply_definition text := pg_get_functiondef(to_regprocedure(
    'public.create_community_comment_reply(uuid,uuid,uuid,bigint,bigint,text,jsonb,uuid,text,boolean)'
  ));
begin
  if v_root_definition like '%v_thread.version <> p_expected_thread_version%'
    or v_reply_definition like '%v_root.object_version <> p_expected_root_version%'
    or v_reply_definition like '%v_target.object_version <> p_expected_target_version%'
    or v_root_definition not like '%v_request.request_hash not in (v_hash, v_legacy_hash)%'
    or v_reply_definition not like '%v_root.team_removed_at is not null%'
    or v_reply_definition not like '%v_target.team_removed_at is not null%'
    or has_function_privilege('public', 'public.create_community_comment_root(uuid,bigint,bigint,text,jsonb,uuid,text,boolean)', 'EXECUTE')
    or has_function_privilege('anon', 'public.create_community_comment_root(uuid,bigint,bigint,text,jsonb,uuid,text,boolean)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.create_community_comment_root(uuid,bigint,bigint,text,jsonb,uuid,text,boolean)', 'EXECUTE')
    or has_function_privilege('discord_bot', 'public.create_community_comment_root(uuid,bigint,bigint,text,jsonb,uuid,text,boolean)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.create_community_comment_root(uuid,bigint,bigint,text,jsonb,uuid,text,boolean)', 'EXECUTE')
    or has_function_privilege('public', 'public.create_community_comment_reply(uuid,uuid,uuid,bigint,bigint,text,jsonb,uuid,text,boolean)', 'EXECUTE')
    or has_function_privilege('anon', 'public.create_community_comment_reply(uuid,uuid,uuid,bigint,bigint,text,jsonb,uuid,text,boolean)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.create_community_comment_reply(uuid,uuid,uuid,bigint,bigint,text,jsonb,uuid,text,boolean)', 'EXECUTE')
    or has_function_privilege('discord_bot', 'public.create_community_comment_reply(uuid,uuid,uuid,bigint,bigint,text,jsonb,uuid,text,boolean)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.create_community_comment_reply(uuid,uuid,uuid,bigint,bigint,text,jsonb,uuid,text,boolean)', 'EXECUTE')
  then
    raise exception using
      errcode = '55000',
      message = 'COMMENT_APPEND_CONCURRENCY_POSTFLIGHT_MISMATCH';
  end if;
end;
$postflight$;

comment on function public.create_community_comment_root(uuid,bigint,bigint,text,jsonb,uuid,text,boolean) is
  'Atomically appends an independent Root under current release, Submission, idempotency and abuse checks; stale read snapshots do not reject safe appends.';
comment on function public.create_community_comment_reply(uuid,uuid,uuid,bigint,bigint,text,jsonb,uuid,text,boolean) is
  'Atomically serializes Reply appends under current Root/target locks and fail-closed branch, moderation, idempotency and abuse checks.';

commit;
