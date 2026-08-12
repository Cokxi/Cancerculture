begin;

set local lock_timeout = '10s';
set local statement_timeout = '60s';

create temporary table submission_report_work_backlog_preflight on commit drop as
select
  (select count(*) from public.submission_reporter_identities) as identity_count,
  (select count(*) from public.submission_report_cases) as case_count,
  (select count(*) from public.submission_reports) as report_count,
  (select count(*) from public.submission_report_payloads) as payload_count,
  (select count(*) from public.submission_report_case_events) as event_count,
  (select count(*) from public.submission_report_requests) as request_count,
  (select count(*) from public.submission_report_reads) as read_count,
  (select count(*) from public.team_role_capabilities) as grant_count;

do $preflight$
declare
  v_eligibility_definition text;
  v_summary_definition text;
begin
  if (select count(*) from public.capability_catalog) <> 38
    or (select count(*) from public.capability_catalog where is_active) <> 34
    or (
      select count(*) from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 34
    or md5(pg_get_functiondef(
      'public.list_submission_report_cases_v2(text,text,integer)'::regprocedure
    )) <> '9588d2d2463be9702a3611fa51dc302b'
    or md5(pg_get_functiondef(
      'public.get_submission_report_unread_counts_v2(text)'::regprocedure
    )) <> '162bdd7333873221782bb3eef932e2ff'
    or to_regprocedure(
      'public.get_submission_report_case_summary_v2(text,uuid)'
    ) is null
    or to_regprocedure(
      'public.get_submission_report_eligibility(text,integer,text,bigint)'
    ) is null then
    raise exception using errcode = '55000',
      message = 'SUBMISSION_REPORT_WORK_BACKLOG_BASELINE_MISMATCH';
  end if;

  select pg_get_functiondef(
    'public.get_submission_report_case_summary_v2(text,uuid)'::regprocedure
  ) into v_summary_definition;
  select pg_get_functiondef(
    'public.get_submission_report_eligibility(text,integer,text,bigint)'::regprocedure
  ) into v_eligibility_definition;

  if position('submission_report_reads' in v_summary_definition) = 0
    or position('''isRead''' in v_summary_definition) = 0
    or position('''isNew''' in v_summary_definition) <> 0
    or position('count(*) >= 3' in v_eligibility_definition) = 0
    or position('cycle_wrapping_up' in v_eligibility_definition) = 0
    or exists (
      select 1
      from public.submission_reports report
      where (
        select count(*)
        from public.submission_report_case_events event
        where event.case_id = report.case_id
          and event.report_id = report.report_id
          and event.event_type = 'report_created'
      ) <> 1
    )
    or exists (
      select 1
      from public.submission_report_cases report_case
      where report_case.reviewed_through_report_id is not null
        and not exists (
          select 1
          from public.submission_report_case_events event
          where event.case_id = report_case.case_id
            and event.report_cursor_id = report_case.reviewed_through_report_id
            and event.event_type = 'case_closed'
        )
    ) then
    raise exception using errcode = '55000',
      message = 'SUBMISSION_REPORT_WORK_BACKLOG_STARTING_CONTRACT_MISMATCH';
  end if;
end;
$preflight$;

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
        'workBacklogReportCount', (
          select count(*)::integer
          from public.submission_reports report
          where report.case_id = report_case.case_id
            and (
              report_case.reviewed_through_report_id is null
              or exists (
                select 1
                from public.submission_report_case_events report_event
                join public.submission_report_case_events boundary_event
                  on boundary_event.case_id = report_case.case_id
                 and boundary_event.event_type = 'case_closed'
                 and boundary_event.report_cursor_id = report_case.reviewed_through_report_id
                where report_event.case_id = report_case.case_id
                  and report_event.event_type = 'report_created'
                  and report_event.report_id = report.report_id
                  and report_event.case_version > boundary_event.case_version
              )
            )
        )
      ) item
    from public.submission_report_cases report_case
    left join public.submissions submission on submission.id = report_case.submission_id
    left join public.voting_cycles cycle on cycle.id = report_case.cycle_id
    where public.submission_report_case_area(report_case.case_id) = p_area
      and report_case.status in ('open', 'in_review')
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
    'reviewedThroughReportId', report_case.reviewed_through_report_id,
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
        'isRead', receipt.report_id is not null,
        'isNew', report_case.reviewed_through_report_id is null or exists (
          select 1
          from public.submission_report_case_events report_event
          join public.submission_report_case_events boundary_event
            on boundary_event.case_id = report_case.case_id
           and boundary_event.event_type = 'case_closed'
           and boundary_event.report_cursor_id = report_case.reviewed_through_report_id
          where report_event.case_id = report_case.case_id
            and report_event.event_type = 'report_created'
            and report_event.report_id = report.report_id
            and report_event.case_version > boundary_event.case_version
        )
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

create or replace function public.get_submission_report_unread_counts_v2(
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
    join public.submission_report_cases report_case on report_case.case_id = report.case_id
    where public.submission_report_case_area(report.case_id) = 'live'
      and report_case.status in ('open', 'in_review')
      and (
        report_case.reviewed_through_report_id is null
        or exists (
          select 1
          from public.submission_report_case_events report_event
          join public.submission_report_case_events boundary_event
            on boundary_event.case_id = report_case.case_id
           and boundary_event.event_type = 'case_closed'
           and boundary_event.report_cursor_id = report_case.reviewed_through_report_id
          where report_event.case_id = report_case.case_id
            and report_event.event_type = 'report_created'
            and report_event.report_id = report.report_id
            and report_event.case_version > boundary_event.case_version
        )
      );
  end if;
  if public.has_submission_report_capability_v2(
    p_actor_discord_user_id, 'submissions.reports.finalized.view'
  ) then
    select count(*)::integer into v_finalized
    from public.submission_reports report
    join public.submission_report_cases report_case on report_case.case_id = report.case_id
    where public.submission_report_case_area(report.case_id) = 'finalized'
      and report_case.status in ('open', 'in_review')
      and (
        report_case.reviewed_through_report_id is null
        or exists (
          select 1
          from public.submission_report_case_events report_event
          join public.submission_report_case_events boundary_event
            on boundary_event.case_id = report_case.case_id
           and boundary_event.event_type = 'case_closed'
           and boundary_event.report_cursor_id = report_case.reviewed_through_report_id
          where report_event.case_id = report_case.case_id
            and report_event.event_type = 'report_created'
            and report_event.report_id = report.report_id
            and report_event.case_version > boundary_event.case_version
        )
      );
  end if;
  return jsonb_build_object(
    'live', v_live, 'finalized', v_finalized, 'total', v_live + v_finalized
  );
end;
$function$;

create or replace function public.get_submission_report_eligibility(
  p_reporter_discord_user_id text,
  p_reporter_dedupe_version integer,
  p_reporter_dedupe_hash text,
  p_submission_id bigint
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_cycle_status text;
  v_paused_from_status text;
  v_reportable boolean := false;
  v_already boolean := false;
  v_multiple boolean := false;
  v_blocked_reason text := null;
begin
  if nullif(btrim(p_reporter_discord_user_id), '') is null
    or p_reporter_dedupe_version is null
    or p_reporter_dedupe_version < 1
    or p_reporter_dedupe_hash is null
    or p_reporter_dedupe_hash !~ '^[0-9a-f]{64}$'
    or p_submission_id is null
    or p_submission_id < 1 then
    raise exception using
      errcode = '22023',
      message = 'SUBMISSION_REPORT_INVALID';
  end if;

  select cycle.status::text, cycle.paused_from_status::text
  into v_cycle_status, v_paused_from_status
  from public.submissions submission
  join public.voting_cycles cycle on cycle.id = submission.cycle_id
  where submission.id = p_submission_id
    and not coalesce(submission.is_disqualified, false)
    and submission.public_visibility_status in ('visible', 'legal_review');

  if found then
    if v_cycle_status in ('voting_closed', 'finalizing') then
      v_blocked_reason := 'cycle_wrapping_up';
    else
      v_reportable :=
        v_cycle_status in (
          'submission_open',
          'voting_open',
          'active',
          'finished'
        )
        or (
          v_cycle_status = 'paused'
          and v_paused_from_status in ('submission_open', 'voting_open')
        );
    end if;
  end if;

  select exists (
    select 1
    from public.submission_reports report
    join public.submission_reporter_identities identity
      on identity.identity_id = report.reporter_identity_id
    where report.submission_id = p_submission_id
      and (
        (
          report.reporter_dedupe_version = p_reporter_dedupe_version
          and report.reporter_dedupe_hash = p_reporter_dedupe_hash
        )
        or identity.discord_user_id = btrim(p_reporter_discord_user_id)
      )
  ) into v_already;

  select count(*) >= 5
  into v_multiple
  from public.submission_reports report
  where report.submission_id = p_submission_id;

  return jsonb_build_object(
    'canReport', v_reportable and not v_already,
    'alreadyReported', v_already,
    'hasMultipleExistingReports', v_multiple,
    'blockedReason', v_blocked_reason
  );
end;
$function$;

alter function public.list_submission_report_cases_v2(text, text, integer) owner to postgres;
alter function public.get_submission_report_case_summary_v2(text, uuid) owner to postgres;
alter function public.get_submission_report_unread_counts_v2(text) owner to postgres;
alter function public.get_submission_report_eligibility(text, integer, text, bigint) owner to postgres;

revoke all on function public.list_submission_report_cases_v2(text, text, integer)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_submission_report_case_summary_v2(text, uuid)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_submission_report_unread_counts_v2(text)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_submission_report_eligibility(text, integer, text, bigint)
  from public, anon, authenticated, discord_bot, service_role;

grant execute on function public.list_submission_report_cases_v2(text, text, integer)
  to service_role;
grant execute on function public.get_submission_report_case_summary_v2(text, uuid)
  to service_role;
grant execute on function public.get_submission_report_unread_counts_v2(text)
  to service_role;
grant execute on function public.get_submission_report_eligibility(text, integer, text, bigint)
  to service_role;

do $postflight$
declare
  v_preflight submission_report_work_backlog_preflight%rowtype;
  v_signature text;
  v_function regprocedure;
  v_definition text;
begin
  select * into strict v_preflight
  from submission_report_work_backlog_preflight;

  foreach v_signature in array array[
    'public.list_submission_report_cases_v2(text,text,integer)',
    'public.get_submission_report_case_summary_v2(text,uuid)',
    'public.get_submission_report_unread_counts_v2(text)',
    'public.get_submission_report_eligibility(text,integer,text,bigint)'
  ] loop
    v_function := to_regprocedure(v_signature);
    v_definition := pg_get_functiondef(v_function);
    if v_function is null
      or not (
        select function_row.prosecdef
          and function_row.proowner = 'postgres'::regrole
          and function_row.proconfig = array['search_path=public, pg_temp']
        from pg_proc function_row
        where function_row.oid = v_function
      )
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
        message = 'SUBMISSION_REPORT_WORK_BACKLOG_FUNCTION_POSTFLIGHT_MISMATCH',
        detail = v_signature;
    end if;
  end loop;

  if position('workBacklogReportCount' in pg_get_functiondef(
      'public.list_submission_report_cases_v2(text,text,integer)'::regprocedure
    )) = 0
    or position('submission_report_reads' in pg_get_functiondef(
      'public.list_submission_report_cases_v2(text,text,integer)'::regprocedure
    )) <> 0
    or position('''isNew''' in pg_get_functiondef(
      'public.get_submission_report_case_summary_v2(text,uuid)'::regprocedure
    )) = 0
    or position('''isRead''' in pg_get_functiondef(
      'public.get_submission_report_case_summary_v2(text,uuid)'::regprocedure
    )) = 0
    or position('submission_report_reads' in pg_get_functiondef(
      'public.get_submission_report_unread_counts_v2(text)'::regprocedure
    )) <> 0
    or position('count(*) >= 5' in pg_get_functiondef(
      'public.get_submission_report_eligibility(text,integer,text,bigint)'::regprocedure
    )) = 0
    or (
      select count(*)
      from pg_proc function_row
      join pg_namespace namespace_row
        on namespace_row.oid = function_row.pronamespace
      where namespace_row.nspname = 'public'
        and function_row.proname in (
          'list_submission_report_cases_v2',
          'get_submission_report_case_summary_v2',
          'get_submission_report_unread_counts_v2',
          'get_submission_report_eligibility'
        )
    ) <> 4
    or v_preflight.identity_count <>
      (select count(*) from public.submission_reporter_identities)
    or v_preflight.case_count <>
      (select count(*) from public.submission_report_cases)
    or v_preflight.report_count <>
      (select count(*) from public.submission_reports)
    or v_preflight.payload_count <>
      (select count(*) from public.submission_report_payloads)
    or v_preflight.event_count <>
      (select count(*) from public.submission_report_case_events)
    or v_preflight.request_count <>
      (select count(*) from public.submission_report_requests)
    or v_preflight.read_count <>
      (select count(*) from public.submission_report_reads)
    or v_preflight.grant_count <>
      (select count(*) from public.team_role_capabilities) then
    raise exception using errcode = '55000',
      message = 'SUBMISSION_REPORT_WORK_BACKLOG_DATA_POSTFLIGHT_MISMATCH';
  end if;
end;
$postflight$;

comment on function public.list_submission_report_cases_v2(text, text, integer)
  is 'Capability-guarded actionable Submission Report Case queue. The work backlog contains Reports serialized after the Case reviewed-through cursor; personal detail reads remain separate.';
comment on function public.get_submission_report_case_summary_v2(text, uuid)
  is 'Capability-guarded Submission Report Case summary with separate team work-backlog and viewer detail-read projections.';
comment on function public.get_submission_report_unread_counts_v2(text)
  is 'Capability-scoped individual Report work-backlog counts after each actionable Case reviewed-through cursor.';
comment on function public.get_submission_report_eligibility(text, integer, text, bigint)
  is 'Returns safe Submission Report eligibility, including a generic multiple-report hint at five existing Reports without exposing an exact count.';

commit;
