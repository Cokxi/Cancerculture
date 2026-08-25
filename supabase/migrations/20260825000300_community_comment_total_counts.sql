do $preflight$
begin
  if to_regprocedure(
    'public.get_community_comment_thread_page(bigint,text,timestamp with time zone,integer,timestamp with time zone,uuid,integer)'
  ) is null
    or to_regprocedure('public.get_community_comment_thread_page_v2(bigint,text,timestamp with time zone,integer,timestamp with time zone,uuid,integer)') is not null
    or to_regprocedure('public.get_community_comment_counts(bigint[])') is not null
    or to_regclass('public.community_comments') is null
  then
    raise exception 'COMMUNITY_COMMENT_TOTAL_COUNTS_PREFLIGHT_FAILED';
  end if;
end;
$preflight$;

create function public.get_community_comment_thread_page_v2(
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
  v_page jsonb;
  v_snapshot_at timestamptz;
  v_total_count bigint;
begin
  v_page := public.get_community_comment_thread_page(
    p_submission_id,
    p_sort,
    p_snapshot_at,
    p_after_score,
    p_after_created_at,
    p_after_public_comment_id,
    p_limit
  );

  if v_page ->> 'outcome' <> 'ok' then
    return v_page;
  end if;

  v_snapshot_at := (v_page ->> 'snapshotAt')::timestamptz;

  select count(*)
  into v_total_count
  from public.community_comments comment_row
  where comment_row.submission_id = p_submission_id
    and comment_row.created_at <= v_snapshot_at;

  return v_page || jsonb_build_object('totalCount', v_total_count);
end;
$function$;

create function public.get_community_comment_counts(
  p_submission_ids bigint[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_items jsonb;
begin
  if p_submission_ids is null
    or cardinality(p_submission_ids) not between 1 and 100
    or exists (
      select 1
      from unnest(p_submission_ids) submission_id
      where submission_id is null or submission_id <= 0
    )
    or (
      select count(distinct submission_id)
      from unnest(p_submission_ids) submission_id
    ) <> cardinality(p_submission_ids)
  then
    raise exception using
      errcode = '22023',
      message = 'COMMUNITY_COMMENT_COUNT_BATCH_INPUT_INVALID';
  end if;

  if public.get_community_comment_release_state() = 'off' then
    return jsonb_build_object('outcome', 'feature_off');
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'submissionId', counted.submission_id,
        'totalCount', counted.total_count
      )
      order by counted.ordinality
    ),
    '[]'::jsonb
  )
  into v_items
  from (
    select
      requested.submission_id,
      requested.ordinality,
      count(comment_row.id)::bigint as total_count
    from unnest(p_submission_ids) with ordinality
      requested(submission_id, ordinality)
    left join public.community_comments comment_row
      on comment_row.submission_id = requested.submission_id
    where public.is_community_comment_submission_eligible(
      requested.submission_id
    )
    group by requested.submission_id, requested.ordinality
  ) counted;

  return jsonb_build_object('outcome', 'ok', 'items', v_items);
end;
$function$;

alter function public.get_community_comment_thread_page_v2(bigint,text,timestamp with time zone,integer,timestamp with time zone,uuid,integer)
  owner to postgres;
alter function public.get_community_comment_counts(bigint[])
  owner to postgres;

revoke all on function public.get_community_comment_thread_page_v2(bigint,text,timestamp with time zone,integer,timestamp with time zone,uuid,integer)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_community_comment_counts(bigint[])
  from public, anon, authenticated, discord_bot, service_role;

grant execute on function public.get_community_comment_thread_page_v2(bigint,text,timestamp with time zone,integer,timestamp with time zone,uuid,integer)
  to service_role;
grant execute on function public.get_community_comment_counts(bigint[])
  to service_role;

comment on function public.get_community_comment_thread_page_v2(bigint,text,timestamp with time zone,integer,timestamp with time zone,uuid,integer) is
  'Service-only canonical Comment Root page with a snapshot-bound Roots-plus-Replies total.';
comment on function public.get_community_comment_counts(bigint[]) is
  'Service-only bounded public-eligibility-safe Roots-plus-Replies totals for shared Comment disclosures.';

do $postflight$
declare
  v_signature text;
  v_function oid;
begin
  foreach v_signature in array array[
    'public.get_community_comment_thread_page_v2(bigint,text,timestamp with time zone,integer,timestamp with time zone,uuid,integer)',
    'public.get_community_comment_counts(bigint[])'
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
      or not has_function_privilege('service_role', v_signature, 'EXECUTE')
    then
      raise exception 'COMMUNITY_COMMENT_TOTAL_COUNTS_POSTFLIGHT_FAILED: %', v_signature;
    end if;
  end loop;

  if (
    select count(*)
    from pg_proc function_row
    join pg_namespace namespace_row on namespace_row.oid = function_row.pronamespace
    where namespace_row.nspname = 'public'
      and function_row.proname in (
        'get_community_comment_thread_page_v2',
        'get_community_comment_counts'
      )
  ) <> 2 then
    raise exception 'COMMUNITY_COMMENT_TOTAL_COUNTS_OVERLOAD_POSTFLIGHT_FAILED';
  end if;
end;
$postflight$;
