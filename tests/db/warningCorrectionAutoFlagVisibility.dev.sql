\set ON_ERROR_STOP on

begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

do $preflight$
begin
  if (select count(*) from public.capability_catalog) <> 52
    or (select count(*) from public.capability_catalog where is_active) <> 48
    or not exists (
      select 1 from public.capability_catalog
      where key = 'users.flag.view'
        and implementation_version = 3
        and definition_hash = '54e6644753e36c355d69b4ca9aa80ef93d9b4b3040d4103a58e56b2a10f55add'
    )
    or exists (
      select 1 from public.team_role_capabilities
      where capability_key = 'users.warnings.overrule'
    )
    or to_regprocedure('public.get_user_warning_overrule_target(text,text,uuid)') is null
    or to_regprocedure(
      'public.list_user_warning_auto_flag_cases(text,text,text,integer,integer)'
    ) is null
    or not exists (
      select 1 from pg_trigger
      where tgrelid = 'public.user_warning_events'::regclass
        and tgname = 'user_warning_overrule_notification_after_insert'
        and not tgisinternal
    )
  then
    raise exception 'DEV_WARNING_CORRECTION_AUTO_FLAG_PREFLIGHT_DRIFT';
  end if;
end;
$preflight$;

do $contract$
declare
  v_actor text;
  v_denied_actor text := 'warning-correction-test-unauthorized';
  v_target text;
  v_session uuid;
  v_public_ids uuid[];
  v_object_versions bigint[];
  v_text_versions bigint[];
  v_first jsonb;
  v_second jsonb;
  v_third jsonb;
  v_fourth jsonb;
  v_first_internal uuid;
  v_second_internal uuid;
  v_target_projection jsonb;
  v_active_flags jsonb;
  v_history_flags jsonb;
  v_overrule_first jsonb;
  v_overrule_first_replay jsonb;
  v_overrule_second jsonb;
  v_owner_detail jsonb;
  v_owner_notifications jsonb;
  v_manual_case_count bigint;
  v_manual_event_count bigint;
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
    select
      comment_row.author_discord_user_id,
      count(*) as comment_count
    from public.community_comments comment_row
    join public.community_comment_text_versions text_version
      on text_version.comment_id = comment_row.id
     and text_version.version = comment_row.current_text_version
    where comment_row.author_deleted_at is null
      and text_version.normalized_body is not null
      and public.is_community_comment_submission_eligible(comment_row.submission_id)
      and exists (
        select 1
        from public.sessions session_row
        where session_row.discord_user_id = comment_row.author_discord_user_id
          and session_row.revoked_at is null
      )
      and not exists (
        select 1
        from public.user_warnings target_warning
        where target_warning.target_discord_user_id = comment_row.author_discord_user_id
      )
      and not exists (
        select 1 from public.user_warnings warning_row
        where warning_row.source_comment_id = comment_row.id
      )
    group by comment_row.author_discord_user_id
    having count(*) >= 4
    order by count(*) desc, comment_row.author_discord_user_id
    limit 1
  ) candidate;

  select session_row.id
  into v_session
  from public.sessions session_row
  where session_row.discord_user_id = v_target
    and session_row.revoked_at is null
  order by session_row.created_at desc, session_row.id
  limit 1;

  if v_actor is null or v_target is null or v_session is null then
    raise exception 'DEV_WARNING_CORRECTION_AUTO_FLAG_FIXTURE_UNAVAILABLE';
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
      and not exists (
        select 1 from public.user_warnings warning_row
        where warning_row.source_comment_id = comment_row.id
      )
    order by comment_row.created_at, comment_row.public_comment_id
    limit 4
  ) source;

  if cardinality(v_public_ids) <> 4 then
    raise exception 'DEV_WARNING_CORRECTION_AUTO_FLAG_SOURCE_COUNT_MISMATCH';
  end if;

  select count(*) into v_manual_case_count from public.user_flag_cases;
  select count(*) into v_manual_event_count from public.user_flag_events;

  begin
    perform public.get_user_warning_overrule_target(
      v_denied_actor,
      v_target,
      '54000000-0000-4000-8000-000000000001'::uuid
    );
    raise exception 'DEV_WARNING_CORRECTION_CAPABILITY_DENIAL_FAILED';
  exception when sqlstate '42501' then null;
  end;

  begin
    perform public.list_user_warning_auto_flag_cases(
      v_denied_actor,
      'active',
      null,
      10,
      0
    );
    raise exception 'DEV_AUTO_FLAG_CAPABILITY_DENIAL_FAILED';
  exception when sqlstate '42501' then null;
  end;

  v_first := public.issue_user_warning(
    v_actor, v_public_ids[1], v_object_versions[1], v_text_versions[1],
    'other', 'Rollback-only correction case one.',
    '54000000-0000-4000-8000-000000000011'::uuid
  );
  v_second := public.issue_user_warning(
    v_actor, v_public_ids[2], v_object_versions[2], v_text_versions[2],
    'other', 'Rollback-only correction case two.',
    '54000000-0000-4000-8000-000000000021'::uuid
  );
  v_third := public.issue_user_warning(
    v_actor, v_public_ids[3], v_object_versions[3], v_text_versions[3],
    'other', 'Rollback-only correction case three.',
    '54000000-0000-4000-8000-000000000031'::uuid
  );
  v_fourth := public.issue_user_warning(
    v_actor, v_public_ids[4], v_object_versions[4], v_text_versions[4],
    'other', 'Rollback-only correction case four.',
    '54000000-0000-4000-8000-000000000041'::uuid
  );

  if v_first ->> 'tierDays' <> '1'
    or v_second ->> 'tierDays' <> '3'
    or v_third ->> 'tierDays' <> '7'
    or v_third #>> '{autoFlag,triggeredByActiveCount}' <> 'true'
    or v_third #>> '{autoFlag,triggeredByFourteenDay}' <> 'false'
    or v_fourth ->> 'tierDays' <> '14'
    or v_fourth #>> '{autoFlag,triggeredByActiveCount}' <> 'true'
    or v_fourth #>> '{autoFlag,triggeredByFourteenDay}' <> 'true'
  then
    raise exception 'DEV_WARNING_CORRECTION_TRIGGER_COMBINATIONS_FAILED';
  end if;

  select warning_row.warning_id
  into v_first_internal
  from public.user_warnings warning_row
  where warning_row.public_warning_id = (v_first ->> 'warningId')::uuid;
  select warning_row.warning_id
  into v_second_internal
  from public.user_warnings warning_row
  where warning_row.public_warning_id = (v_second ->> 'warningId')::uuid;

  v_target_projection := public.get_user_warning_overrule_target(
    v_actor,
    v_target,
    (v_first ->> 'warningId')::uuid
  );
  if v_target_projection ->> 'outcome' <> 'found' then
    raise exception 'DEV_WARNING_CORRECTION_TARGET_BINDING_OUTCOME_FAILED';
  end if;
  if v_target_projection ->> 'targetDiscordUserId' <> v_target then
    raise exception 'DEV_WARNING_CORRECTION_TARGET_BINDING_TARGET_FAILED';
  end if;
  if v_target_projection ->> 'rowVersion' <> '1' then
    raise exception 'DEV_WARNING_CORRECTION_TARGET_BINDING_VERSION_FAILED';
  end if;
  if (select count(*) from jsonb_object_keys(v_target_projection)) <> 5 then
    raise exception 'DEV_WARNING_CORRECTION_TARGET_BINDING_SHAPE_FAILED';
  end if;
  if public.get_user_warning_overrule_target(
      v_actor,
      'warning-correction-target-mismatch',
      (v_first ->> 'warningId')::uuid
    ) ->> 'outcome' <> 'not_found' then
    raise exception 'DEV_WARNING_CORRECTION_TARGET_BINDING_MISMATCH_FAILED';
  end if;

  v_active_flags := public.list_user_warning_auto_flag_cases(
    v_actor,
    'active',
    v_target,
    10,
    0
  );
  if v_active_flags ->> 'total' <> '1'
    or v_active_flags #>> '{items,0,status}' <> 'open'
    or v_active_flags #>> '{items,0,activeWarningCount}' <> '4'
    or v_active_flags #>> '{items,0,triggeredByActiveCount}' <> 'true'
    or v_active_flags #>> '{items,0,triggeredByFourteenDay}' <> 'true'
    or v_active_flags #>> '{items,0,events,0,eventType}' <> 'opened'
    or v_active_flags #>> '{items,0,events,1,eventType}' <> 'recomputed'
    or (v_active_flags -> 'items' -> 0) ?| array[
      'reason', 'comment', 'actorDiscordUserId', 'sourceCommentBody', 'warningId'
    ]
  then
    raise exception 'DEV_AUTO_FLAG_ACTIVE_PROJECTION_FAILED';
  end if;

  begin
    perform public.overrule_user_warning(
      v_actor,
      (v_second ->> 'warningId')::uuid,
      99,
      'Rollback-only stale correction.',
      '54000000-0000-4000-8000-000000000051'::uuid
    );
    raise exception 'DEV_WARNING_CORRECTION_STALE_VERSION_FAILED';
  exception when sqlstate 'PT409' then null;
  end;

  v_overrule_first := public.overrule_user_warning(
    v_actor,
    (v_first ->> 'warningId')::uuid,
    1,
    'Rollback-only bound correction reason one.',
    '54000000-0000-4000-8000-000000000061'::uuid
  );
  v_overrule_first_replay := public.overrule_user_warning(
    v_actor,
    (v_first ->> 'warningId')::uuid,
    1,
    'Rollback-only bound correction reason one.',
    '54000000-0000-4000-8000-000000000061'::uuid
  );

  if v_overrule_first ->> 'replayed' <> 'false'
    or v_overrule_first_replay ->> 'replayed' <> 'true'
    or (
      select count(*)
      from public.notification_events event_row
      where event_row.producer_key = 'user_warning_overruled:' || v_first_internal::text
        and event_row.event_type = 'user_warning_overruled'
        and event_row.owner_discord_user_id = v_target
    ) <> 1
    or (
      select count(*)
      from public.account_notifications notification
      join public.notification_events event_row on event_row.id = notification.event_id
      where event_row.producer_key = 'user_warning_overruled:' || v_first_internal::text
        and notification.owner_discord_user_id = v_target
        and notification.visible_in_product
    ) <> 1
    or exists (
      select 1
      from public.push_delivery_jobs delivery
      join public.notification_events event_row on event_row.id = delivery.event_id
      where event_row.producer_key = 'user_warning_overruled:' || v_first_internal::text
    )
  then
    raise exception 'DEV_WARNING_CORRECTION_NOTIFICATION_ONCE_FAILED';
  end if;

  v_owner_detail := public.get_own_user_warning_detail(
    v_session,
    (v_first ->> 'warningId')::uuid
  );
  if v_owner_detail ->> 'effectiveStatus' <> 'overruled'
    or (select count(*) from jsonb_object_keys(v_owner_detail)) <> 7
    or v_owner_detail ?| array[
      'issuedByDisplayName', 'actorDiscordUserId', 'correctionReason',
      'sourceCommentBody', 'autoFlag', 'targetDiscordUserId'
    ]
    or v_owner_detail::text like '%Rollback-only bound correction reason one.%'
  then
    raise exception 'DEV_WARNING_CORRECTION_OWNER_PRIVACY_FAILED';
  end if;

  v_owner_notifications := public.get_own_notifications(v_session, null, null, 50);
  if not exists (
    select 1
    from jsonb_array_elements(v_owner_notifications -> 'items') item
    where item ->> 'eventType' = 'user_warning_overruled'
      and item ->> 'title' = 'Account Warning corrected'
      and item ->> 'body' =
        'A Warning for your account was overruled. Review its current effective status.'
      and item ->> 'actionLabel' = 'View warning'
      and item::text not like '%Rollback-only bound correction reason one.%'
  ) then
    raise exception 'DEV_WARNING_CORRECTION_NOTIFICATION_COPY_FAILED';
  end if;

  v_overrule_second := public.overrule_user_warning(
    v_actor,
    (v_second ->> 'warningId')::uuid,
    2,
    'Rollback-only bound correction reason two.',
    '54000000-0000-4000-8000-000000000071'::uuid
  );

  if v_overrule_second #>> '{autoFlag,status}' <> 'closed'
    or v_overrule_second ->> 'activeWarningCount' <> '2'
    or (
      select count(*)
      from public.notification_events event_row
      where event_row.producer_key in (
        'user_warning_overruled:' || v_first_internal::text,
        'user_warning_overruled:' || v_second_internal::text
      )
    ) <> 2
  then
    raise exception 'DEV_WARNING_CORRECTION_CLOSE_FAILED';
  end if;

  v_history_flags := public.list_user_warning_auto_flag_cases(
    v_actor,
    'history',
    v_target,
    10,
    0
  );
  if v_history_flags ->> 'total' <> '1'
    or v_history_flags #>> '{items,0,status}' <> 'closed'
    or v_history_flags #>> '{items,0,activeWarningCount}' <> '2'
    or v_history_flags #>> '{items,0,triggeredByActiveCount}' <> 'false'
    or v_history_flags #>> '{items,0,triggeredByFourteenDay}' <> 'false'
    or v_history_flags #>> '{items,0,events,0,eventType}' <> 'opened'
    or v_history_flags #>> '{items,0,events,1,eventType}' <> 'recomputed'
    or v_history_flags #>> '{items,0,events,2,eventType}' <> 'recomputed'
    or v_history_flags #>> '{items,0,events,3,eventType}' <> 'closed'
    or (v_history_flags #>> '{items,0,closedAt}') is null
  then
    raise exception 'DEV_AUTO_FLAG_CLOSED_HISTORY_FAILED';
  end if;

  if (select count(*) from public.user_flag_cases) <> v_manual_case_count
    or (select count(*) from public.user_flag_events) <> v_manual_event_count
  then
    raise exception 'DEV_AUTO_FLAG_MANUAL_DOMAIN_MUTATED';
  end if;
end;
$contract$;

rollback;
