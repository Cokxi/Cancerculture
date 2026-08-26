do $preflight$
begin
  if to_regprocedure(
    'public.build_community_comment_moderation_review_context(uuid)'
  ) is null
    or to_regprocedure(
      'public.get_community_comment_review_case_detail(text,uuid,text)'
    ) is null
  then
    raise exception 'COMMUNITY_COMMENT_MODERATION_REVIEW_CONTEXT_ACL_PREFLIGHT_FAILED';
  end if;
end;
$preflight$;

create or replace function public.get_community_comment_review_case_detail(
  p_actor_discord_user_id text,
  p_case_id uuid,
  p_expected_topic_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_case public.team_inbox_cases%rowtype;
  v_generic jsonb;
  v_domain jsonb;
  v_can_moderate boolean := false;
begin
  if p_expected_topic_key not in ('comment_reports', 'comment_spam') then
    raise exception using errcode = '22023', message = 'COMMENT_REVIEW_TOPIC_INVALID';
  end if;
  select * into v_case from public.team_inbox_cases where id = p_case_id;
  if not found or v_case.topic_key <> p_expected_topic_key then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  perform public.assert_team_inbox_topic_access(
    p_actor_discord_user_id, p_expected_topic_key, false
  );
  begin
    perform public.assert_community_comment_capabilities(
      p_actor_discord_user_id, array['community.comments.moderate']::text[]
    );
    v_can_moderate := true;
  exception
    when insufficient_privilege then
      v_can_moderate := false;
  end;
  v_generic := public.get_team_inbox_case_detail(p_actor_discord_user_id, p_case_id);
  if p_expected_topic_key = 'comment_reports' then
    select jsonb_build_object(
      'kind', 'comment_report',
      'version', report_case.version,
      'generation', report_case.generation,
      'reportCount', report_case.report_count,
      'status', report_case.status,
      'lastOutcome', report_case.last_outcome,
      'comment', public.build_community_comment_public_json(report_case.comment_id),
      'reviewContext', case when v_can_moderate
        then public.build_community_comment_moderation_review_context(report_case.comment_id)
        else null end,
      'moderationVersion', comment_row.team_moderation_version,
      'reports', coalesce((
        select jsonb_agg(jsonb_build_object(
          'publicReportId', report.public_report_id,
          'category', report.category,
          'explanation', report.explanation,
          'rulesVersion', report.rules_version,
          'createdAt', report.created_at
        ) order by report.created_at desc, report.id desc)
        from public.community_comment_reports report
        where report.case_id = report_case.id
      ), '[]'::jsonb)
    ) into v_domain
    from public.community_comment_report_cases report_case
    join public.community_comments comment_row on comment_row.id = report_case.comment_id
    where report_case.team_inbox_case_id = p_case_id;
  else
    select jsonb_build_object(
      'kind', 'comment_spam',
      'version', spam_case.version,
      'generation', spam_case.generation,
      'signalCount', spam_case.signal_count,
      'status', spam_case.status,
      'lastOutcome', spam_case.last_outcome,
      'relatedComments', coalesce((
        select jsonb_agg(jsonb_build_object(
          'comment', public.build_community_comment_public_json(reference.comment_id),
          'reviewContext', case when v_can_moderate
            then public.build_community_comment_moderation_review_context(reference.comment_id)
            else null end,
          'moderationVersion', comment_row.team_moderation_version,
          'referenceCount', reference.reference_count,
          'lastSeenAt', reference.last_seen_at
        ) order by reference.last_seen_at desc, reference.comment_id desc)
        from (
          select * from public.community_comment_spam_comment_refs source_reference
          where source_reference.case_id = spam_case.id
          order by source_reference.last_seen_at desc, source_reference.comment_id desc
          limit 20
        ) reference
        join public.community_comments comment_row on comment_row.id = reference.comment_id
      ), '[]'::jsonb)
    ) into v_domain
    from public.community_comment_spam_cases spam_case
    where spam_case.team_inbox_case_id = p_case_id;
  end if;
  if v_domain is null then return jsonb_build_object('outcome', 'not_found'); end if;
  return jsonb_set(
    v_generic, '{case,sourceVersion}', to_jsonb(v_case.source_version), true
  ) || jsonb_build_object('domain', v_domain);
end;
$function$;

alter function public.get_community_comment_review_case_detail(text,uuid,text)
  owner to postgres;
revoke all on function public.get_community_comment_review_case_detail(text,uuid,text)
  from public, anon, authenticated, discord_bot, service_role;
grant execute on function public.get_community_comment_review_case_detail(text,uuid,text)
  to service_role;

comment on function public.get_community_comment_review_case_detail(text,uuid,text) is
  'Capability-checked Comment Report or Spam Case detail; protected text and latest moderation context require the additional exact Comment moderation right.';

do $postflight$
declare
  v_function oid := to_regprocedure(
    'public.get_community_comment_review_case_detail(text,uuid,text)'
  );
begin
  if v_function is null
    or pg_get_userbyid((select proowner from pg_proc where oid = v_function)) <> 'postgres'
    or not (select prosecdef from pg_proc where oid = v_function)
    or coalesce((select array_to_string(proconfig, ';') from pg_proc where oid = v_function), '')
      not like '%search_path=public, pg_temp%'
    or has_function_privilege('public', v_function, 'EXECUTE')
    or has_function_privilege('anon', v_function, 'EXECUTE')
    or has_function_privilege('authenticated', v_function, 'EXECUTE')
    or has_function_privilege('discord_bot', v_function, 'EXECUTE')
    or not has_function_privilege('service_role', v_function, 'EXECUTE')
  then
    raise exception 'COMMUNITY_COMMENT_MODERATION_REVIEW_CONTEXT_ACL_POSTFLIGHT_FAILED';
  end if;

  if (
    select count(*)
    from pg_proc function_row
    join pg_namespace namespace_row on namespace_row.oid = function_row.pronamespace
    where namespace_row.nspname = 'public'
      and function_row.proname = 'get_community_comment_review_case_detail'
  ) <> 1 then
    raise exception 'COMMUNITY_COMMENT_MODERATION_REVIEW_CONTEXT_ACL_OVERLOAD_FAILED';
  end if;
end;
$postflight$;
