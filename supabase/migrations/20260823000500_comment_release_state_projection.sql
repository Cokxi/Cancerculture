begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $preflight$
declare
  v_signature constant text :=
    'public.get_community_comment_thread_page(bigint,text,timestamp with time zone,integer,timestamp with time zone,uuid,integer)';
  v_definition text;
begin
  select pg_get_functiondef(to_regprocedure(v_signature))
  into strict v_definition;

  if (select release_state from public.community_comment_settings where singleton) <> 'off'
    or exists (select 1 from public.community_comment_abuse_policies)
    or exists (select 1 from public.community_comment_threads)
    or exists (select 1 from public.community_comments)
    or v_definition not like '%case when p_sort = ''top'' then 0 end desc%'
    or v_definition like '%''releaseState''%'
    or not exists (
      select 1
      from pg_proc function_row
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
      message = 'COMMUNITY_COMMENT_RELEASE_STATE_PROJECTION_BASELINE_MISMATCH';
  end if;
end;
$preflight$;

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
begin
  if p_submission_id is null or p_submission_id <= 0
    or p_sort not in ('top', 'newest')
    or p_limit is null or p_limit not between 1 and 20
    or v_snapshot_at > v_now
    or (
      (p_after_created_at is null) <> (p_after_public_comment_id is null)
    )
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

  with candidates as (
    select comment_row.id,
      comment_row.created_at,
      comment_row.public_comment_id,
      0::integer as net_score
    from public.community_comments comment_row
    where comment_row.thread_id = v_thread.id
      and comment_row.root_comment_id is null
      and comment_row.created_at <= v_snapshot_at
      and (
        p_after_created_at is null
        or (
          p_sort = 'top'
          and (
            0 < p_after_score
            or (0 = p_after_score and comment_row.created_at < p_after_created_at)
            or (
              0 = p_after_score
              and comment_row.created_at = p_after_created_at
              and comment_row.public_comment_id < p_after_public_comment_id
            )
          )
        )
        or (
          p_sort = 'newest'
          and (
            comment_row.created_at < p_after_created_at
            or (
              comment_row.created_at = p_after_created_at
              and comment_row.public_comment_id < p_after_public_comment_id
            )
          )
        )
      )
    order by
      case when p_sort = 'top' then 0 end desc,
      comment_row.created_at desc,
      comment_row.public_comment_id desc
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
        'netScore', case when p_sort = 'top' then 0 else null end,
        'createdAt', v_last.created_at,
        'publicCommentId', v_last.public_comment_id
      )
      else null
    end
  );
end;
$function$;

alter function public.get_community_comment_thread_page(bigint,text,timestamp with time zone,integer,timestamp with time zone,uuid,integer)
  owner to postgres;
revoke all on function public.get_community_comment_thread_page(bigint,text,timestamp with time zone,integer,timestamp with time zone,uuid,integer)
  from public, anon, authenticated, discord_bot, service_role;
grant execute on function public.get_community_comment_thread_page(bigint,text,timestamp with time zone,integer,timestamp with time zone,uuid,integer)
  to service_role;

do $postflight$
declare
  v_signature constant text :=
    'public.get_community_comment_thread_page(bigint,text,timestamp with time zone,integer,timestamp with time zone,uuid,integer)';
  v_definition text;
begin
  select pg_get_functiondef(to_regprocedure(v_signature))
  into strict v_definition;

  if (select release_state from public.community_comment_settings where singleton) <> 'off'
    or v_definition not like '%v_release_state text := public.get_community_comment_release_state()%'
    or (
      length(v_definition) - length(replace(v_definition, '''releaseState''', ''))
    ) / length('''releaseState''') <> 2
    or v_definition not like '%case when p_sort = ''top'' then 0 end desc%'
    or not exists (
      select 1
      from pg_proc function_row
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
      message = 'COMMUNITY_COMMENT_RELEASE_STATE_PROJECTION_POSTFLIGHT_MISMATCH';
  end if;
end;
$postflight$;

comment on function public.get_community_comment_thread_page(bigint,text,timestamp with time zone,integer,timestamp with time zone,uuid,integer) is
  'Returns one snapshot-bound Top or Newest Root page with the server-authoritative read_only or open release state.';

commit;
