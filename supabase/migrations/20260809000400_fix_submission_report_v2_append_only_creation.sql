begin;

set local lock_timeout = '10s';
set local statement_timeout = '60s';

create temporary table submission_report_v2_fix_preflight on commit drop as
select
  (select count(*) from public.submission_report_cases) as case_count,
  (select count(*) from public.submission_reports) as report_count,
  (select count(*) from public.submission_report_payloads) as payload_count,
  (select count(*) from public.submission_report_case_events) as event_count,
  (select count(*) from public.submission_report_requests) as request_count;

do $preflight$
begin
  if to_regprocedure(
    'public.create_submission_report_v2(text,integer,text,bigint,integer,text,text,text,uuid)'
  ) is null
    or to_regprocedure('public.create_submission_report(text,integer,text,bigint,integer,text,text,text,uuid)') is null
    or not exists (
      select 1
      from pg_trigger
      where tgrelid = 'public.submission_reports'::regclass
        and tgname = 'protect_submission_reports'
        and not tgisinternal
    ) then
    raise exception 'SUBMISSION_REPORT_V2_FIX_PREFLIGHT_FAILED';
  end if;
end;
$preflight$;

-- The first V2 implementation delegated creation to the immutable V1 function
-- and then attempted to update the new report to taxonomy V2. The report fact
-- trigger correctly rejected that update. This replacement preserves the same
-- locks, idempotency, uniqueness, case, event, and payload transaction while
-- inserting the immutable report fact as taxonomy V2 from the outset.
create or replace function public.create_submission_report_v2(
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
  v_reporter_id text := btrim(p_reporter_discord_user_id);
  v_reason text := btrim(p_reason_code);
  v_subcategory text := nullif(btrim(p_subcategory_code), '');
  v_comment text := nullif(btrim(p_comment), '');
  v_payload jsonb;
  v_request_hash text;
  v_existing_hash text;
  v_existing_result jsonb;
  v_cycle public.voting_cycles%rowtype;
  v_submission public.submissions%rowtype;
  v_cycle_id bigint;
  v_phase text;
  v_content_sha text;
  v_public_profile_id uuid;
  v_identity_id uuid;
  v_case public.submission_report_cases%rowtype;
  v_case_id uuid;
  v_report_id uuid := gen_random_uuid();
  v_created_at timestamptz := statement_timestamp();
  v_result jsonb;
begin
  if p_idempotency_key is null or nullif(v_reporter_id, '') is null
    or char_length(v_reporter_id) > 100
    or p_reporter_dedupe_version is null or p_reporter_dedupe_version < 1
    or p_reporter_dedupe_hash is null
    or p_reporter_dedupe_hash !~ '^[0-9a-f]{64}$'
    or p_submission_id is null or p_submission_id < 1
    or p_reason_taxonomy_version is distinct from 2
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

  v_payload := jsonb_build_object(
    'operation', 'create', 'version', 1,
    'reporterDedupeVersion', p_reporter_dedupe_version,
    'reporterDedupeHash', p_reporter_dedupe_hash,
    'submissionId', p_submission_id,
    'taxonomyVersion', p_reason_taxonomy_version,
    'reason', v_reason, 'subcategory', v_subcategory, 'comment', v_comment
  );
  v_request_hash := encode(
    extensions.digest(convert_to(v_payload::text, 'UTF8'), 'sha256'),
    'hex'
  );
  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  select request_hash, result into v_existing_hash, v_existing_result
  from public.submission_report_requests
  where idempotency_key = p_idempotency_key;
  if found then
    if v_existing_hash = v_request_hash then
      return jsonb_set(v_existing_result, '{replayed}', 'true'::jsonb);
    end if;
    raise exception using errcode = 'PT409', message = 'SUBMISSION_REPORT_IDEMPOTENCY_CONFLICT';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('submission-report-reporter:' || v_reporter_id, 0)
  );

  select public_profile_id into v_public_profile_id
  from public.user_logs
  where discord_user_id = v_reporter_id
  for share;
  if not found then
    raise exception using errcode = '55000', message = 'SUBMISSION_REPORT_IDENTITY_UNAVAILABLE';
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
  select * into v_submission
  from public.submissions
  where id = p_submission_id
  for update;
  if not found or v_submission.cycle_id <> v_cycle.id
    or coalesce(v_submission.is_disqualified, false)
    or coalesce(v_submission.public_visibility_status, '') not in ('visible', 'legal_review') then
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

  if exists (
    select 1
    from public.submission_reports report
    join public.submission_reporter_identities identity
      on identity.identity_id = report.reporter_identity_id
    where report.submission_id = p_submission_id
      and (
        (report.reporter_dedupe_version = p_reporter_dedupe_version
          and report.reporter_dedupe_hash = p_reporter_dedupe_hash)
        or identity.discord_user_id = v_reporter_id
      )
  ) then
    raise exception using errcode = 'PT409', message = 'SUBMISSION_REPORT_ALREADY_REPORTED';
  end if;

  select identity.identity_id into v_identity_id
  from public.submission_reporter_identities identity
  where identity.discord_user_id = v_reporter_id
    and identity.anonymized_at is null
  for update;
  if not found then
    insert into public.submission_reporter_identities (
      discord_user_id, public_profile_id,
      reporter_dedupe_version, reporter_dedupe_hash
    ) values (
      v_reporter_id, v_public_profile_id,
      p_reporter_dedupe_version, p_reporter_dedupe_hash
    ) returning identity_id into v_identity_id;
  end if;

  select operation.content_sha256 into v_content_sha
  from public.submission_upload_operations operation
  where operation.submission_id = v_submission.id
    and operation.status = 'completed';

  select * into v_case
  from public.submission_report_cases
  where submission_id = p_submission_id
  for update;
  if found then
    v_case_id := v_case.case_id;
  else
    v_case_id := gen_random_uuid();
    insert into public.submission_report_cases (
      case_id, submission_id, cycle_id, cycle_reset_count,
      first_report_id, first_report_at, latest_report_id, latest_report_at
    ) values (
      v_case_id, v_submission.id, v_cycle.id, v_cycle.reset_count,
      v_report_id, v_created_at, v_report_id, v_created_at
    );
  end if;

  insert into public.submission_reports (
    report_id, case_id, submission_id, cycle_id, cycle_reset_count,
    reporter_identity_id, reporter_dedupe_version, reporter_dedupe_hash,
    reason_taxonomy_version, reason_code, subcategory_code,
    cycle_status_snapshot, phase_snapshot, public_visibility_snapshot,
    content_sha256, created_at
  ) values (
    v_report_id, v_case_id, v_submission.id, v_cycle.id, v_cycle.reset_count,
    v_identity_id, p_reporter_dedupe_version, p_reporter_dedupe_hash,
    2, v_reason, v_subcategory,
    v_cycle.status::text, v_phase, v_submission.public_visibility_status,
    v_content_sha, v_created_at
  );
  if v_comment is not null then
    insert into public.submission_report_payloads (report_id, reporter_comment)
    values (v_report_id, v_comment);
  end if;

  if v_case.case_id is null then
    update public.submission_report_cases
    set report_count = 1
    where case_id = v_case_id;
    insert into public.submission_report_case_events (
      case_id, report_id, event_type, previous_status, new_status, actor_kind,
      occurred_at, case_version, report_cursor_at, report_cursor_id
    ) values (
      v_case_id, v_report_id, 'report_created', null, 'open', 'reporter',
      v_created_at, 1, v_created_at, v_report_id
    );
  else
    update public.submission_report_cases set
      status = case when status = 'closed' then 'open' else status end,
      row_version = row_version + 1,
      report_count = report_count + 1,
      latest_report_id = v_report_id,
      latest_report_at = v_created_at,
      review_started_at = case when status = 'closed' then null else review_started_at end,
      review_started_by_discord_user_id = case when status = 'closed' then null else review_started_by_discord_user_id end,
      review_started_by_display_name = case when status = 'closed' then null else review_started_by_display_name end,
      closed_at = null,
      closed_by_discord_user_id = null,
      closed_by_display_name = null,
      close_disposition = null,
      close_note = null,
      updated_at = v_created_at
    where case_id = v_case_id;
    insert into public.submission_report_case_events (
      case_id, report_id, event_type, previous_status, new_status, actor_kind,
      occurred_at, case_version, report_cursor_at, report_cursor_id
    ) values (
      v_case_id, v_report_id, 'report_created', v_case.status,
      case when v_case.status = 'closed' then 'open' else v_case.status end,
      'reporter', v_created_at, v_case.row_version + 1, v_created_at, v_report_id
    );
    if v_case.status = 'closed' then
      insert into public.submission_report_case_events (
        case_id, report_id, event_type, previous_status, new_status, actor_kind,
        occurred_at, case_version, report_cursor_at, report_cursor_id
      ) values (
        v_case_id, v_report_id, 'case_reopened_by_report', 'closed', 'open',
        'reporter', v_created_at, v_case.row_version + 1,
        v_created_at, v_report_id
      );
      update public.submission_report_payloads payload
      set retention_due_at = null
      where exists (
        select 1
        from public.submission_reports report
        where report.report_id = payload.report_id
          and report.case_id = v_case_id
      )
        and payload.anonymized_at is null;
    end if;
  end if;

  v_result := jsonb_build_object(
    'reportId', v_report_id,
    'caseId', v_case_id,
    'createdAt', v_created_at,
    'replayed', false
  );
  insert into public.submission_report_requests (
    idempotency_key, operation, request_hash, result
  ) values (
    p_idempotency_key, 'create', v_request_hash, v_result
  );
  return v_result;
exception
  when unique_violation then
    raise exception using errcode = 'PT409', message = 'SUBMISSION_REPORT_ALREADY_REPORTED';
end;
$function$;

alter function public.create_submission_report_v2(
  text, integer, text, bigint, integer, text, text, text, uuid
) owner to postgres;
revoke all on function public.create_submission_report_v2(
  text, integer, text, bigint, integer, text, text, text, uuid
) from public, anon, authenticated, discord_bot, service_role;
grant execute on function public.create_submission_report_v2(
  text, integer, text, bigint, integer, text, text, text, uuid
) to service_role;

do $postflight$
declare
  v_definition text;
  v_preflight submission_report_v2_fix_preflight%rowtype;
begin
  select * into strict v_preflight from submission_report_v2_fix_preflight;
  select pg_get_functiondef(
    'public.create_submission_report_v2(text,integer,text,bigint,integer,text,text,text,uuid)'::regprocedure
  ) into v_definition;

  if position('update public.submission_reports' in lower(v_definition)) > 0
    or position('insert into public.submission_reports' in lower(v_definition)) = 0
    or not exists (
      select 1
      from pg_proc function_row
      join pg_namespace namespace_row on namespace_row.oid = function_row.pronamespace
      where function_row.oid = 'public.create_submission_report_v2(text,integer,text,bigint,integer,text,text,text,uuid)'::regprocedure
        and namespace_row.nspname = 'public'
        and function_row.prosecdef
        and function_row.proowner = 'postgres'::regrole
        and function_row.proconfig = array['search_path=public, pg_temp']
    )
    or has_function_privilege(
      'anon',
      'public.create_submission_report_v2(text,integer,text,bigint,integer,text,text,text,uuid)',
      'EXECUTE'
    )
    or has_function_privilege(
      'authenticated',
      'public.create_submission_report_v2(text,integer,text,bigint,integer,text,text,text,uuid)',
      'EXECUTE'
    )
    or has_function_privilege(
      'discord_bot',
      'public.create_submission_report_v2(text,integer,text,bigint,integer,text,text,text,uuid)',
      'EXECUTE'
    )
    or not has_function_privilege(
      'service_role',
      'public.create_submission_report_v2(text,integer,text,bigint,integer,text,text,text,uuid)',
      'EXECUTE'
    )
    or v_preflight.case_count <> (select count(*) from public.submission_report_cases)
    or v_preflight.report_count <> (select count(*) from public.submission_reports)
    or v_preflight.payload_count <> (select count(*) from public.submission_report_payloads)
    or v_preflight.event_count <> (select count(*) from public.submission_report_case_events)
    or v_preflight.request_count <> (select count(*) from public.submission_report_requests) then
    raise exception 'SUBMISSION_REPORT_V2_FIX_POSTFLIGHT_FAILED';
  end if;
end;
$postflight$;

commit;
