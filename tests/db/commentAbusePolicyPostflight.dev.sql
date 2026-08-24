\set ON_ERROR_STOP on

begin read only;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $postflight$
declare
  v_table text;
  v_signature text;
  v_tables text[] := array[
    'community_comment_abuse_policy_states',
    'community_comment_spam_policy_state',
    'community_comment_policy_requests',
    'community_comment_policy_events',
    'community_comment_release_state_events'
  ];
  v_service text[] := array[
    'public.get_community_comment_policy_management(uuid)',
    'public.manage_community_comment_release_state(uuid,text,bigint,uuid)',
    'public.manage_community_comment_abuse_policy(uuid,text,bigint,boolean,integer,integer,integer,integer,uuid)',
    'public.manage_community_comment_spam_policy(uuid,bigint,boolean,integer,integer,bigint,jsonb,uuid)',
    'public.submit_community_comment_report(uuid,uuid,text,text,uuid,text,boolean,boolean)'
  ];
  v_internal text[] := array[
    'public.require_community_comment_owner_session(uuid)',
    'public.apply_community_comment_abuse_budget(text,text,bigint,text,boolean,timestamp with time zone)',
    'public.mark_community_comment_rejected_input(text,text,bigint,timestamp with time zone)',
    'public.open_or_update_community_comment_spam_case()',
    'public.attach_community_comment_spam_reference()',
    'public.attach_community_comment_report_spam_reference()'
  ];
begin
  if (select release_state from public.community_comment_settings where singleton) <> 'off'
    or (select count(*) from public.community_comment_abuse_policy_states) <> 5
    or exists (
      select 1 from public.community_comment_abuse_policy_states
      where active_policy_version is not null
    )
    or (select count(*) from public.community_comment_spam_policy_state) <> 1
    or exists (
      select 1 from public.community_comment_spam_policy_state
      where active_policy_version is not null
    )
    or (select count(*) from public.capability_catalog) <> 49
    or (select count(*) from public.capability_catalog where is_active) <> 45
    or exists (
      select 1 from public.team_role_capabilities grant_row
      where grant_row.capability_key = any(array[
        'community.comment_reports.view', 'community.comment_reports.review',
        'community.comments.moderate', 'community.comment_spam.view',
        'community.comment_spam.review', 'logs.community_comment_moderation.view'
      ]::text[])
    )
  then
    raise exception 'COMMENT_ABUSE_POLICY_DEV_POSTFLIGHT_STATE_DRIFT';
  end if;

  foreach v_table in array v_tables loop
    if not exists (
      select 1 from pg_class table_row
      where table_row.oid = format('public.%I', v_table)::regclass
        and table_row.relrowsecurity
        and pg_get_userbyid(table_row.relowner) = 'postgres'
    )
      or exists (select 1 from pg_policy policy where policy.polrelid = format('public.%I', v_table)::regclass)
      or has_table_privilege('anon', format('public.%I', v_table), 'SELECT')
      or has_table_privilege('authenticated', format('public.%I', v_table), 'SELECT')
      or has_table_privilege('discord_bot', format('public.%I', v_table), 'SELECT')
      or has_table_privilege('service_role', format('public.%I', v_table), 'SELECT')
      or has_table_privilege('service_role', format('public.%I', v_table), 'INSERT')
      or has_table_privilege('service_role', format('public.%I', v_table), 'UPDATE')
      or has_table_privilege('service_role', format('public.%I', v_table), 'DELETE')
    then
      raise exception 'COMMENT_ABUSE_POLICY_DEV_POSTFLIGHT_TABLE_MISMATCH: %', v_table;
    end if;
  end loop;

  foreach v_signature in array v_service loop
    if not exists (
      select 1 from pg_proc function_row
      where function_row.oid = to_regprocedure(v_signature)
        and pg_get_userbyid(function_row.proowner) = 'postgres'
        and function_row.prosecdef
        and function_row.proconfig @> array['search_path=public, pg_temp']
        and (
          v_signature <> 'public.get_community_comment_policy_management(uuid)'
          or function_row.provolatile = 'v'
        )
    )
      or has_function_privilege('anon', v_signature, 'EXECUTE')
      or has_function_privilege('authenticated', v_signature, 'EXECUTE')
      or has_function_privilege('discord_bot', v_signature, 'EXECUTE')
      or not has_function_privilege('service_role', v_signature, 'EXECUTE')
    then
      raise exception 'COMMENT_ABUSE_POLICY_DEV_POSTFLIGHT_SERVICE_ACL_MISMATCH: %', v_signature;
    end if;
  end loop;

  foreach v_signature in array v_internal loop
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
      raise exception 'COMMENT_ABUSE_POLICY_DEV_POSTFLIGHT_INTERNAL_ACL_MISMATCH: %', v_signature;
    end if;
  end loop;

  if not exists (
    select 1 from pg_constraint constraint_row
    where constraint_row.conrelid = 'public.community_comment_abuse_policies'::regclass
      and constraint_row.conname = 'community_comment_abuse_policies_action_check'
      and pg_get_constraintdef(constraint_row.oid) like '%''report''%'
  ) or not exists (
    select 1 from pg_constraint constraint_row
    where constraint_row.conrelid = 'public.community_comment_abuse_events'::regclass
      and constraint_row.conname = 'community_comment_abuse_events_policy_fkey'
  ) then
    raise exception 'COMMENT_ABUSE_POLICY_DEV_POSTFLIGHT_CONSTRAINT_MISMATCH';
  end if;

  if pg_get_functiondef(
      'public.submit_community_comment_report(uuid,uuid,text,text,uuid,text,boolean,boolean)'::regprocedure
    ) not like '%apply_community_comment_abuse_budget%'
    or pg_get_functiondef(
      'public.apply_community_comment_abuse_budget(text,text,bigint,text,boolean,timestamp with time zone)'::regprocedure
    ) not like '%community_comment_abuse_policy_states%'
    or pg_get_functiondef(
      'public.require_community_comment_owner_session(uuid)'::regprocedure
    ) not like '%member.role = ''admin''%'
    or pg_get_functiondef(
      'public.mark_community_comment_rejected_input(text,text,bigint,timestamp with time zone)'::regprocedure
    ) not like '%community_comment_abuse_policy_states%'
  then
    raise exception 'COMMENT_ABUSE_POLICY_DEV_POSTFLIGHT_DEFINITION_MISMATCH';
  end if;
end;
$postflight$;

rollback;
