begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $preflight$
declare
  v_function oid := to_regprocedure('public.get_community_comment_policy_management(uuid)');
begin
  if v_function is null
    or not exists (
      select 1 from pg_proc function_row
      where function_row.oid = v_function
        and function_row.provolatile = 's'
        and function_row.prosecdef
        and pg_get_userbyid(function_row.proowner) = 'postgres'
        and function_row.proconfig @> array['search_path=public, pg_temp']
    )
    or has_function_privilege('anon', 'public.get_community_comment_policy_management(uuid)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.get_community_comment_policy_management(uuid)', 'EXECUTE')
    or has_function_privilege('discord_bot', 'public.get_community_comment_policy_management(uuid)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.get_community_comment_policy_management(uuid)', 'EXECUTE')
  then
    raise exception using
      errcode = '55000',
      message = 'COMMENT_POLICY_READ_LOCK_CORRECTION_BASELINE_MISMATCH';
  end if;
end;
$preflight$;

create or replace function public.get_community_comment_policy_management(p_session_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor text;
  v_release public.community_comment_settings%rowtype;
  v_spam_state public.community_comment_spam_policy_state%rowtype;
  v_spam_policy public.community_comment_spam_review_policies%rowtype;
begin
  v_actor := public.require_community_comment_owner_session(p_session_id);
  select * into strict v_release from public.community_comment_settings where singleton;
  select * into strict v_spam_state from public.community_comment_spam_policy_state where singleton;
  if v_spam_state.active_policy_version is not null then
    select * into strict v_spam_policy
    from public.community_comment_spam_review_policies policy
    where policy.policy_version = v_spam_state.active_policy_version;
  end if;
  return jsonb_build_object(
    'outcome', 'ok',
    'release', jsonb_build_object(
      'state', v_release.release_state,
      'version', v_release.version,
      'updatedAt', v_release.updated_at
    ),
    'actions', (
      select jsonb_agg(jsonb_build_object(
        'action', state.action,
        'stateVersion', state.state_version,
        'activePolicy', case when policy.policy_version is null then null else jsonb_build_object(
          'policyVersion', policy.policy_version,
          'windowSeconds', policy.window_seconds,
          'maxActions', policy.max_actions,
          'cooldownSeconds', policy.cooldown_seconds,
          'turnstileAfter', policy.turnstile_after,
          'createdAt', policy.created_at
        ) end,
        'updatedAt', state.updated_at
      ) order by array_position(array['root','reply','edit','vote','report']::text[], state.action))
      from public.community_comment_abuse_policy_states state
      left join public.community_comment_abuse_policies policy
        on policy.action = state.action
       and policy.policy_version = state.active_policy_version
    ),
    'spam', jsonb_build_object(
      'stateVersion', v_spam_state.state_version,
      'activePolicy', case when v_spam_state.active_policy_version is null then null else jsonb_build_object(
        'policyVersion', v_spam_policy.policy_version,
        'minimumEventCount', v_spam_policy.minimum_event_count,
        'lookbackSeconds', v_spam_policy.lookback_seconds,
        'thresholdScore', v_spam_policy.threshold_score,
        'signalWeights', v_spam_policy.signal_weights,
        'createdAt', v_spam_policy.created_at
      ) end,
      'updatedAt', v_spam_state.updated_at
    )
  );
end;
$function$;

alter function public.get_community_comment_policy_management(uuid) owner to postgres;
revoke all on function public.get_community_comment_policy_management(uuid)
from public, anon, authenticated, discord_bot;
grant execute on function public.get_community_comment_policy_management(uuid) to service_role;

do $postflight$
declare
  v_function oid := to_regprocedure('public.get_community_comment_policy_management(uuid)');
begin
  if not exists (
    select 1 from pg_proc function_row
    where function_row.oid = v_function
      and function_row.provolatile = 'v'
      and function_row.prosecdef
      and pg_get_userbyid(function_row.proowner) = 'postgres'
      and function_row.proconfig @> array['search_path=public, pg_temp']
  )
    or has_function_privilege('anon', 'public.get_community_comment_policy_management(uuid)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.get_community_comment_policy_management(uuid)', 'EXECUTE')
    or has_function_privilege('discord_bot', 'public.get_community_comment_policy_management(uuid)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.get_community_comment_policy_management(uuid)', 'EXECUTE')
  then
    raise exception using
      errcode = '55000',
      message = 'COMMENT_POLICY_READ_LOCK_CORRECTION_POSTFLIGHT_MISMATCH';
  end if;
end;
$postflight$;

commit;
