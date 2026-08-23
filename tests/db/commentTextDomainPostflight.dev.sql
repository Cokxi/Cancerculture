\set ON_ERROR_STOP on

begin read only;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $postflight$
declare
  v_table text;
  v_signature text;
  v_definition text;
  v_tables text[] := array[
    'community_comment_settings',
    'community_comment_threads',
    'community_comments',
    'community_comment_text_versions',
    'community_comment_mention_lifecycle',
    'community_comment_mentions',
    'community_comment_mutation_events',
    'community_comment_mutation_requests',
    'community_comment_abuse_policies',
    'community_comment_abuse_buckets',
    'community_comment_abuse_events'
  ];
  v_service text[] := array[
    'public.get_community_comment_thread_page(bigint,text,timestamp with time zone,integer,timestamp with time zone,uuid,integer)',
    'public.get_community_comment_replies(uuid,timestamp with time zone,timestamp with time zone,uuid,integer)',
    'public.get_community_comment_deep_link(uuid)',
    'public.get_community_comments_batch(uuid[])',
    'public.search_community_comment_mention_targets(uuid,text,integer)',
    'public.create_community_comment_root(uuid,bigint,bigint,text,jsonb,uuid,text,boolean)',
    'public.create_community_comment_reply(uuid,uuid,uuid,bigint,bigint,text,jsonb,uuid,text,boolean)',
    'public.edit_community_comment(uuid,uuid,bigint,text,jsonb,uuid,text,boolean)',
    'public.delete_community_comment(uuid,uuid,bigint,uuid,boolean)'
  ];
  v_internal_definer text[] := array[
    'public.get_community_comment_release_state()',
    'public.is_community_comment_submission_eligible(bigint)',
    'public.apply_community_comment_abuse_budget(text,text,bigint,text,boolean,timestamp with time zone)',
    'public.mark_community_comment_rejected_input(text,text,bigint,timestamp with time zone)',
    'public.build_community_comment_public_json(uuid)',
    'public.resolve_community_comment_replay(text,uuid,text,text)'
  ];
  v_internal_invoker text[] := array[
    'public.protect_community_comment_append_only()',
    'public.protect_community_comment_identity()',
    'public.validate_community_comment_body(text)',
    'public.replace_community_comment_mentions(uuid,bigint,text,jsonb,timestamp with time zone)'
  ];
begin
  if (select release_state from public.community_comment_settings where singleton) <> 'off'
    or exists (select 1 from public.community_comment_abuse_policies)
    or exists (select 1 from public.community_comment_threads)
    or exists (select 1 from public.community_comments)
  then
    raise exception 'COMMUNITY_COMMENTS_DEV_POSTFLIGHT_STATE_DRIFT';
  end if;

  foreach v_table in array v_tables loop
    if not exists (
      select 1 from pg_class table_row
      where table_row.oid = format('public.%I', v_table)::regclass
        and table_row.relrowsecurity
        and pg_get_userbyid(table_row.relowner) = 'postgres'
    )
      or exists (
        select 1 from pg_policy policy
        where policy.polrelid = format('public.%I', v_table)::regclass
      )
      or has_table_privilege('anon', format('public.%I', v_table), 'SELECT')
      or has_table_privilege('authenticated', format('public.%I', v_table), 'SELECT')
      or has_table_privilege('discord_bot', format('public.%I', v_table), 'SELECT')
      or has_table_privilege('service_role', format('public.%I', v_table), 'SELECT')
      or has_table_privilege('service_role', format('public.%I', v_table), 'INSERT')
      or has_table_privilege('service_role', format('public.%I', v_table), 'UPDATE')
      or has_table_privilege('service_role', format('public.%I', v_table), 'DELETE')
    then
      raise exception 'COMMUNITY_COMMENTS_DEV_POSTFLIGHT_TABLE_MISMATCH: %', v_table;
    end if;
  end loop;

  foreach v_signature in array v_service loop
    if not exists (
      select 1 from pg_proc function_row
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
      raise exception 'COMMUNITY_COMMENTS_DEV_POSTFLIGHT_SERVICE_ACL_MISMATCH: %', v_signature;
    end if;
  end loop;

  foreach v_signature in array v_internal_definer loop
    if not exists (
      select 1 from pg_proc function_row
      where function_row.oid = to_regprocedure(v_signature)
        and pg_get_userbyid(function_row.proowner) = 'postgres'
        and function_row.prosecdef
        and function_row.proconfig @> array['search_path=public, pg_temp']
    )
      or has_function_privilege('anon', v_signature, 'EXECUTE')
      or has_function_privilege('authenticated', v_signature, 'EXECUTE')
      or has_function_privilege('discord_bot', v_signature, 'EXECUTE')
      or has_function_privilege('service_role', v_signature, 'EXECUTE')
    then
      raise exception 'COMMUNITY_COMMENTS_DEV_POSTFLIGHT_INTERNAL_ACL_MISMATCH: %', v_signature;
    end if;
  end loop;

  foreach v_signature in array v_internal_invoker loop
    if not exists (
      select 1 from pg_proc function_row
      where function_row.oid = to_regprocedure(v_signature)
        and pg_get_userbyid(function_row.proowner) = 'postgres'
        and not function_row.prosecdef
        and function_row.proconfig @> array['search_path=public, pg_temp']
    )
      or has_function_privilege('anon', v_signature, 'EXECUTE')
      or has_function_privilege('authenticated', v_signature, 'EXECUTE')
      or has_function_privilege('discord_bot', v_signature, 'EXECUTE')
      or has_function_privilege('service_role', v_signature, 'EXECUTE')
    then
      raise exception 'COMMUNITY_COMMENTS_DEV_POSTFLIGHT_INVOKER_ACL_MISMATCH: %', v_signature;
    end if;
  end loop;

  if (
    select count(*)
    from pg_proc function_row
    join pg_namespace namespace on namespace.oid = function_row.pronamespace
    where namespace.nspname = 'public'
      and function_row.proname like '%community_comment%'
  ) <> cardinality(v_service || v_internal_definer || v_internal_invoker)
  then
    raise exception 'COMMUNITY_COMMENTS_DEV_POSTFLIGHT_OVERLOAD_MISMATCH';
  end if;

  foreach v_signature in array array[
    'public.create_community_comment_root(uuid,bigint,bigint,text,jsonb,uuid,text,boolean)',
    'public.create_community_comment_reply(uuid,uuid,uuid,bigint,bigint,text,jsonb,uuid,text,boolean)',
    'public.edit_community_comment(uuid,uuid,bigint,text,jsonb,uuid,text,boolean)',
    'public.delete_community_comment(uuid,uuid,bigint,uuid,boolean)'
  ] loop
    select pg_get_functiondef(to_regprocedure(v_signature)) into strict v_definition;
    if position('extensions.digest(' in v_definition) = 0 then
      raise exception 'COMMUNITY_COMMENTS_DEV_POSTFLIGHT_DIGEST_MISMATCH: %', v_signature;
    end if;
  end loop;

  select pg_get_functiondef(
    'public.get_community_comment_thread_page(bigint,text,timestamp with time zone,integer,timestamp with time zone,uuid,integer)'::regprocedure
  ) into strict v_definition;
  if position('case when p_sort = ''top'' then net_score end desc' in v_definition) > 0
    or position('case when p_sort = ''top'' then 0 end desc' in v_definition) = 0
  then
    raise exception 'COMMUNITY_COMMENTS_DEV_POSTFLIGHT_TOP_SORT_MISMATCH';
  end if;
end;
$postflight$;

rollback;
