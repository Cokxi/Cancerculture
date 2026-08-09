begin;

do $preflight$
declare
  v_has_function regprocedure :=
    to_regprocedure('public.has_submission_report_capability_v2(text,text)');
  v_manage_function regprocedure := to_regprocedure(
    'public.manage_submission_report_case_v2(text,uuid,text,text,bigint,uuid,text,text,text,uuid)'
  );
begin
  if (select count(*) from public.capability_catalog) <> 38
    or (select count(*) from public.capability_catalog where is_active) <> 34
    or (
      select count(*) from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 34
    or not exists (
      select 1 from public.capability_catalog
      where key = 'submissions.reports.review'
        and is_active and assignable_to_non_admin
        and implementation_version = 3
        and definition_hash = '490f3168bf6cb0b162384ced36e2c3a3156d933d14603eb340255b9242bbdb0a'
    )
    or not exists (
      select 1 from public.capability_catalog
      where key = 'submissions.reports.assign'
        and not is_active and not assignable_to_non_admin
        and implementation_version = 2
        and definition_hash = '7e8c8683353d35f1bc817a2967c64ff934cc1a905db8ab9beaf1a693713b3ea6'
    )
    or exists (
      select 1 from public.team_role_capabilities
      where capability_key = 'submissions.reports.assign'
    ) then
    raise exception using errcode = '55000',
      message = 'SUBMISSION_REPORT_REVIEW_AUTH_V3_CAPABILITY_MISMATCH';
  end if;

  if v_has_function is null
    or md5(pg_get_functiondef(v_has_function)) <> '41725f1c94857245e3d865be3aee5b39'
    or v_manage_function is null
    or md5(pg_get_functiondef(v_manage_function)) <> 'fc1aff72e45b8bade234f1dfa92389ac' then
    raise exception using errcode = '55000',
      message = 'SUBMISSION_REPORT_REVIEW_AUTH_V3_BASELINE_MISMATCH';
  end if;
end;
$preflight$;

create temp table submission_report_review_auth_v3_preflight
on commit drop as
select
  (select count(*) from public.submission_report_cases) as case_count,
  (select count(*) from public.submission_reports) as report_count,
  (select count(*) from public.submission_report_payloads) as payload_count,
  (select count(*) from public.submission_report_case_events) as event_count,
  (select count(*) from public.submission_report_requests) as request_count,
  (select count(*) from public.submission_report_reads) as read_count,
  (select count(*) from public.team_role_capabilities) as grant_count;

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
    when 'logs.submission_reporters.view' then '854f3ddd41413b3223ed220d4f6a86d4f6f14436ce05de6d225dd255e6dc7846'
    when 'logs.submission_report_moderation.view' then '848b90d2b81ec364bd0c122cdd2e31ad68380d0e82d2f921c90467229e8108d7'
    when 'submissions.reports.review' then '490f3168bf6cb0b162384ced36e2c3a3156d933d14603eb340255b9242bbdb0a'
    else null
  end;
  v_version := case p_capability_key
    when 'submissions.reports.review' then 3
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

alter function public.has_submission_report_capability_v2(text, text)
  owner to postgres;
revoke all on function public.has_submission_report_capability_v2(text, text)
  from public, anon, authenticated, discord_bot, service_role;

do $postflight$
declare
  v_preflight submission_report_review_auth_v3_preflight%rowtype;
  v_has_function regprocedure :=
    'public.has_submission_report_capability_v2(text,text)'::regprocedure;
  v_definition text := lower(pg_get_functiondef(v_has_function));
begin
  select * into strict v_preflight
  from submission_report_review_auth_v3_preflight;

  if v_definition not like '%when ''submissions.reports.review'' then ''490f3168bf6cb0b162384ced36e2c3a3156d933d14603eb340255b9242bbdb0a''%'
    or v_definition not like '%when ''submissions.reports.review'' then 3%'
    or v_definition like '%submissions.reports.assign%'
    or not (
      select function_row.prosecdef
        and function_row.proowner = (select oid from pg_roles where rolname = 'postgres')
        and function_row.proconfig = array['search_path=public, pg_temp']
      from pg_proc function_row where function_row.oid = v_has_function
    )
    or (
      select count(*) from pg_proc function_row
      cross join lateral aclexplode(
        coalesce(function_row.proacl, acldefault('f', function_row.proowner))
      ) privilege_row
      where function_row.oid = v_has_function
        and privilege_row.privilege_type = 'EXECUTE'
    ) <> 1
    or has_function_privilege('service_role', v_has_function, 'EXECUTE')
    or has_function_privilege('anon', v_has_function, 'EXECUTE')
    or has_function_privilege('authenticated', v_has_function, 'EXECUTE')
    or has_function_privilege('discord_bot', v_has_function, 'EXECUTE') then
    raise exception using errcode = '55000',
      message = 'SUBMISSION_REPORT_REVIEW_AUTH_V3_FUNCTION_POSTFLIGHT_MISMATCH';
  end if;

  if v_preflight.case_count <> (select count(*) from public.submission_report_cases)
    or v_preflight.report_count <> (select count(*) from public.submission_reports)
    or v_preflight.payload_count <> (select count(*) from public.submission_report_payloads)
    or v_preflight.event_count <> (select count(*) from public.submission_report_case_events)
    or v_preflight.request_count <> (select count(*) from public.submission_report_requests)
    or v_preflight.read_count <> (select count(*) from public.submission_report_reads)
    or v_preflight.grant_count <> (select count(*) from public.team_role_capabilities) then
    raise exception using errcode = '55000',
      message = 'SUBMISSION_REPORT_REVIEW_AUTH_V3_DATA_POSTFLIGHT_MISMATCH';
  end if;
end;
$postflight$;

comment on function public.has_submission_report_capability_v2(text, text)
  is 'Fail-closed exact Submission Report capability authorization for the V3 review workflow; the legacy assign tombstone is never authorizing.';

commit;
