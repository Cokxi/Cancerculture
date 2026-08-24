begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $preflight$
begin
  if (select count(*) from public.capability_catalog) <> 43
    or (select count(*) from public.capability_catalog where is_active) <> 39
    or (select count(*) from public.team_inbox_topic_catalog) <> 1
    or to_regclass('public.community_comments') is null
    or to_regclass('public.community_comment_votes') is null
    or to_regclass('public.community_comment_abuse_events') is null
    or to_regclass('public.team_inbox_cases') is null
    or to_regprocedure('public.require_account_session(uuid)') is null
    or to_regprocedure('public.upsert_team_inbox_case(text,text,bigint,text,text)') is null
    or to_regprocedure('public.build_community_comment_public_json(uuid)') is null
    or exists (
      select 1 from public.capability_catalog
      where key = any(array[
        'community.comment_reports.view',
        'community.comment_reports.review',
        'community.comments.moderate',
        'community.comment_spam.view',
        'community.comment_spam.review',
        'logs.community_comment_moderation.view'
      ]::text[])
    )
    or to_regclass('public.community_comment_reports') is not null
    or exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'community_comments'
        and column_name in ('team_removed_at', 'team_moderation_version')
    )
  then
    raise exception using
      errcode = '55000',
      message = 'COMMENT_REVIEW_BASELINE_MISMATCH';
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
  'community.comment_reports.view', 'View Comment Reports',
  'View redacted Comment Report queues, case details, immutable report facts, and the integrated append-only Case timeline without claiming or changing a Case.',
  'Community',
  array[
    'View the redacted Comment Report Team Inbox topic, bounded queues, full Case details, and permanent Case timeline.',
    'View report categories, allowlisted explanations, Comment context, and report counts without reporter identity.',
    'Use capability-protected bounded username and exact Discord ID Case search.'
  ]::text[],
  array[
    'Claiming, returning, solving, removing, or restoring a Comment.',
    'Viewing reporter identity, raw abuse signals, manual User Flags, private security data, or prior Comment bodies.',
    'Viewing automated Spam Review Cases or the standalone moderation log.',
    'Managing roles, grants, Team membership, Owner access, or unrelated content and logs.'
  ]::text[],
  'high', true, true, 1,
  '70902b326e0b5f2247e1c20443886f28fa16480aca8e05f6d63ad3367b1bffcd'
),
(
  'community.comment_reports.review', 'Review Comment Reports',
  'Claim, return, and resolve Comment Report Cases with No action, always together with the exact Comment Report View capability.',
  'Community',
  array[
    'Exclusively claim an open Comment Report Case and return unresolved work with a bounded internal note.',
    'Solve an assigned Comment Report Case with No action under expected Case and source versions.',
    'Use idempotent, concurrency-safe Case workflow actions while preserving the append-only timeline.'
  ]::text[],
  array[
    'Viewing a Comment Report Case without community.comment_reports.view.',
    'Removing or restoring Comments without community.comments.moderate.',
    'Viewing reporter identity, automated Spam Cases, raw signals, or the standalone moderation log.',
    'Taking over another reviewer assignment or managing roles, grants, Team membership, or Owner access.'
  ]::text[],
  'high', true, true, 1,
  'b201f956e4cc586b0a445455935224c3cefd5d5c950260e6899c451191e19da9'
),
(
  'community.comments.moderate', 'Moderate Comments',
  'Remove or restore eligible Comments through expected-version, idempotent, append-only audited moderation without implied Report, Spam, or log access.',
  'Community',
  array[
    'Remove a visible Comment directly or atomically while solving an assigned Report or Spam Case when the additional Case rights are present.',
    'Restore the latest retainable Comment body, Mentions, and Vote presentation after an internal correction reason and expected-version check.',
    'Close a removed Root branch and preserve existing Replies and immutable moderation history.'
  ]::text[],
  array[
    'Viewing Comment Report or Spam Case details without their exact View rights.',
    'Claiming, returning, or solving Cases without their exact Review rights.',
    'Overriding author deletion, unavailable Submission state, retention limits, account state, or public release controls.',
    'Viewing reporter identities, raw Spam signals, moderation logs, roles, grants, Team membership, or Owner access.'
  ]::text[],
  'critical', true, true, 1,
  '68c743df9ccd4dba9cf6f511a0d7b737e1d7ba84450425722846912784c17e9f'
),
(
  'community.comment_spam.view', 'View Comment Spam Review',
  'View redacted user-centered automated Comment Spam Review queues, bounded aggregates, related public Comment context, and permanent Case timelines.',
  'Community',
  array[
    'View the redacted Spam Review Team Inbox topic, bounded queues, full Case details, and permanent Case timeline.',
    'View bounded aggregate risk context and allowlisted related Comment references without raw signal weights or thresholds.',
    'Use capability-protected bounded username and exact Discord ID Case search.'
  ]::text[],
  array[
    'Claiming, returning, solving, removing, or restoring a Comment.',
    'Viewing raw Spam signals, private heuristics, IP or device data, manual User Flags, reporter identity, or prior Comment bodies.',
    'Viewing Comment Report Cases or the standalone moderation log.',
    'Managing roles, grants, Team membership, Owner access, or unrelated content and logs.'
  ]::text[],
  'high', true, true, 1,
  '389916756fe7326a7ba51977168f22d0f4a079b77b25deed29bdeeb1e05d42da'
),
(
  'community.comment_spam.review', 'Review Comment Spam Cases',
  'Claim, return, and resolve automated Comment Spam Review Cases with No action, always together with the exact Spam View capability.',
  'Community',
  array[
    'Exclusively claim an open automated Spam Review Case and return unresolved work with a bounded internal note.',
    'Solve an assigned Spam Review Case with No action under expected Case and source versions.',
    'Use idempotent, concurrency-safe Case workflow actions while preserving the append-only timeline.'
  ]::text[],
  array[
    'Viewing a Spam Review Case without community.comment_spam.view.',
    'Removing or restoring Comments without community.comments.moderate.',
    'Viewing raw signal weights, thresholds, IP or device data, manual User Flags, reporter identity, or the standalone moderation log.',
    'Automatically sanctioning an account or taking over another reviewer assignment.'
  ]::text[],
  'high', true, true, 1,
  'eb211f298b166f8896c55f669cb721c790f3b27c3eb87d60799b7af741c14b76'
),
(
  'logs.community_comment_moderation.view', 'View Comment Moderation Logs',
  'View the redacted append-only Comment moderation log without gaining Comment, Report, Spam Case, or workflow mutation authority.',
  'Logs',
  array[
    'View bounded newest-first Remove and Restore events with safe public Comment references, action, database time, and redacted actor snapshot.',
    'Review immutable moderation version transitions and allowlisted outcome codes without opening Case payloads.'
  ]::text[],
  array[
    'Removing or restoring Comments, claiming or solving Cases, or viewing Report and Spam Case details.',
    'Viewing reporter identities, raw Spam signals, private heuristics, prior Comment bodies, or unrelated moderation data.',
    'Exporting unbounded logs or exposing internal IDs, Discord IDs, secrets, IP, device, or security data.',
    'Managing roles, grants, Team membership, Owner access, or unrelated logs.'
  ]::text[],
  'high', true, true, 1,
  '6db2fa540e00d5146aebbfe021eec0a26dea7bf1078f59a5dda74ad8a5813ea3'
);

insert into public.team_inbox_topic_catalog (
  topic_key, display_name, is_active, required_read_capabilities,
  required_action_capabilities, activated_at, accepts_new_cases
)
values
  (
    'comment_reports', 'Comment Reports', true,
    array['community.comment_reports.view']::text[],
    array['community.comment_reports.view', 'community.comment_reports.review']::text[],
    transaction_timestamp(), true
  ),
  (
    'comment_spam', 'Comment Spam Review', true,
    array['community.comment_spam.view']::text[],
    array['community.comment_spam.view', 'community.comment_spam.review']::text[],
    transaction_timestamp(), true
  );

alter table public.community_comments
  add column team_removed_at timestamptz,
  add column team_moderation_version bigint not null default 0,
  add constraint community_comments_team_moderation_version_check
    check (team_moderation_version >= 0),
  add constraint community_comments_team_removal_time_check
    check (team_removed_at is null or team_removed_at >= created_at);

create table public.community_comment_report_cases (
  id uuid primary key default gen_random_uuid(),
  comment_id uuid not null unique
    references public.community_comments(id) on delete restrict,
  team_inbox_case_id uuid unique
    references public.team_inbox_cases(id) on delete restrict,
  generation bigint not null default 1 check (generation > 0),
  report_count bigint not null default 0 check (report_count >= 0),
  status text not null default 'open' check (status in ('open', 'solved')),
  version bigint not null default 1 check (version > 0),
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  solved_at timestamptz,
  last_outcome text,
  constraint community_comment_report_case_state_check check (
    (status = 'open' and solved_at is null and last_outcome is null)
    or (status = 'solved' and solved_at is not null
      and last_outcome in ('no_action', 'removed'))
  )
);

create table public.community_comment_reports (
  id uuid primary key default gen_random_uuid(),
  public_report_id uuid not null unique default gen_random_uuid(),
  case_id uuid not null references public.community_comment_report_cases(id) on delete restrict,
  comment_id uuid not null references public.community_comments(id) on delete restrict,
  reporter_discord_user_id text not null
    references public.user_logs(discord_user_id) on delete restrict,
  category text not null check (category in (
    'hate_discriminatory', 'harassment_threats', 'illegal_harmful',
    'privacy_doxxing', 'spam_scam_manipulation', 'other'
  )),
  explanation text,
  rules_version integer not null check (rules_version > 0),
  rules_affirmed_at timestamptz not null default transaction_timestamp(),
  request_id uuid not null,
  created_at timestamptz not null default transaction_timestamp(),
  unique (comment_id, reporter_discord_user_id),
  unique (reporter_discord_user_id, request_id),
  constraint community_comment_report_explanation_check check (
    (category = 'other' and char_length(explanation) between 20 and 500)
    or (category <> 'other' and (
      explanation is null or char_length(explanation) between 10 and 500
    ))
  )
);

create table public.community_comment_report_events (
  id bigint generated always as identity primary key,
  case_id uuid not null references public.community_comment_report_cases(id) on delete restrict,
  event_type text not null check (event_type in ('report_received', 'reopened', 'solved')),
  generation bigint not null check (generation > 0),
  case_version bigint not null check (case_version > 0),
  report_id uuid references public.community_comment_reports(id) on delete restrict,
  outcome text check (outcome in ('no_action', 'removed')),
  created_at timestamptz not null default transaction_timestamp()
);

create table public.community_comment_report_requests (
  reporter_discord_user_id text not null,
  request_id uuid not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  result jsonb not null check (jsonb_typeof(result) = 'object'),
  created_at timestamptz not null default transaction_timestamp(),
  primary key (reporter_discord_user_id, request_id)
);

create table public.community_comment_spam_review_policies (
  policy_version bigint primary key check (policy_version > 0),
  is_active boolean not null default false,
  minimum_event_count integer not null check (minimum_event_count between 2 and 10000),
  lookback_seconds integer not null check (lookback_seconds between 60 and 2592000),
  created_at timestamptz not null default transaction_timestamp()
);

create unique index community_comment_spam_review_one_active_policy_idx
  on public.community_comment_spam_review_policies(is_active)
  where is_active;

create table public.community_comment_spam_cases (
  id uuid primary key default gen_random_uuid(),
  subject_discord_user_id text not null
    references public.user_logs(discord_user_id) on delete restrict,
  generation bigint not null check (generation > 0),
  policy_version bigint not null
    references public.community_comment_spam_review_policies(policy_version) on delete restrict,
  team_inbox_case_id uuid unique
    references public.team_inbox_cases(id) on delete restrict,
  status text not null default 'open' check (status in ('open', 'solved')),
  signal_count bigint not null check (signal_count > 0),
  version bigint not null default 1 check (version > 0),
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  solved_at timestamptz,
  last_outcome text,
  unique (subject_discord_user_id, generation),
  constraint community_comment_spam_case_state_check check (
    (status = 'open' and solved_at is null and last_outcome is null)
    or (status = 'solved' and solved_at is not null
      and last_outcome in ('no_action', 'removed'))
  )
);

create unique index community_comment_spam_one_open_case_idx
  on public.community_comment_spam_cases(subject_discord_user_id)
  where status = 'open';

create table public.community_comment_spam_signals (
  id bigint generated always as identity primary key,
  case_id uuid not null references public.community_comment_spam_cases(id) on delete restrict,
  abuse_event_id bigint not null unique
    references public.community_comment_abuse_events(id) on delete restrict,
  signal_class text not null check (signal_class ~ '^[a-z0-9_:-]{2,100}$'),
  created_at timestamptz not null default transaction_timestamp()
);

create table public.community_comment_spam_comment_refs (
  case_id uuid not null references public.community_comment_spam_cases(id) on delete restrict,
  comment_id uuid not null references public.community_comments(id) on delete restrict,
  first_seen_at timestamptz not null default transaction_timestamp(),
  last_seen_at timestamptz not null default transaction_timestamp(),
  reference_count bigint not null default 1 check (reference_count > 0),
  primary key (case_id, comment_id)
);

create table public.community_comment_spam_events (
  id bigint generated always as identity primary key,
  case_id uuid not null references public.community_comment_spam_cases(id) on delete restrict,
  event_type text not null check (event_type in ('created', 'signals_updated', 'solved')),
  case_version bigint not null check (case_version > 0),
  signal_count bigint not null check (signal_count > 0),
  outcome text check (outcome in ('no_action', 'removed')),
  created_at timestamptz not null default transaction_timestamp()
);

create table public.community_comment_review_requests (
  actor_discord_user_id text not null,
  request_id uuid not null,
  operation text not null check (operation in ('resolve_report', 'resolve_spam', 'moderate_direct')),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  result jsonb not null check (jsonb_typeof(result) = 'object'),
  created_at timestamptz not null default transaction_timestamp(),
  primary key (actor_discord_user_id, request_id)
);

create table public.community_comment_moderation_events (
  id bigint generated always as identity primary key,
  comment_id uuid not null references public.community_comments(id) on delete restrict,
  public_comment_id uuid not null,
  submission_id bigint not null,
  action text not null check (action in ('remove', 'restore')),
  from_object_version bigint not null check (from_object_version > 0),
  to_object_version bigint not null check (to_object_version > from_object_version),
  moderation_version bigint not null check (moderation_version > 0),
  actor_discord_user_id text not null,
  actor_display_snapshot text not null,
  actor_role_snapshot text not null,
  internal_reason text not null check (char_length(internal_reason) between 3 and 1000),
  source_topic text check (source_topic in ('comment_reports', 'comment_spam')),
  source_case_id uuid references public.team_inbox_cases(id) on delete restrict,
  request_id uuid not null,
  created_at timestamptz not null default transaction_timestamp(),
  unique (actor_discord_user_id, request_id),
  unique (comment_id, moderation_version)
);

create index community_comment_reports_case_created_idx
  on public.community_comment_reports(case_id, created_at desc, id desc);
create index community_comment_report_events_case_idx
  on public.community_comment_report_events(case_id, id desc);
create index community_comment_spam_signals_case_idx
  on public.community_comment_spam_signals(case_id, id desc);
create index community_comment_spam_events_case_idx
  on public.community_comment_spam_events(case_id, id desc);
create index community_comment_moderation_events_log_idx
  on public.community_comment_moderation_events(created_at desc, id desc);

alter table public.community_comment_report_cases enable row level security;
alter table public.community_comment_reports enable row level security;
alter table public.community_comment_report_events enable row level security;
alter table public.community_comment_report_requests enable row level security;
alter table public.community_comment_spam_review_policies enable row level security;
alter table public.community_comment_spam_cases enable row level security;
alter table public.community_comment_spam_signals enable row level security;
alter table public.community_comment_spam_comment_refs enable row level security;
alter table public.community_comment_spam_events enable row level security;
alter table public.community_comment_review_requests enable row level security;
alter table public.community_comment_moderation_events enable row level security;

revoke all on table
  public.community_comment_report_cases,
  public.community_comment_reports,
  public.community_comment_report_events,
  public.community_comment_report_requests,
  public.community_comment_spam_review_policies,
  public.community_comment_spam_cases,
  public.community_comment_spam_signals,
  public.community_comment_spam_comment_refs,
  public.community_comment_spam_events,
  public.community_comment_review_requests,
  public.community_comment_moderation_events
from public, anon, authenticated, discord_bot, service_role;

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

  select case when p_action_access
      then topic.required_action_capabilities
      else topic.required_read_capabilities
    end
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
      ('winners.payouts.view', 2,
        '9de22d0055e9c8b6b8cb701e4f6f554aa4c241ab0cbfb0a4709ecc9841702a54'),
      ('winners.recipient_corrections.manage', 2,
        'e569fa66e8f9c2794fe030c4e034ebf8a7e458c6ddccf2a868d2cac1fd5ea2bd'),
      ('community.comment_reports.view', 1,
        '70902b326e0b5f2247e1c20443886f28fa16480aca8e05f6d63ad3367b1bffcd'),
      ('community.comment_reports.review', 1,
        'b201f956e4cc586b0a445455935224c3cefd5d5c950260e6899c451191e19da9'),
      ('community.comment_spam.view', 1,
        '389916756fe7326a7ba51977168f22d0f4a079b77b25deed29bdeeb1e05d42da'),
      ('community.comment_spam.review', 1,
        'eb211f298b166f8896c55f669cb721c790f3b27c3eb87d60799b7af741c14b76')
    ) expected(capability_key, implementation_version, definition_hash)
    where expected.capability_key = v_capability;

    if v_expected_version is null or not exists (
      select 1 from public.capability_catalog capability
      where capability.key = v_capability
        and capability.is_active
        and capability.assignable_to_non_admin
        and capability.implementation_version = v_expected_version
        and capability.definition_hash = v_expected_hash
    ) then
      raise exception using
        errcode = '55000', message = 'TEAM_INBOX_CAPABILITY_DEPENDENCY_UNAVAILABLE';
    end if;
    if v_role <> 'admin' and not exists (
      select 1 from public.team_role_capabilities grant_row
      where grant_row.role_key = v_role
        and grant_row.capability_key = v_capability
    ) then
      raise exception using errcode = '42501', message = 'TEAM_INBOX_FORBIDDEN';
    end if;
  end loop;
  return v_role;
end;
$function$;

create function public.assert_community_comment_capabilities(
  p_actor_discord_user_id text,
  p_capabilities text[]
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
  v_capability text;
  v_expected_hash text;
begin
  if v_actor_id !~ '^[0-9]{1,100}$'
    or p_capabilities is null
    or cardinality(p_capabilities) not between 1 and 3
    or exists (select 1 from unnest(p_capabilities) item where item is null)
  then
    raise exception using errcode = '42501', message = 'COMMENT_REVIEW_FORBIDDEN';
  end if;

  select member.role into v_role
  from public.team_members member
  join public.team_roles role on role.key = member.role and role.is_active
  where member.discord_user_id = v_actor_id;
  if not found then
    raise exception using errcode = '42501', message = 'COMMENT_REVIEW_FORBIDDEN';
  end if;

  foreach v_capability in array p_capabilities loop
    v_expected_hash := case v_capability
      when 'community.comment_reports.view' then
        '70902b326e0b5f2247e1c20443886f28fa16480aca8e05f6d63ad3367b1bffcd'
      when 'community.comment_reports.review' then
        'b201f956e4cc586b0a445455935224c3cefd5d5c950260e6899c451191e19da9'
      when 'community.comments.moderate' then
        '68c743df9ccd4dba9cf6f511a0d7b737e1d7ba84450425722846912784c17e9f'
      when 'community.comment_spam.view' then
        '389916756fe7326a7ba51977168f22d0f4a079b77b25deed29bdeeb1e05d42da'
      when 'community.comment_spam.review' then
        'eb211f298b166f8896c55f669cb721c790f3b27c3eb87d60799b7af741c14b76'
      when 'logs.community_comment_moderation.view' then
        '6db2fa540e00d5146aebbfe021eec0a26dea7bf1078f59a5dda74ad8a5813ea3'
      else null
    end;
    if v_expected_hash is null or not exists (
      select 1 from public.capability_catalog capability
      where capability.key = v_capability
        and capability.is_active
        and capability.assignable_to_non_admin
        and capability.implementation_version = 1
        and capability.definition_hash = v_expected_hash
    ) then
      raise exception using errcode = '55000', message = 'COMMENT_REVIEW_CAPABILITY_UNAVAILABLE';
    end if;
    if v_role <> 'admin' and not exists (
      select 1 from public.team_role_capabilities grant_row
      where grant_row.role_key = v_role and grant_row.capability_key = v_capability
    ) then
      raise exception using errcode = '42501', message = 'COMMENT_REVIEW_FORBIDDEN';
    end if;
  end loop;
  return v_role;
end;
$function$;

revoke all on sequence
  public.community_comment_report_events_id_seq,
  public.community_comment_spam_signals_id_seq,
  public.community_comment_spam_events_id_seq,
  public.community_comment_moderation_events_id_seq
from public, anon, authenticated, discord_bot, service_role;

create function public.guard_community_comment_team_moderation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $function$
begin
  if old.team_removed_at is not null
    and new.current_text_version is distinct from old.current_text_version
    and new.author_deleted_at is not distinct from old.author_deleted_at
  then
    raise exception using errcode = '55000', message = 'COMMUNITY_COMMENT_TEAM_REMOVED';
  end if;
  return new;
end;
$function$;

create function public.guard_community_comment_reply_target()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $function$
begin
  if new.root_comment_id is not null and (
    exists (
      select 1 from public.community_comments root_row
      where root_row.id = new.root_comment_id and root_row.team_removed_at is not null
    ) or exists (
      select 1 from public.community_comments target_row
      where target_row.id = new.reply_target_comment_id and target_row.team_removed_at is not null
    )
  ) then
    raise exception using errcode = '55000', message = 'COMMUNITY_COMMENT_REPLY_TARGET_UNAVAILABLE';
  end if;
  return new;
end;
$function$;

create function public.guard_community_comment_vote_target()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $function$
begin
  if exists (
    select 1 from public.community_comments comment_row
    where comment_row.id = new.comment_id and comment_row.team_removed_at is not null
  ) then
    raise exception using errcode = '55000', message = 'COMMUNITY_COMMENT_TEAM_REMOVED';
  end if;
  return new;
end;
$function$;

create trigger community_comments_team_moderation_guard
before update on public.community_comments
for each row execute function public.guard_community_comment_team_moderation();
create trigger community_comments_reply_target_guard
before insert on public.community_comments
for each row execute function public.guard_community_comment_reply_target();
create trigger community_comment_votes_team_removed_guard
before insert or update on public.community_comment_votes
for each row execute function public.guard_community_comment_vote_target();
create trigger community_comment_vote_transitions_team_removed_guard
before insert on public.community_comment_vote_transitions
for each row execute function public.guard_community_comment_vote_target();

create trigger community_comment_reports_no_update
before update on public.community_comment_reports
for each row execute function public.protect_community_comment_append_only();
create trigger community_comment_reports_no_delete
before delete on public.community_comment_reports
for each row execute function public.protect_community_comment_append_only();
create trigger community_comment_report_events_no_update
before update on public.community_comment_report_events
for each row execute function public.protect_community_comment_append_only();
create trigger community_comment_report_events_no_delete
before delete on public.community_comment_report_events
for each row execute function public.protect_community_comment_append_only();
create trigger community_comment_report_requests_no_update
before update on public.community_comment_report_requests
for each row execute function public.protect_community_comment_append_only();
create trigger community_comment_report_requests_no_delete
before delete on public.community_comment_report_requests
for each row execute function public.protect_community_comment_append_only();
create trigger community_comment_spam_signals_no_update
before update on public.community_comment_spam_signals
for each row execute function public.protect_community_comment_append_only();
create trigger community_comment_spam_signals_no_delete
before delete on public.community_comment_spam_signals
for each row execute function public.protect_community_comment_append_only();
create trigger community_comment_spam_events_no_update
before update on public.community_comment_spam_events
for each row execute function public.protect_community_comment_append_only();
create trigger community_comment_spam_events_no_delete
before delete on public.community_comment_spam_events
for each row execute function public.protect_community_comment_append_only();
create trigger community_comment_review_requests_no_update
before update on public.community_comment_review_requests
for each row execute function public.protect_community_comment_append_only();
create trigger community_comment_review_requests_no_delete
before delete on public.community_comment_review_requests
for each row execute function public.protect_community_comment_append_only();
create trigger community_comment_moderation_events_no_update
before update on public.community_comment_moderation_events
for each row execute function public.protect_community_comment_append_only();
create trigger community_comment_moderation_events_no_delete
before delete on public.community_comment_moderation_events
for each row execute function public.protect_community_comment_append_only();

create or replace function public.get_community_comment_vote_counts_json(
  p_comment_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select case
    when comment_row.author_deleted_at is not null
      or comment_row.team_removed_at is not null then null
    else jsonb_build_object(
      'up', count(*) filter (where vote.vote_state = 'up')::integer,
      'down', count(*) filter (where vote.vote_state = 'down')::integer
    )
  end
  from public.community_comments comment_row
  left join public.community_comment_votes vote
    on vote.comment_id = comment_row.id and vote.vote_state is not null
  where comment_row.id = p_comment_id
  group by comment_row.author_deleted_at, comment_row.team_removed_at;
$function$;

create or replace function public.get_community_comment_vote_score_at(
  p_comment_id uuid,
  p_snapshot_at timestamptz
)
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select case
    when comment_row.author_deleted_at is not null
      or comment_row.team_removed_at is not null then 0
    else coalesce(sum(
      case latest.to_state when 'up' then 1 when 'down' then -1 else 0 end
    ), 0)::integer
  end
  from public.community_comments comment_row
  left join lateral (
    select distinct on (transition.voter_discord_user_id)
      transition.voter_discord_user_id, transition.to_state
    from public.community_comment_vote_transitions transition
    where transition.comment_id = comment_row.id
      and transition.transitioned_at <= p_snapshot_at
    order by transition.voter_discord_user_id,
      transition.transitioned_at desc, transition.id desc
  ) latest on true
  where comment_row.id = p_comment_id
  group by comment_row.author_deleted_at, comment_row.team_removed_at;
$function$;

create or replace function public.get_community_comment_vote_projection(
  p_comment_id uuid,
  p_voter_discord_user_id text
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select jsonb_build_object(
    'publicCommentId', comment_row.public_comment_id,
    'voteCounts', public.get_community_comment_vote_counts_json(comment_row.id),
    'viewerState', vote.vote_state,
    'viewerVersion', coalesce(vote.version, 0)
  )
  from public.community_comments comment_row
  left join public.community_comment_votes vote
    on vote.comment_id = comment_row.id
   and vote.voter_discord_user_id = p_voter_discord_user_id
  where comment_row.id = p_comment_id
    and comment_row.author_deleted_at is null
    and comment_row.team_removed_at is null;
$function$;

create or replace function public.resolve_community_comment_vote_replay(
  p_voter_discord_user_id text,
  p_request_id uuid,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_request public.community_comment_vote_requests%rowtype;
  v_comment public.community_comments%rowtype;
begin
  select * into v_request
  from public.community_comment_vote_requests request
  where request.voter_discord_user_id = p_voter_discord_user_id
    and request.request_id = p_request_id;
  if not found then return null; end if;
  if v_request.request_hash <> p_request_hash then
    return jsonb_build_object('outcome', 'idempotency_conflict');
  end if;
  select * into v_comment from public.community_comments where id = v_request.comment_id;
  if not found or v_comment.author_deleted_at is not null
    or v_comment.team_removed_at is not null
    or not public.is_community_comment_submission_eligible(v_comment.submission_id)
  then
    return jsonb_build_object('outcome', 'comment_unavailable');
  end if;
  return v_request.receipt || jsonb_build_object('replayed', true);
end;
$function$;

create or replace function public.get_community_comment_vote_viewer_state(
  p_session_id uuid,
  p_public_comment_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor text;
  v_items jsonb;
begin
  if p_session_id is null or p_public_comment_ids is null
    or cardinality(p_public_comment_ids) > 100
    or exists (select 1 from unnest(p_public_comment_ids) public_id where public_id is null)
  then
    raise exception using errcode = '22023', message = 'COMMUNITY_COMMENT_VOTE_VIEWER_INPUT_INVALID';
  end if;
  if public.get_community_comment_release_state() = 'off' then
    return jsonb_build_object('outcome', 'feature_off');
  end if;
  v_actor := public.require_account_session(p_session_id);
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'publicCommentId', comment_row.public_comment_id,
      'state', vote.vote_state,
      'version', coalesce(vote.version, 0)
    ) order by requested.first_ordinality
  ), '[]'::jsonb)
  into v_items
  from (
    select public_id, min(ordinality) as first_ordinality
    from unnest(p_public_comment_ids) with ordinality input(public_id, ordinality)
    group by public_id
  ) requested
  join public.community_comments comment_row
    on comment_row.public_comment_id = requested.public_id
  left join public.community_comment_votes vote
    on vote.comment_id = comment_row.id and vote.voter_discord_user_id = v_actor
  where comment_row.author_deleted_at is null
    and comment_row.team_removed_at is null
    and public.is_community_comment_submission_eligible(comment_row.submission_id);
  return jsonb_build_object('outcome', 'ok', 'items', v_items);
end;
$function$;

create or replace function public.build_community_comment_public_json(
  p_comment_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select jsonb_build_object(
    'publicCommentId', comment_row.public_comment_id,
    'submissionId', comment_row.submission_id,
    'rootPublicCommentId', root_row.public_comment_id,
    'replyTargetPublicCommentId', target_row.public_comment_id,
    'version', comment_row.object_version,
    'createdAt', comment_row.created_at,
    'edited', comment_row.edited_at is not null,
    'editedAt', comment_row.edited_at,
    'tombstone', case
      when comment_row.author_deleted_at is not null then 'author_deleted'
      when comment_row.team_removed_at is not null then 'team_removed'
      else null
    end,
    'body', case
      when comment_row.author_deleted_at is not null
        or comment_row.team_removed_at is not null then null
      else text_version.normalized_body
    end,
    'author', jsonb_build_object(
      'publicProfileId', author_row.public_profile_id,
      'displayName', coalesce(
        nullif(btrim(author_row.current_guild_nickname), ''),
        nullif(btrim(author_row.current_display_name), ''),
        nullif(btrim(author_row.current_discord_handle), ''),
        nullif(btrim(author_row.current_discord_username), ''),
        'CancerCulture member'
      ),
      'isCreator', submission.discord_user_id = comment_row.author_discord_user_id,
      'isBanned', author_row.is_banned
    ),
    'mentions', case
      when comment_row.author_deleted_at is not null
        or comment_row.team_removed_at is not null then '[]'::jsonb
      else coalesce((
        select jsonb_agg(jsonb_build_object(
          'targetPublicProfileId', target_user.public_profile_id,
          'displayName', coalesce(
            nullif(btrim(target_user.current_guild_nickname), ''),
            nullif(btrim(target_user.current_display_name), ''),
            nullif(btrim(target_user.current_discord_handle), ''),
            nullif(btrim(target_user.current_discord_username), ''),
            'CancerCulture member'
          ),
          'startIndex', mention.start_index,
          'endIndex', mention.end_index
        ) order by mention.start_index, mention.end_index)
        from public.community_comment_mentions mention
        join public.user_logs target_user
          on target_user.discord_user_id = mention.target_discord_user_id
        where mention.comment_id = comment_row.id
          and mention.text_version = comment_row.current_text_version
          and target_user.public_profile_id is not null
      ), '[]'::jsonb)
    end,
    'replyCount', case when comment_row.root_comment_id is null then (
      select count(*)::integer from public.community_comments reply
      where reply.root_comment_id = comment_row.id
    ) else 0 end,
    'voteCounts', public.get_community_comment_vote_counts_json(comment_row.id)
  )
  from public.community_comments comment_row
  join public.community_comment_text_versions text_version
    on text_version.comment_id = comment_row.id
   and text_version.version = comment_row.current_text_version
  join public.user_logs author_row
    on author_row.discord_user_id = comment_row.author_discord_user_id
  join public.submissions submission on submission.id = comment_row.submission_id
  left join public.community_comments root_row on root_row.id = comment_row.root_comment_id
  left join public.community_comments target_row on target_row.id = comment_row.reply_target_comment_id
  where comment_row.id = p_comment_id and author_row.public_profile_id is not null;
$function$;

create function public.submit_community_comment_report(
  p_session_id uuid,
  p_public_comment_id uuid,
  p_category text,
  p_explanation text,
  p_request_id uuid,
  p_request_hash text,
  p_rules_affirmed boolean,
  p_turnstile_verified boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor text;
  v_comment public.community_comments%rowtype;
  v_case public.community_comment_report_cases%rowtype;
  v_report public.community_comment_reports%rowtype;
  v_existing public.community_comment_report_requests%rowtype;
  v_rules_version integer;
  v_subject_username text;
  v_upsert jsonb;
  v_result jsonb;
  v_was_solved boolean := false;
  v_explanation text := nullif(btrim(p_explanation), '');
begin
  if p_session_id is null or p_public_comment_id is null or p_request_id is null
    or p_request_hash !~ '^[0-9a-f]{64}$'
    or p_category not in (
      'hate_discriminatory', 'harassment_threats', 'illegal_harmful',
      'privacy_doxxing', 'spam_scam_manipulation', 'other'
    )
    or not coalesce(p_rules_affirmed, false)
    or not coalesce(p_turnstile_verified, false)
    or (p_category = 'other' and coalesce(char_length(v_explanation), 0) not between 20 and 500)
    or (p_category <> 'other' and v_explanation is not null
      and char_length(v_explanation) not between 10 and 500)
  then
    raise exception using errcode = '22023', message = 'COMMUNITY_COMMENT_REPORT_INPUT_INVALID';
  end if;

  if public.get_community_comment_release_state() <> 'open' then
    return jsonb_build_object('outcome', 'feature_unavailable');
  end if;
  v_actor := public.require_account_session(p_session_id);

  perform pg_advisory_xact_lock(hashtextextended(
    'community-comment-report-request:' || v_actor || ':' || p_request_id::text, 0
  ));
  select * into v_existing
  from public.community_comment_report_requests request
  where request.reporter_discord_user_id = v_actor and request.request_id = p_request_id;
  if found then
    if v_existing.request_hash <> p_request_hash then
      return jsonb_build_object('outcome', 'idempotency_conflict');
    end if;
    return v_existing.result || jsonb_build_object('replayed', true);
  end if;

  select * into v_comment
  from public.community_comments comment_row
  where comment_row.public_comment_id = p_public_comment_id
  for update;
  if not found or v_comment.author_deleted_at is not null
    or v_comment.team_removed_at is not null
    or not public.is_community_comment_submission_eligible(v_comment.submission_id)
  then
    v_result := jsonb_build_object('outcome', 'comment_unavailable');
  elsif v_comment.author_discord_user_id = v_actor then
    v_result := jsonb_build_object('outcome', 'self_report_forbidden');
  else
    perform pg_advisory_xact_lock(hashtextextended(
      'community-comment-report:' || v_comment.id::text || ':' || v_actor, 0
    ));
    if exists (
      select 1 from public.community_comment_reports report
      where report.comment_id = v_comment.id
        and report.reporter_discord_user_id = v_actor
    ) then
      v_result := jsonb_build_object('outcome', 'already_reported');
    else
      select rules.current_version into v_rules_version
      from public.rules_meta rules where rules.id = 1;
      if v_rules_version is null or v_rules_version <= 0 then
        raise exception using errcode = '55000', message = 'COMMUNITY_COMMENT_RULES_UNAVAILABLE';
      end if;

      perform pg_advisory_xact_lock(hashtextextended(
        'team-inbox-source:comment_reports:comment:' || v_comment.id::text, 0
      ));
      select * into v_case from public.community_comment_report_cases
      where comment_id = v_comment.id for update;
      if not found then
        insert into public.community_comment_report_cases(comment_id, report_count)
        values (v_comment.id, 1) returning * into v_case;
      elsif v_case.status = 'solved' then
        v_was_solved := true;
        update public.community_comment_report_cases
        set generation = generation + 1, report_count = report_count + 1,
            status = 'open', version = version + 1, solved_at = null,
            last_outcome = null, updated_at = transaction_timestamp()
        where id = v_case.id returning * into v_case;
      else
        update public.community_comment_report_cases
        set report_count = report_count + 1, version = version + 1,
            updated_at = transaction_timestamp()
        where id = v_case.id returning * into v_case;
      end if;

      insert into public.community_comment_reports(
        case_id, comment_id, reporter_discord_user_id, category, explanation,
        rules_version, request_id
      ) values (
        v_case.id, v_comment.id, v_actor, p_category, v_explanation,
        v_rules_version, p_request_id
      ) returning * into v_report;
      insert into public.community_comment_report_events(
        case_id, event_type, generation, case_version, report_id
      ) values (
        v_case.id,
        case when v_was_solved then 'reopened' else 'report_received' end,
        v_case.generation, v_case.version, v_report.id
      );

      select coalesce(
        nullif(btrim(author_row.current_discord_username), ''),
        nullif(btrim(author_row.current_display_name), ''),
        'Community member'
      ) into v_subject_username
      from public.user_logs author_row
      where author_row.discord_user_id = v_comment.author_discord_user_id;
      v_upsert := public.upsert_team_inbox_case(
        'comment_reports', 'comment:' || v_comment.id::text, v_case.version,
        v_comment.author_discord_user_id, v_subject_username
      );
      update public.community_comment_report_cases
      set team_inbox_case_id = (v_upsert ->> 'caseId')::uuid
      where id = v_case.id and team_inbox_case_id is distinct from (v_upsert ->> 'caseId')::uuid;
      v_result := jsonb_build_object(
        'outcome', 'accepted', 'publicReportId', v_report.public_report_id
      );
    end if;
  end if;

  insert into public.community_comment_report_requests(
    reporter_discord_user_id, request_id, request_hash, result
  ) values (v_actor, p_request_id, p_request_hash, v_result);
  return v_result;
end;
$function$;

create function public.open_or_update_community_comment_spam_case()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_policy public.community_comment_spam_review_policies%rowtype;
  v_case public.community_comment_spam_cases%rowtype;
  v_event_count bigint;
  v_generation bigint;
  v_subject_username text;
  v_upsert jsonb;
begin
  if new.outcome = 'allowed' then return new; end if;
  select * into v_policy
  from public.community_comment_spam_review_policies policy
  where policy.is_active for share;
  if not found then return new; end if;

  select count(*) into v_event_count
  from public.community_comment_abuse_events abuse_event
  where abuse_event.author_discord_user_id = new.author_discord_user_id
    and abuse_event.outcome <> 'allowed'
    and abuse_event.created_at >= new.created_at
      - make_interval(secs => v_policy.lookback_seconds);
  if v_event_count < v_policy.minimum_event_count then return new; end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'community-comment-spam:' || new.author_discord_user_id, 0
  ));
  select * into v_case
  from public.community_comment_spam_cases spam_case
  where spam_case.subject_discord_user_id = new.author_discord_user_id
    and spam_case.status = 'open'
  for update;
  if not found then
    select coalesce(max(spam_case.generation), 0) + 1 into v_generation
    from public.community_comment_spam_cases spam_case
    where spam_case.subject_discord_user_id = new.author_discord_user_id;
    insert into public.community_comment_spam_cases(
      subject_discord_user_id, generation, policy_version, signal_count
    ) values (
      new.author_discord_user_id, v_generation, v_policy.policy_version, v_event_count
    ) returning * into v_case;
    insert into public.community_comment_spam_signals(case_id, abuse_event_id, signal_class)
    select v_case.id, abuse_event.id, abuse_event.action || ':' || abuse_event.outcome
    from public.community_comment_abuse_events abuse_event
    where abuse_event.author_discord_user_id = new.author_discord_user_id
      and abuse_event.outcome <> 'allowed'
      and abuse_event.created_at >= new.created_at
        - make_interval(secs => v_policy.lookback_seconds)
    on conflict (abuse_event_id) do nothing;
    insert into public.community_comment_spam_events(
      case_id, event_type, case_version, signal_count
    ) values (v_case.id, 'created', v_case.version, v_case.signal_count);
  else
    insert into public.community_comment_spam_signals(case_id, abuse_event_id, signal_class)
    values (v_case.id, new.id, new.action || ':' || new.outcome)
    on conflict (abuse_event_id) do nothing;
    if found then
      update public.community_comment_spam_cases
      set signal_count = signal_count + 1, version = version + 1,
          updated_at = transaction_timestamp()
      where id = v_case.id returning * into v_case;
      insert into public.community_comment_spam_events(
        case_id, event_type, case_version, signal_count
      ) values (v_case.id, 'signals_updated', v_case.version, v_case.signal_count);
    end if;
  end if;

  select coalesce(
    nullif(btrim(subject_row.current_discord_username), ''),
    nullif(btrim(subject_row.current_display_name), ''), 'Community member'
  ) into v_subject_username
  from public.user_logs subject_row
  where subject_row.discord_user_id = new.author_discord_user_id;
  v_upsert := public.upsert_team_inbox_case(
    'comment_spam',
    'user:' || new.author_discord_user_id || ':generation:' || v_case.generation::text,
    v_case.version, new.author_discord_user_id, v_subject_username
  );
  update public.community_comment_spam_cases
  set team_inbox_case_id = (v_upsert ->> 'caseId')::uuid
  where id = v_case.id and team_inbox_case_id is distinct from (v_upsert ->> 'caseId')::uuid;
  return new;
end;
$function$;

create function public.attach_community_comment_spam_reference()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_case_id uuid;
  v_actor text;
begin
  v_actor := case when tg_table_name = 'community_comment_vote_transitions'
    then new.voter_discord_user_id else new.actor_discord_user_id end;
  select spam_case.id into v_case_id
  from public.community_comment_spam_cases spam_case
  where spam_case.subject_discord_user_id = v_actor and spam_case.status = 'open'
  for update;
  if found then
    insert into public.community_comment_spam_comment_refs(case_id, comment_id)
    values (v_case_id, new.comment_id)
    on conflict (case_id, comment_id) do update
    set last_seen_at = transaction_timestamp(),
        reference_count = public.community_comment_spam_comment_refs.reference_count + 1;
  end if;
  return new;
end;
$function$;

create trigger community_comment_abuse_events_spam_review
after insert on public.community_comment_abuse_events
for each row execute function public.open_or_update_community_comment_spam_case();
create trigger community_comment_mutation_events_spam_reference
after insert on public.community_comment_mutation_events
for each row execute function public.attach_community_comment_spam_reference();
create trigger community_comment_vote_transitions_spam_reference
after insert on public.community_comment_vote_transitions
for each row execute function public.attach_community_comment_spam_reference();

alter function public.mutate_team_inbox_case(text,uuid,uuid,text,text,bigint,bigint,text)
  rename to mutate_team_inbox_case_v1;
alter function public.record_team_inbox_topic_action(text,uuid,bigint,bigint,text,text)
  rename to record_team_inbox_topic_action_v1;
alter function public.solve_team_inbox_case(text,uuid,bigint,bigint,text,text)
  rename to solve_team_inbox_case_v1;

revoke all on function public.mutate_team_inbox_case_v1(text,uuid,uuid,text,text,bigint,bigint,text)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.record_team_inbox_topic_action_v1(text,uuid,bigint,bigint,text,text)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.solve_team_inbox_case_v1(text,uuid,bigint,bigint,text,text)
  from public, anon, authenticated, discord_bot, service_role;

create function public.mutate_team_inbox_case(
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
  v_topic text;
begin
  select topic_key into v_topic from public.team_inbox_cases where id = p_case_id;
  if p_action = 'return' and v_topic in ('comment_reports', 'comment_spam')
    and (p_note is null or char_length(btrim(p_note)) not between 3 and 1000)
  then
    raise exception using errcode = '22023', message = 'TEAM_INBOX_RETURN_NOTE_REQUIRED';
  end if;
  return public.mutate_team_inbox_case_v1(
    p_actor_discord_user_id, p_case_id, p_idempotency_key, p_action,
    p_expected_state, p_expected_row_version, p_expected_work_version, p_note
  );
end;
$function$;

create function public.record_team_inbox_topic_action(
  p_actor_discord_user_id text,
  p_case_id uuid,
  p_expected_row_version bigint,
  p_expected_source_version bigint,
  p_outcome_code text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare v_topic text;
begin
  select topic_key into v_topic from public.team_inbox_cases where id = p_case_id;
  if v_topic in ('comment_reports', 'comment_spam') then
    raise exception using errcode = '42501', message = 'COMMENT_REVIEW_ATOMIC_ACTION_REQUIRED';
  end if;
  return public.record_team_inbox_topic_action_v1(
    p_actor_discord_user_id, p_case_id, p_expected_row_version,
    p_expected_source_version, p_outcome_code, p_note
  );
end;
$function$;

create function public.solve_team_inbox_case(
  p_actor_discord_user_id text,
  p_case_id uuid,
  p_expected_row_version bigint,
  p_expected_source_version bigint,
  p_outcome_code text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare v_topic text;
begin
  select topic_key into v_topic from public.team_inbox_cases where id = p_case_id;
  if v_topic in ('comment_reports', 'comment_spam') then
    raise exception using errcode = '42501', message = 'COMMENT_REVIEW_ATOMIC_SOLVE_REQUIRED';
  end if;
  return public.solve_team_inbox_case_v1(
    p_actor_discord_user_id, p_case_id, p_expected_row_version,
    p_expected_source_version, p_outcome_code, p_note
  );
end;
$function$;

create function public.apply_community_comment_moderation(
  p_actor_discord_user_id text,
  p_public_comment_id uuid,
  p_action text,
  p_expected_object_version bigint,
  p_expected_moderation_version bigint,
  p_internal_reason text,
  p_source_topic text,
  p_source_case_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_comment public.community_comments%rowtype;
  v_role text;
  v_actor_display text;
  v_from_version bigint;
begin
  if p_action not in ('remove', 'restore') or p_public_comment_id is null
    or p_request_id is null
    or char_length(btrim(p_internal_reason)) not between 3 and 1000
    or (p_source_topic is null) <> (p_source_case_id is null)
    or (p_source_topic is not null and p_source_topic not in ('comment_reports', 'comment_spam'))
  then
    raise exception using errcode = '22023', message = 'COMMUNITY_COMMENT_MODERATION_INPUT_INVALID';
  end if;
  v_role := public.assert_community_comment_capabilities(
    p_actor_discord_user_id, array['community.comments.moderate']::text[]
  );
  select * into v_comment from public.community_comments
  where public_comment_id = p_public_comment_id for update;
  if not found or v_comment.author_deleted_at is not null
    or not public.is_community_comment_submission_eligible(v_comment.submission_id)
  then
    return jsonb_build_object('outcome', 'comment_unavailable');
  end if;
  if v_comment.object_version <> p_expected_object_version
    or v_comment.team_moderation_version <> p_expected_moderation_version
  then
    return jsonb_build_object(
      'outcome', 'stale', 'objectVersion', v_comment.object_version,
      'moderationVersion', v_comment.team_moderation_version,
      'removed', v_comment.team_removed_at is not null
    );
  end if;
  if (p_action = 'remove' and v_comment.team_removed_at is not null)
    or (p_action = 'restore' and v_comment.team_removed_at is null)
  then
    return jsonb_build_object('outcome', 'unavailable');
  end if;
  select coalesce(
    nullif(btrim(actor_row.current_discord_username), ''),
    nullif(btrim(actor_row.current_display_name), ''), 'Team member'
  ) into v_actor_display
  from public.user_logs actor_row
  where actor_row.discord_user_id = p_actor_discord_user_id;

  v_from_version := v_comment.object_version;
  update public.community_comments
  set team_removed_at = case when p_action = 'remove'
        then transaction_timestamp() else null end,
      team_moderation_version = team_moderation_version + 1,
      object_version = object_version + 1
  where id = v_comment.id returning * into v_comment;
  update public.community_comment_threads
  set version = version + 1, updated_at = transaction_timestamp()
  where id = v_comment.thread_id;
  insert into public.community_comment_moderation_events(
    comment_id, public_comment_id, submission_id, action,
    from_object_version, to_object_version, moderation_version,
    actor_discord_user_id, actor_display_snapshot, actor_role_snapshot,
    internal_reason, source_topic, source_case_id, request_id
  ) values (
    v_comment.id, v_comment.public_comment_id, v_comment.submission_id, p_action,
    v_from_version, v_comment.object_version, v_comment.team_moderation_version,
    p_actor_discord_user_id, v_actor_display, v_role,
    btrim(p_internal_reason), p_source_topic, p_source_case_id, p_request_id
  );
  return jsonb_build_object(
    'outcome', case when p_action = 'remove' then 'removed' else 'restored' end,
    'publicCommentId', v_comment.public_comment_id,
    'objectVersion', v_comment.object_version,
    'moderationVersion', v_comment.team_moderation_version,
    'comment', public.build_community_comment_public_json(v_comment.id)
  );
end;
$function$;

create function public.moderate_community_comment(
  p_actor_discord_user_id text,
  p_public_comment_id uuid,
  p_action text,
  p_expected_object_version bigint,
  p_expected_moderation_version bigint,
  p_internal_reason text,
  p_request_id uuid,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_existing public.community_comment_review_requests%rowtype;
  v_result jsonb;
begin
  if p_request_id is null or p_request_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'COMMUNITY_COMMENT_MODERATION_INPUT_INVALID';
  end if;
  perform public.assert_community_comment_capabilities(
    p_actor_discord_user_id, array['community.comments.moderate']::text[]
  );
  perform pg_advisory_xact_lock(hashtextextended(
    'community-comment-review-request:' || p_actor_discord_user_id || ':' || p_request_id::text, 0
  ));
  select * into v_existing from public.community_comment_review_requests request
  where request.actor_discord_user_id = p_actor_discord_user_id
    and request.request_id = p_request_id;
  if found then
    if v_existing.request_hash <> p_request_hash or v_existing.operation <> 'moderate_direct' then
      return jsonb_build_object('outcome', 'idempotency_conflict');
    end if;
    return v_existing.result || jsonb_build_object('replayed', true);
  end if;
  v_result := public.apply_community_comment_moderation(
    p_actor_discord_user_id, p_public_comment_id, p_action,
    p_expected_object_version, p_expected_moderation_version,
    p_internal_reason, null, null, p_request_id
  );
  insert into public.community_comment_review_requests(
    actor_discord_user_id, request_id, operation, request_hash, result
  ) values (
    p_actor_discord_user_id, p_request_id, 'moderate_direct', p_request_hash, v_result
  );
  return v_result;
end;
$function$;

create function public.resolve_community_comment_review_case(
  p_actor_discord_user_id text,
  p_topic_key text,
  p_case_id uuid,
  p_action text,
  p_public_comment_id uuid,
  p_expected_row_version bigint,
  p_expected_work_version bigint,
  p_expected_source_version bigint,
  p_expected_domain_version bigint,
  p_expected_object_version bigint,
  p_expected_moderation_version bigint,
  p_internal_reason text,
  p_request_id uuid,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_case public.team_inbox_cases%rowtype;
  v_report_case public.community_comment_report_cases%rowtype;
  v_spam_case public.community_comment_spam_cases%rowtype;
  v_comment public.community_comments%rowtype;
  v_role text;
  v_actor_display text;
  v_existing public.community_comment_review_requests%rowtype;
  v_moderation jsonb;
  v_result jsonb;
  v_next_source_version bigint;
  v_operation text;
  v_domain_outcome text;
begin
  if p_topic_key not in ('comment_reports', 'comment_spam')
    or p_action not in ('no_action', 'remove')
    or p_case_id is null or p_request_id is null
    or p_request_hash !~ '^[0-9a-f]{64}$'
    or char_length(btrim(p_internal_reason)) not between 3 and 1000
    or (p_action = 'remove' and (
      p_public_comment_id is null or p_expected_object_version is null
      or p_expected_moderation_version is null
    ))
  then
    raise exception using errcode = '22023', message = 'COMMENT_REVIEW_RESOLVE_INPUT_INVALID';
  end if;
  v_operation := case when p_topic_key = 'comment_reports'
    then 'resolve_report' else 'resolve_spam' end;
  v_domain_outcome := case when p_action = 'remove' then 'removed' else 'no_action' end;
  v_role := public.assert_team_inbox_topic_access(
    p_actor_discord_user_id, p_topic_key, true
  );
  perform pg_advisory_xact_lock(hashtextextended(
    'community-comment-review-request:' || p_actor_discord_user_id || ':' || p_request_id::text, 0
  ));
  select * into v_existing from public.community_comment_review_requests request
  where request.actor_discord_user_id = p_actor_discord_user_id
    and request.request_id = p_request_id;
  if found then
    if v_existing.request_hash <> p_request_hash or v_existing.operation <> v_operation then
      return jsonb_build_object('outcome', 'idempotency_conflict');
    end if;
    return v_existing.result || jsonb_build_object('replayed', true);
  end if;

  select * into v_case from public.team_inbox_cases where id = p_case_id for update;
  if not found or v_case.topic_key <> p_topic_key then
    v_result := jsonb_build_object('outcome', 'not_found');
  elsif v_case.status <> 'in_progress'
    or v_case.assignee_discord_user_id <> p_actor_discord_user_id
  then
    raise exception using errcode = '42501', message = 'TEAM_INBOX_ASSIGNEE_REQUIRED';
  elsif v_case.row_version <> p_expected_row_version
    or v_case.work_version <> p_expected_work_version
    or v_case.source_version <> p_expected_source_version
  then
    v_result := jsonb_build_object(
      'outcome', 'stale', 'rowVersion', v_case.row_version,
      'workVersion', v_case.work_version, 'sourceVersion', v_case.source_version
    );
  else
    if p_topic_key = 'comment_reports' then
      select * into v_report_case from public.community_comment_report_cases
      where team_inbox_case_id = v_case.id for update;
      if not found or v_report_case.status <> 'open'
        or v_report_case.version <> p_expected_domain_version
      then
        v_result := jsonb_build_object('outcome', 'stale');
      elsif p_action = 'remove' and not exists (
        select 1 from public.community_comments comment_row
        where comment_row.id = v_report_case.comment_id
          and comment_row.public_comment_id = p_public_comment_id
      ) then
        v_result := jsonb_build_object('outcome', 'comment_unavailable');
      else
        v_next_source_version := v_report_case.version + 1;
      end if;
    else
      select * into v_spam_case from public.community_comment_spam_cases
      where team_inbox_case_id = v_case.id for update;
      if not found or v_spam_case.status <> 'open'
        or v_spam_case.version <> p_expected_domain_version
      then
        v_result := jsonb_build_object('outcome', 'stale');
      elsif p_action = 'remove' and not exists (
        select 1
        from public.community_comment_spam_comment_refs reference
        join public.community_comments comment_row on comment_row.id = reference.comment_id
        where reference.case_id = v_spam_case.id
          and comment_row.public_comment_id = p_public_comment_id
          and comment_row.author_discord_user_id = v_spam_case.subject_discord_user_id
      ) then
        v_result := jsonb_build_object('outcome', 'comment_unavailable');
      else
        v_next_source_version := v_spam_case.version + 1;
      end if;
    end if;

    if v_result is null and p_action = 'remove' then
      perform public.assert_community_comment_capabilities(
        p_actor_discord_user_id, array['community.comments.moderate']::text[]
      );
      v_moderation := public.apply_community_comment_moderation(
        p_actor_discord_user_id, p_public_comment_id, 'remove',
        p_expected_object_version, p_expected_moderation_version,
        p_internal_reason, p_topic_key, p_case_id, p_request_id
      );
      if v_moderation ->> 'outcome' <> 'removed' then v_result := v_moderation; end if;
    end if;

    if v_result is null then
      if p_topic_key = 'comment_reports' then
        update public.community_comment_report_cases
        set status = 'solved', version = version + 1,
            solved_at = transaction_timestamp(), last_outcome = v_domain_outcome,
            updated_at = transaction_timestamp()
        where id = v_report_case.id returning * into v_report_case;
        insert into public.community_comment_report_events(
          case_id, event_type, generation, case_version, outcome
        ) values (
          v_report_case.id, 'solved', v_report_case.generation,
          v_report_case.version, v_domain_outcome
        );
      else
        update public.community_comment_spam_cases
        set status = 'solved', version = version + 1,
            solved_at = transaction_timestamp(), last_outcome = v_domain_outcome,
            updated_at = transaction_timestamp()
        where id = v_spam_case.id returning * into v_spam_case;
        insert into public.community_comment_spam_events(
          case_id, event_type, case_version, signal_count, outcome
        ) values (
          v_spam_case.id, 'solved', v_spam_case.version,
          v_spam_case.signal_count, v_domain_outcome
        );
      end if;

      select coalesce(
        nullif(btrim(actor_row.current_discord_username), ''),
        nullif(btrim(actor_row.current_display_name), ''), 'Team member'
      ) into v_actor_display
      from public.user_logs actor_row
      where actor_row.discord_user_id = p_actor_discord_user_id;
      update public.team_inbox_cases
      set status = 'solved', solved_at = transaction_timestamp(),
          source_version = v_next_source_version,
          row_version = row_version + 1, updated_at = transaction_timestamp()
      where id = v_case.id returning * into v_case;
      insert into public.team_inbox_timeline_events(
        case_id, event_type, work_version, row_version,
        actor_discord_user_id, actor_display_snapshot, actor_role_snapshot,
        capability_context, source_version, outcome_code, bounded_note
      ) values (
        v_case.id, 'solved', v_case.work_version, v_case.row_version,
        p_actor_discord_user_id, v_actor_display, v_role,
        jsonb_build_object('topicKey', p_topic_key, 'access', 'action'),
        v_next_source_version, v_domain_outcome, btrim(p_internal_reason)
      );
      v_result := jsonb_build_object(
        'outcome', 'solved', 'status', v_case.status,
        'rowVersion', v_case.row_version, 'workVersion', v_case.work_version,
        'sourceVersion', v_case.source_version, 'decision', p_action,
        'moderation', v_moderation
      );
    end if;
  end if;

  insert into public.community_comment_review_requests(
    actor_discord_user_id, request_id, operation, request_hash, result
  ) values (
    p_actor_discord_user_id, p_request_id, v_operation, p_request_hash, v_result
  );
  return v_result;
end;
$function$;

create function public.get_community_comment_review_case_detail(
  p_actor_discord_user_id text,
  p_case_id uuid,
  p_expected_topic_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_case public.team_inbox_cases%rowtype;
  v_generic jsonb;
  v_domain jsonb;
begin
  if p_expected_topic_key not in ('comment_reports', 'comment_spam') then
    raise exception using errcode = '22023', message = 'COMMENT_REVIEW_TOPIC_INVALID';
  end if;
  select * into v_case from public.team_inbox_cases where id = p_case_id;
  if not found or v_case.topic_key <> p_expected_topic_key then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  perform public.assert_team_inbox_topic_access(
    p_actor_discord_user_id, p_expected_topic_key, false
  );
  v_generic := public.get_team_inbox_case_detail(p_actor_discord_user_id, p_case_id);
  if p_expected_topic_key = 'comment_reports' then
    select jsonb_build_object(
      'kind', 'comment_report',
      'version', report_case.version,
      'generation', report_case.generation,
      'reportCount', report_case.report_count,
      'status', report_case.status,
      'lastOutcome', report_case.last_outcome,
      'comment', public.build_community_comment_public_json(report_case.comment_id),
      'moderationVersion', comment_row.team_moderation_version,
      'reports', coalesce((
        select jsonb_agg(jsonb_build_object(
          'publicReportId', report.public_report_id,
          'category', report.category,
          'explanation', report.explanation,
          'rulesVersion', report.rules_version,
          'createdAt', report.created_at
        ) order by report.created_at desc, report.id desc)
        from public.community_comment_reports report
        where report.case_id = report_case.id
      ), '[]'::jsonb)
    ) into v_domain
    from public.community_comment_report_cases report_case
    join public.community_comments comment_row on comment_row.id = report_case.comment_id
    where report_case.team_inbox_case_id = p_case_id;
  else
    select jsonb_build_object(
      'kind', 'comment_spam',
      'version', spam_case.version,
      'generation', spam_case.generation,
      'signalCount', spam_case.signal_count,
      'status', spam_case.status,
      'lastOutcome', spam_case.last_outcome,
      'relatedComments', coalesce((
        select jsonb_agg(jsonb_build_object(
          'comment', public.build_community_comment_public_json(reference.comment_id),
          'moderationVersion', comment_row.team_moderation_version,
          'referenceCount', reference.reference_count,
          'lastSeenAt', reference.last_seen_at
        ) order by reference.last_seen_at desc, reference.comment_id desc)
        from (
          select * from public.community_comment_spam_comment_refs source_reference
          where source_reference.case_id = spam_case.id
          order by source_reference.last_seen_at desc, source_reference.comment_id desc
          limit 20
        ) reference
        join public.community_comments comment_row on comment_row.id = reference.comment_id
      ), '[]'::jsonb)
    ) into v_domain
    from public.community_comment_spam_cases spam_case
    where spam_case.team_inbox_case_id = p_case_id;
  end if;
  if v_domain is null then return jsonb_build_object('outcome', 'not_found'); end if;
  return jsonb_set(
    v_generic, '{case,sourceVersion}', to_jsonb(v_case.source_version), true
  ) || jsonb_build_object('domain', v_domain);
end;
$function$;

create function public.get_community_comment_moderation_target(
  p_actor_discord_user_id text,
  p_public_comment_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_comment public.community_comments%rowtype;
begin
  perform public.assert_community_comment_capabilities(
    p_actor_discord_user_id, array['community.comments.moderate']::text[]
  );
  select * into v_comment from public.community_comments
  where public_comment_id = p_public_comment_id;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  return jsonb_build_object(
    'outcome', 'found',
    'comment', public.build_community_comment_public_json(v_comment.id),
    'objectVersion', v_comment.object_version,
    'moderationVersion', v_comment.team_moderation_version,
    'removed', v_comment.team_removed_at is not null,
    'authorDeleted', v_comment.author_deleted_at is not null,
    'submissionEligible', public.is_community_comment_submission_eligible(v_comment.submission_id)
  );
end;
$function$;

create function public.get_community_comment_moderation_log(
  p_actor_discord_user_id text,
  p_before_created_at timestamptz default null,
  p_before_id bigint default null,
  p_limit integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare v_items jsonb;
begin
  perform public.assert_community_comment_capabilities(
    p_actor_discord_user_id, array['logs.community_comment_moderation.view']::text[]
  );
  if p_limit not between 1 and 50
    or ((p_before_created_at is null) <> (p_before_id is null))
  then
    raise exception using errcode = '22023', message = 'COMMENT_MODERATION_LOG_INPUT_INVALID';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', item.id,
    'publicCommentId', item.public_comment_id,
    'submissionId', item.submission_id,
    'action', item.action,
    'fromObjectVersion', item.from_object_version,
    'toObjectVersion', item.to_object_version,
    'moderationVersion', item.moderation_version,
    'actorDisplayName', item.actor_display_snapshot,
    'actorRole', item.actor_role_snapshot,
    'sourceTopic', item.source_topic,
    'createdAt', item.created_at
  ) order by item.created_at desc, item.id desc), '[]'::jsonb)
  into v_items
  from (
    select * from public.community_comment_moderation_events event
    where p_before_created_at is null
      or (event.created_at, event.id) < (p_before_created_at, p_before_id)
    order by event.created_at desc, event.id desc
    limit p_limit
  ) item;
  return jsonb_build_object('items', v_items);
end;
$function$;

alter table public.community_comment_report_cases owner to postgres;
alter table public.community_comment_reports owner to postgres;
alter table public.community_comment_report_events owner to postgres;
alter table public.community_comment_report_requests owner to postgres;
alter table public.community_comment_spam_review_policies owner to postgres;
alter table public.community_comment_spam_cases owner to postgres;
alter table public.community_comment_spam_signals owner to postgres;
alter table public.community_comment_spam_comment_refs owner to postgres;
alter table public.community_comment_spam_events owner to postgres;
alter table public.community_comment_review_requests owner to postgres;
alter table public.community_comment_moderation_events owner to postgres;
alter sequence public.community_comment_report_events_id_seq owner to postgres;
alter sequence public.community_comment_spam_signals_id_seq owner to postgres;
alter sequence public.community_comment_spam_events_id_seq owner to postgres;
alter sequence public.community_comment_moderation_events_id_seq owner to postgres;

alter function public.assert_team_inbox_topic_access(text,text,boolean) owner to postgres;
alter function public.assert_community_comment_capabilities(text,text[]) owner to postgres;
alter function public.guard_community_comment_team_moderation() owner to postgres;
alter function public.guard_community_comment_reply_target() owner to postgres;
alter function public.guard_community_comment_vote_target() owner to postgres;
alter function public.get_community_comment_vote_counts_json(uuid) owner to postgres;
alter function public.get_community_comment_vote_score_at(uuid,timestamptz) owner to postgres;
alter function public.get_community_comment_vote_projection(uuid,text) owner to postgres;
alter function public.resolve_community_comment_vote_replay(text,uuid,text) owner to postgres;
alter function public.get_community_comment_vote_viewer_state(uuid,uuid[]) owner to postgres;
alter function public.build_community_comment_public_json(uuid) owner to postgres;
alter function public.submit_community_comment_report(uuid,uuid,text,text,uuid,text,boolean,boolean) owner to postgres;
alter function public.open_or_update_community_comment_spam_case() owner to postgres;
alter function public.attach_community_comment_spam_reference() owner to postgres;
alter function public.mutate_team_inbox_case(text,uuid,uuid,text,text,bigint,bigint,text) owner to postgres;
alter function public.record_team_inbox_topic_action(text,uuid,bigint,bigint,text,text) owner to postgres;
alter function public.solve_team_inbox_case(text,uuid,bigint,bigint,text,text) owner to postgres;
alter function public.apply_community_comment_moderation(text,uuid,text,bigint,bigint,text,text,uuid,uuid) owner to postgres;
alter function public.moderate_community_comment(text,uuid,text,bigint,bigint,text,uuid,text) owner to postgres;
alter function public.resolve_community_comment_review_case(text,text,uuid,text,uuid,bigint,bigint,bigint,bigint,bigint,bigint,text,uuid,text) owner to postgres;
alter function public.get_community_comment_review_case_detail(text,uuid,text) owner to postgres;
alter function public.get_community_comment_moderation_target(text,uuid) owner to postgres;
alter function public.get_community_comment_moderation_log(text,timestamptz,bigint,integer) owner to postgres;

revoke all on function public.assert_team_inbox_topic_access(text,text,boolean)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.assert_community_comment_capabilities(text,text[])
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_community_comment_vote_counts_json(uuid)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_community_comment_vote_score_at(uuid,timestamptz)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_community_comment_vote_projection(uuid,text)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.resolve_community_comment_vote_replay(text,uuid,text)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_community_comment_vote_viewer_state(uuid,uuid[])
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.build_community_comment_public_json(uuid)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.submit_community_comment_report(uuid,uuid,text,text,uuid,text,boolean,boolean)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.open_or_update_community_comment_spam_case()
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.attach_community_comment_spam_reference()
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.mutate_team_inbox_case(text,uuid,uuid,text,text,bigint,bigint,text)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.record_team_inbox_topic_action(text,uuid,bigint,bigint,text,text)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.solve_team_inbox_case(text,uuid,bigint,bigint,text,text)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.apply_community_comment_moderation(text,uuid,text,bigint,bigint,text,text,uuid,uuid)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.moderate_community_comment(text,uuid,text,bigint,bigint,text,uuid,text)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.resolve_community_comment_review_case(text,text,uuid,text,uuid,bigint,bigint,bigint,bigint,bigint,bigint,text,uuid,text)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_community_comment_review_case_detail(text,uuid,text)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_community_comment_moderation_target(text,uuid)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_community_comment_moderation_log(text,timestamptz,bigint,integer)
  from public, anon, authenticated, discord_bot, service_role;

grant execute on function public.get_community_comment_vote_viewer_state(uuid,uuid[])
  to service_role;
grant execute on function public.submit_community_comment_report(uuid,uuid,text,text,uuid,text,boolean,boolean)
  to service_role;
grant execute on function public.mutate_team_inbox_case(text,uuid,uuid,text,text,bigint,bigint,text)
  to service_role;
grant execute on function public.record_team_inbox_topic_action(text,uuid,bigint,bigint,text,text)
  to service_role;
grant execute on function public.solve_team_inbox_case(text,uuid,bigint,bigint,text,text)
  to service_role;
grant execute on function public.moderate_community_comment(text,uuid,text,bigint,bigint,text,uuid,text)
  to service_role;
grant execute on function public.resolve_community_comment_review_case(text,text,uuid,text,uuid,bigint,bigint,bigint,bigint,bigint,bigint,text,uuid,text)
  to service_role;
grant execute on function public.get_community_comment_review_case_detail(text,uuid,text)
  to service_role;
grant execute on function public.get_community_comment_moderation_target(text,uuid)
  to service_role;
grant execute on function public.get_community_comment_moderation_log(text,timestamptz,bigint,integer)
  to service_role;

do $postflight$
declare
  v_table text;
  v_signature text;
begin
  if (select count(*) from public.capability_catalog) <> 49
    or (select count(*) from public.capability_catalog where is_active) <> 45
    or (select count(*) from public.team_inbox_topic_catalog) <> 3
    or exists (
      select 1 from public.team_role_capabilities grant_row
      where grant_row.capability_key = any(array[
        'community.comment_reports.view', 'community.comment_reports.review',
        'community.comments.moderate', 'community.comment_spam.view',
        'community.comment_spam.review', 'logs.community_comment_moderation.view'
      ]::text[])
    )
    or exists (select 1 from public.community_comment_spam_review_policies)
    or (select count(*) from public.team_inbox_topic_catalog
        where topic_key in ('comment_reports', 'comment_spam')
          and is_active and accepts_new_cases) <> 2
  then
    raise exception using errcode = '55000', message = 'COMMENT_REVIEW_POSTFLIGHT_MISMATCH';
  end if;

  foreach v_table in array array[
    'community_comment_report_cases', 'community_comment_reports',
    'community_comment_report_events', 'community_comment_report_requests',
    'community_comment_spam_review_policies', 'community_comment_spam_cases',
    'community_comment_spam_signals', 'community_comment_spam_comment_refs',
    'community_comment_spam_events', 'community_comment_review_requests',
    'community_comment_moderation_events'
  ] loop
    if not exists (
      select 1 from pg_class table_row join pg_namespace namespace on namespace.oid = table_row.relnamespace
      where namespace.nspname = 'public' and table_row.relname = v_table
        and table_row.relrowsecurity
    ) then
      raise exception using errcode = '55000', message = 'COMMENT_REVIEW_RLS_MISMATCH';
    end if;
  end loop;

  foreach v_signature in array array[
    'public.submit_community_comment_report(uuid,uuid,text,text,uuid,text,boolean,boolean)',
    'public.moderate_community_comment(text,uuid,text,bigint,bigint,text,uuid,text)',
    'public.resolve_community_comment_review_case(text,text,uuid,text,uuid,bigint,bigint,bigint,bigint,bigint,bigint,text,uuid,text)',
    'public.get_community_comment_review_case_detail(text,uuid,text)',
    'public.get_community_comment_moderation_target(text,uuid)',
    'public.get_community_comment_moderation_log(text,timestamp with time zone,bigint,integer)'
  ] loop
    if to_regprocedure(v_signature) is null or not exists (
      select 1 from pg_proc function_row
      where function_row.oid = to_regprocedure(v_signature)
        and pg_get_userbyid(function_row.proowner) = 'postgres'
        and function_row.prosecdef
        and function_row.proconfig @> array['search_path=public, pg_temp']
    ) or has_function_privilege('public', v_signature, 'EXECUTE')
      or has_function_privilege('anon', v_signature, 'EXECUTE')
      or has_function_privilege('authenticated', v_signature, 'EXECUTE')
      or has_function_privilege('discord_bot', v_signature, 'EXECUTE')
      or not has_function_privilege('service_role', v_signature, 'EXECUTE')
    then
      raise exception using errcode = '55000', message = 'COMMENT_REVIEW_FUNCTION_ACL_MISMATCH';
    end if;
  end loop;
end;
$postflight$;

comment on function public.submit_community_comment_report(uuid,uuid,text,text,uuid,text,boolean,boolean) is
  'Accepts one immutable, Turnstile-verified Comment Report per authenticated reporter and Comment without exposing reporter identity.';
comment on function public.resolve_community_comment_review_case(text,text,uuid,text,uuid,bigint,bigint,bigint,bigint,bigint,bigint,text,uuid,text) is
  'Atomically solves an assigned Comment Report or Spam Review Case under expected generic, source, domain, and optional Comment versions.';
comment on function public.get_community_comment_moderation_log(text,timestamptz,bigint,integer) is
  'Returns a bounded redacted append-only Comment moderation log under its exact capability.';

commit;
