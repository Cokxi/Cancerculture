begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $preflight$
begin
  if (select count(*) from public.capability_catalog) <> 33
    or (select count(*) from public.capability_catalog where is_active) <> 29
    or (
      select count(*) from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 29
    or to_regclass('public.submission_report_cases') is null
    or to_regprocedure(
      'public.create_submission_report(text,integer,text,bigint,integer,text,text,text,uuid)'
    ) is null
    or to_regprocedure(
      'public.review_submission_report_case(text,uuid,text,text,bigint,uuid,text,text,uuid)'
    ) is null then
    raise exception using errcode = '55000',
      message = 'SUBMISSION_REPORT_ACTIVATION_BASELINE_MISMATCH';
  end if;
  if not exists (
      select 1 from public.capability_catalog
      where key = 'submissions.reports.view' and not is_active
        and not assignable_to_non_admin and implementation_version = 1
        and definition_hash = '0f8bdec2e69427665a49067e4a2d2da7d4f81053b6f6e1f427cc262f26b7ef0e'
    ) or not exists (
      select 1 from public.capability_catalog
      where key = 'submissions.reports.review' and not is_active
        and not assignable_to_non_admin and implementation_version = 1
        and definition_hash = 'a9c1de7076eac2fd58052833930038f01e48e1ea37da51fb1f696508b11575f1'
    ) or exists (
      select 1 from public.team_role_capabilities
      where capability_key in ('submissions.reports.view', 'submissions.reports.review')
    ) then
    raise exception using errcode = '55000',
      message = 'SUBMISSION_REPORT_ACTIVATION_STAGED_STATE_MISMATCH';
  end if;
end;
$preflight$;

update public.capability_catalog
set is_active = true, assignable_to_non_admin = true
where key in ('submissions.reports.view', 'submissions.reports.review');

do $postflight$
begin
  if (select count(*) from public.capability_catalog) <> 33
    or (select count(*) from public.capability_catalog where is_active) <> 31
    or (
      select count(*) from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 31
    or (
      select count(*) from public.capability_catalog
      where key in ('submissions.reports.view', 'submissions.reports.review')
        and is_active and assignable_to_non_admin
    ) <> 2
    or exists (
      select 1 from public.team_role_capabilities
      where capability_key in ('submissions.reports.view', 'submissions.reports.review')
    ) then
    raise exception using errcode = '55000',
      message = 'SUBMISSION_REPORT_ACTIVATION_POSTFLIGHT_MISMATCH';
  end if;
end;
$postflight$;

commit;
