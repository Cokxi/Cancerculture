begin;

set local lock_timeout = '5s';
set local statement_timeout = '45s';

do $preflight$
begin
  if (select count(*) from public.capability_catalog) <> 31
    or (select count(*) from public.capability_catalog where is_active) <> 29
    or (
      select count(*) from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 29
    or to_regclass('public.submissions') is null
    or to_regclass('public.voting_cycles') is null
    or to_regclass('public.user_logs') is null
    or to_regclass('public.submission_upload_operations') is null then
    raise exception using errcode = '55000',
      message = 'SUBMISSION_REPORT_BASELINE_MISMATCH';
  end if;

  if exists (
      select 1 from public.capability_catalog
      where key in ('submissions.reports.view', 'submissions.reports.review')
    )
    or to_regclass('public.submission_report_cases') is not null
    or to_regclass('public.submission_reports') is not null
    or to_regclass('public.submission_reporter_identities') is not null
    or to_regclass('public.submission_report_payloads') is not null
    or to_regclass('public.submission_report_case_events') is not null
    or to_regclass('public.submission_report_requests') is not null then
    raise exception using errcode = '55000',
      message = 'SUBMISSION_REPORT_TARGET_ALREADY_PRESENT';
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
    'submissions.reports.view',
    'View Submission Reports',
    'View the case-centered Submission Report queue and reporter-centered Report history without changing review or moderation state.',
    'Submission Moderation',
    array[
      'View bounded Submission Report queue and case details.',
      'View complete reporter-centered Submission Report history with minimal current identity.',
      'View report reasons, optional reporter context, immutable phase snapshots, and case events.'
    ]::text[],
    array[
      'Acknowledging, reviewing, reopening, or closing Report cases.',
      'Disqualifying, reinstating, hiding, deleting, banning, or otherwise sanctioning users or Submissions.',
      'Viewing unrelated User Directory, Moderation Log, vote, security, or infrastructure data.'
    ]::text[],
    'high', false, false, 1,
    '0f8bdec2e69427665a49067e4a2d2da7d4f81053b6f6e1f427cc262f26b7ef0e'
  ),
  (
    'submissions.reports.review',
    'Review Submission Report Cases',
    'Acknowledge and work Submission Report cases with optimistic concurrency while all actual moderation actions remain separately authorized.',
    'Submission Moderation',
    array[
      'Acknowledge Reports through an explicit shared high-water cursor.',
      'Start review, return a case to the queue, and close a case with an auditable disposition and note.',
      'Reopen review only through the defined case workflow and expected-version contract.'
    ]::text[],
    array[
      'Reading the Report queue or reporter history without submissions.reports.view.',
      'Disqualifying, reinstating, hiding, deleting, banning, or otherwise sanctioning users or Submissions.',
      'Changing Report facts, reporter identity, reasons, counts, or append-only events.'
    ]::text[],
    'high', false, false, 1,
    'a9c1de7076eac2fd58052833930038f01e48e1ea37da51fb1f696508b11575f1'
  );

create table public.submission_reporter_identities (
  identity_id uuid primary key default gen_random_uuid(),
  discord_user_id text,
  public_profile_id uuid,
  reporter_dedupe_version integer not null,
  reporter_dedupe_hash text not null,
  created_at timestamptz not null default transaction_timestamp(),
  anonymized_at timestamptz,
  constraint submission_reporter_identity_discord_check
    check (discord_user_id is null or char_length(btrim(discord_user_id)) between 1 and 100),
  constraint submission_reporter_identity_dedupe_version_check
    check (reporter_dedupe_version >= 1),
  constraint submission_reporter_identity_dedupe_hash_check
    check (reporter_dedupe_hash ~ '^[0-9a-f]{64}$'),
  constraint submission_reporter_identity_anonymization_check
    check (
      (anonymized_at is null and discord_user_id is not null and public_profile_id is not null)
      or (anonymized_at is not null and discord_user_id is null and public_profile_id is null)
    )
);

create unique index submission_reporter_identity_active_discord_idx
  on public.submission_reporter_identities(discord_user_id)
  where discord_user_id is not null and anonymized_at is null;

create index submission_reporter_identity_dedupe_idx
  on public.submission_reporter_identities(
    reporter_dedupe_version, reporter_dedupe_hash
  );

create table public.submission_report_cases (
  case_id uuid primary key default gen_random_uuid(),
  submission_id bigint not null unique,
  cycle_id bigint not null,
  cycle_reset_count integer not null,
  status text not null default 'open',
  row_version bigint not null default 1,
  report_count integer not null default 0,
  first_report_id uuid not null,
  first_report_at timestamptz not null,
  latest_report_id uuid not null,
  latest_report_at timestamptz not null,
  acknowledged_report_id uuid,
  acknowledged_report_at timestamptz,
  reviewed_through_report_id uuid,
  reviewed_through_report_at timestamptz,
  review_started_at timestamptz,
  review_started_by_discord_user_id text,
  review_started_by_display_name text,
  closed_at timestamptz,
  closed_by_discord_user_id text,
  closed_by_display_name text,
  close_disposition text,
  close_note text,
  updated_at timestamptz not null default transaction_timestamp(),
  constraint submission_report_cases_status_check
    check (status in ('open', 'in_review', 'closed')),
  constraint submission_report_cases_version_check check (row_version >= 1),
  constraint submission_report_cases_count_check check (report_count >= 0),
  constraint submission_report_cases_reset_check check (cycle_reset_count >= 0),
  constraint submission_report_cases_ack_pair_check
    check ((acknowledged_report_id is null) = (acknowledged_report_at is null)),
  constraint submission_report_cases_reviewed_pair_check
    check ((reviewed_through_report_id is null) = (reviewed_through_report_at is null)),
  constraint submission_report_cases_close_disposition_check
    check (close_disposition is null or close_disposition in (
      'action_taken', 'no_action_current_rules',
      'insufficient_information', 'submission_unavailable', 'completed_other'
    )),
  constraint submission_report_cases_close_note_check
    check (close_note is null or char_length(btrim(close_note)) between 10 and 1000),
  constraint submission_report_cases_state_metadata_check
    check (
      (status = 'open' and closed_at is null and close_disposition is null and close_note is null)
      or (status = 'in_review' and review_started_at is not null and closed_at is null and close_disposition is null and close_note is null)
      or (status = 'closed' and review_started_at is not null and closed_at is not null and close_disposition is not null and close_note is not null)
    )
);

create table public.submission_reports (
  report_id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.submission_report_cases(case_id)
    on update restrict on delete restrict,
  submission_id bigint not null,
  cycle_id bigint not null,
  cycle_reset_count integer not null,
  reporter_identity_id uuid not null
    references public.submission_reporter_identities(identity_id)
    on update restrict on delete restrict,
  reporter_dedupe_version integer not null,
  reporter_dedupe_hash text not null,
  reason_taxonomy_version integer not null,
  reason_code text not null,
  subcategory_code text,
  cycle_status_snapshot text not null,
  phase_snapshot text not null,
  public_visibility_snapshot text not null,
  content_sha256 text,
  created_at timestamptz not null,
  recorded_at timestamptz not null default transaction_timestamp(),
  constraint submission_reports_once_per_reporter
    unique (submission_id, reporter_dedupe_version, reporter_dedupe_hash),
  constraint submission_reports_dedupe_check
    check (reporter_dedupe_hash ~ '^[0-9a-f]{64}$' and reporter_dedupe_version >= 1),
  constraint submission_reports_taxonomy_check
    check (reason_taxonomy_version = 1),
  constraint submission_reports_reason_check
    check (reason_code in (
      'illegal_or_harmful_content', 'hate_harassment_or_threats',
      'privacy_or_personal_information', 'rights_or_ownership',
      'spam_or_platform_abuse', 'fair_play_manipulation',
      'low_effort_or_off_topic', 'other_rules_concern'
    )),
  constraint submission_reports_subcategory_check check (
    subcategory_code is null
    or (reason_code = 'illegal_or_harmful_content' and subcategory_code in ('sexual_abuse_content', 'extreme_violence', 'terrorism_or_illegal_activity'))
    or (reason_code = 'hate_harassment_or_threats' and subcategory_code in ('hate_speech', 'threats', 'targeted_harassment'))
    or (reason_code = 'privacy_or_personal_information' and subcategory_code in ('doxxing', 'personal_information', 'impersonation_or_identity_rights'))
    or (reason_code = 'rights_or_ownership' and subcategory_code = 'copyright_or_unlicensed_use')
    or (reason_code = 'spam_or_platform_abuse' and subcategory_code in ('spam', 'upload_limit_evasion'))
    or (reason_code = 'fair_play_manipulation' and subcategory_code in ('vote_influence_or_promotion', 'coordinated_manipulation'))
    or (reason_code = 'low_effort_or_off_topic' and subcategory_code in ('low_effort', 'off_topic'))
  ),
  constraint submission_reports_phase_check
    check (phase_snapshot in ('submission_open', 'voting_open', 'voting_closed', 'history')),
  constraint submission_reports_visibility_check
    check (public_visibility_snapshot in ('visible', 'legal_review')),
  constraint submission_reports_content_hash_check
    check (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$'),
  constraint submission_reports_reset_check check (cycle_reset_count >= 0)
);

alter table public.submission_report_cases
  add constraint submission_report_cases_first_report_fk
  foreign key (first_report_id) references public.submission_reports(report_id)
  on update restrict on delete restrict deferrable initially deferred,
  add constraint submission_report_cases_latest_report_fk
  foreign key (latest_report_id) references public.submission_reports(report_id)
  on update restrict on delete restrict deferrable initially deferred,
  add constraint submission_report_cases_ack_report_fk
  foreign key (acknowledged_report_id) references public.submission_reports(report_id)
  on update restrict on delete restrict,
  add constraint submission_report_cases_reviewed_report_fk
  foreign key (reviewed_through_report_id) references public.submission_reports(report_id)
  on update restrict on delete restrict;

create table public.submission_report_payloads (
  report_id uuid primary key references public.submission_reports(report_id)
    on update restrict on delete restrict,
  reporter_comment text not null,
  retention_due_at timestamptz,
  anonymized_at timestamptz,
  constraint submission_report_payload_comment_check
    check (char_length(btrim(reporter_comment)) between 10 and 500),
  constraint submission_report_payload_anonymized_check
    check (anonymized_at is null or reporter_comment = '[anonymized]')
);

create table public.submission_report_case_events (
  event_id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.submission_report_cases(case_id)
    on update restrict on delete restrict,
  report_id uuid references public.submission_reports(report_id)
    on update restrict on delete restrict,
  event_type text not null,
  previous_status text,
  new_status text not null,
  actor_kind text not null,
  actor_discord_user_id text,
  actor_display_name text,
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default transaction_timestamp(),
  disposition text,
  note text,
  case_version bigint not null,
  report_cursor_at timestamptz,
  report_cursor_id uuid,
  constraint submission_report_events_type_check check (event_type in (
    'report_created', 'case_reopened_by_report', 'case_acknowledged',
    'review_started', 'review_returned_open', 'case_closed'
  )),
  constraint submission_report_events_status_check check (
    (previous_status is null or previous_status in ('open', 'in_review', 'closed'))
    and new_status in ('open', 'in_review', 'closed')
  ),
  constraint submission_report_events_actor_check check (
    (actor_kind = 'reporter' and actor_discord_user_id is null)
    or (actor_kind in ('admin', 'team') and nullif(btrim(actor_discord_user_id), '') is not null)
  ),
  constraint submission_report_events_note_check
    check (note is null or char_length(btrim(note)) between 10 and 1000),
  constraint submission_report_events_cursor_pair_check
    check ((report_cursor_at is null) = (report_cursor_id is null)),
  constraint submission_report_events_version_check check (case_version >= 1)
);

create table public.submission_report_requests (
  request_id uuid primary key default gen_random_uuid(),
  idempotency_key uuid not null unique,
  operation text not null,
  request_hash text not null,
  result jsonb not null,
  created_at timestamptz not null default transaction_timestamp(),
  constraint submission_report_requests_operation_check
    check (operation in ('create', 'acknowledge', 'start_review', 'return_open', 'close')),
  constraint submission_report_requests_hash_check
    check (request_hash ~ '^[0-9a-f]{64}$'),
  constraint submission_report_requests_result_check
    check (jsonb_typeof(result) = 'object')
);

create index submission_report_cases_queue_idx
  on public.submission_report_cases(status, updated_at, case_id);
create index submission_reports_case_cursor_idx
  on public.submission_reports(case_id, created_at, report_id);
create index submission_reports_identity_cursor_idx
  on public.submission_reports(reporter_identity_id, created_at desc, report_id desc);
create index submission_report_events_case_cursor_idx
  on public.submission_report_case_events(case_id, occurred_at, event_id);

alter table public.submission_reporter_identities owner to postgres;
alter table public.submission_report_cases owner to postgres;
alter table public.submission_reports owner to postgres;
alter table public.submission_report_payloads owner to postgres;
alter table public.submission_report_case_events owner to postgres;
alter table public.submission_report_requests owner to postgres;

create function public.protect_submission_report_append_only()
returns trigger language plpgsql set search_path = public, pg_temp
as $function$
begin
  raise exception using errcode = '55000',
    message = 'SUBMISSION_REPORT_APPEND_ONLY_VIOLATION';
end;
$function$;

create function public.protect_submission_report_case_delete()
returns trigger language plpgsql set search_path = public, pg_temp
as $function$
begin
  raise exception using errcode = '55000',
    message = 'SUBMISSION_REPORT_CASE_DELETE_FORBIDDEN';
end;
$function$;

alter function public.protect_submission_report_append_only() owner to postgres;
alter function public.protect_submission_report_case_delete() owner to postgres;

create trigger protect_submission_reports
before update or delete on public.submission_reports
for each row execute function public.protect_submission_report_append_only();
create trigger protect_submission_report_events
before update or delete on public.submission_report_case_events
for each row execute function public.protect_submission_report_append_only();
create trigger protect_submission_report_requests
before update or delete on public.submission_report_requests
for each row execute function public.protect_submission_report_append_only();
create trigger protect_submission_report_case_delete
before delete on public.submission_report_cases
for each row execute function public.protect_submission_report_case_delete();

alter table public.submission_reporter_identities enable row level security;
alter table public.submission_report_cases enable row level security;
alter table public.submission_reports enable row level security;
alter table public.submission_report_payloads enable row level security;
alter table public.submission_report_case_events enable row level security;
alter table public.submission_report_requests enable row level security;

revoke all on table public.submission_reporter_identities from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.submission_report_cases from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.submission_reports from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.submission_report_payloads from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.submission_report_case_events from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.submission_report_requests from public, anon, authenticated, discord_bot, service_role;

create function public.authorize_submission_report_capability(
  p_actor_discord_user_id text,
  p_capability_key text
)
returns text language plpgsql security definer set search_path = public, pg_temp
as $function$
declare
  v_actor_id text := btrim(p_actor_discord_user_id);
  v_role text;
  v_hash text;
begin
  v_hash := case p_capability_key
    when 'submissions.reports.view' then '0f8bdec2e69427665a49067e4a2d2da7d4f81053b6f6e1f427cc262f26b7ef0e'
    when 'submissions.reports.review' then 'a9c1de7076eac2fd58052833930038f01e48e1ea37da51fb1f696508b11575f1'
    else null
  end;
  if nullif(v_actor_id, '') is null or v_hash is null then
    raise exception using errcode = '42501', message = 'SUBMISSION_REPORT_FORBIDDEN';
  end if;
  if not exists (
    select 1 from public.capability_catalog
    where key = p_capability_key and is_active and assignable_to_non_admin
      and implementation_version = 1 and definition_hash = v_hash
  ) then
    raise exception using errcode = '55000',
      message = 'SUBMISSION_REPORT_AUTHORIZATION_DEPENDENCY_UNAVAILABLE';
  end if;
  select member.role into v_role
  from public.team_members member
  join public.team_roles role on role.key = member.role and role.is_active
  where member.discord_user_id = v_actor_id;
  if not found or (
    v_role <> 'admin' and not exists (
      select 1 from public.team_role_capabilities
      where role_key = v_role and capability_key = p_capability_key
    )
  ) then
    raise exception using errcode = '42501', message = 'SUBMISSION_REPORT_FORBIDDEN';
  end if;
  return v_role;
end;
$function$;

create function public.get_submission_report_eligibility(
  p_reporter_discord_user_id text,
  p_reporter_dedupe_version integer,
  p_reporter_dedupe_hash text,
  p_submission_id bigint
)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $function$
declare
  v_reportable boolean := false;
  v_already boolean := false;
  v_multiple boolean := false;
begin
  if nullif(btrim(p_reporter_discord_user_id), '') is null
    or p_reporter_dedupe_version is null or p_reporter_dedupe_version < 1
    or p_reporter_dedupe_hash is null
    or p_reporter_dedupe_hash !~ '^[0-9a-f]{64}$'
    or p_submission_id is null or p_submission_id < 1 then
    raise exception using errcode = '22023', message = 'SUBMISSION_REPORT_INVALID';
  end if;
  select exists (
    select 1 from public.submissions submission
    join public.voting_cycles cycle on cycle.id = submission.cycle_id
    where submission.id = p_submission_id
      and not coalesce(submission.is_disqualified, false)
      and submission.public_visibility_status in ('visible', 'legal_review')
      and (
        cycle.status in ('submission_open', 'voting_open', 'voting_closed', 'active', 'finished')
        or (cycle.status = 'paused' and cycle.paused_from_status in ('submission_open', 'voting_open'))
      )
  ) into v_reportable;
  select exists (
    select 1 from public.submission_reports report
    join public.submission_reporter_identities identity
      on identity.identity_id = report.reporter_identity_id
    where report.submission_id = p_submission_id
      and (
        (report.reporter_dedupe_version = p_reporter_dedupe_version
          and report.reporter_dedupe_hash = p_reporter_dedupe_hash)
        or identity.discord_user_id = btrim(p_reporter_discord_user_id)
      )
  ) into v_already;
  select count(*) >= 3 into v_multiple
  from public.submission_reports report where report.submission_id = p_submission_id;
  return jsonb_build_object(
    'canReport', v_reportable and not v_already,
    'alreadyReported', v_already,
    'hasMultipleExistingReports', v_multiple
  );
end;
$function$;

create function public.create_submission_report(
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
    or p_reason_taxonomy_version is null or p_reason_taxonomy_version <> 1
    or v_reason is null or v_reason not in (
      'illegal_or_harmful_content', 'hate_harassment_or_threats',
      'privacy_or_personal_information', 'rights_or_ownership',
      'spam_or_platform_abuse', 'fair_play_manipulation',
      'low_effort_or_off_topic', 'other_rules_concern'
    ) or (v_comment is not null and char_length(v_comment) not between 10 and 500)
    or not (
      v_subcategory is null
      or (v_reason = 'illegal_or_harmful_content' and v_subcategory in ('sexual_abuse_content', 'extreme_violence', 'terrorism_or_illegal_activity'))
      or (v_reason = 'hate_harassment_or_threats' and v_subcategory in ('hate_speech', 'threats', 'targeted_harassment'))
      or (v_reason = 'privacy_or_personal_information' and v_subcategory in ('doxxing', 'personal_information', 'impersonation_or_identity_rights'))
      or (v_reason = 'rights_or_ownership' and v_subcategory = 'copyright_or_unlicensed_use')
      or (v_reason = 'spam_or_platform_abuse' and v_subcategory in ('spam', 'upload_limit_evasion'))
      or (v_reason = 'fair_play_manipulation' and v_subcategory in ('vote_influence_or_promotion', 'coordinated_manipulation'))
      or (v_reason = 'low_effort_or_off_topic' and v_subcategory in ('low_effort', 'off_topic'))
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
  v_request_hash := encode(extensions.digest(convert_to(v_payload::text, 'UTF8'), 'sha256'), 'hex');
  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  select request_hash, result into v_existing_hash, v_existing_result
  from public.submission_report_requests where idempotency_key = p_idempotency_key;
  if found then
    if v_existing_hash = v_request_hash then
      return jsonb_set(v_existing_result, '{replayed}', 'true'::jsonb);
    end if;
    raise exception using errcode = 'PT409', message = 'SUBMISSION_REPORT_IDEMPOTENCY_CONFLICT';
  end if;

  -- A reporter may legitimately submit reports for different submissions at the same
  -- instant. Serialize only their identity boundary so first-use creation cannot race.
  perform pg_advisory_xact_lock(
    hashtextextended('submission-report-reporter:' || v_reporter_id, 0)
  );

  select public_profile_id into v_public_profile_id
  from public.user_logs where discord_user_id = v_reporter_id for share;
  if not found then
    raise exception using errcode = '55000', message = 'SUBMISSION_REPORT_IDENTITY_UNAVAILABLE';
  end if;

  select submission.cycle_id into v_cycle_id
  from public.submissions submission where submission.id = p_submission_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'SUBMISSION_REPORT_NOT_REPORTABLE';
  end if;
  select * into v_cycle from public.voting_cycles where id = v_cycle_id for update;
  select * into v_submission from public.submissions where id = p_submission_id for update;
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
  if v_phase is null then
    raise exception using errcode = 'P0002', message = 'SUBMISSION_REPORT_NOT_REPORTABLE';
  end if;

  if exists (
    select 1 from public.submission_reports report
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
  where identity.discord_user_id = v_reporter_id and identity.anonymized_at is null
  for update;
  if not found then
    insert into public.submission_reporter_identities (
      discord_user_id, public_profile_id, reporter_dedupe_version, reporter_dedupe_hash
    ) values (
      v_reporter_id, v_public_profile_id, p_reporter_dedupe_version, p_reporter_dedupe_hash
    ) returning identity_id into v_identity_id;
  end if;

  select operation.content_sha256 into v_content_sha
  from public.submission_upload_operations operation
  where operation.submission_id = v_submission.id and operation.status = 'completed';

  select * into v_case from public.submission_report_cases
  where submission_id = p_submission_id for update;
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
    p_reason_taxonomy_version, v_reason, v_subcategory,
    v_cycle.status::text, v_phase, v_submission.public_visibility_status,
    v_content_sha, v_created_at
  );
  if v_comment is not null then
    insert into public.submission_report_payloads(report_id, reporter_comment)
    values (v_report_id, v_comment);
  end if;

  if v_case.case_id is null then
    update public.submission_report_cases set report_count = 1 where case_id = v_case_id;
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
      closed_at = null, closed_by_discord_user_id = null, closed_by_display_name = null,
      close_disposition = null, close_note = null, updated_at = v_created_at
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
        'reporter', v_created_at, v_case.row_version + 1, v_created_at, v_report_id
      );
      update public.submission_report_payloads payload set retention_due_at = null
      where exists (
        select 1 from public.submission_reports report
        where report.report_id = payload.report_id and report.case_id = v_case_id
      ) and payload.anonymized_at is null;
    end if;
  end if;

  v_result := jsonb_build_object(
    'reportId', v_report_id, 'caseId', v_case_id,
    'createdAt', v_created_at, 'replayed', false
  );
  insert into public.submission_report_requests(
    idempotency_key, operation, request_hash, result
  ) values (p_idempotency_key, 'create', v_request_hash, v_result);
  return v_result;
exception
  when unique_violation then
    raise exception using errcode = 'PT409', message = 'SUBMISSION_REPORT_ALREADY_REPORTED';
end;
$function$;

create function public.list_submission_report_cases(
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
  select coalesce(jsonb_agg(item order by priority, unseen desc, report_count desc, updated_at, case_id), '[]'::jsonb)
  into v_result from (
    select case_row.case_id, case_row.report_count, case_row.updated_at,
      case
        when coalesce(cycle.status::text, '') in ('voting_open', 'voting_closed', 'active') then 1
        when cycle.status::text = 'paused' and cycle.paused_from_status = 'voting_open' then 1
        when coalesce(cycle.status::text, '') = 'submission_open' then 2
        when cycle.status::text = 'paused' and cycle.paused_from_status = 'submission_open' then 2
        else 3
      end as priority,
      case_row.acknowledged_report_id is distinct from case_row.latest_report_id as unseen,
      jsonb_build_object(
        'caseId', case_row.case_id, 'submissionId', case_row.submission_id,
        'cycleId', case_row.cycle_id, 'status', case_row.status,
        'rowVersion', case_row.row_version, 'reportCount', case_row.report_count,
        'latestReportId', case_row.latest_report_id,
        'latestReportAt', case_row.latest_report_at,
        'unseen', case_row.acknowledged_report_id is distinct from case_row.latest_report_id,
        'currentCycleStatus', cycle.status::text,
        'currentVisibility', submission.public_visibility_status,
        'currentDisqualified', coalesce(submission.is_disqualified, false),
        'currentAvailable', submission.id is not null,
        'priority', case
          when coalesce(cycle.status::text, '') in ('voting_open', 'voting_closed', 'active') then 'urgent'
          when cycle.status::text = 'paused' and cycle.paused_from_status = 'voting_open' then 'urgent'
          when coalesce(cycle.status::text, '') = 'submission_open' then 'high'
          when cycle.status::text = 'paused' and cycle.paused_from_status = 'submission_open' then 'high'
          else 'normal' end
      ) as item
    from public.submission_report_cases case_row
    left join public.submissions submission on submission.id = case_row.submission_id
    left join public.voting_cycles cycle on cycle.id = case_row.cycle_id
    order by priority, unseen desc, case_row.report_count desc, case_row.updated_at, case_row.case_id
    limit p_limit
  ) page;
  return v_result;
end;
$function$;

create function public.get_submission_report_case(
  p_actor_discord_user_id text,
  p_case_id uuid
)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $function$
declare v_result jsonb;
begin
  perform public.authorize_submission_report_capability(
    p_actor_discord_user_id, 'submissions.reports.view'
  );
  select jsonb_build_object(
    'caseId', case_row.case_id, 'submissionId', case_row.submission_id,
    'cycleId', case_row.cycle_id, 'status', case_row.status,
    'rowVersion', case_row.row_version, 'reportCount', case_row.report_count,
    'latestReportId', case_row.latest_report_id,
    'latestReportAt', case_row.latest_report_at,
    'acknowledgedReportId', case_row.acknowledged_report_id,
    'reviewedThroughReportId', case_row.reviewed_through_report_id,
    'reviewStartedAt', case_row.review_started_at,
    'reviewStartedBy', case_row.review_started_by_display_name,
    'closedAt', case_row.closed_at, 'closedBy', case_row.closed_by_display_name,
    'closeDisposition', case_row.close_disposition, 'closeNote', case_row.close_note,
    'currentCycleStatus', cycle.status::text,
    'currentVisibility', submission.public_visibility_status,
    'currentDisqualified', coalesce(submission.is_disqualified, false),
    'currentAvailable', submission.id is not null,
    'reports', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'reportId', report.report_id, 'createdAt', report.created_at,
        'reasonTaxonomyVersion', report.reason_taxonomy_version,
        'reasonCode', report.reason_code, 'subcategoryCode', report.subcategory_code,
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
        )
      ) order by report.created_at, report.report_id), '[]'::jsonb)
      from public.submission_reports report
      join public.submission_reporter_identities identity on identity.identity_id = report.reporter_identity_id
      left join public.user_logs user_log on user_log.discord_user_id = identity.discord_user_id
      left join public.submission_report_payloads payload on payload.report_id = report.report_id
      where report.case_id = case_row.case_id
    ),
    'events', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'eventId', event.event_id, 'eventType', event.event_type,
        'previousStatus', event.previous_status, 'newStatus', event.new_status,
        'actorDisplayName', event.actor_display_name,
        'occurredAt', event.occurred_at, 'disposition', event.disposition,
        'note', event.note, 'caseVersion', event.case_version,
        'reportCursorId', event.report_cursor_id
      ) order by event.occurred_at, event.event_id), '[]'::jsonb)
      from public.submission_report_case_events event
      where event.case_id = case_row.case_id
    )
  ) into v_result
  from public.submission_report_cases case_row
  left join public.submissions submission on submission.id = case_row.submission_id
  left join public.voting_cycles cycle on cycle.id = case_row.cycle_id
  where case_row.case_id = p_case_id;
  if v_result is null then
    raise exception using errcode = 'P0002', message = 'SUBMISSION_REPORT_CASE_NOT_FOUND';
  end if;
  return v_result;
end;
$function$;

create function public.list_submission_reporter_profiles(
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
        'latestReportAt', max(report.created_at)
      ) item
    from public.submission_reports report
    join public.submission_reporter_identities identity on identity.identity_id = report.reporter_identity_id
    join public.user_logs user_log on user_log.discord_user_id = identity.discord_user_id
    where identity.anonymized_at is null
    group by user_log.public_profile_id, user_log.current_display_name,
      user_log.current_guild_nickname, user_log.current_discord_username
    order by latest_report_at desc, user_log.public_profile_id
    limit p_limit
  ) page;
  return v_result;
end;
$function$;

create function public.get_submission_reporter_history(
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
    'publicProfileId', p_public_profile_id, 'label', v_label,
    'reports', coalesce(jsonb_agg(item order by created_at desc, report_id desc), '[]'::jsonb)
  ) into v_result from (
    select report.created_at, report.report_id,
      jsonb_build_object(
        'reportId', report.report_id, 'caseId', report.case_id,
        'submissionId', report.submission_id, 'cycleId', report.cycle_id,
        'createdAt', report.created_at, 'reasonCode', report.reason_code,
        'subcategoryCode', report.subcategory_code,
        'comment', payload.reporter_comment, 'phaseSnapshot', report.phase_snapshot,
        'caseStatus', case_row.status, 'closeDisposition', case_row.close_disposition,
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

create function public.review_submission_report_case(
  p_actor_discord_user_id text,
  p_case_id uuid,
  p_operation text,
  p_expected_status text,
  p_expected_row_version bigint,
  p_expected_latest_report_id uuid,
  p_disposition text,
  p_note text,
  p_idempotency_key uuid
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $function$
declare
  v_actor_id text := btrim(p_actor_discord_user_id);
  v_operation text := btrim(p_operation);
  v_note text := nullif(btrim(p_note), '');
  v_role text; v_display text; v_payload jsonb; v_hash text;
  v_existing_hash text; v_existing_result jsonb;
  v_case public.submission_report_cases%rowtype;
  v_new_status text; v_event_type text; v_result jsonb; v_now timestamptz := statement_timestamp();
begin
  if p_idempotency_key is null or p_case_id is null
    or p_expected_row_version is null or p_expected_row_version < 1
    or p_expected_latest_report_id is null
    or p_expected_status is null
    or p_expected_status not in ('open', 'in_review', 'closed')
    or v_operation is null
    or v_operation not in ('acknowledge', 'start_review', 'return_open', 'close')
    or (v_operation in ('return_open', 'close') and (v_note is null or char_length(v_note) not between 10 and 1000))
    or (v_operation = 'close' and (p_disposition is null or p_disposition not in (
      'action_taken', 'no_action_current_rules', 'insufficient_information',
      'submission_unavailable', 'completed_other'
    ))) or (v_operation <> 'close' and p_disposition is not null) then
    raise exception using errcode = '22023', message = 'SUBMISSION_REPORT_REVIEW_INVALID';
  end if;
  perform public.authorize_submission_report_capability(v_actor_id, 'submissions.reports.view');
  v_role := public.authorize_submission_report_capability(v_actor_id, 'submissions.reports.review');
  select coalesce(
    nullif(btrim(current_display_name), ''), nullif(btrim(current_guild_nickname), ''),
    nullif(btrim(current_discord_username), ''), v_actor_id
  ) into v_display from public.user_logs where discord_user_id = v_actor_id;

  v_payload := jsonb_build_object(
    'operation', v_operation, 'version', 1, 'actor', v_actor_id,
    'caseId', p_case_id, 'expectedStatus', p_expected_status,
    'expectedRowVersion', p_expected_row_version,
    'expectedLatestReportId', p_expected_latest_report_id,
    'disposition', p_disposition, 'note', v_note
  );
  v_hash := encode(extensions.digest(convert_to(v_payload::text, 'UTF8'), 'sha256'), 'hex');
  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  select request_hash, result into v_existing_hash, v_existing_result
  from public.submission_report_requests where idempotency_key = p_idempotency_key;
  if found then
    if v_existing_hash = v_hash then return jsonb_set(v_existing_result, '{replayed}', 'true'::jsonb); end if;
    raise exception using errcode = 'PT409', message = 'SUBMISSION_REPORT_IDEMPOTENCY_CONFLICT';
  end if;

  select * into v_case from public.submission_report_cases where case_id = p_case_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'SUBMISSION_REPORT_CASE_NOT_FOUND'; end if;
  if v_case.status <> p_expected_status or v_case.row_version <> p_expected_row_version
    or v_case.latest_report_id <> p_expected_latest_report_id then
    raise exception using errcode = 'PT409', message = 'SUBMISSION_REPORT_STALE';
  end if;
  if (v_operation = 'start_review' and v_case.status <> 'open')
    or (v_operation in ('return_open', 'close') and v_case.status <> 'in_review')
    or (v_operation = 'acknowledge' and v_case.status = 'closed') then
    raise exception using errcode = 'PT409', message = 'SUBMISSION_REPORT_STATE_CONFLICT';
  end if;

  v_new_status := case v_operation when 'start_review' then 'in_review'
    when 'return_open' then 'open' when 'close' then 'closed' else v_case.status end;
  v_event_type := case v_operation when 'acknowledge' then 'case_acknowledged'
    when 'start_review' then 'review_started' when 'return_open' then 'review_returned_open'
    else 'case_closed' end;
  update public.submission_report_cases set
    status = v_new_status, row_version = row_version + 1,
    acknowledged_report_id = case when v_operation in ('acknowledge', 'start_review') then latest_report_id else acknowledged_report_id end,
    acknowledged_report_at = case when v_operation in ('acknowledge', 'start_review') then latest_report_at else acknowledged_report_at end,
    review_started_at = case when v_operation = 'start_review' then v_now when v_operation = 'return_open' then null else review_started_at end,
    review_started_by_discord_user_id = case when v_operation = 'start_review' then v_actor_id when v_operation = 'return_open' then null else review_started_by_discord_user_id end,
    review_started_by_display_name = case when v_operation = 'start_review' then v_display when v_operation = 'return_open' then null else review_started_by_display_name end,
    reviewed_through_report_id = case when v_operation = 'close' then latest_report_id else reviewed_through_report_id end,
    reviewed_through_report_at = case when v_operation = 'close' then latest_report_at else reviewed_through_report_at end,
    closed_at = case when v_operation = 'close' then v_now else null end,
    closed_by_discord_user_id = case when v_operation = 'close' then v_actor_id else null end,
    closed_by_display_name = case when v_operation = 'close' then v_display else null end,
    close_disposition = case when v_operation = 'close' then p_disposition else null end,
    close_note = case when v_operation = 'close' then v_note else null end,
    updated_at = v_now
  where case_id = p_case_id;
  insert into public.submission_report_case_events(
    case_id, event_type, previous_status, new_status, actor_kind,
    actor_discord_user_id, actor_display_name, occurred_at, disposition,
    note, case_version, report_cursor_at, report_cursor_id
  ) values (
    p_case_id, v_event_type, v_case.status, v_new_status,
    case when v_role = 'admin' then 'admin' else 'team' end,
    v_actor_id, v_display, v_now, p_disposition, v_note,
    v_case.row_version + 1, v_case.latest_report_at, v_case.latest_report_id
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
    'latestReportId', v_case.latest_report_id, 'replayed', false
  );
  insert into public.submission_report_requests(idempotency_key, operation, request_hash, result)
  values (p_idempotency_key, v_operation, v_hash, v_result);
  return v_result;
end;
$function$;

alter function public.authorize_submission_report_capability(text, text) owner to postgres;
alter function public.get_submission_report_eligibility(text, integer, text, bigint) owner to postgres;
alter function public.create_submission_report(text, integer, text, bigint, integer, text, text, text, uuid) owner to postgres;
alter function public.list_submission_report_cases(text, integer) owner to postgres;
alter function public.get_submission_report_case(text, uuid) owner to postgres;
alter function public.list_submission_reporter_profiles(text, integer) owner to postgres;
alter function public.get_submission_reporter_history(text, uuid, integer) owner to postgres;
alter function public.review_submission_report_case(text, uuid, text, text, bigint, uuid, text, text, uuid) owner to postgres;

revoke all on function public.protect_submission_report_append_only() from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.protect_submission_report_case_delete() from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.authorize_submission_report_capability(text, text) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_submission_report_eligibility(text, integer, text, bigint) from public, anon, authenticated, discord_bot;
revoke all on function public.create_submission_report(text, integer, text, bigint, integer, text, text, text, uuid) from public, anon, authenticated, discord_bot;
revoke all on function public.list_submission_report_cases(text, integer) from public, anon, authenticated, discord_bot;
revoke all on function public.get_submission_report_case(text, uuid) from public, anon, authenticated, discord_bot;
revoke all on function public.list_submission_reporter_profiles(text, integer) from public, anon, authenticated, discord_bot;
revoke all on function public.get_submission_reporter_history(text, uuid, integer) from public, anon, authenticated, discord_bot;
revoke all on function public.review_submission_report_case(text, uuid, text, text, bigint, uuid, text, text, uuid) from public, anon, authenticated, discord_bot;
grant execute on function public.get_submission_report_eligibility(text, integer, text, bigint) to service_role;
grant execute on function public.create_submission_report(text, integer, text, bigint, integer, text, text, text, uuid) to service_role;
grant execute on function public.list_submission_report_cases(text, integer) to service_role;
grant execute on function public.get_submission_report_case(text, uuid) to service_role;
grant execute on function public.list_submission_reporter_profiles(text, integer) to service_role;
grant execute on function public.get_submission_reporter_history(text, uuid, integer) to service_role;
grant execute on function public.review_submission_report_case(text, uuid, text, text, bigint, uuid, text, text, uuid) to service_role;

comment on table public.submission_reports is
  'Server-only immutable Submission Report facts. No raw IP, device identifier, Turnstile token, object key, or media copy is stored.';
comment on table public.submission_report_case_events is
  'Append-only Report case workflow history. Seen high-water, workflow status, and future viewer unread remain separate contracts.';

do $postflight$
begin
  if (select count(*) from public.capability_catalog) <> 33
    or (select count(*) from public.capability_catalog where is_active) <> 29
    or (
      select count(*) from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 29
    or exists (
      select 1 from public.capability_catalog
      where key in ('submissions.reports.view', 'submissions.reports.review')
        and (is_active or assignable_to_non_admin)
    )
    or exists (
      select 1 from public.team_role_capabilities
      where capability_key in ('submissions.reports.view', 'submissions.reports.review')
    ) then
    raise exception using errcode = '55000',
      message = 'SUBMISSION_REPORT_STAGED_CAPABILITY_MISMATCH';
  end if;
  if exists (
    select 1 from pg_class relation join pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname in (
        'submission_reporter_identities', 'submission_report_cases', 'submission_reports',
        'submission_report_payloads', 'submission_report_case_events', 'submission_report_requests'
      ) and not relation.relrowsecurity
  ) then
    raise exception using errcode = '55000', message = 'SUBMISSION_REPORT_RLS_MISMATCH';
  end if;
end;
$postflight$;

commit;
