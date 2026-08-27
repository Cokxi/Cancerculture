begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $preflight$
begin
  if (select count(*) from public.capability_catalog) <> 54
    or (select count(*) from public.capability_catalog where is_active) <> 50
    or (select count(*) from public.capability_catalog where is_active and assignable_to_non_admin) <> 50
    or (select count(*) from public.team_inbox_topic_catalog) <> 3
    or exists (
      select 1 from public.capability_catalog
      where key in ('users.warning_appeals.view', 'users.warning_appeals.review')
    )
    or exists (
      select 1 from public.team_role_capabilities
      where capability_key in ('users.warning_appeals.view', 'users.warning_appeals.review')
    )
    or exists (
      select 1 from public.team_inbox_topic_catalog where topic_key = 'warning_appeals'
    )
    or to_regclass('public.user_warnings') is null
    or to_regclass('public.user_warning_current') is null
    or to_regclass('public.user_warning_events') is null
    or to_regclass('public.team_inbox_cases') is null
    or to_regclass('public.notification_events') is null
    or to_regprocedure('public.require_account_session(uuid)') is null
    or to_regprocedure('public.overrule_user_warning(text,uuid,bigint,text,uuid)') is null
    or to_regprocedure('public.get_team_inbox_case_detail(text,uuid)') is null
    or to_regprocedure('public.solve_team_inbox_case(text,uuid,bigint,bigint,text,text)') is null
    or not exists (
      select 1 from public.notification_category_catalog
      where category_key = 'account_warnings'
        and is_active and required_in_product and not push_available
    )
  then
    raise exception using
      errcode = '55000',
      message = 'USER_WARNING_APPEAL_BASELINE_MISMATCH';
  end if;

  if to_regclass('public.user_warning_appeals') is not null
    or to_regclass('public.user_warning_appeal_current') is not null
    or to_regclass('public.user_warning_appeal_events') is not null
    or to_regclass('public.user_warning_appeal_requests') is not null
  then
    raise exception using
      errcode = '55000',
      message = 'USER_WARNING_APPEAL_ALREADY_PRESENT';
  end if;
end;
$preflight$;

insert into public.capability_catalog (
  key, display_name, description, category, included_actions, excluded_actions,
  risk_level, assignable_to_non_admin, is_active, implementation_version,
  definition_hash
)
values
  (
    'users.warning_appeals.view',
    'View Warning Appeals',
    'View exact Warning Appeal queues, Case detail, bounded owner text, required Warning evidence, and immutable history without changing state.',
    'User Moderation',
    array[
      'View the dedicated Warning Appeals Team Inbox topic, bounded queues, exact Case detail, and immutable timeline.',
      'View one Appeal''s bounded owner text, exact Warning reason, current status, source Comment evidence, and required Team actor snapshots.',
      'Use capability-protected bounded username and exact Discord ID Case search.'
    ]::text[],
    array[
      'Claiming, returning, upholding, or overruling an Appeal.',
      'Viewing unrelated Warning history, automatic Flags, Overwatch, Reports, or other moderation data.',
      'Exposing Appeal text, Warning evidence, or Team identity to Member, public, generic Notification, Push, log, or unrelated navigation surfaces.',
      'Managing roles, grants, Team membership, Owner access, or unrelated logs.'
    ]::text[],
    'high', true, true, 1,
    '12e5c12bc11d28225154a338dcdd1c498b55817600b58c72aac90ee3fda53806'
  ),
  (
    'users.warning_appeals.review',
    'Review Warning Appeals',
    'Claim, return, uphold, or resolve Warning Appeal Cases through expected-version, idempotent atomic review, always together with the exact Appeal View capability.',
    'User Moderation',
    array[
      'Exclusively claim an open Warning Appeal Case and return unresolved work with a bounded internal note.',
      'Uphold one exact assigned Appeal with a mandatory bounded review reason and neutral owner notification.',
      'Resolve one exact assigned Appeal as Overrule only while the separate users.warnings.overrule capability is also held and the canonical Warning correction contract succeeds.',
      'Use idempotent, concurrency-safe Case and Appeal transitions while preserving append-only evidence.'
    ]::text[],
    array[
      'Viewing a Warning Appeal Case without users.warning_appeals.view.',
      'Overruling a Warning without users.warnings.overrule, issuing Warnings, or selecting Warning duration.',
      'Pausing, deleting, shortening, or rewriting a Warning, Appeal, Case, event, request, or source evidence.',
      'Creating Flags, Overwatch entries, Bans, Holds, participation changes, or any other sanction.',
      'Managing roles, grants, Team membership, Owner access, or unrelated logs.'
    ]::text[],
    'critical', true, true, 1,
    'd1f3593313990dbd9bd3d0dee379246cd5b4e6349b405e34033738aaa920cad3'
  );

insert into public.team_inbox_topic_catalog (
  topic_key, display_name, is_active, required_read_capabilities,
  required_action_capabilities, activated_at, accepts_new_cases
)
values (
  'warning_appeals', 'Warning Appeals', true,
  array['users.warning_appeals.view']::text[],
  array['users.warning_appeals.view', 'users.warning_appeals.review']::text[],
  transaction_timestamp(), true
);

create table public.user_warning_appeals (
  appeal_id uuid primary key,
  public_appeal_id uuid not null unique default gen_random_uuid(),
  warning_id uuid not null unique
    references public.user_warnings(warning_id) on update restrict on delete restrict,
  target_discord_user_id text not null
    references public.user_logs(discord_user_id) on update restrict on delete restrict,
  team_inbox_case_id uuid not null unique
    references public.team_inbox_cases(id) on update restrict on delete restrict,
  appeal_text text not null,
  submitted_at timestamptz not null,
  recorded_at timestamptz not null default transaction_timestamp(),
  unique (appeal_id, warning_id, target_discord_user_id),
  constraint user_warning_appeal_text_check check (
    char_length(appeal_text) between 20 and 1000
    and octet_length(appeal_text) <= 4000
    and appeal_text = btrim(appeal_text)
    and appeal_text = normalize(appeal_text, NFC)
    and appeal_text !~ E'[\\x00\\r]'
  )
);

create table public.user_warning_appeal_current (
  appeal_id uuid primary key,
  warning_id uuid not null,
  target_discord_user_id text not null,
  status text not null check (status in ('submitted', 'upheld', 'overruled')),
  row_version bigint not null default 1 check (row_version > 0),
  reviewed_at timestamptz,
  updated_at timestamptz not null,
  foreign key (appeal_id, warning_id, target_discord_user_id)
    references public.user_warning_appeals(appeal_id, warning_id, target_discord_user_id)
    on update restrict on delete restrict,
  constraint user_warning_appeal_current_state_check check (
    (status = 'submitted' and reviewed_at is null)
    or (status in ('upheld', 'overruled') and reviewed_at is not null)
  )
);

create table public.user_warning_appeal_events (
  event_id bigint generated always as identity primary key,
  appeal_id uuid not null,
  warning_id uuid not null,
  target_discord_user_id text not null,
  event_type text not null check (event_type in ('submitted', 'upheld', 'overruled')),
  actor_kind text not null check (actor_kind in ('owner', 'team')),
  actor_discord_user_id text not null
    references public.user_logs(discord_user_id) on update restrict on delete restrict,
  actor_display_name text,
  actor_role_key text,
  review_reason text,
  appeal_row_version bigint not null check (appeal_row_version > 0),
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default transaction_timestamp(),
  foreign key (appeal_id, warning_id, target_discord_user_id)
    references public.user_warning_appeals(appeal_id, warning_id, target_discord_user_id)
    on update restrict on delete restrict,
  constraint user_warning_appeal_event_actor_check check (
    (actor_kind = 'owner' and actor_role_key is null and review_reason is null)
    or (actor_kind = 'team' and nullif(btrim(actor_role_key), '') is not null
      and char_length(btrim(review_reason)) between 3 and 1000)
  )
);

create unique index user_warning_appeal_one_terminal_event_idx
  on public.user_warning_appeal_events(appeal_id)
  where event_type in ('upheld', 'overruled');
create index user_warning_appeal_event_history_idx
  on public.user_warning_appeal_events(appeal_id, event_id);

create table public.user_warning_appeal_requests (
  request_id uuid primary key,
  operation text not null check (operation in ('submit', 'uphold', 'overrule')),
  actor_discord_user_id text not null
    references public.user_logs(discord_user_id) on update restrict on delete restrict,
  appeal_id uuid not null
    references public.user_warning_appeals(appeal_id) on update restrict on delete restrict,
  warning_id uuid not null
    references public.user_warnings(warning_id) on update restrict on delete restrict,
  team_inbox_case_id uuid not null
    references public.team_inbox_cases(id) on update restrict on delete restrict,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  request_payload jsonb not null check (jsonb_typeof(request_payload) = 'object'),
  receipt jsonb not null check (jsonb_typeof(receipt) = 'object'),
  created_at timestamptz not null default transaction_timestamp()
);

alter table public.user_warning_appeals enable row level security;
alter table public.user_warning_appeal_current enable row level security;
alter table public.user_warning_appeal_events enable row level security;
alter table public.user_warning_appeal_requests enable row level security;

create function public.protect_user_warning_appeal_append_only()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $function$
begin
  raise exception using errcode = '55000', message = 'USER_WARNING_APPEAL_HISTORY_IS_APPEND_ONLY';
end;
$function$;

create function public.protect_user_warning_appeal_current()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'USER_WARNING_APPEAL_CURRENT_DELETE_FORBIDDEN';
  end if;
  if (new.appeal_id, new.warning_id, new.target_discord_user_id)
      is distinct from (old.appeal_id, old.warning_id, old.target_discord_user_id)
    or old.status <> 'submitted'
    or new.status not in ('upheld', 'overruled')
    or new.row_version <> old.row_version + 1
    or new.reviewed_at is null
  then
    raise exception using errcode = '55000', message = 'USER_WARNING_APPEAL_CURRENT_TRANSITION_FORBIDDEN';
  end if;
  return new;
end;
$function$;

create trigger user_warning_appeals_immutable
before update or delete on public.user_warning_appeals
for each row execute function public.protect_user_warning_appeal_append_only();
create trigger user_warning_appeal_events_immutable
before update or delete on public.user_warning_appeal_events
for each row execute function public.protect_user_warning_appeal_append_only();
create trigger user_warning_appeal_requests_immutable
before update or delete on public.user_warning_appeal_requests
for each row execute function public.protect_user_warning_appeal_append_only();
create trigger user_warning_appeal_current_guard
before update or delete on public.user_warning_appeal_current
for each row execute function public.protect_user_warning_appeal_current();

create or replace function public.assert_team_inbox_topic_access(
  p_actor_discord_user_id text,
  p_topic_key text,
  p_action_access boolean
)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor_id text := btrim(p_actor_discord_user_id);
  v_role text;
  v_capabilities text[];
  v_capability text;
  v_expected_version integer;
  v_expected_hash text;
begin
  if v_actor_id !~ '^[0-9]{1,100}$' then
    raise exception using errcode = '42501', message = 'TEAM_INBOX_FORBIDDEN';
  end if;
  select case when p_action_access then topic.required_action_capabilities
      else topic.required_read_capabilities end
  into v_capabilities
  from public.team_inbox_topic_catalog topic
  where topic.topic_key = p_topic_key and topic.is_active;
  if not found then
    raise exception using errcode = '42501', message = 'TEAM_INBOX_TOPIC_UNAVAILABLE';
  end if;
  select member.role into v_role
  from public.team_members member
  join public.team_roles role on role.key = member.role and role.is_active
  where member.discord_user_id = v_actor_id;
  if not found then
    raise exception using errcode = '42501', message = 'TEAM_INBOX_FORBIDDEN';
  end if;
  foreach v_capability in array v_capabilities loop
    select expected.implementation_version, expected.definition_hash
    into v_expected_version, v_expected_hash
    from (values
      ('winners.payouts.view', 2, '9de22d0055e9c8b6b8cb701e4f6f554aa4c241ab0cbfb0a4709ecc9841702a54'),
      ('winners.recipient_corrections.manage', 2, 'e569fa66e8f9c2794fe030c4e034ebf8a7e458c6ddccf2a868d2cac1fd5ea2bd'),
      ('community.comment_reports.view', 2, '31e7f8d6bb49d148c717991d39b8cfbb7cde4e7757026839854b0fdad89a4775'),
      ('community.comment_reports.review', 1, 'b201f956e4cc586b0a445455935224c3cefd5d5c950260e6899c451191e19da9'),
      ('community.comment_spam.view', 1, '389916756fe7326a7ba51977168f22d0f4a079b77b25deed29bdeeb1e05d42da'),
      ('community.comment_spam.review', 1, 'eb211f298b166f8896c55f669cb721c790f3b27c3eb87d60799b7af741c14b76'),
      ('users.warning_appeals.view', 1, '12e5c12bc11d28225154a338dcdd1c498b55817600b58c72aac90ee3fda53806'),
      ('users.warning_appeals.review', 1, 'd1f3593313990dbd9bd3d0dee379246cd5b4e6349b405e34033738aaa920cad3')
    ) expected(capability_key, implementation_version, definition_hash)
    where expected.capability_key = v_capability;
    if v_expected_version is null or not exists (
      select 1 from public.capability_catalog capability
      where capability.key = v_capability and capability.is_active
        and capability.assignable_to_non_admin
        and capability.implementation_version = v_expected_version
        and capability.definition_hash = v_expected_hash
    ) then
      raise exception using errcode = '55000', message = 'TEAM_INBOX_CAPABILITY_DEPENDENCY_UNAVAILABLE';
    end if;
    if v_role <> 'admin' and not exists (
      select 1 from public.team_role_capabilities grant_row
      where grant_row.role_key = v_role and grant_row.capability_key = v_capability
    ) then
      raise exception using errcode = '42501', message = 'TEAM_INBOX_FORBIDDEN';
    end if;
  end loop;
  return v_role;
end;
$function$;

create function public.submit_user_warning_appeal(
  p_session_id uuid,
  p_public_warning_id uuid,
  p_appeal_text text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner_id text;
  v_text text := normalize(btrim(p_appeal_text), NFC);
  v_warning public.user_warnings%rowtype;
  v_current public.user_warning_current%rowtype;
  v_appeal_id uuid := gen_random_uuid();
  v_case_id uuid;
  v_username text;
  v_payload jsonb;
  v_hash text;
  v_existing public.user_warning_appeal_requests%rowtype;
  v_receipt jsonb;
  v_now timestamptz := clock_timestamp();
begin
  if p_public_warning_id is null or p_appeal_text is null or p_request_id is null
    or char_length(v_text) not between 20 and 1000
    or octet_length(v_text) > 4000 or v_text ~ E'[\\x00\\r]'
  then
    raise exception using errcode = '22023', message = 'USER_WARNING_APPEAL_INPUT_INVALID';
  end if;
  v_owner_id := public.require_account_session(p_session_id);
  v_payload := jsonb_build_object(
    'operation', 'submit', 'operationVersion', 1,
    'ownerDiscordUserId', v_owner_id, 'warningId', p_public_warning_id,
    'appealText', v_text
  );
  v_hash := encode(extensions.digest(convert_to(v_payload::text, 'UTF8'), 'sha256'), 'hex');
  perform pg_advisory_xact_lock(hashtextextended('user-warning-appeal-request:' || p_request_id::text, 0));
  select * into v_existing from public.user_warning_appeal_requests where request_id = p_request_id;
  if found then
    if v_existing.actor_discord_user_id = v_owner_id and v_existing.operation = 'submit'
      and v_existing.request_hash = v_hash
    then
      return jsonb_set(v_existing.receipt, '{replayed}', 'true'::jsonb);
    end if;
    raise exception using errcode = 'PT409', message = 'USER_WARNING_APPEAL_IDEMPOTENCY_CONFLICT';
  end if;
  select * into v_warning from public.user_warnings
  where public_warning_id = p_public_warning_id and target_discord_user_id = v_owner_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'USER_WARNING_APPEAL_WARNING_NOT_FOUND';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('user-warning-appeal:' || v_warning.warning_id::text, 0));
  select * into v_current from public.user_warning_current
  where warning_id = v_warning.warning_id for update;
  if not found then
    raise exception using errcode = '55000', message = 'USER_WARNING_CURRENT_PROJECTION_UNAVAILABLE';
  end if;
  if v_current.state = 'overruled' then
    raise exception using errcode = 'PT409', message = 'USER_WARNING_APPEAL_WARNING_WITHDRAWN';
  end if;
  if exists (select 1 from public.user_warning_appeals where warning_id = v_warning.warning_id) then
    raise exception using errcode = 'PT409', message = 'USER_WARNING_APPEAL_ALREADY_SUBMITTED';
  end if;
  select coalesce(
    nullif(btrim(current_discord_username), ''),
    nullif(btrim(current_discord_handle), ''),
    nullif(btrim(current_display_name), ''),
    nullif(btrim(current_guild_nickname), ''),
    'Community member'
  ) into v_username from public.user_logs where discord_user_id = v_owner_id;
  v_case_id := (public.upsert_team_inbox_case(
    'warning_appeals', 'warning-appeal:' || v_appeal_id::text, 1,
    v_owner_id, coalesce(v_username, 'Community member')
  ) ->> 'caseId')::uuid;
  insert into public.user_warning_appeals (
    appeal_id, warning_id, target_discord_user_id, team_inbox_case_id,
    appeal_text, submitted_at
  ) values (
    v_appeal_id, v_warning.warning_id, v_owner_id, v_case_id, v_text, v_now
  );
  insert into public.user_warning_appeal_current (
    appeal_id, warning_id, target_discord_user_id, status, updated_at
  ) values (v_appeal_id, v_warning.warning_id, v_owner_id, 'submitted', v_now);
  insert into public.user_warning_appeal_events (
    appeal_id, warning_id, target_discord_user_id, event_type, actor_kind,
    actor_discord_user_id, actor_display_name, appeal_row_version, occurred_at
  ) values (
    v_appeal_id, v_warning.warning_id, v_owner_id, 'submitted', 'owner',
    v_owner_id, v_username, 1, v_now
  );
  v_receipt := jsonb_build_object(
    'outcome', 'submitted', 'appealId', v_appeal_id,
    'warningId', p_public_warning_id, 'status', 'submitted',
    'appealRowVersion', 1, 'replayed', false
  );
  insert into public.user_warning_appeal_requests (
    request_id, operation, actor_discord_user_id, appeal_id, warning_id,
    team_inbox_case_id, request_hash, request_payload, receipt
  ) values (
    p_request_id, 'submit', v_owner_id, v_appeal_id, v_warning.warning_id,
    v_case_id, v_hash, v_payload, v_receipt
  );
  return v_receipt;
end;
$function$;

create function public.get_own_user_warning_appeal_status(
  p_session_id uuid,
  p_public_warning_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner_id text;
  v_result jsonb;
begin
  if p_public_warning_id is null then
    raise exception using errcode = '22023', message = 'USER_WARNING_APPEAL_STATUS_INPUT_INVALID';
  end if;
  v_owner_id := public.require_account_session(p_session_id);
  select jsonb_build_object(
    'outcome', 'found',
    'warningId', warning_row.public_warning_id,
    'appealable', appeal.appeal_id is null and current_row.state <> 'overruled',
    'status', case appeal_current.status
      when 'overruled' then 'withdrawn'
      else appeal_current.status end,
    'submittedAt', appeal.submitted_at,
    'reviewedAt', appeal_current.reviewed_at
  ) into v_result
  from public.user_warnings warning_row
  join public.user_warning_current current_row on current_row.warning_id = warning_row.warning_id
  left join public.user_warning_appeals appeal on appeal.warning_id = warning_row.warning_id
  left join public.user_warning_appeal_current appeal_current on appeal_current.appeal_id = appeal.appeal_id
  where warning_row.public_warning_id = p_public_warning_id
    and warning_row.target_discord_user_id = v_owner_id;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  return v_result;
end;
$function$;

create function public.get_user_warning_appeal_case_detail(
  p_actor_discord_user_id text,
  p_case_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_generic jsonb;
  v_domain jsonb;
begin
  perform public.assert_team_inbox_topic_access(p_actor_discord_user_id, 'warning_appeals', false);
  v_generic := public.get_team_inbox_case_detail(p_actor_discord_user_id, p_case_id);
  if v_generic ->> 'outcome' <> 'found'
    or v_generic #>> '{case,topicKey}' <> 'warning_appeals'
  then return jsonb_build_object('outcome', 'not_found'); end if;
  select jsonb_build_object(
    'kind', 'warning_appeal',
    'appealId', appeal.public_appeal_id,
    'appealText', appeal.appeal_text,
    'appealStatus', appeal_current.status,
    'appealRowVersion', appeal_current.row_version,
    'submittedAt', appeal.submitted_at,
    'reviewedAt', appeal_current.reviewed_at,
    'reviewReason', terminal_event.review_reason,
    'warning', jsonb_build_object(
      'warningId', warning_row.public_warning_id,
      'category', warning_row.category,
      'reason', warning_row.reason,
      'issuedAt', warning_row.issued_at,
      'issuedByDisplayName', warning_row.issued_by_display_name,
      'issuedByRole', warning_row.issued_by_role_key,
      'state', warning_current.state,
      'effectiveTierDays', warning_current.effective_tier_days,
      'expiresAt', warning_current.expires_at,
      'rowVersion', warning_current.row_version,
      'sourcePublicCommentId', warning_row.source_public_comment_id,
      'sourceSubmissionId', warning_row.source_submission_id,
      'sourceCommentObjectVersion', warning_row.source_comment_object_version,
      'sourceCommentTextVersion', warning_row.source_comment_text_version,
      'sourceCommentBody', warning_row.source_comment_body
    )
  ) into v_domain
  from public.user_warning_appeals appeal
  join public.user_warning_appeal_current appeal_current on appeal_current.appeal_id = appeal.appeal_id
  join public.user_warnings warning_row on warning_row.warning_id = appeal.warning_id
  join public.user_warning_current warning_current on warning_current.warning_id = appeal.warning_id
  left join lateral (
    select event_row.review_reason from public.user_warning_appeal_events event_row
    where event_row.appeal_id = appeal.appeal_id
      and event_row.event_type in ('upheld', 'overruled')
    order by event_row.event_id desc limit 1
  ) terminal_event on true
  where appeal.team_inbox_case_id = p_case_id;
  if v_domain is null then return jsonb_build_object('outcome', 'not_found'); end if;
  return v_generic || jsonb_build_object('domain', v_domain);
end;
$function$;

create function public.sync_user_warning_appeal_overrule()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_appeal public.user_warning_appeals%rowtype;
  v_current public.user_warning_appeal_current%rowtype;
  v_case public.team_inbox_cases%rowtype;
  v_now timestamptz := new.occurred_at;
  v_display text := coalesce(nullif(btrim(new.actor_display_name), ''), 'Team member');
begin
  select * into v_appeal from public.user_warning_appeals where warning_id = new.warning_id;
  if not found then return new; end if;
  select * into v_current from public.user_warning_appeal_current
  where appeal_id = v_appeal.appeal_id for update;
  if v_current.status <> 'submitted' then return new; end if;
  select * into strict v_case from public.team_inbox_cases
  where id = v_appeal.team_inbox_case_id for update;
  if v_case.status = 'solved' then
    raise exception using errcode = '55000', message = 'USER_WARNING_APPEAL_CASE_STATE_MISMATCH';
  end if;
  update public.user_warning_appeal_current
  set status = 'overruled', row_version = row_version + 1,
      reviewed_at = v_now, updated_at = v_now
  where appeal_id = v_appeal.appeal_id returning * into v_current;
  insert into public.user_warning_appeal_events (
    appeal_id, warning_id, target_discord_user_id, event_type, actor_kind,
    actor_discord_user_id, actor_display_name, actor_role_key, review_reason,
    appeal_row_version, occurred_at
  ) values (
    v_appeal.appeal_id, v_appeal.warning_id, v_appeal.target_discord_user_id,
    'overruled', 'team', new.actor_discord_user_id, new.actor_display_name,
    new.actor_role_key, new.reason, v_current.row_version, v_now
  );
  update public.team_inbox_cases
  set status = 'solved',
      assignee_discord_user_id = coalesce(assignee_discord_user_id, new.actor_discord_user_id),
      assignee_display_snapshot = coalesce(assignee_display_snapshot, v_display),
      claimed_at = coalesce(claimed_at, v_now), solved_at = v_now,
      row_version = row_version + 1, updated_at = v_now
  where id = v_case.id returning * into v_case;
  insert into public.team_inbox_timeline_events (
    case_id, event_type, work_version, row_version,
    actor_discord_user_id, actor_display_snapshot, actor_role_snapshot,
    capability_context, source_version, outcome_code
  ) values (
    v_case.id, 'solved', v_case.work_version, v_case.row_version,
    new.actor_discord_user_id, v_display, new.actor_role_key,
    jsonb_build_object('topicKey', 'warning_appeals', 'access', 'users.warnings.overrule'),
    v_case.source_version, 'warning_overruled'
  );
  return new;
end;
$function$;

create trigger user_warning_appeal_sync_after_overrule
after insert on public.user_warning_events
for each row when (new.event_type = 'overruled')
execute function public.sync_user_warning_appeal_overrule();

create function public.review_user_warning_appeal(
  p_actor_discord_user_id text,
  p_case_id uuid,
  p_outcome text,
  p_expected_case_row_version bigint,
  p_expected_case_work_version bigint,
  p_expected_case_source_version bigint,
  p_expected_appeal_row_version bigint,
  p_expected_warning_row_version bigint,
  p_reason text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor_id text := btrim(p_actor_discord_user_id);
  v_reason text := normalize(btrim(p_reason), NFC);
  v_case public.team_inbox_cases%rowtype;
  v_appeal public.user_warning_appeals%rowtype;
  v_current public.user_warning_appeal_current%rowtype;
  v_warning public.user_warnings%rowtype;
  v_warning_current public.user_warning_current%rowtype;
  v_role text;
  v_display text;
  v_payload jsonb;
  v_hash text;
  v_existing public.user_warning_appeal_requests%rowtype;
  v_solve jsonb;
  v_receipt jsonb;
  v_now timestamptz := clock_timestamp();
begin
  if p_case_id is null or p_outcome not in ('uphold', 'overrule')
    or p_expected_case_row_version is null
    or p_expected_case_work_version is null
    or p_expected_case_source_version is null
    or p_expected_appeal_row_version is null
    or p_expected_warning_row_version is null
    or p_reason is null
    or least(p_expected_case_row_version, p_expected_case_work_version,
      p_expected_case_source_version, p_expected_appeal_row_version,
      p_expected_warning_row_version) <= 0
    or char_length(v_reason) not between 3 and 1000
    or octet_length(v_reason) > 4000 or v_reason ~ E'[\\x00\\r]'
    or p_request_id is null
  then
    raise exception using errcode = '22023', message = 'USER_WARNING_APPEAL_REVIEW_INPUT_INVALID';
  end if;
  select * into v_case from public.team_inbox_cases where id = p_case_id;
  if not found or v_case.topic_key <> 'warning_appeals' then
    raise exception using errcode = 'P0002', message = 'USER_WARNING_APPEAL_CASE_NOT_FOUND';
  end if;
  v_role := public.assert_team_inbox_topic_access(v_actor_id, 'warning_appeals', true);
  if p_outcome = 'overrule' then
    perform public.authorize_user_warning_capability(v_actor_id, 'users.warnings.overrule');
  end if;
  v_payload := jsonb_build_object(
    'operation', p_outcome, 'operationVersion', 1, 'actorDiscordUserId', v_actor_id,
    'caseId', p_case_id, 'expectedCaseRowVersion', p_expected_case_row_version,
    'expectedCaseWorkVersion', p_expected_case_work_version,
    'expectedCaseSourceVersion', p_expected_case_source_version,
    'expectedAppealRowVersion', p_expected_appeal_row_version,
    'expectedWarningRowVersion', p_expected_warning_row_version, 'reason', v_reason
  );
  v_hash := encode(extensions.digest(convert_to(v_payload::text, 'UTF8'), 'sha256'), 'hex');
  perform pg_advisory_xact_lock(hashtextextended('user-warning-appeal-request:' || p_request_id::text, 0));
  select * into v_existing from public.user_warning_appeal_requests where request_id = p_request_id;
  if found then
    if v_existing.actor_discord_user_id = v_actor_id
      and v_existing.operation = p_outcome and v_existing.request_hash = v_hash
    then return jsonb_set(v_existing.receipt, '{replayed}', 'true'::jsonb); end if;
    raise exception using errcode = 'PT409', message = 'USER_WARNING_APPEAL_IDEMPOTENCY_CONFLICT';
  end if;
  select * into v_case from public.team_inbox_cases where id = p_case_id for update;
  select * into v_appeal from public.user_warning_appeals
  where team_inbox_case_id = p_case_id;
  if not found then raise exception using errcode = '55000', message = 'USER_WARNING_APPEAL_DOMAIN_UNAVAILABLE'; end if;
  select * into v_current from public.user_warning_appeal_current
  where appeal_id = v_appeal.appeal_id for update;
  select * into v_warning from public.user_warnings where warning_id = v_appeal.warning_id;
  select * into v_warning_current from public.user_warning_current
  where warning_id = v_appeal.warning_id for update;
  if v_case.status <> 'in_progress' or v_case.assignee_discord_user_id <> v_actor_id then
    raise exception using errcode = '42501', message = 'TEAM_INBOX_ASSIGNEE_REQUIRED';
  end if;
  if v_case.row_version <> p_expected_case_row_version
    or v_case.work_version <> p_expected_case_work_version
    or v_case.source_version <> p_expected_case_source_version
    or v_current.row_version <> p_expected_appeal_row_version
    or v_warning_current.row_version <> p_expected_warning_row_version
  then
    return jsonb_build_object(
      'outcome', 'stale', 'caseRowVersion', v_case.row_version,
      'caseWorkVersion', v_case.work_version, 'appealRowVersion', v_current.row_version,
      'warningRowVersion', v_warning_current.row_version
    );
  end if;
  if v_current.status <> 'submitted' then
    raise exception using errcode = 'PT409', message = 'USER_WARNING_APPEAL_ALREADY_REVIEWED';
  end if;
  select coalesce(nullif(btrim(current_discord_username), ''), 'Team member')
  into v_display from public.user_logs where discord_user_id = v_actor_id;
  if p_outcome = 'uphold' then
    update public.user_warning_appeal_current
    set status = 'upheld', row_version = row_version + 1,
        reviewed_at = v_now, updated_at = v_now
    where appeal_id = v_appeal.appeal_id returning * into v_current;
    insert into public.user_warning_appeal_events (
      appeal_id, warning_id, target_discord_user_id, event_type, actor_kind,
      actor_discord_user_id, actor_display_name, actor_role_key, review_reason,
      appeal_row_version, occurred_at
    ) values (
      v_appeal.appeal_id, v_appeal.warning_id, v_appeal.target_discord_user_id,
      'upheld', 'team', v_actor_id, v_display, v_role, v_reason,
      v_current.row_version, v_now
    );
    v_solve := public.solve_team_inbox_case(
      v_actor_id, p_case_id, p_expected_case_row_version,
      p_expected_case_source_version, 'warning_appeal_upheld', null
    );
    if v_solve ->> 'outcome' <> 'solved' then
      raise exception using errcode = 'PT409', message = 'USER_WARNING_APPEAL_CASE_STALE';
    end if;
    perform public.enqueue_account_notification_event(
      'user_warning_appeal_upheld:' || v_appeal.appeal_id::text,
      'user_warning_appeal_upheld', 'account_warnings',
      v_appeal.target_discord_user_id,
      '/warnings/' || v_warning.public_warning_id::text, true
    );
  else
    perform public.overrule_user_warning(
      v_actor_id, v_warning.public_warning_id,
      p_expected_warning_row_version, v_reason, p_request_id
    );
    select * into v_current from public.user_warning_appeal_current
    where appeal_id = v_appeal.appeal_id;
    if v_current.status <> 'overruled' then
      raise exception using errcode = '55000', message = 'USER_WARNING_APPEAL_OVERRULE_SYNC_FAILED';
    end if;
  end if;
  v_receipt := jsonb_build_object(
    'outcome', case when p_outcome = 'uphold' then 'upheld' else 'overruled' end,
    'appealId', v_appeal.public_appeal_id,
    'warningId', v_warning.public_warning_id,
    'appealRowVersion', v_current.row_version, 'replayed', false
  );
  insert into public.user_warning_appeal_requests (
    request_id, operation, actor_discord_user_id, appeal_id, warning_id,
    team_inbox_case_id, request_hash, request_payload, receipt
  ) values (
    p_request_id, p_outcome, v_actor_id, v_appeal.appeal_id, v_appeal.warning_id,
    p_case_id, v_hash, v_payload, v_receipt
  );
  return v_receipt;
end;
$function$;

create function public.guard_user_warning_appeal_case_return()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $function$
begin
  if old.topic_key = 'warning_appeals'
    and old.status = 'in_progress' and new.status = 'open'
    and coalesce(current_setting('app.warning_appeal_case_return', true), '')
      <> (old.id::text || ':return')
  then
    raise exception using errcode = '55000', message = 'USER_WARNING_APPEAL_CASE_RETURN_GUARD';
  end if;
  return new;
end;
$function$;

create trigger user_warning_appeal_case_return_guard
before update on public.team_inbox_cases
for each row execute function public.guard_user_warning_appeal_case_return();

create function public.mutate_user_warning_appeal_case(
  p_actor_discord_user_id text,
  p_case_id uuid,
  p_idempotency_key uuid,
  p_action text,
  p_expected_state text,
  p_expected_row_version bigint,
  p_expected_work_version bigint,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_case public.team_inbox_cases%rowtype;
  v_note text := nullif(btrim(p_note), '');
begin
  if p_action not in ('claim', 'return', 'force_release')
    or (p_action in ('return', 'force_release')
      and (v_note is null or char_length(v_note) not between 3 and 1000))
  then
    raise exception using errcode = '22023', message = 'USER_WARNING_APPEAL_CASE_MUTATION_INPUT_INVALID';
  end if;
  select * into v_case from public.team_inbox_cases where id = p_case_id;
  if not found or v_case.topic_key <> 'warning_appeals' then
    raise exception using errcode = 'P0002', message = 'USER_WARNING_APPEAL_CASE_NOT_FOUND';
  end if;
  if p_action in ('return', 'force_release') then
    perform set_config(
      'app.warning_appeal_case_return',
      p_case_id::text || ':return',
      true
    );
  end if;
  return public.mutate_team_inbox_case(
    p_actor_discord_user_id, p_case_id, p_idempotency_key, p_action,
    p_expected_state, p_expected_row_version, p_expected_work_version, v_note
  );
end;
$function$;

alter table public.notification_events
  drop constraint notification_event_type_check,
  drop constraint notification_event_category_check;
alter table public.notification_events
  add constraint notification_event_type_check check (event_type in (
    'winner_claim_required', 'winner_correction_ready', 'winner_donation_finalized',
    'winner_payout_sent', 'donation_recipient_change_required',
    'submission_disqualified', 'submission_reinstated',
    'cycle_started', 'cycle_submission_ending_15m', 'cycle_submission_ending_10m',
    'cycle_submission_ending_5m', 'cycle_submission_ended',
    'cycle_voting_ending_15m', 'cycle_voting_ending_10m',
    'cycle_voting_ending_5m', 'cycle_voting_ended', 'cycle_results_ready',
    'community_vote_announced',
    'wallet_issue_received', 'wallet_issue_correction_ready', 'wallet_issue_resolved',
    'comment_reply', 'comment_mention',
    'user_warning_issued', 'user_warning_overruled', 'user_warning_appeal_upheld'
  )),
  add constraint notification_event_category_check check (
    (event_type in ('winner_claim_required', 'winner_correction_ready', 'winner_donation_finalized',
      'winner_payout_sent', 'donation_recipient_change_required') and category_key = 'winners_claims')
    or (event_type in ('submission_disqualified', 'submission_reinstated') and category_key = 'submission_moderation')
    or (event_type in ('cycle_started', 'cycle_submission_ending_15m', 'cycle_submission_ending_10m',
      'cycle_submission_ending_5m', 'cycle_submission_ended', 'cycle_voting_ending_15m',
      'cycle_voting_ending_10m', 'cycle_voting_ending_5m', 'cycle_voting_ended',
      'cycle_results_ready') and category_key = 'cycles_voting')
    or (event_type = 'community_vote_announced' and category_key = 'community_votes')
    or (event_type in ('wallet_issue_received', 'wallet_issue_correction_ready', 'wallet_issue_resolved') and category_key = 'wallet_issues')
    or (event_type = 'comment_reply' and category_key = 'comment_replies')
    or (event_type = 'comment_mention' and category_key = 'comment_mentions')
    or (event_type in ('user_warning_issued', 'user_warning_overruled', 'user_warning_appeal_upheld') and category_key = 'account_warnings')
  );

create or replace function public.get_own_notifications(
  p_session_id uuid,
  p_before_created_at timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 20
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner_id text;
  v_items jsonb;
begin
  if p_limit not between 1 and 50
    or ((p_before_created_at is null) <> (p_before_id is null))
  then raise exception using errcode = '22023', message = 'NOTIFICATION_PAGE_INPUT_INVALID'; end if;
  v_owner_id := public.require_account_session(p_session_id);
  select coalesce(jsonb_agg(item.payload order by item.created_at desc, item.id desc), '[]'::jsonb)
  into v_items
  from (
    select notification.created_at, notification.id,
      jsonb_build_object(
        'id', notification.id, 'categoryKey', event.category_key,
        'eventType', event.event_type,
        'title', case event.event_type
          when 'winner_claim_required' then 'Winner claim required'
          when 'winner_correction_ready' then 'Winner claim ready'
          when 'winner_donation_finalized' then 'Winner result finalized'
          when 'winner_payout_sent' then 'Prize sent'
          when 'donation_recipient_change_required' then 'Choose another charity'
          when 'submission_disqualified' then 'Submission disqualified'
          when 'submission_reinstated' then 'Submission restored'
          when 'wallet_issue_received' then 'Wallet issue received'
          when 'wallet_issue_correction_ready' then 'Wallet correction ready'
          when 'wallet_issue_resolved' then 'Wallet issue resolved'
          when 'comment_reply' then 'New comment reply'
          when 'comment_mention' then 'New comment mention'
          when 'user_warning_issued' then 'Account Warning'
          when 'user_warning_overruled' then 'Account Warning withdrawn'
          when 'user_warning_appeal_upheld' then 'Warning appeal reviewed'
          else 'Cycle results are ready' end,
        'body', coalesce(event.public_body, case event.event_type
          when 'winner_claim_required' then 'Review and confirm your winner claim.'
          when 'winner_correction_ready' then 'Review the full recipient and confirm your Claim within 24 hours.'
          when 'winner_donation_finalized' then 'View your finalized winner result.'
          when 'winner_payout_sent' then 'Your prize payout has been recorded as sent.'
          when 'submission_disqualified' then 'View your moderation history for details.'
          when 'submission_reinstated' then 'View your moderation history for details.'
          when 'wallet_issue_received' then 'Your winning-Submission report is ready for Team review.'
          when 'wallet_issue_correction_ready' then 'Review the full recipient and confirm your Claim within 24 hours.'
          when 'wallet_issue_resolved' then 'Review the current recipient and confirm your Claim within 24 hours.'
          when 'comment_reply' then 'You have a new reply.'
          when 'comment_mention' then 'You were mentioned.'
          when 'user_warning_issued' then 'Review a Warning issued by the CancerCulture Team.'
          when 'user_warning_overruled' then 'A Warning for your account was withdrawn. Review your updated account Warning status.'
          when 'user_warning_appeal_upheld' then 'CancerCulture Team reviewed your Warning appeal. Open CancerCulture to view the outcome.'
          else 'View the finalized Cycle results.' end),
        'actionLabel', case event.event_type
          when 'winner_claim_required' then 'Review claim'
          when 'winner_correction_ready' then 'Review claim'
          when 'winner_donation_finalized' then 'View result'
          when 'winner_payout_sent' then 'View payout'
          when 'donation_recipient_change_required' then 'Choose charity'
          when 'submission_disqualified' then 'View details'
          when 'submission_reinstated' then 'View details'
          when 'wallet_issue_received' then 'View claim'
          when 'wallet_issue_correction_ready' then 'Review claim'
          when 'wallet_issue_resolved' then 'View claim'
          when 'comment_reply' then 'View reply'
          when 'comment_mention' then 'View mention'
          when 'user_warning_issued' then 'View warning'
          when 'user_warning_overruled' then 'View updated status'
          when 'user_warning_appeal_upheld' then 'View outcome'
          else 'View results' end,
        'createdAt', notification.created_at, 'readAt', notification.read_at
      ) payload
    from public.account_notifications notification
    join public.notification_events event on event.id = notification.event_id
    where notification.owner_discord_user_id = v_owner_id
      and notification.visible_in_product
      and (notification.read_at is null or notification.read_at > transaction_timestamp() - interval '3 days')
      and (p_before_created_at is null or (notification.created_at, notification.id) < (p_before_created_at, p_before_id))
    order by notification.created_at desc, notification.id desc
    limit p_limit + 1
  ) item;
  return jsonb_build_object('items', v_items);
end;
$function$;

alter table public.user_warning_appeals owner to postgres;
alter table public.user_warning_appeal_current owner to postgres;
alter table public.user_warning_appeal_events owner to postgres;
alter table public.user_warning_appeal_requests owner to postgres;

alter function public.protect_user_warning_appeal_append_only() owner to postgres;
alter function public.protect_user_warning_appeal_current() owner to postgres;
alter function public.assert_team_inbox_topic_access(text,text,boolean) owner to postgres;
alter function public.submit_user_warning_appeal(uuid,uuid,text,uuid) owner to postgres;
alter function public.get_own_user_warning_appeal_status(uuid,uuid) owner to postgres;
alter function public.get_user_warning_appeal_case_detail(text,uuid) owner to postgres;
alter function public.sync_user_warning_appeal_overrule() owner to postgres;
alter function public.review_user_warning_appeal(text,uuid,text,bigint,bigint,bigint,bigint,bigint,text,uuid) owner to postgres;
alter function public.guard_user_warning_appeal_case_return() owner to postgres;
alter function public.mutate_user_warning_appeal_case(text,uuid,uuid,text,text,bigint,bigint,text) owner to postgres;
alter function public.get_own_notifications(uuid,timestamptz,uuid,integer) owner to postgres;

revoke all on table public.user_warning_appeals from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.user_warning_appeal_current from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.user_warning_appeal_events from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.user_warning_appeal_requests from public, anon, authenticated, discord_bot, service_role;

revoke all on function public.protect_user_warning_appeal_append_only() from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.protect_user_warning_appeal_current() from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.assert_team_inbox_topic_access(text,text,boolean) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.sync_user_warning_appeal_overrule() from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.submit_user_warning_appeal(uuid,uuid,text,uuid) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_own_user_warning_appeal_status(uuid,uuid) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_user_warning_appeal_case_detail(text,uuid) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.review_user_warning_appeal(text,uuid,text,bigint,bigint,bigint,bigint,bigint,text,uuid) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.guard_user_warning_appeal_case_return() from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.mutate_user_warning_appeal_case(text,uuid,uuid,text,text,bigint,bigint,text) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_own_notifications(uuid,timestamptz,uuid,integer) from public, anon, authenticated, discord_bot, service_role;

grant execute on function public.submit_user_warning_appeal(uuid,uuid,text,uuid) to service_role;
grant execute on function public.get_own_user_warning_appeal_status(uuid,uuid) to service_role;
grant execute on function public.get_user_warning_appeal_case_detail(text,uuid) to service_role;
grant execute on function public.review_user_warning_appeal(text,uuid,text,bigint,bigint,bigint,bigint,bigint,text,uuid) to service_role;
grant execute on function public.mutate_user_warning_appeal_case(text,uuid,uuid,text,text,bigint,bigint,text) to service_role;
grant execute on function public.get_own_notifications(uuid,timestamptz,uuid,integer) to service_role;

do $postflight$
begin
  if (select count(*) from public.capability_catalog) <> 56
    or (select count(*) from public.capability_catalog where is_active) <> 52
    or (select count(*) from public.team_role_capabilities
        where capability_key in ('users.warning_appeals.view', 'users.warning_appeals.review')) <> 0
    or not exists (
      select 1 from public.team_inbox_topic_catalog
      where topic_key = 'warning_appeals' and is_active and accepts_new_cases
        and required_read_capabilities = array['users.warning_appeals.view']::text[]
        and required_action_capabilities = array['users.warning_appeals.view', 'users.warning_appeals.review']::text[]
    )
    or (select count(*) from pg_proc function_row
        join pg_namespace namespace_row on namespace_row.oid = function_row.pronamespace
        where namespace_row.nspname = 'public'
          and function_row.proname in (
            'submit_user_warning_appeal', 'get_own_user_warning_appeal_status',
            'get_user_warning_appeal_case_detail', 'review_user_warning_appeal',
            'sync_user_warning_appeal_overrule', 'mutate_user_warning_appeal_case'
          )) <> 6
    or has_function_privilege('authenticated', 'public.submit_user_warning_appeal(uuid,uuid,text,uuid)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.review_user_warning_appeal(text,uuid,text,bigint,bigint,bigint,bigint,bigint,text,uuid)', 'EXECUTE')
  then
    raise exception using errcode = '55000', message = 'USER_WARNING_APPEAL_POSTFLIGHT_MISMATCH';
  end if;
end;
$postflight$;

commit;
