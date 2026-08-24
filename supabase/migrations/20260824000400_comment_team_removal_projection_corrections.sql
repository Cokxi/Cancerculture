begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $preflight$
begin
  if (select count(*) from public.capability_catalog) <> 49
    or (select count(*) from public.capability_catalog where is_active) <> 45
    or not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'community_comments'
        and column_name = 'team_removed_at'
    )
    or to_regprocedure('public.get_community_comment_replies(uuid,timestamp with time zone,timestamp with time zone,uuid,integer)') is null
    or to_regprocedure('public.set_community_comment_vote(uuid,uuid,text,bigint,uuid,text,boolean)') is null
    or to_regprocedure('public.set_community_comment_vote_v1(uuid,uuid,text,bigint,uuid,text,boolean)') is not null
  then
    raise exception using errcode = '55000', message = 'COMMENT_TEAM_REMOVAL_CORRECTION_BASELINE_MISMATCH';
  end if;
end;
$preflight$;

create or replace function public.get_community_comment_replies(
  p_root_public_comment_id uuid,
  p_snapshot_at timestamptz,
  p_before_created_at timestamptz,
  p_before_public_comment_id uuid,
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
  v_root public.community_comments%rowtype;
  v_ids uuid[];
  v_page_ids uuid[];
  v_items jsonb := '[]'::jsonb;
  v_has_more boolean := false;
  v_earliest public.community_comments%rowtype;
begin
  if p_root_public_comment_id is null
    or p_limit is null or p_limit not between 1 and 20
    or v_snapshot_at > v_now
    or ((p_before_created_at is null) <> (p_before_public_comment_id is null))
  then
    raise exception using errcode = '22023', message = 'COMMUNITY_COMMENT_REPLY_PAGE_INPUT_INVALID';
  end if;
  if public.get_community_comment_release_state() = 'off' then
    return jsonb_build_object('outcome', 'feature_off');
  end if;
  select * into v_root from public.community_comments comment_row
  where comment_row.public_comment_id = p_root_public_comment_id
    and comment_row.root_comment_id is null;
  if not found or not public.is_community_comment_submission_eligible(v_root.submission_id) then
    return jsonb_build_object('outcome', 'comment_unavailable');
  end if;
  select array_agg(reply.id order by reply.created_at desc, reply.public_comment_id desc)
  into v_ids
  from (
    select comment_row.id, comment_row.created_at, comment_row.public_comment_id
    from public.community_comments comment_row
    where comment_row.root_comment_id = v_root.id
      and comment_row.created_at <= v_snapshot_at
      and (p_before_created_at is null
        or comment_row.created_at < p_before_created_at
        or (comment_row.created_at = p_before_created_at
          and comment_row.public_comment_id < p_before_public_comment_id))
    order by comment_row.created_at desc, comment_row.public_comment_id desc
    limit p_limit + 1
  ) reply;
  v_has_more := coalesce(cardinality(v_ids), 0) > p_limit;
  v_page_ids := case when v_ids is null then array[]::uuid[]
    else v_ids[1:least(cardinality(v_ids), p_limit)] end;
  select coalesce(jsonb_agg(
    public.build_community_comment_public_json(reply.id)
    order by reply.created_at, reply.public_comment_id
  ), '[]'::jsonb)
  into v_items from public.community_comments reply where reply.id = any(v_page_ids);
  if cardinality(v_page_ids) > 0 then
    select * into v_earliest from public.community_comments reply
    where reply.id = v_page_ids[cardinality(v_page_ids)];
  end if;
  return jsonb_build_object(
    'outcome', 'ok', 'submissionId', v_root.submission_id,
    'rootPublicCommentId', v_root.public_comment_id,
    'rootVersion', v_root.object_version,
    'branchOpen', v_root.author_deleted_at is null and v_root.team_removed_at is null,
    'snapshotAt', v_snapshot_at, 'items', v_items, 'hasMore', v_has_more,
    'nextTuple', case when v_has_more and v_earliest.id is not null then
      jsonb_build_object('createdAt', v_earliest.created_at,
        'publicCommentId', v_earliest.public_comment_id)
      else null end
  );
end;
$function$;

alter function public.set_community_comment_vote(uuid,uuid,text,bigint,uuid,text,boolean)
  rename to set_community_comment_vote_v1;
revoke all on function public.set_community_comment_vote_v1(uuid,uuid,text,bigint,uuid,text,boolean)
  from public, anon, authenticated, discord_bot, service_role;

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
begin
  if exists (
    select 1 from public.community_comments comment_row
    where comment_row.public_comment_id = p_public_comment_id
      and comment_row.team_removed_at is not null
  ) then
    return jsonb_build_object('outcome', 'comment_unavailable');
  end if;
  return public.set_community_comment_vote_v1(
    p_session_id, p_public_comment_id, p_desired_state, p_expected_version,
    p_request_id, p_content_digest, p_turnstile_verified
  );
end;
$function$;

alter function public.get_community_comment_replies(uuid,timestamptz,timestamptz,uuid,integer)
  owner to postgres;
alter function public.set_community_comment_vote(uuid,uuid,text,bigint,uuid,text,boolean)
  owner to postgres;
revoke all on function public.get_community_comment_replies(uuid,timestamptz,timestamptz,uuid,integer)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.set_community_comment_vote(uuid,uuid,text,bigint,uuid,text,boolean)
  from public, anon, authenticated, discord_bot, service_role;
grant execute on function public.get_community_comment_replies(uuid,timestamptz,timestamptz,uuid,integer)
  to service_role;
grant execute on function public.set_community_comment_vote(uuid,uuid,text,bigint,uuid,text,boolean)
  to service_role;

do $postflight$
declare
  v_replies text := pg_get_functiondef(to_regprocedure(
    'public.get_community_comment_replies(uuid,timestamp with time zone,timestamp with time zone,uuid,integer)'
  ));
  v_vote text := pg_get_functiondef(to_regprocedure(
    'public.set_community_comment_vote(uuid,uuid,text,bigint,uuid,text,boolean)'
  ));
begin
  if v_replies not like '%v_root.team_removed_at is null%'
    or v_vote not like '%comment_row.team_removed_at is not null%'
    or has_function_privilege('public', 'public.set_community_comment_vote(uuid,uuid,text,bigint,uuid,text,boolean)', 'EXECUTE')
    or has_function_privilege('anon', 'public.set_community_comment_vote(uuid,uuid,text,bigint,uuid,text,boolean)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.set_community_comment_vote(uuid,uuid,text,bigint,uuid,text,boolean)', 'EXECUTE')
    or has_function_privilege('discord_bot', 'public.set_community_comment_vote(uuid,uuid,text,bigint,uuid,text,boolean)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.set_community_comment_vote(uuid,uuid,text,bigint,uuid,text,boolean)', 'EXECUTE')
    or has_function_privilege('service_role', 'public.set_community_comment_vote_v1(uuid,uuid,text,bigint,uuid,text,boolean)', 'EXECUTE')
  then
    raise exception using errcode = '55000', message = 'COMMENT_TEAM_REMOVAL_CORRECTION_POSTFLIGHT_MISMATCH';
  end if;
end;
$postflight$;

comment on function public.get_community_comment_replies(uuid,timestamptz,timestamptz,uuid,integer) is
  'Returns paginated Replies and reports a Root branch closed after either author deletion or Team removal.';
comment on function public.set_community_comment_vote(uuid,uuid,text,bigint,uuid,text,boolean) is
  'Fail-closed Team-removal wrapper around the accepted atomic Comment Vote mutation.';

commit;
