do $preflight$
begin
  if to_regprocedure(
    'public.get_community_comment_moderation_target(text,uuid)'
  ) is null
    or to_regprocedure(
      'public.moderate_community_comment(text,uuid,text,bigint,bigint,text,uuid,text)'
    ) is null
    or to_regprocedure(
      'public.mutate_team_inbox_case(text,uuid,uuid,text,text,bigint,bigint,text)'
    ) is null
    or to_regclass('public.community_comment_report_cases') is null
    or to_regclass('public.community_comments') is null
    or to_regclass('public.team_inbox_cases') is null
  then
    raise exception 'COMMUNITY_COMMENT_CLAIMED_REVIEW_HOLD_PREFLIGHT_FAILED';
  end if;
end;
$preflight$;

create function public.is_community_comment_claimed_for_review(
  p_public_comment_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select exists (
    select 1
    from public.community_comments comment_row
    join public.community_comment_report_cases report_case
      on report_case.comment_id = comment_row.id
     and report_case.status = 'open'
    join public.team_inbox_cases inbox_case
      on inbox_case.id = report_case.team_inbox_case_id
     and inbox_case.topic_key = 'comment_reports'
     and inbox_case.status = 'in_progress'
    where comment_row.public_comment_id = p_public_comment_id
  );
$function$;

create or replace function public.get_community_comment_moderation_target(
  p_actor_discord_user_id text,
  p_public_comment_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_comment public.community_comments%rowtype;
begin
  perform public.assert_community_comment_capabilities(
    p_actor_discord_user_id, array['community.comments.moderate']::text[]
  );
  select * into v_comment from public.community_comments
  where public_comment_id = p_public_comment_id;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  return jsonb_build_object(
    'outcome', 'found',
    'comment', public.build_community_comment_public_json(v_comment.id),
    'objectVersion', v_comment.object_version,
    'moderationVersion', v_comment.team_moderation_version,
    'removed', v_comment.team_removed_at is not null,
    'authorDeleted', v_comment.author_deleted_at is not null,
    'submissionEligible', public.is_community_comment_submission_eligible(v_comment.submission_id),
    'claimedForReview', public.is_community_comment_claimed_for_review(v_comment.public_comment_id),
    'reviewContext', public.build_community_comment_moderation_review_context(v_comment.id)
  );
end;
$function$;

create or replace function public.moderate_community_comment(
  p_actor_discord_user_id text,
  p_public_comment_id uuid,
  p_action text,
  p_expected_object_version bigint,
  p_expected_moderation_version bigint,
  p_internal_reason text,
  p_request_id uuid,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_existing public.community_comment_review_requests%rowtype;
  v_result jsonb;
begin
  if p_public_comment_id is null
    or p_action not in ('remove', 'restore')
    or p_request_id is null
    or p_request_hash !~ '^[0-9a-f]{64}$'
    or coalesce(char_length(btrim(p_internal_reason)), 0) not between 3 and 1000
  then
    raise exception using errcode = '22023', message = 'COMMUNITY_COMMENT_MODERATION_INPUT_INVALID';
  end if;
  perform public.assert_community_comment_capabilities(
    p_actor_discord_user_id, array['community.comments.moderate']::text[]
  );
  perform pg_advisory_xact_lock(hashtextextended(
    'community-comment-review-request:' || p_actor_discord_user_id || ':' || p_request_id::text, 0
  ));
  select * into v_existing from public.community_comment_review_requests request
  where request.actor_discord_user_id = p_actor_discord_user_id
    and request.request_id = p_request_id;
  if found then
    if v_existing.request_hash <> p_request_hash or v_existing.operation <> 'moderate_direct' then
      return jsonb_build_object('outcome', 'idempotency_conflict');
    end if;
    return v_existing.result || jsonb_build_object('replayed', true);
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'community-comment-moderation:' || p_public_comment_id::text, 0
  ));
  if public.is_community_comment_claimed_for_review(p_public_comment_id) then
    v_result := jsonb_build_object('outcome', 'claimed_for_review');
  else
    v_result := public.apply_community_comment_moderation(
      p_actor_discord_user_id, p_public_comment_id, p_action,
      p_expected_object_version, p_expected_moderation_version,
      p_internal_reason, null, null, p_request_id
    );
  end if;
  insert into public.community_comment_review_requests(
    actor_discord_user_id, request_id, operation, request_hash, result
  ) values (
    p_actor_discord_user_id, p_request_id, 'moderate_direct', p_request_hash, v_result
  );
  return v_result;
end;
$function$;

create or replace function public.mutate_team_inbox_case(
  p_actor_discord_user_id text,
  p_case_id uuid,
  p_idempotency_key uuid,
  p_action text,
  p_expected_state text,
  p_expected_row_version bigint,
  p_expected_work_version bigint,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_topic text;
  v_public_comment_id uuid;
begin
  select inbox_case.topic_key, comment_row.public_comment_id
  into v_topic, v_public_comment_id
  from public.team_inbox_cases inbox_case
  left join public.community_comment_report_cases report_case
    on inbox_case.topic_key = 'comment_reports'
   and report_case.team_inbox_case_id = inbox_case.id
  left join public.community_comments comment_row
    on comment_row.id = report_case.comment_id
  where inbox_case.id = p_case_id;
  if p_action = 'return' and v_topic in ('comment_reports', 'comment_spam')
    and (p_note is null or char_length(btrim(p_note)) not between 3 and 1000)
  then
    raise exception using errcode = '22023', message = 'TEAM_INBOX_RETURN_NOTE_REQUIRED';
  end if;
  if p_action = 'claim' and v_topic = 'comment_reports'
    and v_public_comment_id is not null
  then
    perform pg_advisory_xact_lock(hashtextextended(
      'community-comment-moderation:' || v_public_comment_id::text, 0
    ));
  end if;
  return public.mutate_team_inbox_case_v1(
    p_actor_discord_user_id, p_case_id, p_idempotency_key, p_action,
    p_expected_state, p_expected_row_version, p_expected_work_version, p_note
  );
end;
$function$;

alter function public.is_community_comment_claimed_for_review(uuid)
  owner to postgres;
alter function public.get_community_comment_moderation_target(text,uuid)
  owner to postgres;
alter function public.moderate_community_comment(text,uuid,text,bigint,bigint,text,uuid,text)
  owner to postgres;
alter function public.mutate_team_inbox_case(text,uuid,uuid,text,text,bigint,bigint,text)
  owner to postgres;

revoke all on function public.is_community_comment_claimed_for_review(uuid)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_community_comment_moderation_target(text,uuid)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.moderate_community_comment(text,uuid,text,bigint,bigint,text,uuid,text)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.mutate_team_inbox_case(text,uuid,uuid,text,text,bigint,bigint,text)
  from public, anon, authenticated, discord_bot, service_role;

grant execute on function public.get_community_comment_moderation_target(text,uuid)
  to service_role;
grant execute on function public.moderate_community_comment(text,uuid,text,bigint,bigint,text,uuid,text)
  to service_role;
grant execute on function public.mutate_team_inbox_case(text,uuid,uuid,text,text,bigint,bigint,text)
  to service_role;

comment on function public.is_community_comment_claimed_for_review(uuid) is
  'Internal fail-closed predicate for an active claimed Comment Report; not directly executable by application roles.';
comment on function public.get_community_comment_moderation_target(text,uuid) is
  'Capability-checked direct Comment moderation target with protected review context and neutral claimed-Case hold state.';
comment on function public.moderate_community_comment(text,uuid,text,bigint,bigint,text,uuid,text) is
  'Idempotent standalone Comment moderation; rejects a direct action while its Comment Report is claimed.';
comment on function public.mutate_team_inbox_case(text,uuid,uuid,text,text,bigint,bigint,text) is
  'Capability-checked Team Inbox Claim/Return/Force release wrapper; Comment Report Claim shares the direct-moderation transaction lock.';

do $postflight$
declare
  v_signature text;
  v_function oid;
begin
  foreach v_signature in array array[
    'public.is_community_comment_claimed_for_review(uuid)',
    'public.get_community_comment_moderation_target(text,uuid)',
    'public.moderate_community_comment(text,uuid,text,bigint,bigint,text,uuid,text)',
    'public.mutate_team_inbox_case(text,uuid,uuid,text,text,bigint,bigint,text)'
  ] loop
    v_function := to_regprocedure(v_signature);
    if v_function is null
      or pg_get_userbyid((select proowner from pg_proc where oid = v_function)) <> 'postgres'
      or not (select prosecdef from pg_proc where oid = v_function)
      or coalesce((select array_to_string(proconfig, ';') from pg_proc where oid = v_function), '')
        not like '%search_path=public, pg_temp%'
      or has_function_privilege('public', v_signature, 'EXECUTE')
      or has_function_privilege('anon', v_signature, 'EXECUTE')
      or has_function_privilege('authenticated', v_signature, 'EXECUTE')
      or has_function_privilege('discord_bot', v_signature, 'EXECUTE')
    then
      raise exception 'COMMUNITY_COMMENT_CLAIMED_REVIEW_HOLD_POSTFLIGHT_FAILED: %', v_signature;
    end if;
  end loop;

  if has_function_privilege(
    'service_role',
    'public.is_community_comment_claimed_for_review(uuid)',
    'EXECUTE'
  )
    or not has_function_privilege(
      'service_role',
      'public.get_community_comment_moderation_target(text,uuid)',
      'EXECUTE'
    )
    or not has_function_privilege(
      'service_role',
      'public.moderate_community_comment(text,uuid,text,bigint,bigint,text,uuid,text)',
      'EXECUTE'
    )
    or not has_function_privilege(
      'service_role',
      'public.mutate_team_inbox_case(text,uuid,uuid,text,text,bigint,bigint,text)',
      'EXECUTE'
    )
  then
    raise exception 'COMMUNITY_COMMENT_CLAIMED_REVIEW_HOLD_ACL_POSTFLIGHT_FAILED';
  end if;

  if (
    select count(*)
    from pg_proc function_row
    join pg_namespace namespace_row on namespace_row.oid = function_row.pronamespace
    where namespace_row.nspname = 'public'
      and function_row.proname in (
        'is_community_comment_claimed_for_review',
        'get_community_comment_moderation_target',
        'moderate_community_comment',
        'mutate_team_inbox_case'
      )
  ) <> 4 then
    raise exception 'COMMUNITY_COMMENT_CLAIMED_REVIEW_HOLD_OVERLOAD_POSTFLIGHT_FAILED';
  end if;
end;
$postflight$;
