begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $correction$
declare
  v_signature constant text :=
    'public.get_community_comment_thread_page(bigint,text,timestamp with time zone,integer,timestamp with time zone,uuid,integer)';
  v_invalid constant text :=
    'case when p_sort = ''top'' then net_score end desc';
  v_valid constant text :=
    'case when p_sort = ''top'' then 0 end desc';
  v_definition text;
begin
  if to_regprocedure(v_signature) is null
    or (select release_state from public.community_comment_settings where singleton) <> 'off'
    or exists (select 1 from public.community_comment_abuse_policies)
    or exists (select 1 from public.community_comment_threads)
    or exists (select 1 from public.community_comments)
    or not exists (
      select 1
      from pg_proc function_row
      where function_row.oid = to_regprocedure(v_signature)
        and pg_get_userbyid(function_row.proowner) = 'postgres'
        and function_row.prosecdef
        and function_row.proconfig @> array['search_path=public, pg_temp']
    )
  then
    raise exception using
      errcode = '55000',
      message = 'COMMUNITY_COMMENT_TOP_ALIAS_CORRECTION_BASELINE_MISMATCH';
  end if;

  select pg_get_functiondef(to_regprocedure(v_signature))
  into strict v_definition;

  if (
      length(v_definition) - length(replace(v_definition, v_invalid, ''))
    ) / length(v_invalid) <> 1
    or v_definition like '%' || v_valid || '%'
  then
    raise exception using
      errcode = '55000',
      message = 'COMMUNITY_COMMENT_TOP_ALIAS_CORRECTION_DEFINITION_MISMATCH';
  end if;

  execute replace(v_definition, v_invalid, v_valid);
end;
$correction$;

do $postflight$
declare
  v_signature constant text :=
    'public.get_community_comment_thread_page(bigint,text,timestamp with time zone,integer,timestamp with time zone,uuid,integer)';
  v_invalid constant text :=
    'case when p_sort = ''top'' then net_score end desc';
  v_valid constant text :=
    'case when p_sort = ''top'' then 0 end desc';
  v_definition text;
begin
  select pg_get_functiondef(to_regprocedure(v_signature))
  into strict v_definition;

  if v_definition like '%' || v_invalid || '%'
    or (
      length(v_definition) - length(replace(v_definition, v_valid, ''))
    ) / length(v_valid) <> 1
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
    or (
      select count(*)
      from pg_proc function_row
      join pg_namespace namespace on namespace.oid = function_row.pronamespace
      where namespace.nspname = 'public'
        and function_row.proname = 'get_community_comment_thread_page'
    ) <> 1
    or (select release_state from public.community_comment_settings where singleton) <> 'off'
    or exists (select 1 from public.community_comment_abuse_policies)
    or exists (select 1 from public.community_comment_threads)
    or exists (select 1 from public.community_comments)
  then
    raise exception using
      errcode = '55000',
      message = 'COMMUNITY_COMMENT_TOP_ALIAS_CORRECTION_POSTFLIGHT_MISMATCH';
  end if;
end;
$postflight$;

comment on function public.get_community_comment_thread_page(bigint,text,timestamp with time zone,integer,timestamp with time zone,uuid,integer) is
  'Returns one snapshot-bound Top or Newest Root page without relying on an output alias inside the Top sort expression.';

commit;
