begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create temporary table submission_report_team_workflow_preflight on commit drop as
select
  (select count(*) from public.submission_report_cases) as case_count,
  (select count(*) from public.submission_reports) as report_count,
  (select count(*) from public.submission_report_payloads) as payload_count,
  (select count(*) from public.submission_report_case_events) as event_count,
  (select count(*) from public.submission_report_requests) as request_count;

do $preflight$
begin
  if (select count(*) from public.capability_catalog) <> 33
    or (select count(*) from public.capability_catalog where is_active) <> 31
    or (
      select count(*) from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 31
    or to_regclass('public.submission_report_cases') is null
    or to_regclass('public.submission_reports') is null
    or to_regclass('public.submission_report_payloads') is null
    or to_regclass('public.submission_report_case_events') is null
    or to_regclass('public.submission_report_requests') is null
    or to_regclass('public.team_members') is null
    or to_regclass('public.team_roles') is null
    or to_regclass('public.team_role_capabilities') is null
    or to_regclass('public.submissions') is null
    or to_regclass('public.votes') is null
    or to_regclass('public.voting_cycles') is null then
    raise exception using errcode = '55000',
      message = 'SUBMISSION_REPORT_TEAM_WORKFLOW_BASELINE_MISMATCH';
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
    ) or exists (
      select 1 from public.team_role_capabilities
      where capability_key in (
        'submissions.reports.view', 'submissions.reports.review'
      )
    ) then
    raise exception using errcode = '55000',
      message = 'SUBMISSION_REPORT_TEAM_WORKFLOW_PREDECESSOR_MISMATCH';
  end if;

  if exists (
      select 1 from public.capability_catalog
      where key in (
        'submissions.reports.live.view',
        'submissions.reports.finalized.view',
        'submissions.reports.assign',
        'logs.submission_reporters.view',
        'logs.submission_report_moderation.view'
      )
    ) or to_regclass('public.submission_report_reads') is not null
    or exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'submission_report_cases'
        and column_name in (
          'assigned_to_discord_user_id', 'assigned_to_display_name', 'assigned_at'
        )
    )
    or to_regprocedure('public.submission_report_case_area(uuid)') is not null
    or to_regprocedure('public.list_submission_report_cases_v2(text,text,integer)') is not null
    or to_regprocedure('public.get_submission_report_case_summary_v2(text,uuid)') is not null
    or to_regprocedure('public.get_submission_report_detail_v2(text,uuid)') is not null
    or to_regprocedure('public.get_submission_report_unread_counts_v2(text)') is not null
    or to_regprocedure(
      'public.manage_submission_report_case_v2(text,uuid,text,text,bigint,uuid,text,text,text,uuid)'
    ) is not null then
    raise exception using errcode = '55000',
      message = 'SUBMISSION_REPORT_TEAM_WORKFLOW_TARGET_ALREADY_PRESENT';
  end if;
end;
$preflight$;

insert into public.capability_catalog (
  key, display_name, description, category, included_actions,
  excluded_actions, risk_level, assignable_to_non_admin, is_active,
  implementation_version, definition_hash
)
values
  (
    'submissions.reports.live.view',
    'View Live Cycle Submission Reports',
    'View case-centered Submission Reports for current and pre-finalization Cycles without changing workflow or moderation state.',
    'Submission Moderation',
    array[
      'View bounded Live Cycle Report queue and Case summaries.',
      'View minimal Report summaries and one authorized full Report detail.',
      'Receive viewer-specific unread counts only for Live Cycle Reports.'
    ]::text[],
    array[
      'Viewing Finalized Cycle Reports or reporter-centered and workflow logs.',
      'Claiming, reviewing, releasing, reassigning, or closing Report Cases.',
      'Disqualifying, reinstating, hiding, deleting, banning, or otherwise sanctioning users or Submissions.'
    ]::text[],
    'high', false, false, 1,
    'aa31ce50a9b0cbf4862b9d35bde8f9e2219d90c3aedadce06eb0e1fba55d34b8'
  ),
  (
    'submissions.reports.finalized.view',
    'View Finalized Cycle Submission Reports',
    'View case-centered Submission Reports for finalized Cycles and safe unavailable-state fallbacks without changing workflow or moderation state.',
    'Submission Moderation',
    array[
      'View bounded Finalized Cycle Report queue and Case summaries.',
      'View minimal Report summaries and one authorized full Report detail.',
      'Receive viewer-specific unread counts only for Finalized Cycle Reports.'
    ]::text[],
    array[
      'Viewing Live Cycle Reports or reporter-centered and workflow logs.',
      'Claiming, reviewing, releasing, reassigning, or closing Report Cases.',
      'Disqualifying, reinstating, hiding, deleting, banning, or otherwise sanctioning users or Submissions.'
    ]::text[],
    'high', false, false, 1,
    '7e6f885d45c6195034e836609f4bdea52f33180c47cea8dfae07c74ef5a1b49c'
  ),
  (
    'submissions.reports.assign',
    'Reassign Submission Report Cases',
    'Force-release or reassign an actively claimed Submission Report Case under exact area-view and optimistic-concurrency checks.',
    'Submission Moderation',
    array[
      'Force-release an actively claimed Report Case with an auditable reason.',
      'Reassign an actively claimed Report Case to an eligible current Team reviewer.'
    ]::text[],
    array[
      'Viewing any Report queue or detail without the exact Live or Finalized View capability.',
      'Claiming unassigned Cases, voluntarily releasing own Cases, reviewing, or closing Cases without submissions.reports.review.',
      'Performing any underlying Submission or User moderation action.'
    ]::text[],
    'high', false, false, 1,
    '06859ad3c5905a08471186dbbde2bc90238f0758be4edcfe525507a4e3db2752'
  ),
  (
    'logs.submission_reporters.view',
    'View Submission Reporter User Logs',
    'View reporter-centered Submission Report history as neutral human-review context without a reporter score or workflow access.',
    'Submission Report Logs',
    array[
      'View a reporter-centered list and bounded Submission Report history.',
      'View neutral counts of Reports in Cases closed with action without attributing causality.'
    ]::text[],
    array[
      'Viewing Live or Finalized Case queues, full Case workflow history, or unread badges.',
      'Claiming, reviewing, releasing, reassigning, or closing Report Cases.',
      'Viewing unrelated User Directory, moderation, vote, security, or infrastructure data.'
    ]::text[],
    'high', false, false, 1,
    'a33f7a7290f09372bd03db6d4c0b8a8923b2c3ce18bcdd847493a58524658ca0'
  ),
  (
    'logs.submission_report_moderation.view',
    'View Submission Report Moderation Logs',
    'View the append-only Submission Report workflow audit with server-side redaction and no Report free text.',
    'Submission Report Logs',
    array[
      'View allowlisted Case, Cycle, Submission, workflow event, outcome, actor display, role, and timestamp fields.',
      'View claim, release, recovery, reassignment, close, and Report-caused reopen history.'
    ]::text[],
    array[
      'Viewing reporter comments, raw evidence, stable delegated actor identifiers, or security signals.',
      'Viewing Live or Finalized Case queues or reporter-centered User Logs.',
      'Claiming, reviewing, releasing, reassigning, closing, or performing underlying moderation actions.'
    ]::text[],
    'high', false, false, 1,
    '5d584c66b113a543755dab6730df8de30362c1d2b5dccc46f8b74019756c76f7'
  );

alter table public.submission_report_cases
  add column assigned_to_discord_user_id text,
  add column assigned_to_display_name text,
  add column assigned_at timestamptz,
  add constraint submission_report_cases_assignment_check check (
    (assigned_to_discord_user_id is null and assigned_to_display_name is null and assigned_at is null)
    or (
      nullif(btrim(assigned_to_discord_user_id), '') is not null
      and nullif(btrim(assigned_to_display_name), '') is not null
      and assigned_at is not null
    )
  );

alter table public.submission_report_case_events
  add column actor_role_key text,
  add column authorization_capability_key text,
  add column previous_assignee_discord_user_id text,
  add column previous_assignee_display_name text,
  add column new_assignee_discord_user_id text,
  add column new_assignee_display_name text;

alter table public.submission_report_case_events
  drop constraint submission_report_events_type_check,
  add constraint submission_report_events_type_check check (event_type in (
    'report_created', 'case_reopened_by_report', 'case_acknowledged',
    'review_started', 'review_returned_open', 'case_closed',
    'case_claimed', 'case_released', 'case_claim_recovered',
    'case_forced_released', 'case_reassigned'
  )),
  add constraint submission_report_events_assignment_actor_check check (
    actor_role_key is null or nullif(btrim(actor_role_key), '') is not null
  ),
  add constraint submission_report_events_assignment_capability_check check (
    authorization_capability_key is null
    or authorization_capability_key in (
      'submissions.reports.live.view',
      'submissions.reports.finalized.view',
      'submissions.reports.review',
      'submissions.reports.assign'
    )
  ),
  add constraint submission_report_events_previous_assignee_check check (
    (previous_assignee_discord_user_id is null) = (previous_assignee_display_name is null)
  ),
  add constraint submission_report_events_new_assignee_check check (
    (new_assignee_discord_user_id is null) = (new_assignee_display_name is null)
  );

alter table public.submission_report_requests
  drop constraint submission_report_requests_operation_check,
  add constraint submission_report_requests_operation_check check (operation in (
    'create', 'acknowledge', 'start_review', 'return_open', 'close',
    'claim', 'release', 'recover_claim', 'forced_release', 'reassign'
  ));

create table public.submission_report_reads (
  viewer_discord_user_id text not null,
  report_id uuid not null references public.submission_reports(report_id)
    on update restrict on delete restrict,
  first_read_at timestamptz not null default transaction_timestamp(),
  read_area text not null,
  primary key (viewer_discord_user_id, report_id),
  constraint submission_report_reads_viewer_check
    check (nullif(btrim(viewer_discord_user_id), '') is not null),
  constraint submission_report_reads_area_check
    check (read_area in ('live', 'finalized'))
);

create index submission_report_reads_report_idx
  on public.submission_report_reads(report_id, viewer_discord_user_id);

alter table public.submission_report_reads owner to postgres;
alter table public.submission_report_reads enable row level security;
revoke all on table public.submission_report_reads
  from public, anon, authenticated, discord_bot, service_role;

create function public.submission_report_case_area(p_case_id uuid)
returns text language sql stable security definer set search_path = public, pg_temp
as $function$
  select case
    when cycle.status::text in ('submission_open', 'voting_open', 'voting_closed', 'active')
      or (
        cycle.status::text = 'paused'
        and cycle.paused_from_status::text in ('submission_open', 'voting_open')
      ) then 'live'
    when cycle.status::text = 'finished' then 'finalized'
    when latest_report.phase_snapshot = 'history' then 'finalized'
    else 'finalized'
  end
  from public.submission_report_cases report_case
  join public.submission_reports latest_report
    on latest_report.report_id = report_case.latest_report_id
  left join public.voting_cycles cycle on cycle.id = report_case.cycle_id
  where report_case.case_id = p_case_id
$function$;

create function public.has_submission_report_capability_v2(
  p_actor_discord_user_id text,
  p_capability_key text
)
returns boolean language plpgsql stable security definer set search_path = public, pg_temp
as $function$
declare
  v_actor_id text := btrim(p_actor_discord_user_id);
  v_hash text;
  v_role text;
begin
  v_hash := case p_capability_key
    when 'submissions.reports.live.view' then 'aa31ce50a9b0cbf4862b9d35bde8f9e2219d90c3aedadce06eb0e1fba55d34b8'
    when 'submissions.reports.finalized.view' then '7e6f885d45c6195034e836609f4bdea52f33180c47cea8dfae07c74ef5a1b49c'
    when 'submissions.reports.assign' then '06859ad3c5905a08471186dbbde2bc90238f0758be4edcfe525507a4e3db2752'
    when 'logs.submission_reporters.view' then 'a33f7a7290f09372bd03db6d4c0b8a8923b2c3ce18bcdd847493a58524658ca0'
    when 'logs.submission_report_moderation.view' then '5d584c66b113a543755dab6730df8de30362c1d2b5dccc46f8b74019756c76f7'
    when 'submissions.reports.review' then 'a9c1de7076eac2fd58052833930038f01e48e1ea37da51fb1f696508b11575f1'
    else null
  end;
  if nullif(v_actor_id, '') is null or v_hash is null then return false; end if;
  if not exists (
    select 1 from public.capability_catalog
    where key = p_capability_key and is_active and assignable_to_non_admin
      and implementation_version = 1 and definition_hash = v_hash
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

create function public.authorize_submission_report_capability_v2(
  p_actor_discord_user_id text,
  p_capability_key text
)
returns text language plpgsql stable security definer set search_path = public, pg_temp
as $function$
declare v_role text;
begin
  if not public.has_submission_report_capability_v2(
    p_actor_discord_user_id, p_capability_key
  ) then
    raise exception using errcode = '42501', message = 'SUBMISSION_REPORT_FORBIDDEN';
  end if;
  select member.role into strict v_role
  from public.team_members member
  join public.team_roles role on role.key = member.role and role.is_active
  where member.discord_user_id = btrim(p_actor_discord_user_id);
  return v_role;
end;
$function$;

create function public.list_submission_report_cases_v2(
  p_actor_discord_user_id text,
  p_area text,
  p_limit integer default 50
)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $function$
declare v_result jsonb; v_capability text;
begin
  if p_area not in ('live', 'finalized') or p_limit not between 1 and 50 then
    raise exception using errcode = '22023', message = 'SUBMISSION_REPORT_LIST_INVALID';
  end if;
  v_capability := case p_area when 'live' then 'submissions.reports.live.view'
    else 'submissions.reports.finalized.view' end;
  perform public.authorize_submission_report_capability_v2(
    p_actor_discord_user_id, v_capability
  );
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
        'currentCycleStatus', cycle.status::text,
        'currentVisibility', submission.public_visibility_status,
        'currentDisqualified', coalesce(submission.is_disqualified, false),
        'currentAvailable', submission.id is not null,
        'currentVoteCount', (
          select count(*)::integer from public.votes vote
          where vote.submission_id = report_case.submission_id
        ),
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
                and receipt.viewer_discord_user_id = btrim(p_actor_discord_user_id)
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

create function public.get_submission_report_case_summary_v2(
  p_actor_discord_user_id text,
  p_case_id uuid
)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $function$
declare v_area text; v_capability text; v_result jsonb;
begin
  v_area := public.submission_report_case_area(p_case_id);
  if v_area is null then
    raise exception using errcode = 'P0002', message = 'SUBMISSION_REPORT_CASE_NOT_FOUND';
  end if;
  v_capability := case v_area when 'live' then 'submissions.reports.live.view'
    else 'submissions.reports.finalized.view' end;
  perform public.authorize_submission_report_capability_v2(
    p_actor_discord_user_id, v_capability
  );
  select jsonb_build_object(
    'caseId', report_case.case_id,
    'submissionId', report_case.submission_id,
    'cycleId', report_case.cycle_id,
    'area', v_area,
    'status', report_case.status,
    'rowVersion', report_case.row_version,
    'reportCount', report_case.report_count,
    'latestReportId', report_case.latest_report_id,
    'assignedToDisplayName', report_case.assigned_to_display_name,
    'assignedAt', report_case.assigned_at,
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
       and receipt.viewer_discord_user_id = btrim(p_actor_discord_user_id)
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

create function public.get_submission_report_detail_v2(
  p_actor_discord_user_id text,
  p_report_id uuid
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $function$
declare v_area text; v_capability text; v_result jsonb;
begin
  select public.submission_report_case_area(report.case_id) into v_area
  from public.submission_reports report where report.report_id = p_report_id;
  if not found or v_area is null then
    raise exception using errcode = 'P0002', message = 'SUBMISSION_REPORT_NOT_FOUND';
  end if;
  v_capability := case v_area when 'live' then 'submissions.reports.live.view'
    else 'submissions.reports.finalized.view' end;
  perform public.authorize_submission_report_capability_v2(
    p_actor_discord_user_id, v_capability
  );
  insert into public.submission_report_reads(
    viewer_discord_user_id, report_id, first_read_at, read_area
  ) values (btrim(p_actor_discord_user_id), p_report_id, statement_timestamp(), v_area)
  on conflict (viewer_discord_user_id, report_id) do nothing;
  select jsonb_build_object(
    'reportId', report.report_id,
    'caseId', report.case_id,
    'submissionId', report.submission_id,
    'cycleId', report.cycle_id,
    'createdAt', report.created_at,
    'reasonTaxonomyVersion', report.reason_taxonomy_version,
    'reasonCode', report.reason_code,
    'subcategoryCode', report.subcategory_code,
    'comment', payload.reporter_comment,
    'phaseSnapshot', report.phase_snapshot,
    'cycleStatusSnapshot', report.cycle_status_snapshot,
    'visibilitySnapshot', report.public_visibility_snapshot,
    'contentSha256', report.content_sha256,
    'reporterPublicProfileId', identity.public_profile_id,
    'reporterLabel', coalesce(
      nullif(btrim(user_log.current_display_name), ''),
      nullif(btrim(user_log.current_guild_nickname), ''),
      nullif(btrim(user_log.current_discord_username), ''),
      case when identity.anonymized_at is null then 'Reporter' else 'Anonymous reporter' end
    ),
    'readAt', receipt.first_read_at
  ) into v_result
  from public.submission_reports report
  join public.submission_reporter_identities identity
    on identity.identity_id = report.reporter_identity_id
  left join public.user_logs user_log on user_log.discord_user_id = identity.discord_user_id
  left join public.submission_report_payloads payload on payload.report_id = report.report_id
  join public.submission_report_reads receipt
    on receipt.report_id = report.report_id
   and receipt.viewer_discord_user_id = btrim(p_actor_discord_user_id)
  where report.report_id = p_report_id;
  return v_result;
end;
$function$;

create function public.get_submission_report_unread_counts_v2(
  p_actor_discord_user_id text
)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $function$
declare v_live integer := 0; v_finalized integer := 0;
begin
  if public.has_submission_report_capability_v2(
    p_actor_discord_user_id, 'submissions.reports.live.view'
  ) then
    select count(*)::integer into v_live
    from public.submission_reports report
    where public.submission_report_case_area(report.case_id) = 'live'
      and not exists (
        select 1 from public.submission_report_reads receipt
        where receipt.report_id = report.report_id
          and receipt.viewer_discord_user_id = btrim(p_actor_discord_user_id)
      );
  end if;
  if public.has_submission_report_capability_v2(
    p_actor_discord_user_id, 'submissions.reports.finalized.view'
  ) then
    select count(*)::integer into v_finalized
    from public.submission_reports report
    where public.submission_report_case_area(report.case_id) = 'finalized'
      and not exists (
        select 1 from public.submission_report_reads receipt
        where receipt.report_id = report.report_id
          and receipt.viewer_discord_user_id = btrim(p_actor_discord_user_id)
      );
  end if;
  return jsonb_build_object(
    'live', v_live, 'finalized', v_finalized, 'total', v_live + v_finalized
  );
end;
$function$;

create function public.manage_submission_report_case_v2(
  p_actor_discord_user_id text,
  p_case_id uuid,
  p_operation text,
  p_expected_status text,
  p_expected_row_version bigint,
  p_expected_latest_report_id uuid,
  p_target_discord_user_id text,
  p_disposition text,
  p_note text,
  p_idempotency_key uuid
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $function$
declare
  v_actor_id text := btrim(p_actor_discord_user_id);
  v_target_id text := nullif(btrim(p_target_discord_user_id), '');
  v_operation text := btrim(p_operation);
  v_expected_status text := nullif(btrim(p_expected_status), '');
  v_disposition text := nullif(btrim(p_disposition), '');
  v_note text := nullif(btrim(p_note), '');
  v_area text;
  v_view_capability text;
  v_actor_role text;
  v_actor_display text;
  v_target_display text;
  v_previous_eligible boolean;
  v_request_payload jsonb;
  v_request_hash text;
  v_existing_hash text;
  v_existing_result jsonb;
  v_case public.submission_report_cases%rowtype;
  v_new_status text;
  v_event_type text;
  v_result jsonb;
  v_now timestamptz := statement_timestamp();
begin
  if nullif(v_actor_id, '') is null
    or p_idempotency_key is null or p_case_id is null
    or p_expected_row_version is null or p_expected_row_version < 1
    or p_expected_latest_report_id is null
    or v_expected_status is null
    or v_expected_status not in ('open', 'in_review', 'closed')
    or nullif(v_operation, '') is null
    or v_operation not in (
      'claim', 'release', 'recover_claim', 'forced_release', 'reassign', 'close'
    )
    or (v_operation in ('release', 'recover_claim', 'forced_release', 'reassign', 'close')
      and (v_note is null or char_length(v_note) not between 10 and 1000))
    or (v_operation = 'reassign' and v_target_id is null)
    or (v_operation <> 'reassign' and v_target_id is not null)
    or (v_operation = 'close' and (
      v_disposition is null or v_disposition not in (
        'action_taken', 'no_action_current_rules', 'insufficient_information',
        'submission_unavailable', 'completed_other'
      )
    ))
    or (v_operation <> 'close' and v_disposition is not null) then
    raise exception using errcode = '22023', message = 'SUBMISSION_REPORT_WORKFLOW_INVALID';
  end if;

  v_area := public.submission_report_case_area(p_case_id);
  if v_area is null then
    raise exception using errcode = 'P0002', message = 'SUBMISSION_REPORT_CASE_NOT_FOUND';
  end if;
  v_view_capability := case v_area when 'live' then 'submissions.reports.live.view'
    else 'submissions.reports.finalized.view' end;
  perform public.authorize_submission_report_capability_v2(v_actor_id, v_view_capability);
  v_actor_role := public.authorize_submission_report_capability_v2(
    v_actor_id, 'submissions.reports.review'
  );
  if v_operation in ('forced_release', 'reassign') then
    perform public.authorize_submission_report_capability_v2(
      v_actor_id, 'submissions.reports.assign'
    );
  end if;
  select coalesce(
    nullif(btrim(current_display_name), ''),
    nullif(btrim(current_guild_nickname), ''),
    nullif(btrim(current_discord_username), ''),
    v_actor_id
  ) into v_actor_display
  from public.user_logs where discord_user_id = v_actor_id;
  v_actor_display := coalesce(v_actor_display, v_actor_id);

  v_request_payload := jsonb_build_object(
    'operation', v_operation, 'version', 2, 'actor', v_actor_id,
    'caseId', p_case_id, 'expectedStatus', v_expected_status,
    'expectedRowVersion', p_expected_row_version,
    'expectedLatestReportId', p_expected_latest_report_id,
    'target', v_target_id, 'disposition', v_disposition, 'note', v_note
  );
  v_request_hash := encode(
    extensions.digest(convert_to(v_request_payload::text, 'UTF8'), 'sha256'), 'hex'
  );
  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  select request_hash, result into v_existing_hash, v_existing_result
  from public.submission_report_requests where idempotency_key = p_idempotency_key;
  if found then
    if v_existing_hash = v_request_hash then
      return jsonb_set(v_existing_result, '{replayed}', 'true'::jsonb);
    end if;
    raise exception using errcode = 'PT409',
      message = 'SUBMISSION_REPORT_IDEMPOTENCY_CONFLICT';
  end if;

  select * into v_case from public.submission_report_cases
  where case_id = p_case_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'SUBMISSION_REPORT_CASE_NOT_FOUND';
  end if;
  if v_case.status <> v_expected_status
    or v_case.row_version <> p_expected_row_version
    or v_case.latest_report_id <> p_expected_latest_report_id then
    raise exception using errcode = 'PT409', message = 'SUBMISSION_REPORT_STALE';
  end if;

  if v_operation = 'claim' then
    if v_case.status <> 'open' or v_case.assigned_to_discord_user_id is not null then
      raise exception using errcode = 'PT409', message = 'SUBMISSION_REPORT_CLAIM_CONFLICT';
    end if;
    v_new_status := 'in_review';
    v_event_type := 'case_claimed';
  elsif v_operation = 'recover_claim' then
    if v_case.status <> 'in_review' or v_case.assigned_to_discord_user_id is null then
      raise exception using errcode = 'PT409', message = 'SUBMISSION_REPORT_RECOVERY_CONFLICT';
    end if;
    v_previous_eligible := public.has_submission_report_capability_v2(
      v_case.assigned_to_discord_user_id, v_view_capability
    ) and public.has_submission_report_capability_v2(
      v_case.assigned_to_discord_user_id, 'submissions.reports.review'
    );
    if v_previous_eligible then
      raise exception using errcode = '42501', message = 'SUBMISSION_REPORT_RECOVERY_FORBIDDEN';
    end if;
    v_new_status := 'in_review';
    v_event_type := 'case_claim_recovered';
  elsif v_operation = 'release' then
    if v_case.status <> 'in_review'
      or v_case.assigned_to_discord_user_id is distinct from v_actor_id then
      raise exception using errcode = '42501', message = 'SUBMISSION_REPORT_NOT_ASSIGNEE';
    end if;
    v_new_status := 'open';
    v_event_type := 'case_released';
  elsif v_operation = 'forced_release' then
    if v_case.status <> 'in_review' or v_case.assigned_to_discord_user_id is null then
      raise exception using errcode = 'PT409', message = 'SUBMISSION_REPORT_RELEASE_CONFLICT';
    end if;
    v_new_status := 'open';
    v_event_type := 'case_forced_released';
  elsif v_operation = 'reassign' then
    if v_case.status <> 'in_review' or v_case.assigned_to_discord_user_id is null
      or v_target_id = v_case.assigned_to_discord_user_id then
      raise exception using errcode = 'PT409', message = 'SUBMISSION_REPORT_REASSIGN_CONFLICT';
    end if;
    if not public.has_submission_report_capability_v2(v_target_id, v_view_capability)
      or not public.has_submission_report_capability_v2(
        v_target_id, 'submissions.reports.review'
      ) then
      raise exception using errcode = '42501', message = 'SUBMISSION_REPORT_TARGET_INELIGIBLE';
    end if;
    select coalesce(
      nullif(btrim(current_display_name), ''),
      nullif(btrim(current_guild_nickname), ''),
      nullif(btrim(current_discord_username), ''),
      v_target_id
    ) into v_target_display
    from public.user_logs where discord_user_id = v_target_id;
    v_target_display := coalesce(v_target_display, v_target_id);
    v_new_status := 'in_review';
    v_event_type := 'case_reassigned';
  else
    if v_case.status <> 'in_review'
      or v_case.assigned_to_discord_user_id is distinct from v_actor_id then
      raise exception using errcode = '42501', message = 'SUBMISSION_REPORT_NOT_ASSIGNEE';
    end if;
    v_new_status := 'closed';
    v_event_type := 'case_closed';
  end if;

  update public.submission_report_cases set
    status = v_new_status,
    row_version = row_version + 1,
    assigned_to_discord_user_id = case
      when v_operation in ('claim', 'recover_claim') then v_actor_id
      when v_operation = 'reassign' then v_target_id
      else null end,
    assigned_to_display_name = case
      when v_operation in ('claim', 'recover_claim') then v_actor_display
      when v_operation = 'reassign' then v_target_display
      else null end,
    assigned_at = case
      when v_operation in ('claim', 'recover_claim', 'reassign') then v_now
      else null end,
    review_started_at = case
      when v_operation in ('claim', 'recover_claim', 'reassign') then v_now
      when v_operation in ('release', 'forced_release') then null
      else review_started_at end,
    review_started_by_discord_user_id = case
      when v_operation in ('claim', 'recover_claim') then v_actor_id
      when v_operation = 'reassign' then v_target_id
      when v_operation in ('release', 'forced_release') then null
      else review_started_by_discord_user_id end,
    review_started_by_display_name = case
      when v_operation in ('claim', 'recover_claim') then v_actor_display
      when v_operation = 'reassign' then v_target_display
      when v_operation in ('release', 'forced_release') then null
      else review_started_by_display_name end,
    reviewed_through_report_id = case when v_operation = 'close'
      then latest_report_id else reviewed_through_report_id end,
    reviewed_through_report_at = case when v_operation = 'close'
      then latest_report_at else reviewed_through_report_at end,
    closed_at = case when v_operation = 'close' then v_now else null end,
    closed_by_discord_user_id = case when v_operation = 'close' then v_actor_id else null end,
    closed_by_display_name = case when v_operation = 'close' then v_actor_display else null end,
    close_disposition = case when v_operation = 'close' then v_disposition else null end,
    close_note = case when v_operation = 'close' then v_note else null end,
    updated_at = v_now
  where case_id = p_case_id;

  insert into public.submission_report_case_events(
    case_id, event_type, previous_status, new_status, actor_kind,
    actor_discord_user_id, actor_display_name, actor_role_key,
    authorization_capability_key, occurred_at, disposition, note,
    case_version, report_cursor_at, report_cursor_id,
    previous_assignee_discord_user_id, previous_assignee_display_name,
    new_assignee_discord_user_id, new_assignee_display_name
  ) values (
    p_case_id, v_event_type, v_case.status, v_new_status,
    case when v_actor_role = 'admin' then 'admin' else 'team' end,
    v_actor_id, v_actor_display, v_actor_role,
    case when v_operation in ('forced_release', 'reassign')
      then 'submissions.reports.assign' else 'submissions.reports.review' end,
    v_now, v_disposition, v_note, v_case.row_version + 1,
    v_case.latest_report_at, v_case.latest_report_id,
    v_case.assigned_to_discord_user_id, v_case.assigned_to_display_name,
    case when v_operation in ('claim', 'recover_claim') then v_actor_id
      when v_operation = 'reassign' then v_target_id else null end,
    case when v_operation in ('claim', 'recover_claim') then v_actor_display
      when v_operation = 'reassign' then v_target_display else null end
  );

  if v_operation = 'close' then
    update public.submission_report_payloads payload
    set retention_due_at = v_now + interval '24 months'
    where exists (
      select 1 from public.submission_reports report
      where report.report_id = payload.report_id and report.case_id = p_case_id
    ) and payload.anonymized_at is null;
  end if;

  v_result := jsonb_build_object(
    'caseId', p_case_id, 'status', v_new_status,
    'rowVersion', v_case.row_version + 1,
    'latestReportId', v_case.latest_report_id,
    'assignedToDiscordUserId', case
      when v_operation in ('claim', 'recover_claim') then v_actor_id
      when v_operation = 'reassign' then v_target_id else null end,
    'replayed', false
  );
  insert into public.submission_report_requests(
    idempotency_key, operation, request_hash, result
  ) values (p_idempotency_key, v_operation, v_request_hash, v_result);
  return v_result;
end;
$function$;

alter function public.submission_report_case_area(uuid) owner to postgres;
alter function public.has_submission_report_capability_v2(text, text) owner to postgres;
alter function public.authorize_submission_report_capability_v2(text, text) owner to postgres;
alter function public.list_submission_report_cases_v2(text, text, integer) owner to postgres;
alter function public.get_submission_report_case_summary_v2(text, uuid) owner to postgres;
alter function public.get_submission_report_detail_v2(text, uuid) owner to postgres;
alter function public.get_submission_report_unread_counts_v2(text) owner to postgres;
alter function public.manage_submission_report_case_v2(
  text, uuid, text, text, bigint, uuid, text, text, text, uuid
) owner to postgres;

revoke all on function public.submission_report_case_area(uuid)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.has_submission_report_capability_v2(text, text)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.authorize_submission_report_capability_v2(text, text)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.list_submission_report_cases_v2(text, text, integer)
  from public, anon, authenticated, discord_bot;
revoke all on function public.get_submission_report_case_summary_v2(text, uuid)
  from public, anon, authenticated, discord_bot;
revoke all on function public.get_submission_report_detail_v2(text, uuid)
  from public, anon, authenticated, discord_bot;
revoke all on function public.get_submission_report_unread_counts_v2(text)
  from public, anon, authenticated, discord_bot;
revoke all on function public.manage_submission_report_case_v2(
  text, uuid, text, text, bigint, uuid, text, text, text, uuid
) from public, anon, authenticated, discord_bot;

grant execute on function public.list_submission_report_cases_v2(text, text, integer)
  to service_role;
grant execute on function public.get_submission_report_case_summary_v2(text, uuid)
  to service_role;
grant execute on function public.get_submission_report_detail_v2(text, uuid)
  to service_role;
grant execute on function public.get_submission_report_unread_counts_v2(text)
  to service_role;
grant execute on function public.manage_submission_report_case_v2(
  text, uuid, text, text, bigint, uuid, text, text, text, uuid
) to service_role;

comment on table public.submission_report_reads is
  'Server-only viewer/report read receipts. A receipt is created only when an authorized full Report detail is returned; Case workflow and shared acknowledgement remain separate.';
comment on function public.manage_submission_report_case_v2(
  text, uuid, text, text, bigint, uuid, text, text, text, uuid
) is 'Atomic exclusive Case claim, release, ineligible-assignee recovery, privileged forced release/reassignment, and assignee-only close with optimistic concurrency and append-only audit.';

do $postflight$
declare
  v_preflight submission_report_team_workflow_preflight%rowtype;
  v_signature text;
  v_function regprocedure;
begin
  select * into strict v_preflight from submission_report_team_workflow_preflight;
  if (select count(*) from public.capability_catalog) <> 38
    or (select count(*) from public.capability_catalog where is_active) <> 31
    or (
      select count(*) from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 31
    or (
      select count(*) from public.capability_catalog
      where key in (
        'submissions.reports.live.view',
        'submissions.reports.finalized.view',
        'submissions.reports.assign',
        'logs.submission_reporters.view',
        'logs.submission_report_moderation.view'
      ) and not is_active and not assignable_to_non_admin
    ) <> 5
    or exists (
      select 1 from public.team_role_capabilities
      where capability_key in (
        'submissions.reports.live.view',
        'submissions.reports.finalized.view',
        'submissions.reports.assign',
        'logs.submission_reporters.view',
        'logs.submission_report_moderation.view'
      )
    )
    or v_preflight.case_count <> (select count(*) from public.submission_report_cases)
    or v_preflight.report_count <> (select count(*) from public.submission_reports)
    or v_preflight.payload_count <> (select count(*) from public.submission_report_payloads)
    or v_preflight.event_count <> (select count(*) from public.submission_report_case_events)
    or v_preflight.request_count <> (select count(*) from public.submission_report_requests)
    or exists (
      select 1 from public.submission_report_cases
      where assigned_to_discord_user_id is not null
        or assigned_to_display_name is not null or assigned_at is not null
    )
    or exists (select 1 from public.submission_report_reads) then
    raise exception using errcode = '55000',
      message = 'SUBMISSION_REPORT_TEAM_WORKFLOW_POSTFLIGHT_MISMATCH';
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
          'manage_submission_report_case_v2'
        )
        and function_row.prosecdef
        and function_row.proowner = (select oid from pg_roles where rolname = 'postgres')
        and function_row.proconfig = array['search_path=public, pg_temp']
    ) <> 8 then
    raise exception using errcode = '55000',
      message = 'SUBMISSION_REPORT_TEAM_WORKFLOW_FUNCTION_HARDENING_MISMATCH';
  end if;

  foreach v_signature in array array[
    'public.list_submission_report_cases_v2(text,text,integer)',
    'public.get_submission_report_case_summary_v2(text,uuid)',
    'public.get_submission_report_detail_v2(text,uuid)',
    'public.get_submission_report_unread_counts_v2(text)',
    'public.manage_submission_report_case_v2(text,uuid,text,text,bigint,uuid,text,text,text,uuid)'
  ] loop
    v_function := to_regprocedure(v_signature);
    if v_function is null
      or (
        select count(*)
        from pg_proc function_row
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
        message = 'SUBMISSION_REPORT_TEAM_WORKFLOW_ENTRY_ACL_MISMATCH',
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
        select count(*)
        from pg_proc function_row
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
        message = 'SUBMISSION_REPORT_TEAM_WORKFLOW_HELPER_ACL_MISMATCH',
        detail = v_signature;
    end if;
  end loop;
end;
$postflight$;

commit;
