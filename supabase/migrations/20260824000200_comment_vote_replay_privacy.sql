begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $preflight$
declare
  v_signature constant text :=
    'public.resolve_community_comment_vote_replay(text,uuid,text)';
  v_definition text;
begin
  select pg_get_functiondef(to_regprocedure(v_signature))
  into strict v_definition;

  if (select release_state from public.community_comment_settings where singleton) <> 'off'
    or (select version from public.community_comment_settings where singleton) <> 1
    or exists (select 1 from public.community_comment_abuse_policies)
    or exists (select 1 from public.community_comment_threads)
    or exists (select 1 from public.community_comments)
    or exists (select 1 from public.community_comment_votes)
    or exists (select 1 from public.community_comment_vote_transitions)
    or exists (select 1 from public.community_comment_vote_requests)
    or v_definition like '%author_deleted_at is not null%'
    or v_definition like '%is_community_comment_submission_eligible%'
    or not exists (
      select 1 from pg_proc function_row
      where function_row.oid = to_regprocedure(v_signature)
        and pg_get_userbyid(function_row.proowner) = 'postgres'
        and function_row.prosecdef
        and function_row.proconfig @> array['search_path=public, pg_temp']
    )
    or has_function_privilege('public', v_signature, 'EXECUTE')
    or has_function_privilege('anon', v_signature, 'EXECUTE')
    or has_function_privilege('authenticated', v_signature, 'EXECUTE')
    or has_function_privilege('discord_bot', v_signature, 'EXECUTE')
    or has_function_privilege('service_role', v_signature, 'EXECUTE')
  then
    raise exception using
      errcode = '55000',
      message = 'COMMENT_VOTE_REPLAY_PRIVACY_BASELINE_MISMATCH';
  end if;
end;
$preflight$;

create or replace function public.resolve_community_comment_vote_replay(
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
  v_comment public.community_comments%rowtype;
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

  select * into v_comment
  from public.community_comments comment_row
  where comment_row.id = v_request.comment_id;
  if not found
    or v_comment.author_deleted_at is not null
    or not public.is_community_comment_submission_eligible(v_comment.submission_id)
  then
    return jsonb_build_object('outcome', 'comment_unavailable');
  end if;

  return v_request.receipt || jsonb_build_object('replayed', true);
end;
$function$;

alter function public.resolve_community_comment_vote_replay(text,uuid,text)
  owner to postgres;
revoke all on function public.resolve_community_comment_vote_replay(text,uuid,text)
  from public, anon, authenticated, discord_bot, service_role;

do $postflight$
declare
  v_signature constant text :=
    'public.resolve_community_comment_vote_replay(text,uuid,text)';
  v_definition text;
begin
  select pg_get_functiondef(to_regprocedure(v_signature))
  into strict v_definition;

  if v_definition not like '%v_comment.author_deleted_at is not null%'
    or v_definition not like '%is_community_comment_submission_eligible(v_comment.submission_id)%'
    or not exists (
      select 1 from pg_proc function_row
      where function_row.oid = to_regprocedure(v_signature)
        and pg_get_userbyid(function_row.proowner) = 'postgres'
        and function_row.prosecdef
        and function_row.proconfig @> array['search_path=public, pg_temp']
    )
    or has_function_privilege('public', v_signature, 'EXECUTE')
    or has_function_privilege('anon', v_signature, 'EXECUTE')
    or has_function_privilege('authenticated', v_signature, 'EXECUTE')
    or has_function_privilege('discord_bot', v_signature, 'EXECUTE')
    or has_function_privilege('service_role', v_signature, 'EXECUTE')
    or (
      select count(*) from pg_proc function_row
      join pg_namespace namespace on namespace.oid = function_row.pronamespace
      where namespace.nspname = 'public'
        and function_row.proname = 'resolve_community_comment_vote_replay'
    ) <> 1
    or (select release_state from public.community_comment_settings where singleton) <> 'off'
    or (select version from public.community_comment_settings where singleton) <> 1
    or exists (select 1 from public.community_comment_abuse_policies)
    or exists (select 1 from public.community_comment_threads)
    or exists (select 1 from public.community_comments)
    or exists (select 1 from public.community_comment_votes)
    or exists (select 1 from public.community_comment_vote_transitions)
    or exists (select 1 from public.community_comment_vote_requests)
  then
    raise exception using
      errcode = '55000',
      message = 'COMMENT_VOTE_REPLAY_PRIVACY_POSTFLIGHT_MISMATCH';
  end if;
end;
$postflight$;

comment on function public.resolve_community_comment_vote_replay(text,uuid,text) is
  'Returns a stable matching Vote receipt only while the Comment and Submission remain publicly eligible; tombstones and unavailable Submissions fail closed without Vote data.';

commit;
