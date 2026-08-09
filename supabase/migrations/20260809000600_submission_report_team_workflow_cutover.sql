begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create temporary table submission_report_team_cutover_preflight on commit drop as
select
  (select count(*) from public.submission_report_cases) as case_count,
  (select count(*) from public.submission_reports) as report_count,
  (select count(*) from public.submission_report_payloads) as payload_count,
  (select count(*) from public.submission_report_case_events) as event_count,
  (select count(*) from public.submission_report_requests) as request_count,
  (select count(*) from public.submission_report_reads) as read_count;

do $preflight$
begin
  if (select count(*) from public.capability_catalog) <> 38
    or (select count(*) from public.capability_catalog where is_active) <> 31
    or (
      select count(*) from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 31
    or to_regclass('public.submission_report_reads') is null
    or to_regprocedure('public.submission_report_case_area(uuid)') is null
    or to_regprocedure('public.has_submission_report_capability_v2(text,text)') is null
    or to_regprocedure('public.authorize_submission_report_capability_v2(text,text)') is null
    or to_regprocedure('public.list_submission_report_cases_v2(text,text,integer)') is null
    or to_regprocedure('public.get_submission_report_case_summary_v2(text,uuid)') is null
    or to_regprocedure('public.get_submission_report_detail_v2(text,uuid)') is null
    or to_regprocedure('public.get_submission_report_unread_counts_v2(text)') is null
    or to_regprocedure(
      'public.manage_submission_report_case_v2(text,uuid,text,text,bigint,uuid,text,text,text,uuid)'
    ) is null then
    raise exception using errcode = '55000',
      message = 'SUBMISSION_REPORT_TEAM_CUTOVER_FOUNDATION_MISMATCH';
  end if;

  if not exists (
      select 1 from public.capability_catalog
      where key = 'submissions.reports.view'
        and is_active and assignable_to_non_admin
        and implementation_version = 1
        and definition_hash = '0f8bdec2e69427665a49067e4a2d2da7d4f81053b6f6e1f427cc262f26b7ef0e'
    ) or not exists (
      select 1 from public.capability_catalog
      where key = 'submissions.reports.review'
        and is_active and assignable_to_non_admin
        and implementation_version = 1
        and definition_hash = 'a9c1de7076eac2fd58052833930038f01e48e1ea37da51fb1f696508b11575f1'
    ) or (
      select count(*) from public.capability_catalog
      where (key, definition_hash) in (
        ('submissions.reports.live.view', 'aa31ce50a9b0cbf4862b9d35bde8f9e2219d90c3aedadce06eb0e1fba55d34b8'),
        ('submissions.reports.finalized.view', '7e6f885d45c6195034e836609f4bdea52f33180c47cea8dfae07c74ef5a1b49c'),
        ('submissions.reports.assign', '06859ad3c5905a08471186dbbde2bc90238f0758be4edcfe525507a4e3db2752'),
        ('logs.submission_reporters.view', 'a33f7a7290f09372bd03db6d4c0b8a8923b2c3ce18bcdd847493a58524658ca0'),
        ('logs.submission_report_moderation.view', '5d584c66b113a543755dab6730df8de30362c1d2b5dccc46f8b74019756c76f7')
      ) and not is_active and not assignable_to_non_admin
        and implementation_version = 1
    ) <> 5 then
    raise exception using errcode = '55000',
      message = 'SUBMISSION_REPORT_TEAM_CUTOVER_CAPABILITY_MISMATCH';
  end if;

  if exists (
      select 1 from public.team_role_capabilities
      where capability_key in (
        'submissions.reports.view',
        'submissions.reports.review',
        'submissions.reports.live.view',
        'submissions.reports.finalized.view',
        'submissions.reports.assign',
        'logs.submission_reporters.view',
        'logs.submission_report_moderation.view'
      )
    ) or exists (
      select 1 from public.submission_report_cases
      where (status = 'in_review') <> (assigned_to_discord_user_id is not null)
    ) or to_regprocedure(
      'public.list_submission_report_assignment_targets_v2(text,uuid)'
    ) is not null or to_regprocedure(
      'public.list_submission_report_moderation_events_v2(text,timestamptz,uuid,integer)'
    ) is not null then
    raise exception using errcode = '55000',
      message = 'SUBMISSION_REPORT_TEAM_CUTOVER_TARGET_MISMATCH';
  end if;
end;
$preflight$;

alter table public.submission_report_cases
  add constraint submission_report_cases_assignment_state_check check (
    (status = 'in_review') = (assigned_to_discord_user_id is not null)
  );

update public.capability_catalog
set display_name = 'View Submission Reports (Legacy)',
    description =
      'Legacy combined Submission Report queue and reporter-history permission retained only as a deprecated tombstone.',
    included_actions = array['No active application actions.']::text[],
    excluded_actions = array[
      'Viewing Live Cycle or Finalized Cycle Report queues.',
      'Viewing reporter-centered or workflow Submission Report logs.',
      'Claiming, reviewing, releasing, reassigning, or closing Report Cases.'
    ]::text[],
    risk_level = 'high',
    assignable_to_non_admin = false,
    is_active = false,
    implementation_version = 2,
    definition_hash = '1ac94f21aa019436dfae29e33349f7640fc3ea026586cb6c159c85b85245b1e9',
    deprecated_at = transaction_timestamp()
where key = 'submissions.reports.view';

update public.capability_catalog
set description =
      'Claim and work Submission Report Cases under the exact current-area View capability while all underlying moderation actions remain separately authorized.',
    included_actions = array[
      'Atomically claim an unassigned Case or recover one whose assignee is no longer eligible.',
      'Voluntarily release an owned Case and close an owned Case with an allowlisted outcome and note.',
      'Use expected status, row version, latest Report cursor, and idempotency on every workflow mutation.'
    ]::text[],
    excluded_actions = array[
      'Reading any Report queue or detail without the exact current-area View capability.',
      'Forcing release or reassignment of another eligible reviewer''s active claim without submissions.reports.assign.',
      'Disqualifying, reinstating, hiding, deleting, banning, or otherwise sanctioning users or Submissions.'
    ]::text[],
    implementation_version = 2,
    definition_hash = '6bcece6a9daf17fe71f5136d6d209ab283a0489c09146fa7b4f614f2b26b7153'
where key = 'submissions.reports.review';

update public.capability_catalog
set is_active = true,
    assignable_to_non_admin = true,
    definition_hash = case key
      when 'submissions.reports.live.view' then 'a32d78f7a26954a5465cd1f1ba05e871d0cf62e69721a7fa4cd83353562fa4fa'
      when 'submissions.reports.finalized.view' then '878dc43e7c22ec06a968fd6c7fa069f936688ef5da82db1caf80b7bf9c462a4f'
      when 'submissions.reports.assign' then 'cf3c1396e1e602aeaa628807427d219a93f3e06bef1f43971e9a61225d74ebe7'
      when 'logs.submission_reporters.view' then '854f3ddd41413b3223ed220d4f6a86d4f6f14436ce05de6d225dd255e6dc7846'
      when 'logs.submission_report_moderation.view' then '848b90d2b81ec364bd0c122cdd2e31ad68380d0e82d2f921c90467229e8108d7'
    end
where key in (
  'submissions.reports.live.view',
  'submissions.reports.finalized.view',
  'submissions.reports.assign',
  'logs.submission_reporters.view',
  'logs.submission_report_moderation.view'
);

create or replace function public.has_submission_report_capability_v2(
  p_actor_discord_user_id text,
  p_capability_key text
)
returns boolean language plpgsql stable security definer set search_path = public, pg_temp
as $function$
declare
  v_actor_id text := btrim(p_actor_discord_user_id);
  v_hash text;
  v_version integer;
  v_role text;
begin
  v_hash := case p_capability_key
    when 'submissions.reports.live.view' then 'a32d78f7a26954a5465cd1f1ba05e871d0cf62e69721a7fa4cd83353562fa4fa'
    when 'submissions.reports.finalized.view' then '878dc43e7c22ec06a968fd6c7fa069f936688ef5da82db1caf80b7bf9c462a4f'
    when 'submissions.reports.assign' then 'cf3c1396e1e602aeaa628807427d219a93f3e06bef1f43971e9a61225d74ebe7'
    when 'logs.submission_reporters.view' then '854f3ddd41413b3223ed220d4f6a86d4f6f14436ce05de6d225dd255e6dc7846'
    when 'logs.submission_report_moderation.view' then '848b90d2b81ec364bd0c122cdd2e31ad68380d0e82d2f921c90467229e8108d7'
    when 'submissions.reports.review' then '6bcece6a9daf17fe71f5136d6d209ab283a0489c09146fa7b4f614f2b26b7153'
    else null
  end;
  v_version := case p_capability_key
    when 'submissions.reports.review' then 2
    else 1
  end;
  if nullif(v_actor_id, '') is null or v_hash is null then return false; end if;
  if not exists (
    select 1 from public.capability_catalog
    where key = p_capability_key and is_active and assignable_to_non_admin
      and implementation_version = v_version and definition_hash = v_hash
  ) then return false; end if;
  select member.role into v_role
  from public.team_members member
  join public.team_roles role on role.key = member.role and role.is_active
  where member.discord_user_id = v_actor_id;
  if not found then return false; end if;
  return v_role = 'admin' or exists (
    select 1 from public.team_role_capabilities
    where role_key = v_role and capability_key = p_capability_key
  );
end;
$function$;

create or replace function public.list_submission_report_cases_v2(
  p_actor_discord_user_id text,
  p_area text,
  p_limit integer default 50
)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $function$
declare v_result jsonb; v_capability text; v_actor_id text := btrim(p_actor_discord_user_id);
begin
  if p_area not in ('live', 'finalized') or p_limit not between 1 and 50 then
    raise exception using errcode = '22023', message = 'SUBMISSION_REPORT_LIST_INVALID';
  end if;
  v_capability := case p_area when 'live' then 'submissions.reports.live.view'
    else 'submissions.reports.finalized.view' end;
  perform public.authorize_submission_report_capability_v2(v_actor_id, v_capability);
  select coalesce(jsonb_agg(item order by report_count desc, latest_report_at desc, case_id), '[]'::jsonb)
  into v_result
  from (
    select report_case.case_id, report_case.report_count, report_case.latest_report_at,
      jsonb_build_object(
        'caseId', report_case.case_id,
        'submissionId', report_case.submission_id,
        'cycleId', report_case.cycle_id,
        'status', report_case.status,
        'rowVersion', report_case.row_version,
        'reportCount', report_case.report_count,
        'latestReportId', report_case.latest_report_id,
        'latestReportAt', report_case.latest_report_at,
        'assignedToDisplayName', report_case.assigned_to_display_name,
        'assignedAt', report_case.assigned_at,
        'isAssignedToViewer', report_case.assigned_to_discord_user_id = v_actor_id,
        'assigneeEligible', case when report_case.assigned_to_discord_user_id is null
          then null else public.has_submission_report_capability_v2(
            report_case.assigned_to_discord_user_id, v_capability
          ) and public.has_submission_report_capability_v2(
            report_case.assigned_to_discord_user_id, 'submissions.reports.review'
          ) end,
        'currentCycleStatus', cycle.status::text,
        'currentVisibility', submission.public_visibility_status,
        'currentDisqualified', coalesce(submission.is_disqualified, false),
        'currentAvailable', submission.id is not null,
        'thumbnailAvailable', case
          when submission.id is not null
            and not coalesce(submission.is_disqualified, false)
            and coalesce(submission.public_visibility_status, '') = 'visible'
            and submission.r2_key is not null
          then true else false end,
        'unreadReportCount', (
          select count(*)::integer from public.submission_reports report
          where report.case_id = report_case.case_id
            and not exists (
              select 1 from public.submission_report_reads receipt
              where receipt.report_id = report.report_id
                and receipt.viewer_discord_user_id = v_actor_id
            )
        )
      ) item
    from public.submission_report_cases report_case
    left join public.submissions submission on submission.id = report_case.submission_id
    left join public.voting_cycles cycle on cycle.id = report_case.cycle_id
    where public.submission_report_case_area(report_case.case_id) = p_area
    order by report_case.report_count desc, report_case.latest_report_at desc, report_case.case_id
    limit p_limit
  ) page;
  return v_result;
end;
$function$;

create or replace function public.get_submission_report_case_summary_v2(
  p_actor_discord_user_id text,
  p_case_id uuid
)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $function$
declare
  v_actor_id text := btrim(p_actor_discord_user_id);
  v_area text;
  v_capability text;
  v_result jsonb;
begin
  v_area := public.submission_report_case_area(p_case_id);
  if v_area is null then
    raise exception using errcode = 'P0002', message = 'SUBMISSION_REPORT_CASE_NOT_FOUND';
  end if;
  v_capability := case v_area when 'live' then 'submissions.reports.live.view'
    else 'submissions.reports.finalized.view' end;
  perform public.authorize_submission_report_capability_v2(v_actor_id, v_capability);
  select jsonb_build_object(
    'caseId', report_case.case_id,
    'submissionId', report_case.submission_id,
    'cycleId', report_case.cycle_id,
    'area', v_area,
    'status', report_case.status,
    'rowVersion', report_case.row_version,
    'reportCount', report_case.report_count,
    'latestReportId', report_case.latest_report_id,
    'latestReportAt', report_case.latest_report_at,
    'assignedToDisplayName', report_case.assigned_to_display_name,
    'assignedAt', report_case.assigned_at,
    'isAssignedToViewer', report_case.assigned_to_discord_user_id = v_actor_id,
    'assigneeEligible', case when report_case.assigned_to_discord_user_id is null
      then null else public.has_submission_report_capability_v2(
        report_case.assigned_to_discord_user_id, v_capability
      ) and public.has_submission_report_capability_v2(
        report_case.assigned_to_discord_user_id, 'submissions.reports.review'
      ) end,
    'closedAt', report_case.closed_at,
    'closeDisposition', report_case.close_disposition,
    'currentCycleStatus', cycle.status::text,
    'currentVisibility', submission.public_visibility_status,
    'currentDisqualified', coalesce(submission.is_disqualified, false),
    'currentAvailable', submission.id is not null,
    'uploaderLabel', case when submission.id is null then null else coalesce(
      nullif(btrim(uploader_log.current_display_name), ''),
      nullif(btrim(uploader_log.current_guild_nickname), ''),
      nullif(btrim(uploader_log.current_discord_username), ''),
      'Uploader'
    ) end,
    'currentVoteCount', (
      select count(*)::integer from public.votes vote
      where vote.submission_id = report_case.submission_id
    ),
    'reports', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'reportId', report.report_id,
        'createdAt', report.created_at,
        'reasonCode', report.reason_code,
        'subcategoryCode', report.subcategory_code,
        'phaseSnapshot', report.phase_snapshot,
        'isRead', receipt.report_id is not null
      ) order by report.created_at, report.report_id), '[]'::jsonb)
      from public.submission_reports report
      left join public.submission_report_reads receipt
        on receipt.report_id = report.report_id
       and receipt.viewer_discord_user_id = v_actor_id
      where report.case_id = report_case.case_id
    )
  ) into v_result
  from public.submission_report_cases report_case
  left join public.submissions submission on submission.id = report_case.submission_id
  left join public.user_logs uploader_log
    on uploader_log.discord_user_id = submission.discord_user_id
  left join public.voting_cycles cycle on cycle.id = report_case.cycle_id
  where report_case.case_id = p_case_id;
  return v_result;
end;
$function$;

create function public.list_submission_report_assignment_targets_v2(
  p_actor_discord_user_id text,
  p_case_id uuid
)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $function$
declare
  v_area text;
  v_view_capability text;
  v_result jsonb;
begin
  v_area := public.submission_report_case_area(p_case_id);
  if v_area is null then
    raise exception using errcode = 'P0002', message = 'SUBMISSION_REPORT_CASE_NOT_FOUND';
  end if;
  v_view_capability := case v_area when 'live' then 'submissions.reports.live.view'
    else 'submissions.reports.finalized.view' end;
  perform public.authorize_submission_report_capability_v2(
    p_actor_discord_user_id, v_view_capability
  );
  perform public.authorize_submission_report_capability_v2(
    p_actor_discord_user_id, 'submissions.reports.review'
  );
  perform public.authorize_submission_report_capability_v2(
    p_actor_discord_user_id, 'submissions.reports.assign'
  );
  select coalesce(jsonb_agg(jsonb_build_object(
    'discordUserId', member.discord_user_id,
    'displayName', coalesce(
      nullif(btrim(user_log.current_display_name), ''),
      nullif(btrim(user_log.current_guild_nickname), ''),
      nullif(btrim(user_log.current_discord_username), ''),
      member.discord_username,
      'Team member'
    ),
    'roleKey', member.role
  ) order by member.role, member.discord_user_id), '[]'::jsonb)
  into v_result
  from public.team_members member
  join public.team_roles role on role.key = member.role and role.is_active
  left join public.user_logs user_log on user_log.discord_user_id = member.discord_user_id
  where public.has_submission_report_capability_v2(
      member.discord_user_id, v_view_capability
    ) and public.has_submission_report_capability_v2(
      member.discord_user_id, 'submissions.reports.review'
    ) and member.discord_user_id is distinct from (
      select report_case.assigned_to_discord_user_id
      from public.submission_report_cases report_case
      where report_case.case_id = p_case_id
    );
  return v_result;
end;
$function$;

create or replace function public.list_submission_reporter_profiles(
  p_actor_discord_user_id text,
  p_limit integer default 50
)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $function$
declare v_result jsonb;
begin
  perform public.authorize_submission_report_capability_v2(
    p_actor_discord_user_id, 'logs.submission_reporters.view'
  );
  if p_limit not between 1 and 50 then
    raise exception using errcode = '22023', message = 'SUBMISSION_REPORT_LIST_INVALID';
  end if;
  select coalesce(jsonb_agg(item order by latest_report_at desc, public_profile_id), '[]'::jsonb)
  into v_result from (
    select user_log.public_profile_id, max(report.created_at) latest_report_at,
      jsonb_build_object(
        'publicProfileId', user_log.public_profile_id,
        'label', coalesce(
          nullif(btrim(user_log.current_display_name), ''),
          nullif(btrim(user_log.current_guild_nickname), ''),
          nullif(btrim(user_log.current_discord_username), ''), 'Reporter'
        ),
        'reportCount', count(*)::integer,
        'actionTakenCaseCount', count(distinct report.case_id) filter (
          where case_row.status = 'closed'
            and case_row.close_disposition = 'action_taken'
        )::integer,
        'latestReportAt', max(report.created_at)
      ) item
    from public.submission_reports report
    join public.submission_reporter_identities identity
      on identity.identity_id = report.reporter_identity_id
    join public.user_logs user_log on user_log.discord_user_id = identity.discord_user_id
    join public.submission_report_cases case_row on case_row.case_id = report.case_id
    where identity.anonymized_at is null
    group by user_log.public_profile_id, user_log.current_display_name,
      user_log.current_guild_nickname, user_log.current_discord_username
    order by latest_report_at desc, user_log.public_profile_id
    limit p_limit
  ) page;
  return v_result;
end;
$function$;

create or replace function public.get_submission_reporter_history(
  p_actor_discord_user_id text,
  p_public_profile_id uuid,
  p_limit integer default 100
)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $function$
declare v_target_id text; v_label text; v_result jsonb;
begin
  perform public.authorize_submission_report_capability_v2(
    p_actor_discord_user_id, 'logs.submission_reporters.view'
  );
  if p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'SUBMISSION_REPORT_LIST_INVALID';
  end if;
  select discord_user_id, coalesce(
    nullif(btrim(current_display_name), ''), nullif(btrim(current_guild_nickname), ''),
    nullif(btrim(current_discord_username), ''), 'Reporter'
  ) into v_target_id, v_label
  from public.user_logs where public_profile_id = p_public_profile_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'SUBMISSION_REPORT_REPORTER_NOT_FOUND';
  end if;
  select jsonb_build_object(
    'publicProfileId', p_public_profile_id,
    'label', v_label,
    'reportCount', count(*)::integer,
    'actionTakenCaseCount', count(*) filter (
      where case_status = 'closed' and close_disposition = 'action_taken'
    )::integer,
    'reports', coalesce(jsonb_agg(item order by created_at desc, report_id desc), '[]'::jsonb)
  ) into v_result from (
    select report.created_at, report.report_id, case_row.status case_status,
      case_row.close_disposition,
      jsonb_build_object(
        'reportId', report.report_id,
        'caseId', report.case_id,
        'caseArea', public.submission_report_case_area(report.case_id),
        'submissionId', report.submission_id,
        'cycleId', report.cycle_id,
        'createdAt', report.created_at,
        'reasonCode', report.reason_code,
        'subcategoryCode', report.subcategory_code,
        'comment', payload.reporter_comment,
        'phaseSnapshot', report.phase_snapshot,
        'caseStatus', case_row.status,
        'closeDisposition', case_row.close_disposition,
        'outcomeCode', case
          when case_row.status = 'open' then 'report_received'
          when case_row.status = 'in_review' then 'under_review'
          when case_row.close_disposition = 'action_taken' then 'action_taken_after_review'
          when case_row.close_disposition = 'no_action_current_rules' then 'reviewed_no_action_current_rules'
          when case_row.close_disposition = 'submission_unavailable' then 'closed_submission_unavailable'
          else 'included_in_completed_review'
        end,
        'currentAvailable', submission.id is not null,
        'currentVisibility', submission.public_visibility_status,
        'currentDisqualified', coalesce(submission.is_disqualified, false)
      ) item
    from public.submission_reports report
    join public.submission_reporter_identities identity
      on identity.identity_id = report.reporter_identity_id
    join public.submission_report_cases case_row on case_row.case_id = report.case_id
    left join public.submission_report_payloads payload on payload.report_id = report.report_id
    left join public.submissions submission on submission.id = report.submission_id
    where identity.discord_user_id = v_target_id and identity.anonymized_at is null
    order by report.created_at desc, report.report_id desc
    limit p_limit
  ) page;
  return v_result;
end;
$function$;

create function public.list_submission_report_moderation_events_v2(
  p_actor_discord_user_id text,
  p_before_occurred_at timestamptz default null,
  p_before_event_id uuid default null,
  p_limit integer default 50
)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $function$
declare v_role text; v_result jsonb;
begin
  v_role := public.authorize_submission_report_capability_v2(
    p_actor_discord_user_id, 'logs.submission_report_moderation.view'
  );
  if (p_before_occurred_at is null) <> (p_before_event_id is null)
    or p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'SUBMISSION_REPORT_LIST_INVALID';
  end if;
  with page as (
    select event.occurred_at, event.event_id, jsonb_build_object(
      'eventId', event.event_id,
      'caseId', event.case_id,
      'caseArea', public.submission_report_case_area(event.case_id),
      'submissionId', report_case.submission_id,
      'cycleId', report_case.cycle_id,
      'eventType', event.event_type,
      'previousStatus', event.previous_status,
      'newStatus', event.new_status,
      'actorDisplayName', event.actor_display_name,
      'actorRoleKey', event.actor_role_key,
      'actorDiscordUserId', case when v_role = 'admin'
        then event.actor_discord_user_id else null end,
      'occurredAt', event.occurred_at,
      'disposition', event.disposition,
      'note', case when v_role = 'admin' then event.note else null end,
      'caseVersion', event.case_version,
      'previousAssigneeDisplayName', event.previous_assignee_display_name,
      'newAssigneeDisplayName', event.new_assignee_display_name
    ) item
    from public.submission_report_case_events event
    join public.submission_report_cases report_case on report_case.case_id = event.case_id
    where p_before_occurred_at is null
      or (event.occurred_at, event.event_id) < (p_before_occurred_at, p_before_event_id)
    order by event.occurred_at desc, event.event_id desc
    limit p_limit + 1
  ), visible as (
    select * from page order by occurred_at desc, event_id desc limit p_limit
  )
  select jsonb_build_object(
    'events', coalesce(
      (select jsonb_agg(item order by occurred_at desc, event_id desc) from visible),
      '[]'::jsonb
    ),
    'nextCursor', case when (select count(*) from page) > p_limit then (
      select jsonb_build_object('occurredAt', occurred_at, 'eventId', event_id)
      from visible order by occurred_at desc, event_id desc
      offset p_limit - 1 limit 1
    ) else null end
  ) into v_result;
  return v_result;
end;
$function$;

alter function public.has_submission_report_capability_v2(text, text) owner to postgres;
alter function public.list_submission_report_cases_v2(text, text, integer) owner to postgres;
alter function public.get_submission_report_case_summary_v2(text, uuid) owner to postgres;
alter function public.list_submission_report_assignment_targets_v2(text, uuid) owner to postgres;
alter function public.list_submission_reporter_profiles(text, integer) owner to postgres;
alter function public.get_submission_reporter_history(text, uuid, integer) owner to postgres;
alter function public.list_submission_report_moderation_events_v2(
  text, timestamptz, uuid, integer
) owner to postgres;

revoke execute on function public.list_submission_report_cases(text, integer)
  from service_role;
revoke execute on function public.get_submission_report_case(text, uuid)
  from service_role;
revoke execute on function public.review_submission_report_case(
  text, uuid, text, text, bigint, uuid, text, text, uuid
) from service_role;

revoke all on function public.list_submission_report_assignment_targets_v2(text, uuid)
  from public, anon, authenticated, discord_bot;
revoke all on function public.list_submission_report_moderation_events_v2(
  text, timestamptz, uuid, integer
) from public, anon, authenticated, discord_bot;
grant execute on function public.list_submission_report_assignment_targets_v2(text, uuid)
  to service_role;
grant execute on function public.list_submission_report_moderation_events_v2(
  text, timestamptz, uuid, integer
) to service_role;

do $postflight$
declare
  v_preflight submission_report_team_cutover_preflight%rowtype;
  v_signature text;
  v_function regprocedure;
begin
  select * into strict v_preflight from submission_report_team_cutover_preflight;
  if (select count(*) from public.capability_catalog) <> 38
    or (select count(*) from public.capability_catalog where is_active) <> 35
    or (
      select count(*) from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 35
    or not exists (
      select 1 from public.capability_catalog
      where key = 'submissions.reports.view'
        and not is_active and not assignable_to_non_admin
        and implementation_version = 2
        and definition_hash = '1ac94f21aa019436dfae29e33349f7640fc3ea026586cb6c159c85b85245b1e9'
        and deprecated_at is not null
    ) or not exists (
      select 1 from public.capability_catalog
      where key = 'submissions.reports.review'
        and is_active and assignable_to_non_admin
        and implementation_version = 2
        and definition_hash = '6bcece6a9daf17fe71f5136d6d209ab283a0489c09146fa7b4f614f2b26b7153'
    ) or (
      select count(*) from public.capability_catalog
      where (key, definition_hash) in (
        ('submissions.reports.live.view', 'a32d78f7a26954a5465cd1f1ba05e871d0cf62e69721a7fa4cd83353562fa4fa'),
        ('submissions.reports.finalized.view', '878dc43e7c22ec06a968fd6c7fa069f936688ef5da82db1caf80b7bf9c462a4f'),
        ('submissions.reports.assign', 'cf3c1396e1e602aeaa628807427d219a93f3e06bef1f43971e9a61225d74ebe7'),
        ('logs.submission_reporters.view', '854f3ddd41413b3223ed220d4f6a86d4f6f14436ce05de6d225dd255e6dc7846'),
        ('logs.submission_report_moderation.view', '848b90d2b81ec364bd0c122cdd2e31ad68380d0e82d2f921c90467229e8108d7')
      ) and is_active and assignable_to_non_admin
    ) <> 5
    or exists (
      select 1 from public.team_role_capabilities
      where capability_key in (
        'submissions.reports.view', 'submissions.reports.review',
        'submissions.reports.live.view', 'submissions.reports.finalized.view',
        'submissions.reports.assign', 'logs.submission_reporters.view',
        'logs.submission_report_moderation.view'
      )
    ) then
    raise exception using errcode = '55000',
      message = 'SUBMISSION_REPORT_TEAM_CUTOVER_CATALOG_POSTFLIGHT_MISMATCH';
  end if;

  if v_preflight.case_count <> (select count(*) from public.submission_report_cases)
    or v_preflight.report_count <> (select count(*) from public.submission_reports)
    or v_preflight.payload_count <> (select count(*) from public.submission_report_payloads)
    or v_preflight.event_count <> (select count(*) from public.submission_report_case_events)
    or v_preflight.request_count <> (select count(*) from public.submission_report_requests)
    or v_preflight.read_count <> (select count(*) from public.submission_report_reads)
    or exists (
      select 1 from public.submission_report_cases
      where (status = 'in_review') <> (assigned_to_discord_user_id is not null)
    ) then
    raise exception using errcode = '55000',
      message = 'SUBMISSION_REPORT_TEAM_CUTOVER_FACT_POSTFLIGHT_MISMATCH';
  end if;

  if has_function_privilege(
      'service_role', 'public.list_submission_report_cases(text,integer)', 'EXECUTE'
    ) or has_function_privilege(
      'service_role', 'public.get_submission_report_case(text,uuid)', 'EXECUTE'
    ) or has_function_privilege(
      'service_role',
      'public.review_submission_report_case(text,uuid,text,text,bigint,uuid,text,text,uuid)',
      'EXECUTE'
    ) or not has_function_privilege(
      'service_role',
      'public.list_submission_report_assignment_targets_v2(text,uuid)',
      'EXECUTE'
    ) or not has_function_privilege(
      'service_role',
      'public.list_submission_report_moderation_events_v2(text,timestamptz,uuid,integer)',
      'EXECUTE'
    ) or has_function_privilege(
      'anon',
      'public.list_submission_report_moderation_events_v2(text,timestamptz,uuid,integer)',
      'EXECUTE'
    ) then
    raise exception using errcode = '55000',
      message = 'SUBMISSION_REPORT_TEAM_CUTOVER_ACL_POSTFLIGHT_MISMATCH';
  end if;

  if (
      select count(*) from pg_proc function_row
      join pg_namespace namespace_row on namespace_row.oid = function_row.pronamespace
      where namespace_row.nspname = 'public'
        and function_row.proname in (
          'submission_report_case_area',
          'has_submission_report_capability_v2',
          'authorize_submission_report_capability_v2',
          'list_submission_report_cases_v2',
          'get_submission_report_case_summary_v2',
          'get_submission_report_detail_v2',
          'get_submission_report_unread_counts_v2',
          'manage_submission_report_case_v2',
          'list_submission_report_assignment_targets_v2',
          'list_submission_reporter_profiles',
          'get_submission_reporter_history',
          'list_submission_report_moderation_events_v2'
        )
        and function_row.prosecdef
        and function_row.proowner = (select oid from pg_roles where rolname = 'postgres')
        and function_row.proconfig = array['search_path=public, pg_temp']
    ) <> 12 then
    raise exception using errcode = '55000',
      message = 'SUBMISSION_REPORT_TEAM_CUTOVER_FUNCTION_HARDENING_MISMATCH';
  end if;

  foreach v_signature in array array[
    'public.list_submission_report_cases_v2(text,text,integer)',
    'public.get_submission_report_case_summary_v2(text,uuid)',
    'public.get_submission_report_detail_v2(text,uuid)',
    'public.get_submission_report_unread_counts_v2(text)',
    'public.manage_submission_report_case_v2(text,uuid,text,text,bigint,uuid,text,text,text,uuid)',
    'public.list_submission_report_assignment_targets_v2(text,uuid)',
    'public.list_submission_reporter_profiles(text,integer)',
    'public.get_submission_reporter_history(text,uuid,integer)',
    'public.list_submission_report_moderation_events_v2(text,timestamptz,uuid,integer)'
  ] loop
    v_function := to_regprocedure(v_signature);
    if v_function is null
      or (
        select count(*) from pg_proc function_row
        cross join lateral aclexplode(
          coalesce(function_row.proacl, acldefault('f', function_row.proowner))
        ) privilege_row
        where function_row.oid = v_function
          and privilege_row.privilege_type = 'EXECUTE'
      ) <> 2
      or not has_function_privilege('service_role', v_function, 'EXECUTE')
      or has_function_privilege('anon', v_function, 'EXECUTE')
      or has_function_privilege('authenticated', v_function, 'EXECUTE')
      or has_function_privilege('discord_bot', v_function, 'EXECUTE') then
      raise exception using errcode = '55000',
        message = 'SUBMISSION_REPORT_TEAM_CUTOVER_ENTRY_ACL_MISMATCH',
        detail = v_signature;
    end if;
  end loop;

  foreach v_signature in array array[
    'public.submission_report_case_area(uuid)',
    'public.has_submission_report_capability_v2(text,text)',
    'public.authorize_submission_report_capability_v2(text,text)'
  ] loop
    v_function := to_regprocedure(v_signature);
    if v_function is null
      or (
        select count(*) from pg_proc function_row
        cross join lateral aclexplode(
          coalesce(function_row.proacl, acldefault('f', function_row.proowner))
        ) privilege_row
        where function_row.oid = v_function
          and privilege_row.privilege_type = 'EXECUTE'
      ) <> 1
      or has_function_privilege('service_role', v_function, 'EXECUTE')
      or has_function_privilege('anon', v_function, 'EXECUTE')
      or has_function_privilege('authenticated', v_function, 'EXECUTE')
      or has_function_privilege('discord_bot', v_function, 'EXECUTE') then
      raise exception using errcode = '55000',
        message = 'SUBMISSION_REPORT_TEAM_CUTOVER_HELPER_ACL_MISMATCH',
        detail = v_signature;
    end if;
  end loop;
end;
$postflight$;

comment on function public.list_submission_report_moderation_events_v2(
  text, timestamptz, uuid, integer
) is 'Capability-guarded, cursor-paginated Submission Report workflow audit. Delegated viewers receive no stable actor IDs or free-text notes.';

commit;
