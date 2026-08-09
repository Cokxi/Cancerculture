-- Submission Report taxonomy V2 and private reporter projection.
-- Additive follow-up: the applied V1 migrations remain immutable.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '45s';

create temporary table submission_report_v2_preflight_counts
on commit drop
as
select
  (select count(*) from public.submission_reporter_identities) identities,
  (select count(*) from public.submission_report_cases) cases,
  (select count(*) from public.submission_reports) reports,
  (select count(*) from public.submission_report_payloads) payloads,
  (select count(*) from public.submission_report_case_events) events,
  (select count(*) from public.submission_report_requests) requests,
  (select count(*) from public.submission_reports where reason_taxonomy_version = 1) taxonomy_v1;

do $preflight$
begin
  if to_regclass('public.submission_reports') is null
    or to_regprocedure(
      'public.create_submission_report(text,integer,text,bigint,integer,text,text,text,uuid)'
    ) is null
    or to_regprocedure(
      'public.create_submission_report_v2(text,integer,text,bigint,integer,text,text,text,uuid)'
    ) is not null
    or to_regprocedure(
      'public.get_own_submission_reports(text,integer,text,timestamptz,uuid,integer)'
    ) is not null
    or (select count(*) from public.capability_catalog) <> 33
    or (select count(*) from public.capability_catalog where is_active) <> 31
    or (
      select count(*) from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 31
    or not exists (
      select 1 from public.capability_catalog
      where key = 'submissions.reports.view'
        and is_active and assignable_to_non_admin
    )
    or not exists (
      select 1 from public.capability_catalog
      where key = 'submissions.reports.review'
        and is_active and assignable_to_non_admin
    )
    or exists (
      select 1 from public.team_role_capabilities
      where capability_key in (
        'submissions.reports.view', 'submissions.reports.review'
      )
    )
    or exists (
      select 1 from public.submission_reports
      where reason_taxonomy_version <> 1
    )
    or not exists (
      select 1 from pg_constraint
      where conrelid = 'public.submission_reports'::regclass
        and conname = 'submission_reports_taxonomy_check'
        and pg_get_constraintdef(oid) like '%reason_taxonomy_version = 1%'
    )
    or not exists (
      select 1 from pg_constraint
      where conrelid = 'public.submission_reports'::regclass
        and conname = 'submission_reports_reason_check'
        and pg_get_constraintdef(oid) like '%spam_or_platform_abuse%'
    )
    or not exists (
      select 1 from pg_constraint
      where conrelid = 'public.submission_reports'::regclass
        and conname = 'submission_reports_subcategory_check'
        and pg_get_constraintdef(oid) like '%personal_information%'
    ) then
    raise exception using errcode = '55000',
      message = 'SUBMISSION_REPORT_V2_BASELINE_MISMATCH';
  end if;
end;
$preflight$;

alter table public.submission_reports
  drop constraint submission_reports_taxonomy_check,
  drop constraint submission_reports_reason_check,
  drop constraint submission_reports_subcategory_check;

alter table public.submission_reports
  add constraint submission_reports_taxonomy_check
    check (reason_taxonomy_version in (1, 2)),
  add constraint submission_reports_reason_check check (
    (reason_taxonomy_version = 1 and reason_code in (
      'illegal_or_harmful_content', 'hate_harassment_or_threats',
      'privacy_or_personal_information', 'rights_or_ownership',
      'spam_or_platform_abuse', 'fair_play_manipulation',
      'low_effort_or_off_topic', 'other_rules_concern'
    ))
    or
    (reason_taxonomy_version = 2 and reason_code in (
      'illegal_or_harmful_content', 'hate_harassment_or_threats',
      'privacy_or_personal_information', 'rights_or_ownership',
      'fair_play_manipulation', 'low_effort_or_off_topic',
      'other_rules_concern'
    ))
  ),
  add constraint submission_reports_subcategory_check check (
    (
      reason_taxonomy_version = 1 and (
        subcategory_code is null
        or (reason_code = 'illegal_or_harmful_content' and subcategory_code in ('sexual_abuse_content', 'extreme_violence', 'terrorism_or_illegal_activity'))
        or (reason_code = 'hate_harassment_or_threats' and subcategory_code in ('hate_speech', 'threats', 'targeted_harassment'))
        or (reason_code = 'privacy_or_personal_information' and subcategory_code in ('doxxing', 'personal_information', 'impersonation_or_identity_rights'))
        or (reason_code = 'rights_or_ownership' and subcategory_code = 'copyright_or_unlicensed_use')
        or (reason_code = 'spam_or_platform_abuse' and subcategory_code in ('spam', 'upload_limit_evasion'))
        or (reason_code = 'fair_play_manipulation' and subcategory_code in ('vote_influence_or_promotion', 'coordinated_manipulation'))
        or (reason_code = 'low_effort_or_off_topic' and subcategory_code in ('low_effort', 'off_topic'))
      )
    )
    or
    (
      reason_taxonomy_version = 2 and subcategory_code is not null and (
        (reason_code = 'illegal_or_harmful_content' and subcategory_code in ('sexual_abuse_content', 'extreme_violence', 'terrorism_or_illegal_activity', 'other'))
        or (reason_code = 'hate_harassment_or_threats' and subcategory_code in ('hate_speech', 'threats', 'targeted_harassment', 'other'))
        or (reason_code = 'privacy_or_personal_information' and subcategory_code in ('doxxing', 'other'))
        or (reason_code = 'rights_or_ownership' and subcategory_code in ('copyright_or_unlicensed_use', 'other'))
        or (reason_code = 'fair_play_manipulation' and subcategory_code in ('vote_influence_or_promotion', 'coordinated_manipulation', 'other'))
        or (reason_code = 'low_effort_or_off_topic' and subcategory_code in ('low_effort', 'off_topic', 'other'))
        or (reason_code = 'other_rules_concern' and subcategory_code = 'other')
      )
    )
  );

create function public.create_submission_report_v2(
  p_reporter_discord_user_id text,
  p_reporter_dedupe_version integer,
  p_reporter_dedupe_hash text,
  p_submission_id bigint,
  p_reason_taxonomy_version integer,
  p_reason_code text,
  p_subcategory_code text,
  p_comment text,
  p_idempotency_key uuid
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $function$
declare
  v_reason text := btrim(p_reason_code);
  v_subcategory text := nullif(btrim(p_subcategory_code), '');
  v_comment text := nullif(btrim(p_comment), '');
  v_legacy_subcategory text;
  v_cycle public.voting_cycles%rowtype;
  v_cycle_id bigint;
  v_phase text;
  v_result jsonb;
  v_report_id uuid;
begin
  if p_reason_taxonomy_version is distinct from 2
    or v_reason is null or v_reason not in (
      'illegal_or_harmful_content', 'hate_harassment_or_threats',
      'privacy_or_personal_information', 'rights_or_ownership',
      'fair_play_manipulation', 'low_effort_or_off_topic',
      'other_rules_concern'
    )
    or v_subcategory is null
    or not (
      (v_reason = 'illegal_or_harmful_content' and v_subcategory in ('sexual_abuse_content', 'extreme_violence', 'terrorism_or_illegal_activity', 'other'))
      or (v_reason = 'hate_harassment_or_threats' and v_subcategory in ('hate_speech', 'threats', 'targeted_harassment', 'other'))
      or (v_reason = 'privacy_or_personal_information' and v_subcategory in ('doxxing', 'other'))
      or (v_reason = 'rights_or_ownership' and v_subcategory in ('copyright_or_unlicensed_use', 'other'))
      or (v_reason = 'fair_play_manipulation' and v_subcategory in ('vote_influence_or_promotion', 'coordinated_manipulation', 'other'))
      or (v_reason = 'low_effort_or_off_topic' and v_subcategory in ('low_effort', 'off_topic', 'other'))
      or (v_reason = 'other_rules_concern' and v_subcategory = 'other')
    )
    or (v_comment is not null and char_length(v_comment) not between 10 and 500)
    or (
      (v_reason in ('fair_play_manipulation', 'rights_or_ownership', 'other_rules_concern')
        or v_subcategory = 'other')
      and (v_comment is null or char_length(v_comment) < 20)
    ) then
    raise exception using errcode = '22023', message = 'SUBMISSION_REPORT_INVALID';
  end if;

  -- V1 remains the proven atomic creation primitive. V2 pre-validates and locks
  -- through that primitive, then records the immutable V2 taxonomy fact in the
  -- same transaction. A failed V2 phase check rolls the whole V1 call back.
  v_legacy_subcategory := case
    when v_subcategory = 'other' then null
    else v_subcategory
  end;
  v_result := public.create_submission_report(
    p_reporter_discord_user_id,
    p_reporter_dedupe_version,
    p_reporter_dedupe_hash,
    p_submission_id,
    1,
    v_reason,
    v_legacy_subcategory,
    v_comment,
    p_idempotency_key
  );
  v_report_id := (v_result ->> 'reportId')::uuid;

  if (v_result ->> 'replayed')::boolean then
    if not exists (
      select 1 from public.submission_reports report
      where report.report_id = v_report_id
        and report.reason_taxonomy_version = 2
        and report.reason_code = v_reason
        and report.subcategory_code = v_subcategory
    ) then
      raise exception using errcode = 'PT409', message = 'SUBMISSION_REPORT_IDEMPOTENCY_CONFLICT';
    end if;
    return v_result;
  end if;

  select submission.cycle_id into v_cycle_id
  from public.submissions submission
  where submission.id = p_submission_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'SUBMISSION_REPORT_NOT_REPORTABLE';
  end if;

  select * into v_cycle
  from public.voting_cycles
  where id = v_cycle_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'SUBMISSION_REPORT_NOT_REPORTABLE';
  end if;

  v_phase := case
    when v_cycle.status::text = 'submission_open' then 'submission_open'
    when v_cycle.status::text in ('voting_open', 'active') then 'voting_open'
    when v_cycle.status::text = 'voting_closed' then 'voting_closed'
    when v_cycle.status::text = 'paused' and v_cycle.paused_from_status = 'submission_open' then 'submission_open'
    when v_cycle.status::text = 'paused' and v_cycle.paused_from_status = 'voting_open' then 'voting_open'
    when v_cycle.status::text = 'finished' then 'history'
    else null
  end;
  if v_phase is null
    or (v_phase = 'history' and v_reason in ('fair_play_manipulation', 'low_effort_or_off_topic'))
    or (v_phase <> 'history' and v_reason = 'rights_or_ownership') then
    raise exception using errcode = 'P0002', message = 'SUBMISSION_REPORT_NOT_REPORTABLE';
  end if;

  update public.submission_reports
  set reason_taxonomy_version = 2,
      reason_code = v_reason,
      subcategory_code = v_subcategory
  where report_id = v_report_id
    and (
      reason_taxonomy_version <> 2
      or reason_code <> v_reason
      or subcategory_code is distinct from v_subcategory
    );

  return v_result;
end;
$function$;

create function public.get_own_submission_reports(
  p_reporter_discord_user_id text,
  p_reporter_dedupe_version integer,
  p_reporter_dedupe_hash text,
  p_before_created_at timestamptz default null,
  p_before_report_id uuid default null,
  p_limit integer default 25
)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $function$
declare
  v_reporter_id text := btrim(p_reporter_discord_user_id);
  v_result jsonb;
begin
  if nullif(v_reporter_id, '') is null or char_length(v_reporter_id) > 100
    or p_reporter_dedupe_version is null or p_reporter_dedupe_version < 1
    or p_reporter_dedupe_hash is null
    or p_reporter_dedupe_hash !~ '^[0-9a-f]{64}$'
    or (p_before_created_at is null) <> (p_before_report_id is null)
    or p_limit not between 1 and 50 then
    raise exception using errcode = '22023', message = 'SUBMISSION_REPORT_INVALID';
  end if;

  with page as (
    select report.created_at, report.report_id, jsonb_build_object(
        'reportId', report.report_id,
        'submissionId', report.submission_id,
        'cycleId', report.cycle_id,
        'createdAt', report.created_at,
        'reasonTaxonomyVersion', report.reason_taxonomy_version,
        'reasonCode', report.reason_code,
        'subcategoryCode', report.subcategory_code,
        'comment', payload.reporter_comment,
        'phaseSnapshot', report.phase_snapshot,
        'outcomeCode', case
          when case_row.status = 'open' then 'report_received'
          when case_row.status = 'in_review' then 'under_review'
          when case_row.close_disposition = 'action_taken' then 'action_taken_after_review'
          when case_row.close_disposition = 'no_action_current_rules' then 'reviewed_no_action_current_rules'
          when case_row.close_disposition = 'submission_unavailable' then 'closed_submission_unavailable'
          else 'included_in_completed_review'
        end,
        'currentAvailable', submission.id is not null,
        'currentCycleStatus', cycle.status::text,
        'currentVisibility', submission.public_visibility_status,
        'currentDisqualified', coalesce(submission.is_disqualified, false)
      ) item
    from public.submission_reports report
    join public.submission_reporter_identities identity
      on identity.identity_id = report.reporter_identity_id
    join public.submission_report_cases case_row on case_row.case_id = report.case_id
    left join public.submission_report_payloads payload on payload.report_id = report.report_id
    left join public.submissions submission on submission.id = report.submission_id
    left join public.voting_cycles cycle on cycle.id = report.cycle_id
    where identity.anonymized_at is null
      and identity.discord_user_id = v_reporter_id
      and (
        p_before_created_at is null
        or (report.created_at, report.report_id) <
          (p_before_created_at, p_before_report_id)
      )
    order by report.created_at desc, report.report_id desc
    limit p_limit + 1
  ), visible as (
    select * from page order by created_at desc, report_id desc limit p_limit
  )
  select jsonb_build_object(
    'reports', coalesce(
      (select jsonb_agg(item order by created_at desc, report_id desc) from visible),
      '[]'::jsonb
    ),
    'nextCursor', case
      when (select count(*) from page) > p_limit then (
        select jsonb_build_object('createdAt', created_at, 'reportId', report_id)
        from visible order by created_at asc, report_id asc limit 1
      )
      else null
    end
  ) into v_result;
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
  perform public.authorize_submission_report_capability(
    p_actor_discord_user_id, 'submissions.reports.view'
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
        'actionTakenCaseCount', count(*) filter (
          where case_row.status = 'closed'
            and case_row.close_disposition = 'action_taken'
        )::integer,
        'latestReportAt', max(report.created_at)
      ) item
    from public.submission_reports report
    join public.submission_reporter_identities identity on identity.identity_id = report.reporter_identity_id
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
  perform public.authorize_submission_report_capability(
    p_actor_discord_user_id, 'submissions.reports.view'
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
        'reportId', report.report_id, 'caseId', report.case_id,
        'submissionId', report.submission_id, 'cycleId', report.cycle_id,
        'createdAt', report.created_at, 'reasonCode', report.reason_code,
        'subcategoryCode', report.subcategory_code,
        'comment', payload.reporter_comment, 'phaseSnapshot', report.phase_snapshot,
        'caseStatus', case_row.status, 'closeDisposition', case_row.close_disposition,
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
    join public.submission_reporter_identities identity on identity.identity_id = report.reporter_identity_id
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

alter function public.create_submission_report_v2(text, integer, text, bigint, integer, text, text, text, uuid) owner to postgres;
alter function public.get_own_submission_reports(text, integer, text, timestamptz, uuid, integer) owner to postgres;
alter function public.list_submission_reporter_profiles(text, integer) owner to postgres;
alter function public.get_submission_reporter_history(text, uuid, integer) owner to postgres;

revoke all on function public.create_submission_report_v2(text, integer, text, bigint, integer, text, text, text, uuid) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_own_submission_reports(text, integer, text, timestamptz, uuid, integer) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.list_submission_reporter_profiles(text, integer) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_submission_reporter_history(text, uuid, integer) from public, anon, authenticated, discord_bot, service_role;

grant execute on function public.create_submission_report_v2(text, integer, text, bigint, integer, text, text, text, uuid) to service_role;
grant execute on function public.get_own_submission_reports(text, integer, text, timestamptz, uuid, integer) to service_role;
grant execute on function public.list_submission_reporter_profiles(text, integer) to service_role;
grant execute on function public.get_submission_reporter_history(text, uuid, integer) to service_role;

do $postflight$
declare
  v_before submission_report_v2_preflight_counts%rowtype;
begin
  select * into v_before from submission_report_v2_preflight_counts;

  if to_regprocedure(
      'public.create_submission_report_v2(text,integer,text,bigint,integer,text,text,text,uuid)'
    ) is null
    or to_regprocedure(
      'public.get_own_submission_reports(text,integer,text,timestamptz,uuid,integer)'
    ) is null
    or not exists (
      select 1 from pg_constraint
      where conrelid = 'public.submission_reports'::regclass
        and conname = 'submission_reports_taxonomy_check'
        and pg_get_constraintdef(oid) like '%reason_taxonomy_version = ANY%'
    )
    or not exists (
      select 1 from pg_constraint
      where conrelid = 'public.submission_reports'::regclass
        and conname = 'submission_reports_subcategory_check'
        and pg_get_constraintdef(oid) like '%subcategory_code IS NOT NULL%'
        and pg_get_constraintdef(oid) like '%other%'
    )
    or not has_function_privilege(
      'service_role',
      'public.create_submission_report_v2(text,integer,text,bigint,integer,text,text,text,uuid)',
      'EXECUTE'
    )
    or has_function_privilege(
      'anon',
      'public.create_submission_report_v2(text,integer,text,bigint,integer,text,text,text,uuid)',
      'EXECUTE'
    )
    or has_function_privilege(
      'authenticated',
      'public.get_own_submission_reports(text,integer,text,timestamptz,uuid,integer)',
      'EXECUTE'
    )
    or has_function_privilege(
      'discord_bot',
      'public.get_own_submission_reports(text,integer,text,timestamptz,uuid,integer)',
      'EXECUTE'
    )
    or (select count(*) from public.capability_catalog) <> 33
    or (select count(*) from public.capability_catalog where is_active) <> 31
    or (
      select count(*) from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 31
    or exists (
      select 1 from public.team_role_capabilities
      where capability_key in (
        'submissions.reports.view', 'submissions.reports.review'
      )
    )
    or (select count(*) from public.submission_reporter_identities) <> v_before.identities
    or (select count(*) from public.submission_report_cases) <> v_before.cases
    or (select count(*) from public.submission_reports) <> v_before.reports
    or (select count(*) from public.submission_report_payloads) <> v_before.payloads
    or (select count(*) from public.submission_report_case_events) <> v_before.events
    or (select count(*) from public.submission_report_requests) <> v_before.requests
    or (
      select count(*) from public.submission_reports
      where reason_taxonomy_version = 1
    ) <> v_before.taxonomy_v1
    or exists (
      select 1 from public.submission_reports
      where reason_taxonomy_version <> 1
    ) then
    raise exception using errcode = '55000',
      message = 'SUBMISSION_REPORT_V2_POSTFLIGHT_FAILED';
  end if;
end;
$postflight$;

commit;
