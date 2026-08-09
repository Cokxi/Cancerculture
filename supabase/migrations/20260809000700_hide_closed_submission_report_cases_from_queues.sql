begin;

do $preflight$
declare
  v_list_function regprocedure := to_regprocedure(
    'public.list_submission_report_cases_v2(text,text,integer)'
  );
  v_unread_function regprocedure := to_regprocedure(
    'public.get_submission_report_unread_counts_v2(text)'
  );
begin
  if (select count(*) from public.capability_catalog) <> 38
    or (select count(*) from public.capability_catalog where is_active) <> 35
    or (
      select count(*) from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 35 then
    raise exception using errcode = '55000',
      message = 'SUBMISSION_REPORT_ACTIONABLE_QUEUE_CATALOG_MISMATCH';
  end if;

  if v_list_function is null
    or md5(pg_get_functiondef(v_list_function)) <> '523e3bec832b7c26706be2e7d8bf06c7'
    or v_unread_function is null
    or md5(pg_get_functiondef(v_unread_function)) <> 'e4f4484e0a65b3d4044c2fe84f1d3730' then
    raise exception using errcode = '55000',
      message = 'SUBMISSION_REPORT_ACTIONABLE_QUEUE_BASELINE_MISMATCH';
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
      and report_case.status in ('open', 'in_review')
    order by report_case.report_count desc, report_case.latest_report_at desc, report_case.case_id
    limit p_limit
  ) page;
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
    join public.submission_report_cases report_case on report_case.case_id = report.case_id
    where public.submission_report_case_area(report.case_id) = 'finalized'
      and report_case.status in ('open', 'in_review')
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

alter function public.list_submission_report_cases_v2(text, text, integer) owner to postgres;
alter function public.get_submission_report_unread_counts_v2(text) owner to postgres;

revoke all on function public.list_submission_report_cases_v2(text, text, integer) from public;
revoke all on function public.get_submission_report_unread_counts_v2(text) from public;
revoke execute on function public.list_submission_report_cases_v2(text, text, integer)
  from anon, authenticated, discord_bot;
revoke execute on function public.get_submission_report_unread_counts_v2(text)
  from anon, authenticated, discord_bot;
grant execute on function public.list_submission_report_cases_v2(text, text, integer)
  to service_role;
grant execute on function public.get_submission_report_unread_counts_v2(text)
  to service_role;

do $postflight$
declare
  v_signature text;
  v_function regprocedure;
  v_definition text;
begin
  foreach v_signature in array array[
    'public.list_submission_report_cases_v2(text,text,integer)',
    'public.get_submission_report_unread_counts_v2(text)'
  ] loop
    v_function := to_regprocedure(v_signature);
    v_definition := lower(pg_get_functiondef(v_function));
    if v_function is null
      or not (
        select function_row.prosecdef
          and function_row.proowner = (select oid from pg_roles where rolname = 'postgres')
          and function_row.proconfig = array['search_path=public, pg_temp']
        from pg_proc function_row where function_row.oid = v_function
      )
      or v_definition not like '%report_case.status%open%in_review%'
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
        message = 'SUBMISSION_REPORT_ACTIONABLE_QUEUE_POSTFLIGHT_MISMATCH',
        detail = v_signature;
    end if;
  end loop;
end;
$postflight$;

comment on function public.list_submission_report_cases_v2(text, text, integer)
  is 'Capability-guarded Live/Finalized actionable Submission Report Case queue. Closed Cases remain available through the append-only workflow log and direct authorized detail.';
comment on function public.get_submission_report_unread_counts_v2(text)
  is 'Capability-scoped viewer unread counts for individual Reports in actionable open or in-review Cases only.';

commit;
