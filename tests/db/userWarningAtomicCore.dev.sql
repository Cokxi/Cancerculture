\set ON_ERROR_STOP on

begin;

set local lock_timeout = '10s';
set local statement_timeout = '90s';

do $preflight$
begin
  if (select count(*) from public.capability_catalog) <> 51
    or (select count(*) from public.capability_catalog where is_active) <> 47
    or (
      select count(*) from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 47
    or exists (
      select 1 from public.team_role_capabilities
      where capability_key in ('users.warnings.issue', 'users.warnings.overrule')
    )
    or to_regclass('public.user_warnings') is null
    or exists (select 1 from public.user_warnings)
  then
    raise exception 'DEV_USER_WARNING_TEST_PREFLIGHT_DRIFT';
  end if;
end;
$preflight$;

do $warning_contract$
declare
  v_actor text;
  v_denied_actor text := 'user-warning-test-unauthorized';
  v_target text;
  v_public_ids uuid[];
  v_object_versions bigint[];
  v_text_versions bigint[];
  v_first jsonb;
  v_first_replay jsonb;
  v_second jsonb;
  v_third jsonb;
  v_fourth jsonb;
  v_fifth jsonb;
  v_overrule_first jsonb;
  v_overrule_first_replay jsonb;
  v_overrule_second jsonb;
  v_first_internal uuid;
  v_second_internal uuid;
  v_third_internal uuid;
  v_fourth_internal uuid;
  v_fifth_internal uuid;
  v_fourth_issued_at timestamptz;
  v_future jsonb;
begin
  select member.discord_user_id
  into v_actor
  from public.team_members member
  where member.role = 'admin'
  order by member.discord_user_id
  limit 1;

  select candidate.author_discord_user_id
  into v_target
  from (
    select comment_row.author_discord_user_id, count(*) as comment_count
    from public.community_comments comment_row
    join public.community_comment_text_versions text_version
      on text_version.comment_id = comment_row.id
     and text_version.version = comment_row.current_text_version
    where comment_row.author_deleted_at is null
      and text_version.normalized_body is not null
      and public.is_community_comment_submission_eligible(comment_row.submission_id)
    group by comment_row.author_discord_user_id
    having count(*) >= 5
    order by count(*) desc, comment_row.author_discord_user_id
    limit 1
  ) candidate;

  if v_actor is null
    or v_target is null
    or exists (
      select 1
      from public.team_members member
      where member.discord_user_id = v_denied_actor
    )
  then
    raise exception 'DEV_USER_WARNING_TEST_FIXTURE_UNAVAILABLE';
  end if;

  select
    array_agg(source.public_comment_id order by source.created_at, source.public_comment_id),
    array_agg(source.object_version order by source.created_at, source.public_comment_id),
    array_agg(source.current_text_version order by source.created_at, source.public_comment_id)
  into v_public_ids, v_object_versions, v_text_versions
  from (
    select
      comment_row.public_comment_id,
      comment_row.object_version,
      comment_row.current_text_version,
      comment_row.created_at
    from public.community_comments comment_row
    join public.community_comment_text_versions text_version
      on text_version.comment_id = comment_row.id
     and text_version.version = comment_row.current_text_version
    where comment_row.author_discord_user_id = v_target
      and comment_row.author_deleted_at is null
      and text_version.normalized_body is not null
      and public.is_community_comment_submission_eligible(comment_row.submission_id)
    order by comment_row.created_at, comment_row.public_comment_id
    limit 5
  ) source;

  if cardinality(v_public_ids) <> 5 then
    raise exception 'DEV_USER_WARNING_TEST_SOURCE_COUNT_MISMATCH';
  end if;

  begin
    perform public.issue_user_warning(
      v_denied_actor,
      v_public_ids[1],
      v_object_versions[1],
      v_text_versions[1],
      'spam',
      'Unauthorized actor must fail closed.',
      '52000000-0000-4000-8000-000000000001'::uuid
    );
    raise exception 'DEV_USER_WARNING_CAPABILITY_DENIAL_FAILED';
  exception when sqlstate '42501' then null;
  end;

  v_first := public.issue_user_warning(
    v_actor,
    v_public_ids[1],
    v_object_versions[1],
    v_text_versions[1],
    'spam',
    'Rollback-only first Warning.',
    '52000000-0000-4000-8000-000000000011'::uuid
  );
  v_first_replay := public.issue_user_warning(
    v_actor,
    v_public_ids[1],
    v_object_versions[1],
    v_text_versions[1],
    'spam',
    'Rollback-only first Warning.',
    '52000000-0000-4000-8000-000000000011'::uuid
  );

  if v_first ->> 'tierDays' <> '1'
    or v_first ->> 'replayed' <> 'false'
    or v_first_replay ->> 'warningId' <> v_first ->> 'warningId'
    or v_first_replay ->> 'replayed' <> 'true'
  then
    raise exception 'DEV_USER_WARNING_ISSUE_REPLAY_FAILED';
  end if;

  begin
    perform public.issue_user_warning(
      v_actor,
      v_public_ids[1],
      v_object_versions[1],
      v_text_versions[1],
      'spam',
      'Conflicting payload.',
      '52000000-0000-4000-8000-000000000011'::uuid
    );
    raise exception 'DEV_USER_WARNING_IDEMPOTENCY_CONFLICT_FAILED';
  exception when sqlstate 'PT409' then null;
  end;

  begin
    perform public.issue_user_warning(
      v_actor,
      v_public_ids[1],
      v_object_versions[1],
      v_text_versions[1],
      'hate_speech',
      'The source Comment is permanently unique.',
      '52000000-0000-4000-8000-000000000012'::uuid
    );
    raise exception 'DEV_USER_WARNING_SOURCE_UNIQUENESS_FAILED';
  exception when sqlstate 'PT409' then null;
  end;

  begin
    perform public.issue_user_warning(
      v_actor,
      v_public_ids[2],
      v_object_versions[2] + 1,
      v_text_versions[2],
      'other',
      'Stale source object version must fail.',
      '52000000-0000-4000-8000-000000000013'::uuid
    );
    raise exception 'DEV_USER_WARNING_STALE_SOURCE_FAILED';
  exception when sqlstate 'PT409' then null;
  end;

  v_second := public.issue_user_warning(
    v_actor, v_public_ids[2], v_object_versions[2], v_text_versions[2],
    'hate_speech', 'Rollback-only second Warning.',
    '52000000-0000-4000-8000-000000000021'::uuid
  );
  v_third := public.issue_user_warning(
    v_actor, v_public_ids[3], v_object_versions[3], v_text_versions[3],
    'other', 'Rollback-only third Warning.',
    '52000000-0000-4000-8000-000000000031'::uuid
  );
  v_fourth := public.issue_user_warning(
    v_actor, v_public_ids[4], v_object_versions[4], v_text_versions[4],
    'spam', 'Rollback-only fourth Warning.',
    '52000000-0000-4000-8000-000000000041'::uuid
  );

  if v_second ->> 'tierDays' <> '3'
    or v_third ->> 'tierDays' <> '7'
    or v_fourth ->> 'tierDays' <> '14'
    or v_third #>> '{autoFlag,status}' <> 'open'
    or v_third #>> '{autoFlag,triggeredByActiveCount}' <> 'true'
    or v_fourth #>> '{autoFlag,triggeredByFourteenDay}' <> 'true'
  then
    raise exception 'DEV_USER_WARNING_PROGRESSION_OR_FLAG_FAILED';
  end if;

  select warning_row.warning_id
  into v_first_internal
  from public.user_warnings warning_row
  where warning_row.public_warning_id = (v_first ->> 'warningId')::uuid;
  select warning_row.warning_id
  into v_second_internal
  from public.user_warnings warning_row
  where warning_row.public_warning_id = (v_second ->> 'warningId')::uuid;
  select warning_row.warning_id
  into v_third_internal
  from public.user_warnings warning_row
  where warning_row.public_warning_id = (v_third ->> 'warningId')::uuid;
  select warning_row.warning_id
  into v_fourth_internal
  from public.user_warnings warning_row
  where warning_row.public_warning_id = (v_fourth ->> 'warningId')::uuid;

  if not exists (
    select 1
    from public.user_warnings warning_row
    join public.community_comments comment_row
      on comment_row.id = warning_row.source_comment_id
    join public.community_comment_text_versions text_version
      on text_version.comment_id = warning_row.source_comment_id
     and text_version.version = warning_row.source_comment_text_version
    where warning_row.warning_id = v_first_internal
      and warning_row.source_comment_object_version = v_object_versions[1]
      and warning_row.source_comment_text_version = v_text_versions[1]
      and warning_row.source_comment_body = text_version.normalized_body
      and warning_row.source_comment_body_digest = encode(
        extensions.digest(convert_to(text_version.normalized_body, 'UTF8'), 'sha256'),
        'hex'
      )
      and warning_row.source_public_comment_id = comment_row.public_comment_id
  ) then
    raise exception 'DEV_USER_WARNING_SOURCE_EVIDENCE_FAILED';
  end if;

  select warning_row.issued_at
  into v_fourth_issued_at
  from public.user_warnings warning_row
  where warning_row.warning_id = v_fourth_internal;

  perform public.sync_user_warning_auto_flag(
    v_target,
    v_fourth_issued_at + interval '8 days',
    v_fourth_internal
  );

  if not exists (
    select 1
    from public.user_warning_auto_flag_cases flag_case
    where flag_case.target_discord_user_id = v_target
      and flag_case.status = 'open'
      and flag_case.active_warning_count = 1
      and not flag_case.triggered_by_active_count
      and flag_case.triggered_by_fourteen_day
  ) then
    raise exception 'DEV_USER_WARNING_FOURTEEN_DAY_TRIGGER_INDEPENDENCE_FAILED';
  end if;

  v_overrule_first := public.overrule_user_warning(
    v_actor,
    (v_first ->> 'warningId')::uuid,
    1,
    'Rollback-only first correction.',
    '52000000-0000-4000-8000-000000000051'::uuid
  );
  v_overrule_first_replay := public.overrule_user_warning(
    v_actor,
    (v_first ->> 'warningId')::uuid,
    1,
    'Rollback-only first correction.',
    '52000000-0000-4000-8000-000000000051'::uuid
  );

  if v_overrule_first ->> 'state' <> 'overruled'
    or v_overrule_first ->> 'recalculatedCount' <> '3'
    or v_overrule_first_replay ->> 'replayed' <> 'true'
    or (
      select array_agg(current_row.effective_tier_days order by warning_row.issued_at, warning_row.warning_id)
      from public.user_warnings warning_row
      join public.user_warning_current current_row
        on current_row.warning_id = warning_row.warning_id
      where warning_row.target_discord_user_id = v_target
        and current_row.state <> 'overruled'
    ) <> array[1,3,7]
  then
    raise exception 'DEV_USER_WARNING_FIRST_OVERRULE_RECALCULATION_FAILED';
  end if;

  v_overrule_second := public.overrule_user_warning(
    v_actor,
    (v_second ->> 'warningId')::uuid,
    2,
    'Rollback-only second correction.',
    '52000000-0000-4000-8000-000000000061'::uuid
  );

  if v_overrule_second ->> 'recalculatedCount' <> '2'
    or v_overrule_second #>> '{autoFlag,status}' <> 'closed'
    or (
      select array_agg(current_row.effective_tier_days order by warning_row.issued_at, warning_row.warning_id)
      from public.user_warnings warning_row
      join public.user_warning_current current_row
        on current_row.warning_id = warning_row.warning_id
      where warning_row.target_discord_user_id = v_target
        and current_row.state <> 'overruled'
    ) <> array[1,3]
  then
    raise exception 'DEV_USER_WARNING_SECOND_OVERRULE_RECALCULATION_FAILED';
  end if;

  v_fifth := public.issue_user_warning(
    v_actor, v_public_ids[5], v_object_versions[5], v_text_versions[5],
    'other', 'Rollback-only fifth Warning.',
    '52000000-0000-4000-8000-000000000071'::uuid
  );
  select warning_row.warning_id
  into v_fifth_internal
  from public.user_warnings warning_row
  where warning_row.public_warning_id = (v_fifth ->> 'warningId')::uuid;

  if v_fifth ->> 'tierDays' <> '7'
    or v_fifth #>> '{autoFlag,status}' <> 'open'
    or v_fifth #>> '{autoFlag,triggeredByActiveCount}' <> 'true'
  then
    raise exception 'DEV_USER_WARNING_FLAG_REOPEN_FAILED';
  end if;

  v_future := public.recalculate_user_warning_target(
    v_target,
    v_fourth_issued_at + interval '20 days',
    null,
    'system',
    null,
    null,
    null,
    null,
    false
  );

  if v_future ->> 'activeWarningCount' <> '0'
    or v_future #>> '{autoFlag,status}' <> 'closed'
    or (
      select count(*)
      from public.user_warning_current current_row
      where current_row.target_discord_user_id = v_target
        and current_row.state = 'expired'
    ) <> 3
    or (
      select count(*)
      from public.user_warning_events event_row
      where event_row.target_discord_user_id = v_target
        and event_row.event_type = 'expired'
    ) <> 3
  then
    raise exception 'DEV_USER_WARNING_EXPIRY_FAILED';
  end if;

  begin
    update public.user_warnings
    set reason = 'History rewrite must fail.'
    where warning_id = v_first_internal;
    raise exception 'DEV_USER_WARNING_CANONICAL_UPDATE_ALLOWED';
  exception when sqlstate '55000' then null;
  end;

  begin
    update public.user_warning_requests
    set request_payload = '{}'::jsonb
    where request_id = '52000000-0000-4000-8000-000000000011'::uuid;
    raise exception 'DEV_USER_WARNING_REQUEST_UPDATE_ALLOWED';
  exception when sqlstate '55000' then null;
  end;

  if (select count(*) from public.user_warnings where target_discord_user_id = v_target) <> 5
    or (select count(*) from public.user_warning_requests where target_discord_user_id = v_target) <> 7
    or (
      select count(*) from public.user_warning_events
      where target_discord_user_id = v_target and event_type = 'overruled'
    ) <> 2
    or (
      select count(*) from public.user_warning_events
      where target_discord_user_id = v_target and event_type = 'recalculated'
    ) <> 5
    or (
      select count(*) from public.user_warning_auto_flag_cases
      where target_discord_user_id = v_target
    ) <> 2
  then
    raise exception 'DEV_USER_WARNING_HISTORY_COUNTS_FAILED';
  end if;
end;
$warning_contract$;

do $security_contract$
declare
  v_table text;
begin
  foreach v_table in array array[
    'user_warnings',
    'user_warning_current',
    'user_warning_events',
    'user_warning_requests',
    'user_warning_auto_flag_cases',
    'user_warning_auto_flag_events'
  ] loop
    if not exists (
      select 1 from pg_class table_row
      where table_row.oid = format('public.%I', v_table)::regclass
        and table_row.relrowsecurity
        and pg_get_userbyid(table_row.relowner) = 'postgres'
    )
      or exists (
        select 1 from pg_policy policy_row
        where policy_row.polrelid = format('public.%I', v_table)::regclass
      )
      or has_table_privilege('anon', format('public.%I', v_table), 'SELECT')
      or has_table_privilege('authenticated', format('public.%I', v_table), 'SELECT')
      or has_table_privilege('discord_bot', format('public.%I', v_table), 'SELECT')
      or has_table_privilege('service_role', format('public.%I', v_table), 'SELECT,INSERT,UPDATE,DELETE')
    then
      raise exception 'DEV_USER_WARNING_TABLE_SECURITY_FAILED: %', v_table;
    end if;
  end loop;

  if has_function_privilege(
      'anon',
      'public.issue_user_warning(text,uuid,bigint,bigint,text,text,uuid)',
      'EXECUTE'
    )
    or has_function_privilege(
      'authenticated',
      'public.overrule_user_warning(text,uuid,bigint,text,uuid)',
      'EXECUTE'
    )
    or not has_function_privilege(
      'service_role',
      'public.process_due_user_warning_expiries(integer)',
      'EXECUTE'
    )
    or has_function_privilege(
      'service_role',
      'public.recalculate_user_warning_target(text,timestamp with time zone,uuid,text,text,text,text,text,boolean)',
      'EXECUTE'
    )
  then
    raise exception 'DEV_USER_WARNING_FUNCTION_SECURITY_FAILED';
  end if;
end;
$security_contract$;

rollback;
