begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $preflight$
begin
  if to_regclass('public.sessions') is null
    or to_regclass('public.user_logs') is null
    or to_regclass('public.submissions') is null
    or to_regclass('public.voting_cycles') is null
    or to_regclass('public.cycle_results') is null
    or to_regprocedure('public.require_account_session(uuid)') is null
    or to_regclass('public.community_comment_settings') is not null
    or to_regclass('public.community_comment_threads') is not null
    or to_regclass('public.community_comments') is not null
    or to_regprocedure('public.get_community_comment_thread_page(bigint,text,timestamp with time zone,integer,timestamp with time zone,uuid,integer)') is not null
    or to_regprocedure('public.create_community_comment_root(uuid,bigint,bigint,text,jsonb,uuid,text,boolean)') is not null
  then
    raise exception using
      errcode = '55000',
      message = 'COMMUNITY_COMMENT_TEXT_FOUNDATION_BASELINE_MISMATCH';
  end if;

  if not exists (
    select 1
    from pg_attribute
    where attrelid = 'public.user_logs'::regclass
      and attname in (
        'discord_user_id', 'public_profile_id', 'is_banned',
        'current_discord_username', 'current_discord_handle',
        'current_display_name', 'current_guild_nickname'
      )
      and not attisdropped
    group by attrelid
    having count(*) = 7
  ) or not exists (
    select 1
    from pg_attribute
    where attrelid = 'public.submissions'::regclass
      and attname in (
        'id', 'cycle_id', 'discord_user_id',
        'public_visibility_status', 'is_disqualified'
      )
      and not attisdropped
    group by attrelid
    having count(*) = 5
  ) then
    raise exception using
      errcode = '55000',
      message = 'COMMUNITY_COMMENT_TEXT_FOUNDATION_SCHEMA_MISMATCH';
  end if;
end;
$preflight$;

create table public.community_comment_settings (
  singleton boolean primary key default true check (singleton),
  release_state text not null default 'off'
    check (release_state in ('off', 'read_only', 'open')),
  version bigint not null default 1 check (version > 0),
  updated_at timestamptz not null default transaction_timestamp()
);

insert into public.community_comment_settings(singleton, release_state)
values (true, 'off');

create table public.community_comment_threads (
  id uuid primary key default gen_random_uuid(),
  submission_id bigint not null unique
    references public.submissions(id) on delete restrict
    check (submission_id > 0),
  version bigint not null default 0 check (version >= 0),
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  unique (id, submission_id)
);

create table public.community_comments (
  id uuid primary key default gen_random_uuid(),
  public_comment_id uuid not null unique default gen_random_uuid(),
  thread_id uuid not null
    references public.community_comment_threads(id) on delete restrict,
  submission_id bigint not null check (submission_id > 0),
  author_discord_user_id text not null
    references public.user_logs(discord_user_id) on delete restrict,
  root_comment_id uuid,
  reply_target_comment_id uuid,
  current_text_version bigint not null default 1 check (current_text_version > 0),
  object_version bigint not null default 1 check (object_version > 0),
  created_at timestamptz not null default transaction_timestamp(),
  edited_at timestamptz,
  author_deleted_at timestamptz,
  constraint community_comments_structure_check check (
    (root_comment_id is null and reply_target_comment_id is null)
    or (root_comment_id is not null and reply_target_comment_id is not null)
  ),
  constraint community_comments_edit_time_check check (
    edited_at is null or edited_at >= created_at
  ),
  constraint community_comments_delete_time_check check (
    author_deleted_at is null or author_deleted_at >= created_at
  ),
  unique (id, thread_id),
  unique (id, submission_id),
  foreign key (thread_id, submission_id)
    references public.community_comment_threads(id, submission_id)
    on delete restrict,
  foreign key (root_comment_id, thread_id)
    references public.community_comments(id, thread_id)
    on delete restrict,
  foreign key (reply_target_comment_id, thread_id)
    references public.community_comments(id, thread_id)
    on delete restrict
);

create table public.community_comment_text_versions (
  comment_id uuid not null
    references public.community_comments(id) on delete restrict,
  version bigint not null check (version > 0),
  transition text not null check (transition in ('created', 'edited', 'author_deleted')),
  normalized_body text,
  created_at timestamptz not null default transaction_timestamp(),
  primary key (comment_id, version),
  constraint community_comment_text_versions_body_check check (
    (transition in ('created', 'edited') and normalized_body is not null)
    or (transition = 'author_deleted' and normalized_body is null)
  ),
  constraint community_comment_text_versions_size_check check (
    normalized_body is null
    or (
      char_length(normalized_body) between 1 and 10000
      and octet_length(normalized_body) <= 40000
      and normalized_body = normalize(normalized_body, NFC)
      and normalized_body !~ E'[\\x00\\r]'
    )
  )
);

alter table public.community_comments
  add constraint community_comments_current_text_version_fkey
  foreign key (id, current_text_version)
  references public.community_comment_text_versions(comment_id, version)
  deferrable initially deferred;

create table public.community_comment_mention_lifecycle (
  id uuid primary key default gen_random_uuid(),
  comment_id uuid not null
    references public.community_comments(id) on delete restrict,
  target_discord_user_id text not null
    references public.user_logs(discord_user_id) on delete restrict,
  first_text_version bigint not null check (first_text_version > 0),
  first_mentioned_at timestamptz not null default transaction_timestamp(),
  unique (comment_id, target_discord_user_id)
);

create table public.community_comment_mentions (
  comment_id uuid not null
    references public.community_comments(id) on delete restrict,
  target_discord_user_id text not null,
  text_version bigint not null check (text_version > 0),
  start_index integer not null check (start_index >= 0),
  end_index integer not null check (end_index > start_index),
  primary key (comment_id, start_index, end_index),
  foreign key (comment_id, target_discord_user_id)
    references public.community_comment_mention_lifecycle(
      comment_id, target_discord_user_id
    ) on delete restrict,
  foreign key (comment_id, text_version)
    references public.community_comment_text_versions(comment_id, version)
    on delete restrict
);

create table public.community_comment_mutation_events (
  id bigint generated always as identity primary key,
  comment_id uuid not null
    references public.community_comments(id) on delete restrict,
  actor_discord_user_id text not null
    references public.user_logs(discord_user_id) on delete restrict,
  event_type text not null
    check (event_type in ('created', 'edited', 'author_deleted')),
  request_id uuid not null,
  from_object_version bigint check (from_object_version is null or from_object_version > 0),
  to_object_version bigint not null check (to_object_version > 0),
  created_at timestamptz not null default transaction_timestamp(),
  unique (actor_discord_user_id, request_id)
);

create table public.community_comment_mutation_requests (
  session_id uuid not null,
  request_id uuid not null,
  actor_discord_user_id text not null
    references public.user_logs(discord_user_id) on delete restrict,
  operation text not null
    check (operation in ('create_root', 'create_reply', 'edit', 'author_delete')),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  receipt jsonb not null check (jsonb_typeof(receipt) = 'object'),
  created_at timestamptz not null default transaction_timestamp(),
  primary key (actor_discord_user_id, request_id),
  unique (session_id, request_id)
);

create table public.community_comment_abuse_policies (
  action text primary key check (action in ('root', 'reply', 'edit')),
  policy_version bigint not null check (policy_version > 0),
  window_seconds integer not null check (window_seconds between 1 and 86400),
  max_actions integer not null check (max_actions > 0),
  cooldown_seconds integer not null check (cooldown_seconds between 1 and 604800),
  turnstile_after integer not null check (turnstile_after between 0 and max_actions),
  active boolean not null default true,
  updated_at timestamptz not null default transaction_timestamp()
);

create table public.community_comment_abuse_buckets (
  author_discord_user_id text not null
    references public.user_logs(discord_user_id) on delete restrict,
  action text not null check (action in ('root', 'reply', 'edit')),
  window_started_at timestamptz not null,
  action_count integer not null default 0 check (action_count >= 0),
  rejected_count integer not null default 0 check (rejected_count >= 0),
  cooldown_until timestamptz,
  last_content_digest text check (
    last_content_digest is null or last_content_digest ~ '^[0-9a-f]{64}$'
  ),
  last_submission_id bigint check (last_submission_id is null or last_submission_id > 0),
  repeated_content_count integer not null default 0
    check (repeated_content_count >= 0),
  version bigint not null default 1 check (version > 0),
  updated_at timestamptz not null default transaction_timestamp(),
  primary key (author_discord_user_id, action)
);

create table public.community_comment_abuse_events (
  id bigint generated always as identity primary key,
  author_discord_user_id text not null
    references public.user_logs(discord_user_id) on delete restrict,
  action text not null check (action in ('root', 'reply', 'edit')),
  submission_id bigint check (submission_id is null or submission_id > 0),
  outcome text not null check (
    outcome in ('allowed', 'turnstile_required', 'cooldown', 'rejected_input')
  ),
  policy_version bigint not null check (policy_version > 0),
  created_at timestamptz not null default transaction_timestamp()
);

create index community_comments_root_page_idx
  on public.community_comments(submission_id, created_at desc, public_comment_id desc)
  where root_comment_id is null;
create index community_comments_reply_page_idx
  on public.community_comments(root_comment_id, created_at desc, public_comment_id desc)
  where root_comment_id is not null;
create index community_comment_mentions_target_idx
  on public.community_comment_mentions(target_discord_user_id, comment_id);
create index community_comment_mutation_events_comment_idx
  on public.community_comment_mutation_events(comment_id, created_at, id);

alter table public.community_comment_settings enable row level security;
alter table public.community_comment_threads enable row level security;
alter table public.community_comments enable row level security;
alter table public.community_comment_text_versions enable row level security;
alter table public.community_comment_mention_lifecycle enable row level security;
alter table public.community_comment_mentions enable row level security;
alter table public.community_comment_mutation_events enable row level security;
alter table public.community_comment_mutation_requests enable row level security;
alter table public.community_comment_abuse_policies enable row level security;
alter table public.community_comment_abuse_buckets enable row level security;
alter table public.community_comment_abuse_events enable row level security;

revoke all on table public.community_comment_settings,
  public.community_comment_threads,
  public.community_comments,
  public.community_comment_text_versions,
  public.community_comment_mention_lifecycle,
  public.community_comment_mentions,
  public.community_comment_mutation_events,
  public.community_comment_mutation_requests,
  public.community_comment_abuse_policies,
  public.community_comment_abuse_buckets,
  public.community_comment_abuse_events
from public, anon, authenticated, discord_bot, service_role;

revoke all on sequence public.community_comment_mutation_events_id_seq,
  public.community_comment_abuse_events_id_seq
from public, anon, authenticated, discord_bot, service_role;

create function public.protect_community_comment_append_only()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $function$
begin
  raise exception using
    errcode = '55000',
    message = 'COMMUNITY_COMMENT_HISTORY_IS_APPEND_ONLY';
end;
$function$;

create function public.protect_community_comment_identity()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $function$
begin
  if new.id is distinct from old.id
    or new.public_comment_id is distinct from old.public_comment_id
    or new.thread_id is distinct from old.thread_id
    or new.submission_id is distinct from old.submission_id
    or new.author_discord_user_id is distinct from old.author_discord_user_id
    or new.root_comment_id is distinct from old.root_comment_id
    or new.reply_target_comment_id is distinct from old.reply_target_comment_id
    or new.created_at is distinct from old.created_at
    or old.author_deleted_at is not null and new.author_deleted_at is null
  then
    raise exception using
      errcode = '55000',
      message = 'COMMUNITY_COMMENT_IDENTITY_IS_IMMUTABLE';
  end if;
  return new;
end;
$function$;

create trigger community_comments_identity_guard
before update on public.community_comments
for each row execute function public.protect_community_comment_identity();

create trigger community_comment_text_versions_no_update
before update on public.community_comment_text_versions
for each row execute function public.protect_community_comment_append_only();
create trigger community_comment_text_versions_no_delete
before delete on public.community_comment_text_versions
for each row execute function public.protect_community_comment_append_only();
create trigger community_comment_mention_lifecycle_no_update
before update on public.community_comment_mention_lifecycle
for each row execute function public.protect_community_comment_append_only();
create trigger community_comment_mention_lifecycle_no_delete
before delete on public.community_comment_mention_lifecycle
for each row execute function public.protect_community_comment_append_only();
create trigger community_comment_mutation_events_no_update
before update on public.community_comment_mutation_events
for each row execute function public.protect_community_comment_append_only();
create trigger community_comment_mutation_events_no_delete
before delete on public.community_comment_mutation_events
for each row execute function public.protect_community_comment_append_only();
create trigger community_comment_mutation_requests_no_update
before update on public.community_comment_mutation_requests
for each row execute function public.protect_community_comment_append_only();
create trigger community_comment_mutation_requests_no_delete
before delete on public.community_comment_mutation_requests
for each row execute function public.protect_community_comment_append_only();
create trigger community_comment_abuse_events_no_update
before update on public.community_comment_abuse_events
for each row execute function public.protect_community_comment_append_only();
create trigger community_comment_abuse_events_no_delete
before delete on public.community_comment_abuse_events
for each row execute function public.protect_community_comment_append_only();

create function public.get_community_comment_release_state()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select coalesce(
    (
      select setting.release_state
      from public.community_comment_settings setting
      where setting.singleton
    ),
    'off'
  );
$function$;

create function public.is_community_comment_submission_eligible(
  p_submission_id bigint
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select exists (
    select 1
    from public.submissions submission
    join public.voting_cycles cycle
      on cycle.id = submission.cycle_id
    join public.cycle_results result
      on result.submission_id = submission.id
     and result.cycle_id = submission.cycle_id
    where submission.id = p_submission_id
      and submission.public_visibility_status = 'visible'
      and coalesce(submission.is_disqualified, false) = false
      and cycle.status = 'finished'
      and cycle.public_number is not null
      and cycle.finalized_at is not null
      and result.finalized_at is not null
      and result.rank_in_cycle is not null
  );
$function$;

create function public.validate_community_comment_body(
  p_body text
)
returns void
language plpgsql
immutable
set search_path = public, pg_temp
as $function$
declare
  v_link text;
begin
  if p_body is null
    or p_body = ''
    or p_body <> btrim(p_body)
    or p_body <> normalize(p_body, NFC)
    or char_length(p_body) > 10000
    or octet_length(p_body) > 40000
    or position(E'\r' in p_body) > 0
    or replace(p_body, E'\n', '') ~ '[[:cntrl:]]'
    or p_body ~ E'\n{4,}'
    or p_body ~* '(^|[^[:alnum:]_])(data|javascript|mailto):'
  then
    raise exception using
      errcode = '22023',
      message = 'COMMUNITY_COMMENT_TEXT_INVALID';
  end if;

  for v_link in
    select matched[1]
    from regexp_matches(
      p_body,
      '((https?://|ftp://|www\.)[^[:space:]<>()]+|([[:alnum:]][[:alnum:]-]*\.)+[[:alpha:]]{2,63}(/[^[:space:]<>()]*)?)',
      'gi'
    ) matched
  loop
    if v_link !~ '^https://cancerculture\.fun/(spread/[0-9]+|cycle-history|wall/(fame|shame)|profile/[0-9a-fA-F-]{36})([?#][^[:space:]<>()]*)?$' then
      raise exception using
        errcode = '22023',
        message = 'COMMUNITY_COMMENT_EXTERNAL_LINK_REJECTED';
    end if;
  end loop;
end;
$function$;

create function public.replace_community_comment_mentions(
  p_comment_id uuid,
  p_text_version bigint,
  p_body text,
  p_mentions jsonb,
  p_now timestamptz
)
returns void
language plpgsql
set search_path = public, pg_temp
as $function$
declare
  v_item jsonb;
  v_target_profile_id uuid;
  v_target_discord_user_id text;
  v_start integer;
  v_end integer;
  v_previous_end integer := 0;
  v_remaining text := '';
begin
  if p_mentions is null
    or jsonb_typeof(p_mentions) <> 'array'
    or jsonb_array_length(p_mentions) > 100
  then
    raise exception using
      errcode = '22023',
      message = 'COMMUNITY_COMMENT_MENTIONS_INVALID';
  end if;

  for v_item in
    select item
    from jsonb_array_elements(p_mentions) item
    order by case
      when item->>'startIndex' ~ '^[0-9]+$' then (item->>'startIndex')::integer
      else -1
    end
  loop
    if jsonb_typeof(v_item) <> 'object'
      or (select count(*) from jsonb_object_keys(v_item)) <> 3
      or not (v_item ? 'targetPublicProfileId')
      or not (v_item ? 'startIndex')
      or not (v_item ? 'endIndex')
      or v_item->>'startIndex' !~ '^[0-9]+$'
      or v_item->>'endIndex' !~ '^[0-9]+$'
    then
      raise exception using
        errcode = '22023',
        message = 'COMMUNITY_COMMENT_MENTIONS_INVALID';
    end if;

    begin
      v_target_profile_id := (v_item->>'targetPublicProfileId')::uuid;
    exception when invalid_text_representation then
      raise exception using
        errcode = '22023',
        message = 'COMMUNITY_COMMENT_MENTIONS_INVALID';
    end;

    v_start := (v_item->>'startIndex')::integer;
    v_end := (v_item->>'endIndex')::integer;

    if v_start < v_previous_end
      or v_end <= v_start
      or v_end > char_length(p_body)
      or substring(p_body from v_start + 1 for 1) <> '@'
    then
      raise exception using
        errcode = '22023',
        message = 'COMMUNITY_COMMENT_MENTIONS_INVALID';
    end if;

    select user_log.discord_user_id
    into v_target_discord_user_id
    from public.user_logs user_log
    where user_log.public_profile_id = v_target_profile_id;

    if not found then
      raise exception using
        errcode = '22023',
        message = 'COMMUNITY_COMMENT_MENTION_TARGET_INVALID';
    end if;

    v_remaining := v_remaining || substring(
      p_body from v_previous_end + 1 for v_start - v_previous_end
    );
    v_previous_end := v_end;
  end loop;

  v_remaining := v_remaining || substring(p_body from v_previous_end + 1);
  if btrim(v_remaining) = '' then
    raise exception using
      errcode = '22023',
      message = 'COMMUNITY_COMMENT_MENTION_ONLY_REJECTED';
  end if;

  delete from public.community_comment_mentions
  where comment_id = p_comment_id;

  for v_item in
    select item
    from jsonb_array_elements(p_mentions) item
    order by (item->>'startIndex')::integer
  loop
    v_target_profile_id := (v_item->>'targetPublicProfileId')::uuid;
    v_start := (v_item->>'startIndex')::integer;
    v_end := (v_item->>'endIndex')::integer;

    select user_log.discord_user_id
    into strict v_target_discord_user_id
    from public.user_logs user_log
    where user_log.public_profile_id = v_target_profile_id;

    insert into public.community_comment_mention_lifecycle (
      comment_id,
      target_discord_user_id,
      first_text_version,
      first_mentioned_at
    ) values (
      p_comment_id,
      v_target_discord_user_id,
      p_text_version,
      p_now
    ) on conflict (comment_id, target_discord_user_id) do nothing;

    insert into public.community_comment_mentions (
      comment_id,
      target_discord_user_id,
      text_version,
      start_index,
      end_index
    ) values (
      p_comment_id,
      v_target_discord_user_id,
      p_text_version,
      v_start,
      v_end
    );
  end loop;
end;
$function$;

create function public.apply_community_comment_abuse_budget(
  p_author_discord_user_id text,
  p_action text,
  p_submission_id bigint,
  p_content_digest text,
  p_turnstile_verified boolean,
  p_now timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_policy public.community_comment_abuse_policies%rowtype;
  v_bucket public.community_comment_abuse_buckets%rowtype;
  v_count integer;
  v_repeat integer;
  v_retry_after integer;
begin
  if p_action not in ('root', 'reply', 'edit')
    or p_submission_id is null
    or p_submission_id <= 0
    or p_content_digest is null
    or p_content_digest !~ '^[0-9a-f]{64}$'
    or p_turnstile_verified is null
  then
    raise exception using
      errcode = '22023',
      message = 'COMMUNITY_COMMENT_ABUSE_INPUT_INVALID';
  end if;

  select * into v_policy
  from public.community_comment_abuse_policies policy
  where policy.action = p_action
    and policy.active;

  if not found then
    return jsonb_build_object('outcome', 'abuse_configuration_unavailable');
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'community-comment-abuse:' || p_author_discord_user_id || ':' || p_action,
      0
    )
  );

  select * into v_bucket
  from public.community_comment_abuse_buckets bucket
  where bucket.author_discord_user_id = p_author_discord_user_id
    and bucket.action = p_action
  for update;

  if not found then
    insert into public.community_comment_abuse_buckets (
      author_discord_user_id,
      action,
      window_started_at,
      action_count,
      rejected_count,
      last_content_digest,
      last_submission_id,
      repeated_content_count,
      updated_at
    ) values (
      p_author_discord_user_id,
      p_action,
      p_now,
      0,
      0,
      null,
      null,
      0,
      p_now
    ) returning * into v_bucket;
  end if;

  if v_bucket.cooldown_until is not null
    and v_bucket.cooldown_until > p_now
  then
    v_retry_after := greatest(
      1,
      ceil(extract(epoch from (v_bucket.cooldown_until - p_now)))::integer
    );
    insert into public.community_comment_abuse_events (
      author_discord_user_id, action, submission_id, outcome, policy_version, created_at
    ) values (
      p_author_discord_user_id, p_action, p_submission_id,
      'cooldown', v_policy.policy_version, p_now
    );
    return jsonb_build_object('outcome', 'cooldown', 'retryAfter', v_retry_after);
  end if;

  if v_bucket.window_started_at
    + make_interval(secs => v_policy.window_seconds) <= p_now
  then
    v_bucket.window_started_at := p_now;
    v_bucket.action_count := 0;
    v_bucket.rejected_count := 0;
    v_bucket.cooldown_until := null;
  end if;

  v_count := v_bucket.action_count + 1;
  v_repeat := case
    when v_bucket.last_content_digest = p_content_digest
      and v_bucket.last_submission_id is distinct from p_submission_id
      then v_bucket.repeated_content_count + 1
    else 0
  end;

  if v_count > v_policy.max_actions then
    update public.community_comment_abuse_buckets
    set action_count = v_count,
        cooldown_until = p_now + make_interval(secs => v_policy.cooldown_seconds),
        last_content_digest = p_content_digest,
        last_submission_id = p_submission_id,
        repeated_content_count = v_repeat,
        version = version + 1,
        updated_at = p_now
    where author_discord_user_id = p_author_discord_user_id
      and action = p_action;

    insert into public.community_comment_abuse_events (
      author_discord_user_id, action, submission_id, outcome, policy_version, created_at
    ) values (
      p_author_discord_user_id, p_action, p_submission_id,
      'cooldown', v_policy.policy_version, p_now
    );
    return jsonb_build_object(
      'outcome', 'cooldown', 'retryAfter', v_policy.cooldown_seconds
    );
  end if;

  if v_count > v_policy.turnstile_after and not p_turnstile_verified then
    update public.community_comment_abuse_buckets
    set action_count = v_count,
        rejected_count = rejected_count + 1,
        last_content_digest = p_content_digest,
        last_submission_id = p_submission_id,
        repeated_content_count = v_repeat,
        version = version + 1,
        updated_at = p_now
    where author_discord_user_id = p_author_discord_user_id
      and action = p_action;

    insert into public.community_comment_abuse_events (
      author_discord_user_id, action, submission_id, outcome, policy_version, created_at
    ) values (
      p_author_discord_user_id, p_action, p_submission_id,
      'turnstile_required', v_policy.policy_version, p_now
    );
    return jsonb_build_object('outcome', 'turnstile_required');
  end if;

  update public.community_comment_abuse_buckets
  set action_count = v_count,
      last_content_digest = p_content_digest,
      last_submission_id = p_submission_id,
      repeated_content_count = v_repeat,
      version = version + 1,
      updated_at = p_now
  where author_discord_user_id = p_author_discord_user_id
    and action = p_action;

  insert into public.community_comment_abuse_events (
    author_discord_user_id, action, submission_id, outcome, policy_version, created_at
  ) values (
    p_author_discord_user_id, p_action, p_submission_id,
    'allowed', v_policy.policy_version, p_now
  );

  return jsonb_build_object('outcome', 'allowed');
end;
$function$;

create function public.mark_community_comment_rejected_input(
  p_author_discord_user_id text,
  p_action text,
  p_submission_id bigint,
  p_now timestamptz
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_policy_version bigint;
begin
  select policy.policy_version into v_policy_version
  from public.community_comment_abuse_policies policy
  where policy.action = p_action and policy.active;

  if not found then
    return;
  end if;

  update public.community_comment_abuse_buckets
  set rejected_count = rejected_count + 1,
      version = version + 1,
      updated_at = p_now
  where author_discord_user_id = p_author_discord_user_id
    and action = p_action;

  insert into public.community_comment_abuse_events (
    author_discord_user_id, action, submission_id, outcome, policy_version, created_at
  ) values (
    p_author_discord_user_id, p_action, p_submission_id,
    'rejected_input', v_policy_version, p_now
  );
end;
$function$;

create function public.build_community_comment_public_json(
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
      else null
    end,
    'body', case
      when comment_row.author_deleted_at is not null then null
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
      when comment_row.author_deleted_at is not null then '[]'::jsonb
      else coalesce(
        (
          select jsonb_agg(
            jsonb_build_object(
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
            ) order by mention.start_index, mention.end_index
          )
          from public.community_comment_mentions mention
          join public.user_logs target_user
            on target_user.discord_user_id = mention.target_discord_user_id
          where mention.comment_id = comment_row.id
            and mention.text_version = comment_row.current_text_version
            and target_user.public_profile_id is not null
        ),
        '[]'::jsonb
      )
    end,
    'replyCount', case
      when comment_row.root_comment_id is null then (
        select count(*)::integer
        from public.community_comments reply
        where reply.root_comment_id = comment_row.id
      )
      else 0
    end
  )
  from public.community_comments comment_row
  join public.community_comment_text_versions text_version
    on text_version.comment_id = comment_row.id
   and text_version.version = comment_row.current_text_version
  join public.user_logs author_row
    on author_row.discord_user_id = comment_row.author_discord_user_id
  join public.submissions submission
    on submission.id = comment_row.submission_id
  left join public.community_comments root_row
    on root_row.id = comment_row.root_comment_id
  left join public.community_comments target_row
    on target_row.id = comment_row.reply_target_comment_id
  where comment_row.id = p_comment_id
    and author_row.public_profile_id is not null;
$function$;

create function public.get_community_comment_thread_page(
  p_submission_id bigint,
  p_sort text,
  p_snapshot_at timestamptz,
  p_after_score integer,
  p_after_created_at timestamptz,
  p_after_public_comment_id uuid,
  p_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_now timestamptz := transaction_timestamp();
  v_snapshot_at timestamptz := coalesce(p_snapshot_at, transaction_timestamp());
  v_thread public.community_comment_threads%rowtype;
  v_ids uuid[];
  v_page_ids uuid[];
  v_items jsonb := '[]'::jsonb;
  v_has_more boolean := false;
  v_last public.community_comments%rowtype;
begin
  if p_submission_id is null or p_submission_id <= 0
    or p_sort not in ('top', 'newest')
    or p_limit is null or p_limit not between 1 and 20
    or v_snapshot_at > v_now
    or (
      (p_after_created_at is null) <> (p_after_public_comment_id is null)
    )
    or (
      p_sort = 'top'
      and (p_after_created_at is null) <> (p_after_score is null)
    )
    or (p_sort = 'newest' and p_after_score is not null)
  then
    raise exception using
      errcode = '22023',
      message = 'COMMUNITY_COMMENT_PAGE_INPUT_INVALID';
  end if;

  if public.get_community_comment_release_state() = 'off' then
    return jsonb_build_object('outcome', 'feature_off');
  end if;

  if not public.is_community_comment_submission_eligible(p_submission_id) then
    return jsonb_build_object('outcome', 'submission_unavailable');
  end if;

  select * into v_thread
  from public.community_comment_threads thread
  where thread.submission_id = p_submission_id;

  if not found then
    return jsonb_build_object(
      'outcome', 'ok',
      'submissionId', p_submission_id,
      'sort', p_sort,
      'snapshotAt', v_snapshot_at,
      'threadVersion', 0,
      'items', '[]'::jsonb,
      'hasMore', false,
      'nextTuple', null
    );
  end if;

  with candidates as (
    select comment_row.id,
      comment_row.created_at,
      comment_row.public_comment_id,
      0::integer as net_score
    from public.community_comments comment_row
    where comment_row.thread_id = v_thread.id
      and comment_row.root_comment_id is null
      and comment_row.created_at <= v_snapshot_at
      and (
        p_after_created_at is null
        or (
          p_sort = 'top'
          and (
            0 < p_after_score
            or (0 = p_after_score and comment_row.created_at < p_after_created_at)
            or (
              0 = p_after_score
              and comment_row.created_at = p_after_created_at
              and comment_row.public_comment_id < p_after_public_comment_id
            )
          )
        )
        or (
          p_sort = 'newest'
          and (
            comment_row.created_at < p_after_created_at
            or (
              comment_row.created_at = p_after_created_at
              and comment_row.public_comment_id < p_after_public_comment_id
            )
          )
        )
      )
    order by
      case when p_sort = 'top' then net_score end desc,
      comment_row.created_at desc,
      comment_row.public_comment_id desc
    limit p_limit + 1
  )
  select array_agg(
    candidate.id order by
      case when p_sort = 'top' then candidate.net_score end desc,
      candidate.created_at desc,
      candidate.public_comment_id desc
  )
  into v_ids
  from candidates candidate;

  v_has_more := coalesce(cardinality(v_ids), 0) > p_limit;
  v_page_ids := case
    when v_ids is null then array[]::uuid[]
    else v_ids[1:least(cardinality(v_ids), p_limit)]
  end;

  select coalesce(
    jsonb_agg(
      public.build_community_comment_public_json(root_comment.id)
      || jsonb_build_object(
        'replyPreview', coalesce(
          (
            select jsonb_agg(
              public.build_community_comment_public_json(preview.id)
              order by preview.created_at, preview.public_comment_id
            )
            from (
              select reply.id, reply.created_at, reply.public_comment_id
              from public.community_comments reply
              where reply.root_comment_id = root_comment.id
                and reply.created_at <= v_snapshot_at
              order by reply.created_at desc, reply.public_comment_id desc
              limit 3
            ) preview
          ),
          '[]'::jsonb
        ),
        'replyPreviewHasMore', (
          select count(*) > 3
          from public.community_comments reply
          where reply.root_comment_id = root_comment.id
            and reply.created_at <= v_snapshot_at
        )
      )
      order by array_position(v_page_ids, root_comment.id)
    ),
    '[]'::jsonb
  ) into v_items
  from public.community_comments root_comment
  where root_comment.id = any(v_page_ids);

  if cardinality(v_page_ids) > 0 then
    select * into v_last
    from public.community_comments comment_row
    where comment_row.id = v_page_ids[cardinality(v_page_ids)];
  end if;

  return jsonb_build_object(
    'outcome', 'ok',
    'submissionId', p_submission_id,
    'sort', p_sort,
    'snapshotAt', v_snapshot_at,
    'threadVersion', v_thread.version,
    'items', v_items,
    'hasMore', v_has_more,
    'nextTuple', case
      when v_has_more and v_last.id is not null then jsonb_build_object(
        'netScore', case when p_sort = 'top' then 0 else null end,
        'createdAt', v_last.created_at,
        'publicCommentId', v_last.public_comment_id
      )
      else null
    end
  );
end;
$function$;

create function public.get_community_comment_deep_link(
  p_public_comment_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_target public.community_comments%rowtype;
  v_root public.community_comments%rowtype;
  v_reply_ids uuid[] := array[]::uuid[];
  v_replies jsonb := '[]'::jsonb;
begin
  if p_public_comment_id is null then
    raise exception using
      errcode = '22023',
      message = 'COMMUNITY_COMMENT_DEEP_LINK_INPUT_INVALID';
  end if;

  if public.get_community_comment_release_state() = 'off' then
    return jsonb_build_object('outcome', 'feature_off');
  end if;

  select * into v_target
  from public.community_comments comment_row
  where comment_row.public_comment_id = p_public_comment_id;

  if not found
    or not public.is_community_comment_submission_eligible(v_target.submission_id)
  then
    return jsonb_build_object('outcome', 'comment_unavailable');
  end if;

  if v_target.root_comment_id is null then
    v_root := v_target;
    select coalesce(
      array_agg(reply.id order by reply.created_at, reply.public_comment_id),
      array[]::uuid[]
    ) into v_reply_ids
    from (
      select comment_row.id, comment_row.created_at, comment_row.public_comment_id
      from public.community_comments comment_row
      where comment_row.root_comment_id = v_root.id
      order by comment_row.created_at desc, comment_row.public_comment_id desc
      limit 3
    ) reply;
  else
    select * into strict v_root
    from public.community_comments comment_row
    where comment_row.id = v_target.root_comment_id;

    select coalesce(
      array_agg(window_row.id order by window_row.created_at, window_row.public_comment_id),
      array[]::uuid[]
    ) into v_reply_ids
    from (
      (
        select comment_row.id, comment_row.created_at, comment_row.public_comment_id
        from public.community_comments comment_row
        where comment_row.root_comment_id = v_root.id
          and (
            comment_row.created_at < v_target.created_at
            or (
              comment_row.created_at = v_target.created_at
              and comment_row.public_comment_id < v_target.public_comment_id
            )
          )
        order by comment_row.created_at desc, comment_row.public_comment_id desc
        limit 10
      )
      union all
      select v_target.id, v_target.created_at, v_target.public_comment_id
      union all
      (
        select comment_row.id, comment_row.created_at, comment_row.public_comment_id
        from public.community_comments comment_row
        where comment_row.root_comment_id = v_root.id
          and (
            comment_row.created_at > v_target.created_at
            or (
              comment_row.created_at = v_target.created_at
              and comment_row.public_comment_id > v_target.public_comment_id
            )
          )
        order by comment_row.created_at, comment_row.public_comment_id
        limit 9
      )
    ) window_row;
  end if;

  select coalesce(
    jsonb_agg(
      public.build_community_comment_public_json(reply.id)
      order by reply.created_at, reply.public_comment_id
    ),
    '[]'::jsonb
  ) into v_replies
  from public.community_comments reply
  where reply.id = any(v_reply_ids);

  return jsonb_build_object(
    'outcome', 'ok',
    'submissionId', v_root.submission_id,
    'targetPublicCommentId', v_target.public_comment_id,
    'root', public.build_community_comment_public_json(v_root.id),
    'replies', v_replies,
    'branchOpen', v_root.author_deleted_at is null,
    'windowLimit', 20
  );
end;
$function$;

create function public.get_community_comments_batch(
  p_public_comment_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_items jsonb;
begin
  if p_public_comment_ids is null
    or cardinality(p_public_comment_ids) > 100
    or exists (
      select 1 from unnest(p_public_comment_ids) value where value is null
    )
  then
    raise exception using
      errcode = '22023',
      message = 'COMMUNITY_COMMENT_BATCH_INPUT_INVALID';
  end if;

  if public.get_community_comment_release_state() = 'off' then
    return jsonb_build_object('outcome', 'feature_off');
  end if;

  select coalesce(
    jsonb_agg(
      public.build_community_comment_public_json(comment_row.id)
      order by requested.ordinality
    ),
    '[]'::jsonb
  ) into v_items
  from unnest(p_public_comment_ids) with ordinality requested(public_id, ordinality)
  join public.community_comments comment_row
    on comment_row.public_comment_id = requested.public_id
  where public.is_community_comment_submission_eligible(comment_row.submission_id);

  return jsonb_build_object('outcome', 'ok', 'items', v_items);
end;
$function$;

create function public.search_community_comment_mention_targets(
  p_session_id uuid,
  p_query text,
  p_limit integer
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
  if p_query is null
    or p_query <> btrim(p_query)
    or char_length(p_query) not between 2 and 64
    or p_limit is null
    or p_limit not between 1 and 20
  then
    raise exception using
      errcode = '22023',
      message = 'COMMUNITY_COMMENT_MENTION_SEARCH_INPUT_INVALID';
  end if;

  if public.get_community_comment_release_state() <> 'open' then
    return jsonb_build_object('outcome', 'feature_not_open');
  end if;

  v_actor := public.require_account_session(p_session_id);

  with targets as (
    select
      user_log.public_profile_id,
      coalesce(
        nullif(btrim(user_log.current_guild_nickname), ''),
        nullif(btrim(user_log.current_display_name), ''),
        nullif(btrim(user_log.current_discord_handle), ''),
        nullif(btrim(user_log.current_discord_username), ''),
        'CancerCulture member'
      ) as display_name,
      user_log.is_banned
    from public.user_logs user_log
    where user_log.public_profile_id is not null
  ), matches as (
    select *
    from targets target
    where position(lower(p_query) in lower(target.display_name)) > 0
    order by
      case when lower(target.display_name) like lower(p_query) || '%' then 0 else 1 end,
      lower(target.display_name),
      target.public_profile_id
    limit p_limit
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'publicProfileId', match.public_profile_id,
        'displayName', match.display_name,
        'isBanned', match.is_banned
      ) order by
        case when lower(match.display_name) like lower(p_query) || '%' then 0 else 1 end,
        lower(match.display_name),
        match.public_profile_id
    ),
    '[]'::jsonb
  ) into v_items
  from matches match;

  return jsonb_build_object('outcome', 'ok', 'items', v_items);
end;
$function$;

create function public.resolve_community_comment_replay(
  p_actor_discord_user_id text,
  p_request_id uuid,
  p_operation text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_request public.community_comment_mutation_requests%rowtype;
begin
  select * into v_request
  from public.community_comment_mutation_requests request
  where request.actor_discord_user_id = p_actor_discord_user_id
    and request.request_id = p_request_id;

  if not found then
    return null;
  end if;

  if v_request.operation <> p_operation
    or v_request.request_hash <> p_request_hash
  then
    return jsonb_build_object('outcome', 'idempotency_conflict');
  end if;

  return v_request.receipt || jsonb_build_object('replayed', true);
end;
$function$;

create function public.create_community_comment_root(
  p_session_id uuid,
  p_submission_id bigint,
  p_expected_thread_version bigint,
  p_normalized_body text,
  p_mentions jsonb,
  p_request_id uuid,
  p_content_digest text,
  p_turnstile_verified boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_now timestamptz := transaction_timestamp();
  v_actor text;
  v_thread public.community_comment_threads%rowtype;
  v_comment public.community_comments%rowtype;
  v_hash text;
  v_replay jsonb;
  v_abuse jsonb;
  v_receipt jsonb;
begin
  if p_session_id is null
    or p_submission_id is null or p_submission_id <= 0
    or p_expected_thread_version is null or p_expected_thread_version < 0
    or p_request_id is null
    or p_mentions is null
  then
    raise exception using
      errcode = '22023',
      message = 'COMMUNITY_COMMENT_ROOT_INPUT_INVALID';
  end if;

  if public.get_community_comment_release_state() = 'off' then
    return jsonb_build_object('outcome', 'feature_off');
  elsif public.get_community_comment_release_state() <> 'open' then
    return jsonb_build_object('outcome', 'read_only');
  end if;

  v_actor := public.require_account_session(p_session_id);
  if not exists (
    select 1 from public.user_logs user_log
    where user_log.discord_user_id = v_actor
      and user_log.public_profile_id is not null
  ) then
    return jsonb_build_object('outcome', 'author_profile_unavailable');
  end if;

  v_hash := encode(
    digest(
      convert_to(
        jsonb_build_object(
          'operation', 'create_root',
          'submissionId', p_submission_id,
          'expectedThreadVersion', p_expected_thread_version,
          'body', p_normalized_body,
          'mentions', p_mentions
        )::text,
        'utf8'
      ),
      'sha256'
    ),
    'hex'
  );

  perform pg_advisory_xact_lock(
    hashtextextended(
      'community-comment-request:' || v_actor || ':' || p_request_id::text,
      0
    )
  );
  v_replay := public.resolve_community_comment_replay(
    v_actor, p_request_id, 'create_root', v_hash
  );
  if v_replay is not null then
    return v_replay;
  end if;

  if not public.is_community_comment_submission_eligible(p_submission_id) then
    return jsonb_build_object('outcome', 'submission_unavailable');
  end if;

  insert into public.community_comment_threads(submission_id)
  values (p_submission_id)
  on conflict (submission_id) do nothing;

  select * into strict v_thread
  from public.community_comment_threads thread
  where thread.submission_id = p_submission_id
  for update;

  if v_thread.version <> p_expected_thread_version then
    return jsonb_build_object(
      'outcome', 'stale_thread',
      'threadVersion', v_thread.version
    );
  end if;

  v_abuse := public.apply_community_comment_abuse_budget(
    v_actor,
    'root',
    p_submission_id,
    p_content_digest,
    p_turnstile_verified,
    v_now
  );
  if v_abuse->>'outcome' <> 'allowed' then
    return v_abuse;
  end if;

  begin
    perform public.validate_community_comment_body(p_normalized_body);

    insert into public.community_comments (
      thread_id,
      submission_id,
      author_discord_user_id,
      created_at
    ) values (
      v_thread.id,
      p_submission_id,
      v_actor,
      v_now
    ) returning * into v_comment;

    insert into public.community_comment_text_versions (
      comment_id, version, transition, normalized_body, created_at
    ) values (
      v_comment.id, 1, 'created', p_normalized_body, v_now
    );

    perform public.replace_community_comment_mentions(
      v_comment.id, 1, p_normalized_body, p_mentions, v_now
    );

    update public.community_comment_threads
    set version = version + 1, updated_at = v_now
    where id = v_thread.id
    returning * into v_thread;

    insert into public.community_comment_mutation_events (
      comment_id, actor_discord_user_id, event_type, request_id,
      from_object_version, to_object_version, created_at
    ) values (
      v_comment.id, v_actor, 'created', p_request_id,
      null, 1, v_now
    );

    v_receipt := jsonb_build_object(
      'outcome', 'created',
      'replayed', false,
      'threadVersion', v_thread.version,
      'comment', public.build_community_comment_public_json(v_comment.id)
    );

    insert into public.community_comment_mutation_requests (
      session_id, request_id, actor_discord_user_id,
      operation, request_hash, receipt, created_at
    ) values (
      p_session_id, p_request_id, v_actor,
      'create_root', v_hash, v_receipt, v_now
    );
  exception when sqlstate '22023' then
    perform public.mark_community_comment_rejected_input(
      v_actor, 'root', p_submission_id, v_now
    );
    return jsonb_build_object('outcome', 'text_or_mentions_invalid');
  end;

  return v_receipt;
end;
$function$;

create function public.create_community_comment_reply(
  p_session_id uuid,
  p_root_public_comment_id uuid,
  p_target_public_comment_id uuid,
  p_expected_root_version bigint,
  p_expected_target_version bigint,
  p_normalized_body text,
  p_mentions jsonb,
  p_request_id uuid,
  p_content_digest text,
  p_turnstile_verified boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_now timestamptz := transaction_timestamp();
  v_actor text;
  v_root public.community_comments%rowtype;
  v_target public.community_comments%rowtype;
  v_thread public.community_comment_threads%rowtype;
  v_comment public.community_comments%rowtype;
  v_hash text;
  v_replay jsonb;
  v_abuse jsonb;
  v_receipt jsonb;
begin
  if p_session_id is null
    or p_root_public_comment_id is null
    or p_target_public_comment_id is null
    or p_expected_root_version is null or p_expected_root_version <= 0
    or p_expected_target_version is null or p_expected_target_version <= 0
    or p_request_id is null
    or p_mentions is null
  then
    raise exception using
      errcode = '22023',
      message = 'COMMUNITY_COMMENT_REPLY_INPUT_INVALID';
  end if;

  if public.get_community_comment_release_state() = 'off' then
    return jsonb_build_object('outcome', 'feature_off');
  elsif public.get_community_comment_release_state() <> 'open' then
    return jsonb_build_object('outcome', 'read_only');
  end if;

  v_actor := public.require_account_session(p_session_id);
  if not exists (
    select 1 from public.user_logs user_log
    where user_log.discord_user_id = v_actor
      and user_log.public_profile_id is not null
  ) then
    return jsonb_build_object('outcome', 'author_profile_unavailable');
  end if;

  v_hash := encode(
    digest(
      convert_to(
        jsonb_build_object(
          'operation', 'create_reply',
          'rootPublicCommentId', p_root_public_comment_id,
          'targetPublicCommentId', p_target_public_comment_id,
          'expectedRootVersion', p_expected_root_version,
          'expectedTargetVersion', p_expected_target_version,
          'body', p_normalized_body,
          'mentions', p_mentions
        )::text,
        'utf8'
      ),
      'sha256'
    ),
    'hex'
  );

  perform pg_advisory_xact_lock(
    hashtextextended(
      'community-comment-request:' || v_actor || ':' || p_request_id::text,
      0
    )
  );
  v_replay := public.resolve_community_comment_replay(
    v_actor, p_request_id, 'create_reply', v_hash
  );
  if v_replay is not null then
    return v_replay;
  end if;

  select * into v_root
  from public.community_comments comment_row
  where comment_row.public_comment_id = p_root_public_comment_id
    and comment_row.root_comment_id is null;
  if not found then
    return jsonb_build_object('outcome', 'root_unavailable');
  end if;

  select * into v_target
  from public.community_comments comment_row
  where comment_row.public_comment_id = p_target_public_comment_id;
  if not found then
    return jsonb_build_object('outcome', 'target_unavailable');
  end if;

  perform 1
  from public.community_comments comment_row
  where comment_row.id = any(array[v_root.id, v_target.id])
  order by comment_row.id
  for update;

  select * into strict v_root
  from public.community_comments comment_row
  where comment_row.id = v_root.id;
  select * into strict v_target
  from public.community_comments comment_row
  where comment_row.id = v_target.id;

  if v_target.thread_id <> v_root.thread_id
    or v_target.submission_id <> v_root.submission_id
    or (
      v_target.id <> v_root.id
      and v_target.root_comment_id is distinct from v_root.id
    )
  then
    return jsonb_build_object('outcome', 'target_unavailable');
  end if;

  if not public.is_community_comment_submission_eligible(v_root.submission_id) then
    return jsonb_build_object('outcome', 'submission_unavailable');
  end if;

  if v_root.author_deleted_at is not null then
    return jsonb_build_object('outcome', 'branch_closed');
  end if;
  if v_target.author_deleted_at is not null then
    return jsonb_build_object('outcome', 'target_unavailable');
  end if;
  if v_root.object_version <> p_expected_root_version
    or v_target.object_version <> p_expected_target_version
  then
    return jsonb_build_object(
      'outcome', 'stale_comment',
      'rootVersion', v_root.object_version,
      'targetVersion', v_target.object_version
    );
  end if;

  select * into strict v_thread
  from public.community_comment_threads thread
  where thread.id = v_root.thread_id
  for update;

  v_abuse := public.apply_community_comment_abuse_budget(
    v_actor,
    'reply',
    v_root.submission_id,
    p_content_digest,
    p_turnstile_verified,
    v_now
  );
  if v_abuse->>'outcome' <> 'allowed' then
    return v_abuse;
  end if;

  begin
    perform public.validate_community_comment_body(p_normalized_body);

    insert into public.community_comments (
      thread_id,
      submission_id,
      author_discord_user_id,
      root_comment_id,
      reply_target_comment_id,
      created_at
    ) values (
      v_root.thread_id,
      v_root.submission_id,
      v_actor,
      v_root.id,
      v_target.id,
      v_now
    ) returning * into v_comment;

    insert into public.community_comment_text_versions (
      comment_id, version, transition, normalized_body, created_at
    ) values (
      v_comment.id, 1, 'created', p_normalized_body, v_now
    );

    perform public.replace_community_comment_mentions(
      v_comment.id, 1, p_normalized_body, p_mentions, v_now
    );

    update public.community_comment_threads
    set version = version + 1, updated_at = v_now
    where id = v_thread.id
    returning * into v_thread;

    insert into public.community_comment_mutation_events (
      comment_id, actor_discord_user_id, event_type, request_id,
      from_object_version, to_object_version, created_at
    ) values (
      v_comment.id, v_actor, 'created', p_request_id,
      null, 1, v_now
    );

    v_receipt := jsonb_build_object(
      'outcome', 'created',
      'replayed', false,
      'threadVersion', v_thread.version,
      'rootVersion', v_root.object_version,
      'comment', public.build_community_comment_public_json(v_comment.id)
    );

    insert into public.community_comment_mutation_requests (
      session_id, request_id, actor_discord_user_id,
      operation, request_hash, receipt, created_at
    ) values (
      p_session_id, p_request_id, v_actor,
      'create_reply', v_hash, v_receipt, v_now
    );
  exception when sqlstate '22023' then
    perform public.mark_community_comment_rejected_input(
      v_actor, 'reply', v_root.submission_id, v_now
    );
    return jsonb_build_object('outcome', 'text_or_mentions_invalid');
  end;

  return v_receipt;
end;
$function$;

create function public.edit_community_comment(
  p_session_id uuid,
  p_public_comment_id uuid,
  p_expected_version bigint,
  p_normalized_body text,
  p_mentions jsonb,
  p_request_id uuid,
  p_content_digest text,
  p_turnstile_verified boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_now timestamptz := transaction_timestamp();
  v_actor text;
  v_comment public.community_comments%rowtype;
  v_thread public.community_comment_threads%rowtype;
  v_hash text;
  v_replay jsonb;
  v_abuse jsonb;
  v_receipt jsonb;
  v_next_text_version bigint;
begin
  if p_session_id is null
    or p_public_comment_id is null
    or p_expected_version is null or p_expected_version <= 0
    or p_request_id is null
    or p_mentions is null
  then
    raise exception using
      errcode = '22023',
      message = 'COMMUNITY_COMMENT_EDIT_INPUT_INVALID';
  end if;

  if public.get_community_comment_release_state() = 'off' then
    return jsonb_build_object('outcome', 'feature_off');
  elsif public.get_community_comment_release_state() <> 'open' then
    return jsonb_build_object('outcome', 'read_only');
  end if;

  v_actor := public.require_account_session(p_session_id);
  v_hash := encode(
    digest(
      convert_to(
        jsonb_build_object(
          'operation', 'edit',
          'publicCommentId', p_public_comment_id,
          'expectedVersion', p_expected_version,
          'body', p_normalized_body,
          'mentions', p_mentions
        )::text,
        'utf8'
      ),
      'sha256'
    ),
    'hex'
  );

  perform pg_advisory_xact_lock(
    hashtextextended(
      'community-comment-request:' || v_actor || ':' || p_request_id::text,
      0
    )
  );
  v_replay := public.resolve_community_comment_replay(
    v_actor, p_request_id, 'edit', v_hash
  );
  if v_replay is not null then
    return v_replay;
  end if;

  select * into v_comment
  from public.community_comments comment_row
  where comment_row.public_comment_id = p_public_comment_id
  for update;

  if not found
    or v_comment.author_discord_user_id <> v_actor
    or not public.is_community_comment_submission_eligible(v_comment.submission_id)
  then
    return jsonb_build_object('outcome', 'comment_unavailable');
  end if;

  if v_comment.author_deleted_at is not null then
    return jsonb_build_object('outcome', 'author_deleted');
  end if;
  if v_comment.object_version <> p_expected_version then
    return jsonb_build_object(
      'outcome', 'stale_comment',
      'version', v_comment.object_version
    );
  end if;
  if v_now > v_comment.created_at + interval '15 minutes' then
    return jsonb_build_object('outcome', 'edit_window_closed');
  end if;

  select * into strict v_thread
  from public.community_comment_threads thread
  where thread.id = v_comment.thread_id
  for update;

  v_abuse := public.apply_community_comment_abuse_budget(
    v_actor,
    'edit',
    v_comment.submission_id,
    p_content_digest,
    p_turnstile_verified,
    v_now
  );
  if v_abuse->>'outcome' <> 'allowed' then
    return v_abuse;
  end if;

  begin
    perform public.validate_community_comment_body(p_normalized_body);
    v_next_text_version := v_comment.current_text_version + 1;

    insert into public.community_comment_text_versions (
      comment_id, version, transition, normalized_body, created_at
    ) values (
      v_comment.id, v_next_text_version, 'edited', p_normalized_body, v_now
    );

    perform public.replace_community_comment_mentions(
      v_comment.id,
      v_next_text_version,
      p_normalized_body,
      p_mentions,
      v_now
    );

    update public.community_comments
    set current_text_version = v_next_text_version,
        object_version = object_version + 1,
        edited_at = v_now
    where id = v_comment.id
    returning * into v_comment;

    update public.community_comment_threads
    set version = version + 1, updated_at = v_now
    where id = v_thread.id
    returning * into v_thread;

    insert into public.community_comment_mutation_events (
      comment_id, actor_discord_user_id, event_type, request_id,
      from_object_version, to_object_version, created_at
    ) values (
      v_comment.id, v_actor, 'edited', p_request_id,
      p_expected_version, v_comment.object_version, v_now
    );

    v_receipt := jsonb_build_object(
      'outcome', 'edited',
      'replayed', false,
      'threadVersion', v_thread.version,
      'comment', public.build_community_comment_public_json(v_comment.id)
    );

    insert into public.community_comment_mutation_requests (
      session_id, request_id, actor_discord_user_id,
      operation, request_hash, receipt, created_at
    ) values (
      p_session_id, p_request_id, v_actor,
      'edit', v_hash, v_receipt, v_now
    );
  exception when sqlstate '22023' then
    perform public.mark_community_comment_rejected_input(
      v_actor, 'edit', v_comment.submission_id, v_now
    );
    return jsonb_build_object('outcome', 'text_or_mentions_invalid');
  end;

  return v_receipt;
end;
$function$;

create function public.delete_community_comment(
  p_session_id uuid,
  p_public_comment_id uuid,
  p_expected_version bigint,
  p_request_id uuid,
  p_confirmed boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_now timestamptz := transaction_timestamp();
  v_actor text;
  v_comment public.community_comments%rowtype;
  v_thread public.community_comment_threads%rowtype;
  v_hash text;
  v_replay jsonb;
  v_receipt jsonb;
  v_next_text_version bigint;
begin
  if p_session_id is null
    or p_public_comment_id is null
    or p_expected_version is null or p_expected_version <= 0
    or p_request_id is null
    or p_confirmed is distinct from true
  then
    raise exception using
      errcode = '22023',
      message = 'COMMUNITY_COMMENT_DELETE_INPUT_INVALID';
  end if;

  if public.get_community_comment_release_state() = 'off' then
    return jsonb_build_object('outcome', 'feature_off');
  elsif public.get_community_comment_release_state() <> 'open' then
    return jsonb_build_object('outcome', 'read_only');
  end if;

  v_actor := public.require_account_session(p_session_id);
  v_hash := encode(
    digest(
      convert_to(
        jsonb_build_object(
          'operation', 'author_delete',
          'publicCommentId', p_public_comment_id,
          'expectedVersion', p_expected_version,
          'confirmed', true
        )::text,
        'utf8'
      ),
      'sha256'
    ),
    'hex'
  );

  perform pg_advisory_xact_lock(
    hashtextextended(
      'community-comment-request:' || v_actor || ':' || p_request_id::text,
      0
    )
  );
  v_replay := public.resolve_community_comment_replay(
    v_actor, p_request_id, 'author_delete', v_hash
  );
  if v_replay is not null then
    return v_replay;
  end if;

  select * into v_comment
  from public.community_comments comment_row
  where comment_row.public_comment_id = p_public_comment_id
  for update;

  if not found
    or v_comment.author_discord_user_id <> v_actor
    or not public.is_community_comment_submission_eligible(v_comment.submission_id)
  then
    return jsonb_build_object('outcome', 'comment_unavailable');
  end if;

  if v_comment.object_version <> p_expected_version then
    return jsonb_build_object(
      'outcome', 'stale_comment',
      'version', v_comment.object_version
    );
  end if;
  if v_comment.author_deleted_at is not null then
    return jsonb_build_object('outcome', 'author_deleted');
  end if;

  select * into strict v_thread
  from public.community_comment_threads thread
  where thread.id = v_comment.thread_id
  for update;

  v_next_text_version := v_comment.current_text_version + 1;
  insert into public.community_comment_text_versions (
    comment_id, version, transition, normalized_body, created_at
  ) values (
    v_comment.id, v_next_text_version, 'author_deleted', null, v_now
  );

  delete from public.community_comment_mentions
  where comment_id = v_comment.id;

  update public.community_comments
  set current_text_version = v_next_text_version,
      object_version = object_version + 1,
      author_deleted_at = v_now
  where id = v_comment.id
  returning * into v_comment;

  update public.community_comment_threads
  set version = version + 1, updated_at = v_now
  where id = v_thread.id
  returning * into v_thread;

  insert into public.community_comment_mutation_events (
    comment_id, actor_discord_user_id, event_type, request_id,
    from_object_version, to_object_version, created_at
  ) values (
    v_comment.id, v_actor, 'author_deleted', p_request_id,
    p_expected_version, v_comment.object_version, v_now
  );

  v_receipt := jsonb_build_object(
    'outcome', 'author_deleted',
    'replayed', false,
    'threadVersion', v_thread.version,
    'branchClosed', v_comment.root_comment_id is null,
    'comment', public.build_community_comment_public_json(v_comment.id)
  );

  insert into public.community_comment_mutation_requests (
    session_id, request_id, actor_discord_user_id,
    operation, request_hash, receipt, created_at
  ) values (
    p_session_id, p_request_id, v_actor,
    'author_delete', v_hash, v_receipt, v_now
  );

  return v_receipt;
end;
$function$;

create function public.get_community_comment_replies(
  p_root_public_comment_id uuid,
  p_snapshot_at timestamptz,
  p_before_created_at timestamptz,
  p_before_public_comment_id uuid,
  p_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_now timestamptz := transaction_timestamp();
  v_snapshot_at timestamptz := coalesce(p_snapshot_at, transaction_timestamp());
  v_root public.community_comments%rowtype;
  v_ids uuid[];
  v_page_ids uuid[];
  v_items jsonb := '[]'::jsonb;
  v_has_more boolean := false;
  v_earliest public.community_comments%rowtype;
begin
  if p_root_public_comment_id is null
    or p_limit is null or p_limit not between 1 and 20
    or v_snapshot_at > v_now
    or ((p_before_created_at is null) <> (p_before_public_comment_id is null))
  then
    raise exception using
      errcode = '22023',
      message = 'COMMUNITY_COMMENT_REPLY_PAGE_INPUT_INVALID';
  end if;

  if public.get_community_comment_release_state() = 'off' then
    return jsonb_build_object('outcome', 'feature_off');
  end if;

  select * into v_root
  from public.community_comments comment_row
  where comment_row.public_comment_id = p_root_public_comment_id
    and comment_row.root_comment_id is null;

  if not found
    or not public.is_community_comment_submission_eligible(v_root.submission_id)
  then
    return jsonb_build_object('outcome', 'comment_unavailable');
  end if;

  select array_agg(reply.id order by reply.created_at desc, reply.public_comment_id desc)
  into v_ids
  from (
    select comment_row.id, comment_row.created_at, comment_row.public_comment_id
    from public.community_comments comment_row
    where comment_row.root_comment_id = v_root.id
      and comment_row.created_at <= v_snapshot_at
      and (
        p_before_created_at is null
        or comment_row.created_at < p_before_created_at
        or (
          comment_row.created_at = p_before_created_at
          and comment_row.public_comment_id < p_before_public_comment_id
        )
      )
    order by comment_row.created_at desc, comment_row.public_comment_id desc
    limit p_limit + 1
  ) reply;

  v_has_more := coalesce(cardinality(v_ids), 0) > p_limit;
  v_page_ids := case
    when v_ids is null then array[]::uuid[]
    else v_ids[1:least(cardinality(v_ids), p_limit)]
  end;

  select coalesce(
    jsonb_agg(
      public.build_community_comment_public_json(reply.id)
      order by reply.created_at, reply.public_comment_id
    ),
    '[]'::jsonb
  ) into v_items
  from public.community_comments reply
  where reply.id = any(v_page_ids);

  if cardinality(v_page_ids) > 0 then
    select * into v_earliest
    from public.community_comments reply
    where reply.id = v_page_ids[cardinality(v_page_ids)];
  end if;

  return jsonb_build_object(
    'outcome', 'ok',
    'submissionId', v_root.submission_id,
    'rootPublicCommentId', v_root.public_comment_id,
    'rootVersion', v_root.object_version,
    'branchOpen', v_root.author_deleted_at is null,
    'snapshotAt', v_snapshot_at,
    'items', v_items,
    'hasMore', v_has_more,
    'nextTuple', case
      when v_has_more and v_earliest.id is not null then jsonb_build_object(
        'createdAt', v_earliest.created_at,
        'publicCommentId', v_earliest.public_comment_id
      )
      else null
    end
  );
end;
$function$;

alter table public.community_comment_settings owner to postgres;
alter table public.community_comment_threads owner to postgres;
alter table public.community_comments owner to postgres;
alter table public.community_comment_text_versions owner to postgres;
alter table public.community_comment_mention_lifecycle owner to postgres;
alter table public.community_comment_mentions owner to postgres;
alter table public.community_comment_mutation_events owner to postgres;
alter table public.community_comment_mutation_requests owner to postgres;
alter table public.community_comment_abuse_policies owner to postgres;
alter table public.community_comment_abuse_buckets owner to postgres;
alter table public.community_comment_abuse_events owner to postgres;
alter sequence public.community_comment_mutation_events_id_seq owner to postgres;
alter sequence public.community_comment_abuse_events_id_seq owner to postgres;

alter function public.protect_community_comment_append_only() owner to postgres;
alter function public.protect_community_comment_identity() owner to postgres;
alter function public.get_community_comment_release_state() owner to postgres;
alter function public.is_community_comment_submission_eligible(bigint) owner to postgres;
alter function public.validate_community_comment_body(text) owner to postgres;
alter function public.replace_community_comment_mentions(uuid,bigint,text,jsonb,timestamp with time zone) owner to postgres;
alter function public.apply_community_comment_abuse_budget(text,text,bigint,text,boolean,timestamp with time zone) owner to postgres;
alter function public.mark_community_comment_rejected_input(text,text,bigint,timestamp with time zone) owner to postgres;
alter function public.build_community_comment_public_json(uuid) owner to postgres;
alter function public.get_community_comment_thread_page(bigint,text,timestamp with time zone,integer,timestamp with time zone,uuid,integer) owner to postgres;
alter function public.get_community_comment_replies(uuid,timestamp with time zone,timestamp with time zone,uuid,integer) owner to postgres;
alter function public.get_community_comment_deep_link(uuid) owner to postgres;
alter function public.get_community_comments_batch(uuid[]) owner to postgres;
alter function public.search_community_comment_mention_targets(uuid,text,integer) owner to postgres;
alter function public.resolve_community_comment_replay(text,uuid,text,text) owner to postgres;
alter function public.create_community_comment_root(uuid,bigint,bigint,text,jsonb,uuid,text,boolean) owner to postgres;
alter function public.create_community_comment_reply(uuid,uuid,uuid,bigint,bigint,text,jsonb,uuid,text,boolean) owner to postgres;
alter function public.edit_community_comment(uuid,uuid,bigint,text,jsonb,uuid,text,boolean) owner to postgres;
alter function public.delete_community_comment(uuid,uuid,bigint,uuid,boolean) owner to postgres;

revoke all on function public.protect_community_comment_append_only()
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.protect_community_comment_identity()
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_community_comment_release_state()
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.is_community_comment_submission_eligible(bigint)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.validate_community_comment_body(text)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.replace_community_comment_mentions(uuid,bigint,text,jsonb,timestamp with time zone)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.apply_community_comment_abuse_budget(text,text,bigint,text,boolean,timestamp with time zone)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.mark_community_comment_rejected_input(text,text,bigint,timestamp with time zone)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.build_community_comment_public_json(uuid)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_community_comment_thread_page(bigint,text,timestamp with time zone,integer,timestamp with time zone,uuid,integer)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_community_comment_replies(uuid,timestamp with time zone,timestamp with time zone,uuid,integer)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_community_comment_deep_link(uuid)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_community_comments_batch(uuid[])
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.search_community_comment_mention_targets(uuid,text,integer)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.resolve_community_comment_replay(text,uuid,text,text)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.create_community_comment_root(uuid,bigint,bigint,text,jsonb,uuid,text,boolean)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.create_community_comment_reply(uuid,uuid,uuid,bigint,bigint,text,jsonb,uuid,text,boolean)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.edit_community_comment(uuid,uuid,bigint,text,jsonb,uuid,text,boolean)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.delete_community_comment(uuid,uuid,bigint,uuid,boolean)
  from public, anon, authenticated, discord_bot, service_role;

grant execute on function public.get_community_comment_thread_page(bigint,text,timestamp with time zone,integer,timestamp with time zone,uuid,integer)
  to service_role;
grant execute on function public.get_community_comment_replies(uuid,timestamp with time zone,timestamp with time zone,uuid,integer)
  to service_role;
grant execute on function public.get_community_comment_deep_link(uuid)
  to service_role;
grant execute on function public.get_community_comments_batch(uuid[])
  to service_role;
grant execute on function public.search_community_comment_mention_targets(uuid,text,integer)
  to service_role;
grant execute on function public.create_community_comment_root(uuid,bigint,bigint,text,jsonb,uuid,text,boolean)
  to service_role;
grant execute on function public.create_community_comment_reply(uuid,uuid,uuid,bigint,bigint,text,jsonb,uuid,text,boolean)
  to service_role;
grant execute on function public.edit_community_comment(uuid,uuid,bigint,text,jsonb,uuid,text,boolean)
  to service_role;
grant execute on function public.delete_community_comment(uuid,uuid,bigint,uuid,boolean)
  to service_role;

do $security_postflight$
declare
  v_signature text;
  v_table text;
  v_service_signatures text[] := array[
    'public.get_community_comment_thread_page(bigint,text,timestamp with time zone,integer,timestamp with time zone,uuid,integer)',
    'public.get_community_comment_replies(uuid,timestamp with time zone,timestamp with time zone,uuid,integer)',
    'public.get_community_comment_deep_link(uuid)',
    'public.get_community_comments_batch(uuid[])',
    'public.search_community_comment_mention_targets(uuid,text,integer)',
    'public.create_community_comment_root(uuid,bigint,bigint,text,jsonb,uuid,text,boolean)',
    'public.create_community_comment_reply(uuid,uuid,uuid,bigint,bigint,text,jsonb,uuid,text,boolean)',
    'public.edit_community_comment(uuid,uuid,bigint,text,jsonb,uuid,text,boolean)',
    'public.delete_community_comment(uuid,uuid,bigint,uuid,boolean)'
  ];
  v_internal_definer_signatures text[] := array[
    'public.get_community_comment_release_state()',
    'public.is_community_comment_submission_eligible(bigint)',
    'public.apply_community_comment_abuse_budget(text,text,bigint,text,boolean,timestamp with time zone)',
    'public.mark_community_comment_rejected_input(text,text,bigint,timestamp with time zone)',
    'public.build_community_comment_public_json(uuid)',
    'public.resolve_community_comment_replay(text,uuid,text,text)'
  ];
  v_internal_invoker_signatures text[] := array[
    'public.protect_community_comment_append_only()',
    'public.protect_community_comment_identity()',
    'public.validate_community_comment_body(text)',
    'public.replace_community_comment_mentions(uuid,bigint,text,jsonb,timestamp with time zone)'
  ];
  v_tables text[] := array[
    'community_comment_settings',
    'community_comment_threads',
    'community_comments',
    'community_comment_text_versions',
    'community_comment_mention_lifecycle',
    'community_comment_mentions',
    'community_comment_mutation_events',
    'community_comment_mutation_requests',
    'community_comment_abuse_policies',
    'community_comment_abuse_buckets',
    'community_comment_abuse_events'
  ];
begin
  foreach v_signature in array v_service_signatures loop
    if to_regprocedure(v_signature) is null
      or not exists (
        select 1 from pg_proc function_row
        where function_row.oid = to_regprocedure(v_signature)
          and pg_get_userbyid(function_row.proowner) = 'postgres'
          and function_row.prosecdef
          and function_row.proconfig @> array['search_path=public, pg_temp']
      )
      or has_function_privilege('anon', v_signature, 'EXECUTE')
      or has_function_privilege('authenticated', v_signature, 'EXECUTE')
      or has_function_privilege('discord_bot', v_signature, 'EXECUTE')
      or not has_function_privilege('service_role', v_signature, 'EXECUTE')
    then
      raise exception using
        errcode = '55000',
        message = 'COMMUNITY_COMMENT_SERVICE_FUNCTION_SECURITY_MISMATCH',
        detail = v_signature;
    end if;
  end loop;

  foreach v_signature in array v_internal_definer_signatures loop
    if to_regprocedure(v_signature) is null
      or not exists (
        select 1 from pg_proc function_row
        where function_row.oid = to_regprocedure(v_signature)
          and pg_get_userbyid(function_row.proowner) = 'postgres'
          and function_row.prosecdef
          and function_row.proconfig @> array['search_path=public, pg_temp']
      )
      or has_function_privilege('anon', v_signature, 'EXECUTE')
      or has_function_privilege('authenticated', v_signature, 'EXECUTE')
      or has_function_privilege('discord_bot', v_signature, 'EXECUTE')
      or has_function_privilege('service_role', v_signature, 'EXECUTE')
    then
      raise exception using
        errcode = '55000',
        message = 'COMMUNITY_COMMENT_INTERNAL_FUNCTION_SECURITY_MISMATCH',
        detail = v_signature;
    end if;
  end loop;

  foreach v_signature in array v_internal_invoker_signatures loop
    if to_regprocedure(v_signature) is null
      or not exists (
        select 1 from pg_proc function_row
        where function_row.oid = to_regprocedure(v_signature)
          and pg_get_userbyid(function_row.proowner) = 'postgres'
          and not function_row.prosecdef
          and function_row.proconfig @> array['search_path=public, pg_temp']
      )
      or has_function_privilege('anon', v_signature, 'EXECUTE')
      or has_function_privilege('authenticated', v_signature, 'EXECUTE')
      or has_function_privilege('discord_bot', v_signature, 'EXECUTE')
      or has_function_privilege('service_role', v_signature, 'EXECUTE')
    then
      raise exception using
        errcode = '55000',
        message = 'COMMUNITY_COMMENT_INVOKER_FUNCTION_SECURITY_MISMATCH',
        detail = v_signature;
    end if;
  end loop;

  if exists (
    select 1
    from pg_proc function_row
    join pg_namespace namespace on namespace.oid = function_row.pronamespace
    where namespace.nspname = 'public'
      and function_row.proname like '%community_comment%'
      and function_row.oid <> all(
        (
          v_service_signatures
          || v_internal_definer_signatures
          || v_internal_invoker_signatures
        )::regprocedure[]
      )
  ) then
    raise exception using
      errcode = '55000',
      message = 'COMMUNITY_COMMENT_FUNCTION_OVERLOAD_MISMATCH';
  end if;

  foreach v_table in array v_tables loop
    if not exists (
      select 1 from pg_class table_row
      where table_row.oid = format('public.%I', v_table)::regclass
        and table_row.relrowsecurity
        and pg_get_userbyid(table_row.relowner) = 'postgres'
    )
      or exists (
        select 1 from pg_policy policy
        where policy.polrelid = format('public.%I', v_table)::regclass
      )
      or has_table_privilege('anon', format('public.%I', v_table), 'SELECT')
      or has_table_privilege('authenticated', format('public.%I', v_table), 'SELECT')
      or has_table_privilege('discord_bot', format('public.%I', v_table), 'SELECT')
      or has_table_privilege('service_role', format('public.%I', v_table), 'SELECT')
      or has_table_privilege('service_role', format('public.%I', v_table), 'INSERT')
      or has_table_privilege('service_role', format('public.%I', v_table), 'UPDATE')
      or has_table_privilege('service_role', format('public.%I', v_table), 'DELETE')
    then
      raise exception using
        errcode = '55000',
        message = 'COMMUNITY_COMMENT_TABLE_SECURITY_MISMATCH',
        detail = v_table;
    end if;
  end loop;

  if (select release_state from public.community_comment_settings where singleton) <> 'off'
    or exists (select 1 from public.community_comment_abuse_policies)
    or has_sequence_privilege(
      'service_role', 'public.community_comment_mutation_events_id_seq', 'USAGE'
    )
    or has_sequence_privilege(
      'service_role', 'public.community_comment_abuse_events_id_seq', 'USAGE'
    )
  then
    raise exception using
      errcode = '55000',
      message = 'COMMUNITY_COMMENT_FAIL_CLOSED_BASELINE_MISMATCH';
  end if;
end;
$security_postflight$;

comment on table public.community_comment_settings is
  'Server-authoritative global Comment release state. The additive foundation starts off and has no public activation path.';
comment on table public.community_comment_text_versions is
  'Protected append-only normalized plain-text versions; prior bodies never enter public or ordinary-author projections.';
comment on table public.community_comment_mention_lifecycle is
  'Immutable per-Comment/per-target Mention lifecycle facts for later exact-once producers. Current assignments remain separate.';
comment on table public.community_comment_abuse_policies is
  'Protected versioned action budgets. The public migration intentionally installs no threshold rows.';
comment on function public.is_community_comment_submission_eligible(bigint) is
  'Requires canonical finished/public/non-DQ Submission state and intentionally admits finalized zero-vote Submissions without Feed eligibility.';
comment on function public.create_community_comment_root(uuid,bigint,bigint,text,jsonb,uuid,text,boolean) is
  'Atomically creates one text Root through current Website-session, release-state, eligibility, expected-version, idempotency and private abuse boundaries.';
comment on function public.create_community_comment_reply(uuid,uuid,uuid,bigint,bigint,text,jsonb,uuid,text,boolean) is
  'Atomically creates one Reply in the locked canonical Root branch; Discord membership and Participation Hold are not prerequisites.';
comment on function public.delete_community_comment(uuid,uuid,bigint,uuid,boolean) is
  'Creates an irreversible confirmed author tombstone and closes a deleted Root branch without deleting Replies or protected history.';

commit;
