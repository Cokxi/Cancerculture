do $preflight$
begin
  if to_regprocedure('public.assert_team_inbox_topic_access(text,text,boolean)') is null
    or to_regprocedure('public.assert_community_comment_capabilities(text,text[])') is null
    or to_regprocedure('public.get_community_comment_review_case_detail(text,uuid,text)') is null
    or to_regclass('public.community_comment_reports') is null
    or to_regclass('public.user_logs') is null
    or not exists (
      select 1
      from public.capability_catalog
      where key = 'community.comment_reports.view'
        and implementation_version = 1
        and definition_hash =
          '70902b326e0b5f2247e1c20443886f28fa16480aca8e05f6d63ad3367b1bffcd'
        and is_active
        and assignable_to_non_admin
    )
  then
    raise exception 'COMMENT_REPORTER_IDENTITY_TEAM_PROJECTION_PREFLIGHT_FAILED';
  end if;
end;
$preflight$;

update public.capability_catalog
set description =
      'View protected Comment Report queues, case details, immutable report facts including reporter identity, and the integrated append-only Case timeline without claiming or changing a Case.',
    included_actions = array[
      'View the redacted Comment Report Team Inbox topic, bounded queues, full Case details, and permanent Case timeline.',
      'View report categories, allowlisted explanations, Comment context, report counts, and each reporter''s current username and exact Discord ID.',
      'Use capability-protected bounded username and exact Discord ID Case search.'
    ]::text[],
    excluded_actions = array[
      'Claiming, returning, solving, removing, or restoring a Comment.',
      'Viewing raw abuse signals, manual User Flags, private security data, or prior Comment bodies.',
      'Viewing automated Spam Review Cases or the standalone moderation log.',
      'Managing roles, grants, Team membership, Owner access, or unrelated content and logs.'
    ]::text[],
    implementation_version = 2,
    definition_hash =
      '31e7f8d6bb49d148c717991d39b8cfbb7cde4e7757026839854b0fdad89a4775'
where key = 'community.comment_reports.view';

create or replace function public.assert_team_inbox_topic_access(
  p_actor_discord_user_id text,
  p_topic_key text,
  p_action_access boolean
)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor_id text := btrim(p_actor_discord_user_id);
  v_role text;
  v_capabilities text[];
  v_capability text;
  v_expected_version integer;
  v_expected_hash text;
begin
  if v_actor_id !~ '^[0-9]{1,100}$' then
    raise exception using errcode = '42501', message = 'TEAM_INBOX_FORBIDDEN';
  end if;

  select case when p_action_access
      then topic.required_action_capabilities
      else topic.required_read_capabilities
    end
  into v_capabilities
  from public.team_inbox_topic_catalog topic
  where topic.topic_key = p_topic_key and topic.is_active;
  if not found then
    raise exception using errcode = '42501', message = 'TEAM_INBOX_TOPIC_UNAVAILABLE';
  end if;

  select member.role into v_role
  from public.team_members member
  join public.team_roles role on role.key = member.role and role.is_active
  where member.discord_user_id = v_actor_id;
  if not found then
    raise exception using errcode = '42501', message = 'TEAM_INBOX_FORBIDDEN';
  end if;

  foreach v_capability in array v_capabilities loop
    select expected.implementation_version, expected.definition_hash
    into v_expected_version, v_expected_hash
    from (values
      ('winners.payouts.view', 2,
        '9de22d0055e9c8b6b8cb701e4f6f554aa4c241ab0cbfb0a4709ecc9841702a54'),
      ('winners.recipient_corrections.manage', 2,
        'e569fa66e8f9c2794fe030c4e034ebf8a7e458c6ddccf2a868d2cac1fd5ea2bd'),
      ('community.comment_reports.view', 2,
        '31e7f8d6bb49d148c717991d39b8cfbb7cde4e7757026839854b0fdad89a4775'),
      ('community.comment_reports.review', 1,
        'b201f956e4cc586b0a445455935224c3cefd5d5c950260e6899c451191e19da9'),
      ('community.comment_spam.view', 1,
        '389916756fe7326a7ba51977168f22d0f4a079b77b25deed29bdeeb1e05d42da'),
      ('community.comment_spam.review', 1,
        'eb211f298b166f8896c55f669cb721c790f3b27c3eb87d60799b7af741c14b76')
    ) expected(capability_key, implementation_version, definition_hash)
    where expected.capability_key = v_capability;

    if v_expected_version is null or not exists (
      select 1 from public.capability_catalog capability
      where capability.key = v_capability
        and capability.is_active
        and capability.assignable_to_non_admin
        and capability.implementation_version = v_expected_version
        and capability.definition_hash = v_expected_hash
    ) then
      raise exception using
        errcode = '55000', message = 'TEAM_INBOX_CAPABILITY_DEPENDENCY_UNAVAILABLE';
    end if;
    if v_role <> 'admin' and not exists (
      select 1 from public.team_role_capabilities grant_row
      where grant_row.role_key = v_role
        and grant_row.capability_key = v_capability
    ) then
      raise exception using errcode = '42501', message = 'TEAM_INBOX_FORBIDDEN';
    end if;
  end loop;
  return v_role;
end;
$function$;

create or replace function public.assert_community_comment_capabilities(
  p_actor_discord_user_id text,
  p_capabilities text[]
)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor_id text := btrim(p_actor_discord_user_id);
  v_role text;
  v_capability text;
  v_expected_version integer;
  v_expected_hash text;
begin
  if v_actor_id !~ '^[0-9]{1,100}$'
    or p_capabilities is null
    or cardinality(p_capabilities) not between 1 and 3
    or exists (select 1 from unnest(p_capabilities) item where item is null)
  then
    raise exception using errcode = '42501', message = 'COMMENT_REVIEW_FORBIDDEN';
  end if;

  select member.role into v_role
  from public.team_members member
  join public.team_roles role on role.key = member.role and role.is_active
  where member.discord_user_id = v_actor_id;
  if not found then
    raise exception using errcode = '42501', message = 'COMMENT_REVIEW_FORBIDDEN';
  end if;

  foreach v_capability in array p_capabilities loop
    select expected.implementation_version, expected.definition_hash
    into v_expected_version, v_expected_hash
    from (values
      ('community.comment_reports.view', 2,
        '31e7f8d6bb49d148c717991d39b8cfbb7cde4e7757026839854b0fdad89a4775'),
      ('community.comment_reports.review', 1,
        'b201f956e4cc586b0a445455935224c3cefd5d5c950260e6899c451191e19da9'),
      ('community.comments.moderate', 1,
        '68c743df9ccd4dba9cf6f511a0d7b737e1d7ba84450425722846912784c17e9f'),
      ('community.comment_spam.view', 1,
        '389916756fe7326a7ba51977168f22d0f4a079b77b25deed29bdeeb1e05d42da'),
      ('community.comment_spam.review', 1,
        'eb211f298b166f8896c55f669cb721c790f3b27c3eb87d60799b7af741c14b76'),
      ('logs.community_comment_moderation.view', 1,
        '6db2fa540e00d5146aebbfe021eec0a26dea7bf1078f59a5dda74ad8a5813ea3')
    ) expected(capability_key, implementation_version, definition_hash)
    where expected.capability_key = v_capability;

    if v_expected_version is null or not exists (
      select 1 from public.capability_catalog capability
      where capability.key = v_capability
        and capability.is_active
        and capability.assignable_to_non_admin
        and capability.implementation_version = v_expected_version
        and capability.definition_hash = v_expected_hash
    ) then
      raise exception using errcode = '55000', message = 'COMMENT_REVIEW_CAPABILITY_UNAVAILABLE';
    end if;
    if v_role <> 'admin' and not exists (
      select 1 from public.team_role_capabilities grant_row
      where grant_row.role_key = v_role and grant_row.capability_key = v_capability
    ) then
      raise exception using errcode = '42501', message = 'COMMENT_REVIEW_FORBIDDEN';
    end if;
  end loop;
  return v_role;
end;
$function$;

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
          'reporterUsername', coalesce(
            nullif(btrim(reporter_row.current_discord_username), ''),
            nullif(btrim(reporter_row.current_discord_handle), ''),
            nullif(btrim(reporter_row.current_display_name), ''),
            nullif(btrim(reporter_row.current_guild_nickname), ''),
            'Community member'
          ),
          'reporterDiscordUserId', report.reporter_discord_user_id,
          'category', report.category,
          'explanation', report.explanation,
          'rulesVersion', report.rules_version,
          'createdAt', report.created_at
        ) order by report.created_at desc, report.id desc)
        from public.community_comment_reports report
        join public.user_logs reporter_row
          on reporter_row.discord_user_id = report.reporter_discord_user_id
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

alter function public.assert_team_inbox_topic_access(text,text,boolean)
  owner to postgres;
alter function public.assert_community_comment_capabilities(text,text[])
  owner to postgres;
alter function public.get_community_comment_review_case_detail(text,uuid,text)
  owner to postgres;

revoke all on function public.assert_team_inbox_topic_access(text,text,boolean)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.assert_community_comment_capabilities(text,text[])
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_community_comment_review_case_detail(text,uuid,text)
  from public, anon, authenticated, discord_bot, service_role;
grant execute on function public.get_community_comment_review_case_detail(text,uuid,text)
  to service_role;

comment on function public.get_community_comment_review_case_detail(text,uuid,text) is
  'Capability-checked Comment Report or Spam Case detail; reporter username and Discord ID are limited to the protected Comment Report View projection, while prior text requires the additional exact Comment moderation right.';

do $postflight$
declare
  v_detail_function oid := to_regprocedure(
    'public.get_community_comment_review_case_detail(text,uuid,text)'
  );
begin
  if not exists (
    select 1
    from public.capability_catalog
    where key = 'community.comment_reports.view'
      and implementation_version = 2
      and definition_hash =
        '31e7f8d6bb49d148c717991d39b8cfbb7cde4e7757026839854b0fdad89a4775'
      and is_active
      and assignable_to_non_admin
  )
    or v_detail_function is null
    or pg_get_userbyid((select proowner from pg_proc where oid = v_detail_function)) <> 'postgres'
    or not (select prosecdef from pg_proc where oid = v_detail_function)
    or coalesce((select array_to_string(proconfig, ';') from pg_proc where oid = v_detail_function), '')
      not like '%search_path=public, pg_temp%'
    or has_function_privilege('public', v_detail_function, 'EXECUTE')
    or has_function_privilege('anon', v_detail_function, 'EXECUTE')
    or has_function_privilege('authenticated', v_detail_function, 'EXECUTE')
    or has_function_privilege('discord_bot', v_detail_function, 'EXECUTE')
    or not has_function_privilege('service_role', v_detail_function, 'EXECUTE')
  then
    raise exception 'COMMENT_REPORTER_IDENTITY_TEAM_PROJECTION_POSTFLIGHT_FAILED';
  end if;

  if (
    select count(*)
    from pg_proc function_row
    join pg_namespace namespace_row on namespace_row.oid = function_row.pronamespace
    where namespace_row.nspname = 'public'
      and function_row.proname in (
        'assert_team_inbox_topic_access',
        'assert_community_comment_capabilities',
        'get_community_comment_review_case_detail'
      )
  ) <> 3 then
    raise exception 'COMMENT_REPORTER_IDENTITY_TEAM_PROJECTION_OVERLOAD_FAILED';
  end if;
end;
$postflight$;
