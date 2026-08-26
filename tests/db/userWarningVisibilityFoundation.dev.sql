\set ON_ERROR_STOP on

begin;

set local lock_timeout = '10s';
set local statement_timeout = '90s';

do $preflight$
begin
  if (select count(*) from public.capability_catalog) <> 52
    or (select count(*) from public.capability_catalog where is_active) <> 48
    or exists (
      select 1 from public.team_role_capabilities
      where capability_key = 'users.warnings.view'
    )
    or not exists (
      select 1 from public.notification_category_catalog
      where category_key = 'account_warnings'
        and required_in_product
        and not in_product_available
        and not push_available
    )
    or to_regprocedure('public.get_own_user_warning_detail(uuid,uuid)') is null
    or to_regprocedure('public.get_user_warning_team_history(text,text)') is null
    or to_regprocedure('public.get_user_warning_team_summaries(text,text[])') is null
  then
    raise exception 'DEV_USER_WARNING_VISIBILITY_PREFLIGHT_DRIFT';
  end if;
end;
$preflight$;

do $contract$
declare
  v_actor text;
  v_target text;
  v_session uuid;
  v_public_comment_id uuid;
  v_object_version bigint;
  v_text_version bigint;
  v_request_id uuid := '53000000-0000-4000-8000-000000000001'::uuid;
  v_receipt jsonb;
  v_replay jsonb;
  v_warning_id uuid;
  v_public_warning_id uuid;
  v_notification_id uuid;
  v_owner_detail jsonb;
  v_team_history jsonb;
  v_summary jsonb;
  v_overrule jsonb;
begin
  select member.discord_user_id
  into v_actor
  from public.team_members member
  where member.role = 'admin'
  order by member.discord_user_id
  limit 1;

  select
    comment_row.author_discord_user_id,
    session_row.id,
    comment_row.public_comment_id,
    comment_row.object_version,
    comment_row.current_text_version
  into
    v_target,
    v_session,
    v_public_comment_id,
    v_object_version,
    v_text_version
  from public.community_comments comment_row
  join public.community_comment_text_versions text_version
    on text_version.comment_id = comment_row.id
   and text_version.version = comment_row.current_text_version
  join public.sessions session_row
    on session_row.discord_user_id = comment_row.author_discord_user_id
   and session_row.revoked_at is null
  where comment_row.author_deleted_at is null
    and text_version.normalized_body is not null
    and public.is_community_comment_submission_eligible(comment_row.submission_id)
    and not exists (
      select 1 from public.user_warnings warning_row
      where warning_row.source_comment_id = comment_row.id
    )
  order by session_row.created_at desc, comment_row.created_at, comment_row.public_comment_id
  limit 1;

  if v_actor is null or v_target is null or v_session is null then
    raise exception 'DEV_USER_WARNING_VISIBILITY_FIXTURE_UNAVAILABLE';
  end if;

  begin
    perform public.get_user_warning_team_history(
      'user-warning-visibility-unauthorized',
      v_target
    );
    raise exception 'DEV_USER_WARNING_VISIBILITY_CAPABILITY_DENIAL_FAILED';
  exception when sqlstate '42501' then null;
  end;

  v_receipt := public.issue_user_warning(
    v_actor,
    v_public_comment_id,
    v_object_version,
    v_text_version,
    'other',
    'Rollback-only Warning visibility contract.',
    v_request_id
  );
  v_replay := public.issue_user_warning(
    v_actor,
    v_public_comment_id,
    v_object_version,
    v_text_version,
    'other',
    'Rollback-only Warning visibility contract.',
    v_request_id
  );

  if v_receipt ->> 'replayed' <> 'false'
    or v_replay ->> 'replayed' <> 'true'
    or v_replay ->> 'warningId' <> v_receipt ->> 'warningId'
  then
    raise exception 'DEV_USER_WARNING_VISIBILITY_REPLAY_FAILED';
  end if;

  v_public_warning_id := (v_receipt ->> 'warningId')::uuid;
  select warning_row.warning_id
  into v_warning_id
  from public.user_warnings warning_row
  where warning_row.public_warning_id = v_public_warning_id;

  select notification.id
  into v_notification_id
  from public.notification_events event_row
  join public.account_notifications notification
    on notification.event_id = event_row.id
  where event_row.producer_key = 'user_warning_issued:' || v_warning_id::text
    and event_row.event_type = 'user_warning_issued'
    and event_row.category_key = 'account_warnings'
    and event_row.owner_discord_user_id = v_target
    and event_row.deep_link = '/warnings/' || v_public_warning_id::text
    and notification.owner_discord_user_id = v_target
    and notification.visible_in_product;

  if v_notification_id is null
    or (
      select count(*) from public.notification_events event_row
      where event_row.producer_key = 'user_warning_issued:' || v_warning_id::text
    ) <> 1
    or (
      select count(*) from public.account_notifications notification
      where notification.id = v_notification_id
    ) <> 1
    or exists (
      select 1 from public.push_delivery_jobs delivery
      where delivery.notification_id = v_notification_id
    )
  then
    raise exception 'DEV_USER_WARNING_VISIBILITY_NOTIFICATION_FAILED';
  end if;

  v_owner_detail := public.get_own_user_warning_detail(v_session, v_public_warning_id);
  if v_owner_detail ->> 'outcome' <> 'found'
    or v_owner_detail ->> 'category' <> 'other'
    or v_owner_detail ->> 'reason' <> 'Rollback-only Warning visibility contract.'
    or v_owner_detail ->> 'effectiveStatus' <> 'active'
    or (select count(*) from jsonb_object_keys(v_owner_detail)) <> 7
    or v_owner_detail ?| array[
      'issuedByDisplayName', 'issuedByRoleKey', 'actorDiscordUserId',
      'sourceCommentBody', 'autoFlag', 'targetDiscordUserId'
    ]
  then
    raise exception 'DEV_USER_WARNING_VISIBILITY_OWNER_PROJECTION_FAILED';
  end if;

  v_team_history := public.get_user_warning_team_history(v_actor, v_target);
  if v_team_history ->> 'outcome' <> 'found'
    or jsonb_array_length(v_team_history -> 'warnings') < 1
    or not ((v_team_history -> 'warnings' -> 0) ? 'sourceCommentBody')
    or not ((v_team_history -> 'warnings' -> 0) ? 'events')
    or (v_team_history -> 'warnings' -> 0) ? 'autoFlag'
  then
    raise exception 'DEV_USER_WARNING_VISIBILITY_TEAM_PROJECTION_FAILED';
  end if;

  v_summary := public.get_user_warning_team_summaries(v_actor, array[v_target]);
  if jsonb_array_length(v_summary -> 'items') <> 1
    or v_summary #>> '{items,0,targetDiscordUserId}' <> v_target
    or (v_summary -> 'items' -> 0) ?| array[
      'reason', 'sourceCommentBody', 'events', 'issuedByDisplayName', 'autoFlag'
    ]
  then
    raise exception 'DEV_USER_WARNING_VISIBILITY_SUMMARY_FAILED';
  end if;

  v_overrule := public.overrule_user_warning(
    v_actor,
    v_public_warning_id,
    1,
    'Rollback-only correction visibility check.',
    '53000000-0000-4000-8000-000000000002'::uuid
  );
  if v_overrule ->> 'state' <> 'overruled'
    or public.get_own_user_warning_detail(v_session, v_public_warning_id)
      ->> 'effectiveStatus' <> 'overruled'
    or public.get_user_warning_team_history(v_actor, v_target)
      #>> '{warnings,0,effectiveStatus}' <> 'overruled'
  then
    raise exception 'DEV_USER_WARNING_VISIBILITY_OVERRULE_READ_FAILED';
  end if;
end;
$contract$;

rollback;
