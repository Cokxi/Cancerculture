\set ON_ERROR_STOP on

begin read only;

do $postflight$
declare
  v_signature text;
  v_table text;
  v_service text[] := array[
    'public.get_community_comment_vote_viewer_state(uuid,uuid[])',
    'public.set_community_comment_vote(uuid,uuid,text,bigint,uuid,text,boolean)'
  ];
  v_internal text[] := array[
    'public.get_community_comment_vote_counts_json(uuid)',
    'public.get_community_comment_vote_score_at(uuid,timestamp with time zone)',
    'public.get_community_comment_vote_projection(uuid,text)',
    'public.resolve_community_comment_vote_replay(text,uuid,text)'
  ];
  v_tables text[] := array[
    'community_comment_votes',
    'community_comment_vote_transitions',
    'community_comment_vote_requests'
  ];
begin
  if (select release_state from public.community_comment_settings where singleton) <> 'off'
    or (select version from public.community_comment_settings where singleton) <> 1
    or exists (select 1 from public.community_comment_abuse_policies)
    or exists (select 1 from public.community_comment_threads)
    or exists (select 1 from public.community_comments)
    or exists (select 1 from public.community_comment_votes)
    or exists (select 1 from public.community_comment_vote_transitions)
    or exists (select 1 from public.community_comment_vote_requests)
  then
    raise exception 'ATOMIC_COMMENT_VOTES_DEV_POSTFLIGHT_STATE_DRIFT';
  end if;

  foreach v_table in array v_tables loop
    if not exists (
      select 1 from pg_class table_row
      where table_row.oid = format('public.%I', v_table)::regclass
        and table_row.relrowsecurity
        and pg_get_userbyid(table_row.relowner) = 'postgres'
    ) or exists (
      select 1 from pg_policy policy
      where policy.polrelid = format('public.%I', v_table)::regclass
    ) or has_table_privilege('anon', format('public.%I', v_table), 'SELECT')
      or has_table_privilege('authenticated', format('public.%I', v_table), 'SELECT')
      or has_table_privilege('discord_bot', format('public.%I', v_table), 'SELECT')
      or has_table_privilege('service_role', format('public.%I', v_table), 'SELECT')
      or has_table_privilege('service_role', format('public.%I', v_table), 'INSERT')
      or has_table_privilege('service_role', format('public.%I', v_table), 'UPDATE')
      or has_table_privilege('service_role', format('public.%I', v_table), 'DELETE')
    then
      raise exception 'ATOMIC_COMMENT_VOTES_DEV_POSTFLIGHT_TABLE_MISMATCH: %', v_table;
    end if;
  end loop;

  foreach v_signature in array v_service loop
    if not exists (
      select 1 from pg_proc function_row
      where function_row.oid = to_regprocedure(v_signature)
        and pg_get_userbyid(function_row.proowner) = 'postgres'
        and function_row.prosecdef
        and function_row.proconfig @> array['search_path=public, pg_temp']
    ) or has_function_privilege('anon', v_signature, 'EXECUTE')
      or has_function_privilege('authenticated', v_signature, 'EXECUTE')
      or has_function_privilege('discord_bot', v_signature, 'EXECUTE')
      or not has_function_privilege('service_role', v_signature, 'EXECUTE')
    then
      raise exception 'ATOMIC_COMMENT_VOTES_DEV_POSTFLIGHT_SERVICE_ACL_MISMATCH: %', v_signature;
    end if;
  end loop;

  foreach v_signature in array v_internal loop
    if not exists (
      select 1 from pg_proc function_row
      where function_row.oid = to_regprocedure(v_signature)
        and pg_get_userbyid(function_row.proowner) = 'postgres'
        and function_row.prosecdef
        and function_row.proconfig @> array['search_path=public, pg_temp']
    ) or has_function_privilege('anon', v_signature, 'EXECUTE')
      or has_function_privilege('authenticated', v_signature, 'EXECUTE')
      or has_function_privilege('discord_bot', v_signature, 'EXECUTE')
      or has_function_privilege('service_role', v_signature, 'EXECUTE')
    then
      raise exception 'ATOMIC_COMMENT_VOTES_DEV_POSTFLIGHT_INTERNAL_ACL_MISMATCH: %', v_signature;
    end if;
  end loop;

  if (
    select count(*) from pg_proc function_row
    join pg_namespace namespace on namespace.oid = function_row.pronamespace
    where namespace.nspname = 'public'
      and function_row.proname in (
        'set_community_comment_vote',
        'get_community_comment_vote_viewer_state'
      )
  ) <> 2 then
    raise exception 'ATOMIC_COMMENT_VOTES_DEV_POSTFLIGHT_OVERLOAD_MISMATCH';
  end if;

  if pg_get_functiondef(
      'public.get_community_comment_thread_page(bigint,text,timestamp with time zone,integer,timestamp with time zone,uuid,integer)'::regprocedure
    ) not like '%get_community_comment_vote_score_at%'
    or pg_get_functiondef(
      'public.set_community_comment_vote(uuid,uuid,text,bigint,uuid,text,boolean)'::regprocedure
    ) not like '%community-comment-vote:%'
    or pg_get_functiondef(
      'public.get_community_comment_vote_viewer_state(uuid,uuid[])'::regprocedure
    ) not like '%cardinality(p_public_comment_ids) > 100%'
  then
    raise exception 'ATOMIC_COMMENT_VOTES_DEV_POSTFLIGHT_DEFINITION_MISMATCH';
  end if;

  if not exists (
    select 1 from pg_constraint constraint_row
    where constraint_row.conrelid = 'public.community_comment_abuse_policies'::regclass
      and constraint_row.conname = 'community_comment_abuse_policies_action_check'
      and pg_get_constraintdef(constraint_row.oid) like '%''vote''%'
  ) or has_sequence_privilege(
    'service_role', 'public.community_comment_vote_transitions_id_seq', 'USAGE'
  ) then
    raise exception 'ATOMIC_COMMENT_VOTES_DEV_POSTFLIGHT_ABUSE_OR_SEQUENCE_MISMATCH';
  end if;
end;
$postflight$;

rollback;
