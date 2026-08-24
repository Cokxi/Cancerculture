begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $preflight$
begin
  if (select release_state from public.community_comment_settings where singleton) <> 'off'
    or (select version from public.community_comment_settings where singleton) <> 1
    or exists (select 1 from public.community_comment_abuse_policies)
    or exists (select 1 from public.community_comment_abuse_buckets)
    or exists (select 1 from public.community_comment_abuse_events)
    or exists (select 1 from public.community_comment_spam_review_policies)
    or exists (select 1 from public.community_comment_threads)
    or exists (select 1 from public.community_comments)
    or exists (select 1 from public.community_comment_reports)
    or exists (select 1 from public.community_comment_spam_cases)
    or exists (select 1 from public.community_comment_moderation_events)
    or to_regclass('public.community_comment_abuse_policy_states') is not null
    or to_regclass('public.community_comment_spam_policy_state') is not null
    or to_regclass('public.community_comment_policy_requests') is not null
    or to_regclass('public.community_comment_policy_events') is not null
    or to_regclass('public.community_comment_release_state_events') is not null
    or to_regprocedure('public.get_community_comment_policy_management(uuid)') is not null
    or to_regprocedure('public.manage_community_comment_release_state(uuid,text,bigint,uuid)') is not null
    or to_regprocedure('public.manage_community_comment_abuse_policy(uuid,text,bigint,boolean,integer,integer,integer,integer,uuid)') is not null
    or to_regprocedure('public.manage_community_comment_spam_policy(uuid,bigint,boolean,integer,integer,bigint,jsonb,uuid)') is not null
    or to_regprocedure('public.submit_community_comment_report(uuid,uuid,text,text,uuid,text,boolean,boolean)') is null
    or (select count(*) from public.capability_catalog) <> 49
    or (select count(*) from public.capability_catalog where is_active) <> 45
    or exists (
      select 1 from public.team_role_capabilities grant_row
      where grant_row.capability_key = any(array[
        'community.comment_reports.view', 'community.comment_reports.review',
        'community.comments.moderate', 'community.comment_spam.view',
        'community.comment_spam.review', 'logs.community_comment_moderation.view'
      ]::text[])
    )
  then
    raise exception using
      errcode = '55000',
      message = 'COMMENT_ABUSE_POLICY_MANAGEMENT_BASELINE_MISMATCH';
  end if;
end;
$preflight$;

alter table public.community_comment_abuse_policies
  drop constraint community_comment_abuse_policies_pkey,
  add constraint community_comment_abuse_policies_pkey
    primary key (action, policy_version),
  add column created_by_discord_user_id text not null
    references public.user_logs(discord_user_id) on delete restrict,
  add column created_at timestamptz not null default transaction_timestamp(),
  add constraint community_comment_abuse_policy_versions_legacy_inactive_check
    check (not active);

alter table public.community_comment_spam_review_policies
  add column threshold_score bigint not null check (threshold_score > 0),
  add column signal_weights jsonb not null check (jsonb_typeof(signal_weights) = 'object'),
  add column created_by_discord_user_id text not null
    references public.user_logs(discord_user_id) on delete restrict,
  add constraint community_comment_spam_policy_versions_legacy_inactive_check
    check (not is_active);

alter table public.community_comment_spam_cases
  add column signal_score bigint not null default 1 check (signal_score > 0);

alter table public.community_comment_spam_events
  add column signal_score bigint not null default 1 check (signal_score > 0);

alter table public.community_comment_abuse_policies
  drop constraint community_comment_abuse_policies_action_check,
  add constraint community_comment_abuse_policies_action_check
    check (action in ('root', 'reply', 'edit', 'vote', 'report'));
alter table public.community_comment_abuse_buckets
  drop constraint community_comment_abuse_buckets_action_check,
  add constraint community_comment_abuse_buckets_action_check
    check (action in ('root', 'reply', 'edit', 'vote', 'report'));
alter table public.community_comment_abuse_events
  drop constraint community_comment_abuse_events_action_check,
  add constraint community_comment_abuse_events_action_check
    check (action in ('root', 'reply', 'edit', 'vote', 'report')),
  add constraint community_comment_abuse_events_policy_fkey
    foreign key (action, policy_version)
    references public.community_comment_abuse_policies(action, policy_version)
    on delete restrict;

create table public.community_comment_abuse_policy_states (
  action text primary key check (action in ('root', 'reply', 'edit', 'vote', 'report')),
  state_version bigint not null default 1 check (state_version > 0),
  active_policy_version bigint,
  updated_by_discord_user_id text
    references public.user_logs(discord_user_id) on delete restrict,
  updated_at timestamptz not null default transaction_timestamp(),
  foreign key (action, active_policy_version)
    references public.community_comment_abuse_policies(action, policy_version)
    on delete restrict
);

insert into public.community_comment_abuse_policy_states(action)
select action
from unnest(array['root', 'reply', 'edit', 'vote', 'report']::text[]) action;

create table public.community_comment_spam_policy_state (
  singleton boolean primary key default true check (singleton),
  state_version bigint not null default 1 check (state_version > 0),
  active_policy_version bigint
    references public.community_comment_spam_review_policies(policy_version)
    on delete restrict,
  updated_by_discord_user_id text
    references public.user_logs(discord_user_id) on delete restrict,
  updated_at timestamptz not null default transaction_timestamp()
);

insert into public.community_comment_spam_policy_state(singleton) values (true);

create table public.community_comment_policy_requests (
  request_id uuid primary key,
  actor_discord_user_id text not null
    references public.user_logs(discord_user_id) on delete restrict,
  operation text not null check (operation in ('release_state', 'abuse_policy', 'spam_policy')),
  action text check (action is null or action in ('root', 'reply', 'edit', 'vote', 'report')),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  result jsonb not null check (jsonb_typeof(result) = 'object'),
  created_at timestamptz not null default transaction_timestamp()
);

create table public.community_comment_policy_events (
  id bigint generated always as identity primary key,
  policy_domain text not null check (policy_domain in ('abuse', 'spam')),
  action text check (
    (policy_domain = 'abuse' and action in ('root', 'reply', 'edit', 'vote', 'report'))
    or (policy_domain = 'spam' and action is null)
  ),
  from_state_version bigint not null check (from_state_version > 0),
  to_state_version bigint not null check (to_state_version = from_state_version + 1),
  from_policy_version bigint,
  to_policy_version bigint,
  actor_discord_user_id text not null
    references public.user_logs(discord_user_id) on delete restrict,
  request_id uuid not null unique
    references public.community_comment_policy_requests(request_id) on delete restrict,
  created_at timestamptz not null default transaction_timestamp()
);

create table public.community_comment_release_state_events (
  id bigint generated always as identity primary key,
  from_state text not null check (from_state in ('off', 'read_only', 'open')),
  to_state text not null check (to_state in ('off', 'read_only', 'open')),
  from_version bigint not null check (from_version > 0),
  to_version bigint not null check (to_version = from_version + 1),
  actor_discord_user_id text not null
    references public.user_logs(discord_user_id) on delete restrict,
  request_id uuid not null unique
    references public.community_comment_policy_requests(request_id) on delete restrict,
  created_at timestamptz not null default transaction_timestamp()
);

alter table public.community_comment_abuse_policy_states enable row level security;
alter table public.community_comment_spam_policy_state enable row level security;
alter table public.community_comment_policy_requests enable row level security;
alter table public.community_comment_policy_events enable row level security;
alter table public.community_comment_release_state_events enable row level security;

revoke all on table
  public.community_comment_abuse_policy_states,
  public.community_comment_spam_policy_state,
  public.community_comment_policy_requests,
  public.community_comment_policy_events,
  public.community_comment_release_state_events
from public, anon, authenticated, discord_bot, service_role;
revoke all on sequence
  public.community_comment_policy_events_id_seq,
  public.community_comment_release_state_events_id_seq
from public, anon, authenticated, discord_bot, service_role;

create trigger community_comment_abuse_policy_versions_no_update
before update on public.community_comment_abuse_policies
for each row execute function public.protect_community_comment_append_only();
create trigger community_comment_abuse_policy_versions_no_delete
before delete on public.community_comment_abuse_policies
for each row execute function public.protect_community_comment_append_only();
create trigger community_comment_spam_policy_versions_no_update
before update on public.community_comment_spam_review_policies
for each row execute function public.protect_community_comment_append_only();
create trigger community_comment_spam_policy_versions_no_delete
before delete on public.community_comment_spam_review_policies
for each row execute function public.protect_community_comment_append_only();
create trigger community_comment_policy_requests_no_update
before update on public.community_comment_policy_requests
for each row execute function public.protect_community_comment_append_only();
create trigger community_comment_policy_requests_no_delete
before delete on public.community_comment_policy_requests
for each row execute function public.protect_community_comment_append_only();
create trigger community_comment_policy_events_no_update
before update on public.community_comment_policy_events
for each row execute function public.protect_community_comment_append_only();
create trigger community_comment_policy_events_no_delete
before delete on public.community_comment_policy_events
for each row execute function public.protect_community_comment_append_only();
create trigger community_comment_release_state_events_no_update
before update on public.community_comment_release_state_events
for each row execute function public.protect_community_comment_append_only();
create trigger community_comment_release_state_events_no_delete
before delete on public.community_comment_release_state_events
for each row execute function public.protect_community_comment_append_only();

create function public.require_community_comment_owner_session(p_session_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor text;
begin
  if p_session_id is null then
    raise exception using errcode = '22023', message = 'COMMUNITY_COMMENT_OWNER_SESSION_INVALID';
  end if;
  v_actor := public.require_account_session(p_session_id);
  if not exists (
    select 1 from public.team_members member
    where member.discord_user_id = v_actor and member.role = 'admin'
  ) then
    raise exception using errcode = '42501', message = 'COMMUNITY_COMMENT_OWNER_REQUIRED';
  end if;
  return v_actor;
end;
$function$;

create function public.get_community_comment_policy_management(p_session_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor text;
  v_release public.community_comment_settings%rowtype;
  v_spam_state public.community_comment_spam_policy_state%rowtype;
  v_spam_policy public.community_comment_spam_review_policies%rowtype;
begin
  v_actor := public.require_community_comment_owner_session(p_session_id);
  select * into strict v_release from public.community_comment_settings where singleton;
  select * into strict v_spam_state from public.community_comment_spam_policy_state where singleton;
  if v_spam_state.active_policy_version is not null then
    select * into strict v_spam_policy
    from public.community_comment_spam_review_policies policy
    where policy.policy_version = v_spam_state.active_policy_version;
  end if;
  return jsonb_build_object(
    'outcome', 'ok',
    'release', jsonb_build_object(
      'state', v_release.release_state,
      'version', v_release.version,
      'updatedAt', v_release.updated_at
    ),
    'actions', (
      select jsonb_agg(jsonb_build_object(
        'action', state.action,
        'stateVersion', state.state_version,
        'activePolicy', case when policy.policy_version is null then null else jsonb_build_object(
          'policyVersion', policy.policy_version,
          'windowSeconds', policy.window_seconds,
          'maxActions', policy.max_actions,
          'cooldownSeconds', policy.cooldown_seconds,
          'turnstileAfter', policy.turnstile_after,
          'createdAt', policy.created_at
        ) end,
        'updatedAt', state.updated_at
      ) order by array_position(array['root','reply','edit','vote','report']::text[], state.action))
      from public.community_comment_abuse_policy_states state
      left join public.community_comment_abuse_policies policy
        on policy.action = state.action
       and policy.policy_version = state.active_policy_version
    ),
    'spam', jsonb_build_object(
      'stateVersion', v_spam_state.state_version,
      'activePolicy', case when v_spam_state.active_policy_version is null then null else jsonb_build_object(
        'policyVersion', v_spam_policy.policy_version,
        'minimumEventCount', v_spam_policy.minimum_event_count,
        'lookbackSeconds', v_spam_policy.lookback_seconds,
        'thresholdScore', v_spam_policy.threshold_score,
        'signalWeights', v_spam_policy.signal_weights,
        'createdAt', v_spam_policy.created_at
      ) end,
      'updatedAt', v_spam_state.updated_at
    )
  );
end;
$function$;

create function public.manage_community_comment_release_state(
  p_session_id uuid,
  p_release_state text,
  p_expected_version bigint,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor text;
  v_settings public.community_comment_settings%rowtype;
  v_from_state text;
  v_existing public.community_comment_policy_requests%rowtype;
  v_hash text;
  v_result jsonb;
begin
  if p_release_state not in ('off', 'read_only', 'open')
    or p_expected_version is null or p_expected_version <= 0 or p_request_id is null
  then
    raise exception using errcode = '22023', message = 'COMMUNITY_COMMENT_RELEASE_INPUT_INVALID';
  end if;
  v_actor := public.require_community_comment_owner_session(p_session_id);
  v_hash := encode(extensions.digest(convert_to(jsonb_build_object(
    'operation','release_state','state',p_release_state,'expectedVersion',p_expected_version
  )::text, 'UTF8'), 'sha256'), 'hex');
  perform pg_advisory_xact_lock(hashtextextended(
    'community-comment-policy-request:' || p_request_id::text, 0
  ));
  select * into v_existing from public.community_comment_policy_requests request
  where request.request_id = p_request_id;
  if found then
    if v_existing.actor_discord_user_id <> v_actor or v_existing.request_hash <> v_hash then
      return jsonb_build_object('outcome', 'idempotency_conflict');
    end if;
    return v_existing.result || jsonb_build_object('replayed', true);
  end if;
  select * into strict v_settings from public.community_comment_settings where singleton for update;
  if v_settings.version <> p_expected_version then
    return jsonb_build_object(
      'outcome','stale_version','currentState',v_settings.release_state,'currentVersion',v_settings.version
    );
  end if;
  if v_settings.release_state = p_release_state then
    v_result := jsonb_build_object(
      'outcome','unchanged','state',v_settings.release_state,'version',v_settings.version,'replayed',false
    );
    insert into public.community_comment_policy_requests(
      request_id, actor_discord_user_id, operation, request_hash, result
    ) values (p_request_id, v_actor, 'release_state', v_hash, v_result);
    return v_result;
  end if;
  v_from_state := v_settings.release_state;
  update public.community_comment_settings
  set release_state = p_release_state, version = version + 1,
      updated_at = transaction_timestamp()
  where singleton returning * into v_settings;
  v_result := jsonb_build_object(
    'outcome','updated','state',v_settings.release_state,'version',v_settings.version,'replayed',false
  );
  insert into public.community_comment_policy_requests(
    request_id, actor_discord_user_id, operation, request_hash, result
  ) values (p_request_id, v_actor, 'release_state', v_hash, v_result);
  insert into public.community_comment_release_state_events(
    from_state, to_state, from_version, to_version,
    actor_discord_user_id, request_id
  ) values (
    v_from_state,
    v_settings.release_state, p_expected_version, v_settings.version, v_actor, p_request_id
  );
  return v_result;
end;
$function$;

create function public.manage_community_comment_abuse_policy(
  p_session_id uuid,
  p_action text,
  p_expected_state_version bigint,
  p_activate boolean,
  p_window_seconds integer,
  p_max_actions integer,
  p_cooldown_seconds integer,
  p_turnstile_after integer,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor text;
  v_state public.community_comment_abuse_policy_states%rowtype;
  v_existing public.community_comment_policy_requests%rowtype;
  v_hash text;
  v_policy_version bigint;
  v_from_policy_version bigint;
  v_result jsonb;
begin
  if p_action not in ('root','reply','edit','vote','report')
    or p_expected_state_version is null or p_expected_state_version <= 0
    or p_activate is null or p_request_id is null
    or (p_activate and (
      p_window_seconds is null or p_window_seconds not between 1 and 86400
      or p_max_actions is null or p_max_actions <= 0
      or p_cooldown_seconds is null or p_cooldown_seconds not between 1 and 604800
      or p_turnstile_after is null or p_turnstile_after not between 0 and p_max_actions
    ))
    or (not p_activate and (
      p_window_seconds is not null or p_max_actions is not null
      or p_cooldown_seconds is not null or p_turnstile_after is not null
    ))
  then
    raise exception using errcode = '22023', message = 'COMMUNITY_COMMENT_ABUSE_POLICY_INPUT_INVALID';
  end if;
  v_actor := public.require_community_comment_owner_session(p_session_id);
  v_hash := encode(extensions.digest(convert_to(jsonb_build_object(
    'operation','abuse_policy','action',p_action,'expectedStateVersion',p_expected_state_version,
    'activate',p_activate,'windowSeconds',p_window_seconds,'maxActions',p_max_actions,
    'cooldownSeconds',p_cooldown_seconds,'turnstileAfter',p_turnstile_after
  )::text, 'UTF8'), 'sha256'), 'hex');
  perform pg_advisory_xact_lock(hashtextextended(
    'community-comment-policy-request:' || p_request_id::text, 0
  ));
  select * into v_existing from public.community_comment_policy_requests request
  where request.request_id = p_request_id;
  if found then
    if v_existing.actor_discord_user_id <> v_actor or v_existing.request_hash <> v_hash then
      return jsonb_build_object('outcome','idempotency_conflict');
    end if;
    return v_existing.result || jsonb_build_object('replayed',true);
  end if;
  select * into strict v_state from public.community_comment_abuse_policy_states state
  where state.action = p_action for update;
  if v_state.state_version <> p_expected_state_version then
    return jsonb_build_object(
      'outcome','stale_version','currentStateVersion',v_state.state_version,
      'activePolicyVersion',v_state.active_policy_version
    );
  end if;
  v_from_policy_version := v_state.active_policy_version;
  if p_activate then
    select coalesce(max(policy.policy_version),0) + 1 into v_policy_version
    from public.community_comment_abuse_policies policy where policy.action = p_action;
    insert into public.community_comment_abuse_policies(
      action, policy_version, window_seconds, max_actions, cooldown_seconds,
      turnstile_after, active, created_by_discord_user_id
    ) values (
      p_action, v_policy_version, p_window_seconds, p_max_actions,
      p_cooldown_seconds, p_turnstile_after, false, v_actor
    );
  else
    v_policy_version := null;
  end if;
  update public.community_comment_abuse_policy_states
  set active_policy_version = v_policy_version,
      state_version = state_version + 1,
      updated_by_discord_user_id = v_actor,
      updated_at = transaction_timestamp()
  where action = p_action returning * into v_state;
  v_result := jsonb_build_object(
    'outcome',case when p_activate then 'activated' else 'deactivated' end,
    'action',p_action,'stateVersion',v_state.state_version,
    'activePolicyVersion',v_state.active_policy_version,'replayed',false
  );
  insert into public.community_comment_policy_requests(
    request_id, actor_discord_user_id, operation, action, request_hash, result
  ) values (p_request_id,v_actor,'abuse_policy',p_action,v_hash,v_result);
  insert into public.community_comment_policy_events(
    policy_domain, action, from_state_version, to_state_version,
    from_policy_version, to_policy_version, actor_discord_user_id, request_id
  ) values (
    'abuse',p_action,p_expected_state_version,v_state.state_version,
    v_from_policy_version,v_policy_version,v_actor,p_request_id
  );
  return v_result;
end;
$function$;

create function public.manage_community_comment_spam_policy(
  p_session_id uuid,
  p_expected_state_version bigint,
  p_activate boolean,
  p_minimum_event_count integer,
  p_lookback_seconds integer,
  p_threshold_score bigint,
  p_signal_weights jsonb,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor text;
  v_state public.community_comment_spam_policy_state%rowtype;
  v_existing public.community_comment_policy_requests%rowtype;
  v_hash text;
  v_policy_version bigint;
  v_from_policy_version bigint;
  v_result jsonb;
begin
  if p_expected_state_version is null or p_expected_state_version <= 0
    or p_activate is null or p_request_id is null
    or (p_activate and (
      p_minimum_event_count is null or p_minimum_event_count not between 2 and 10000
      or p_lookback_seconds is null or p_lookback_seconds not between 60 and 2592000
      or p_threshold_score is null or p_threshold_score <= 0
      or p_signal_weights is null
      or jsonb_typeof(p_signal_weights) <> 'object'
      or p_signal_weights = '{}'::jsonb
      or exists (
        select 1 from jsonb_each_text(p_signal_weights) weight
        where weight.key !~ '^(root|reply|edit|vote|report):(turnstile_required|cooldown|rejected_input)$'
          or weight.value !~ '^[1-9][0-9]*$'
          or weight.value::numeric > 1000000
      )
    ))
    or (not p_activate and (
      p_minimum_event_count is not null or p_lookback_seconds is not null
      or p_threshold_score is not null or p_signal_weights is not null
    ))
  then
    raise exception using errcode = '22023', message = 'COMMUNITY_COMMENT_SPAM_POLICY_INPUT_INVALID';
  end if;
  v_actor := public.require_community_comment_owner_session(p_session_id);
  v_hash := encode(extensions.digest(convert_to(jsonb_build_object(
    'operation','spam_policy','expectedStateVersion',p_expected_state_version,
    'activate',p_activate,'minimumEventCount',p_minimum_event_count,
    'lookbackSeconds',p_lookback_seconds,'thresholdScore',p_threshold_score,
    'signalWeights',p_signal_weights
  )::text, 'UTF8'), 'sha256'), 'hex');
  perform pg_advisory_xact_lock(hashtextextended(
    'community-comment-policy-request:' || p_request_id::text, 0
  ));
  select * into v_existing from public.community_comment_policy_requests request
  where request.request_id = p_request_id;
  if found then
    if v_existing.actor_discord_user_id <> v_actor or v_existing.request_hash <> v_hash then
      return jsonb_build_object('outcome','idempotency_conflict');
    end if;
    return v_existing.result || jsonb_build_object('replayed',true);
  end if;
  select * into strict v_state from public.community_comment_spam_policy_state where singleton for update;
  if v_state.state_version <> p_expected_state_version then
    return jsonb_build_object(
      'outcome','stale_version','currentStateVersion',v_state.state_version,
      'activePolicyVersion',v_state.active_policy_version
    );
  end if;
  v_from_policy_version := v_state.active_policy_version;
  if p_activate then
    select coalesce(max(policy.policy_version),0) + 1 into v_policy_version
    from public.community_comment_spam_review_policies policy;
    insert into public.community_comment_spam_review_policies(
      policy_version,is_active,minimum_event_count,lookback_seconds,
      threshold_score,signal_weights,created_by_discord_user_id
    ) values (
      v_policy_version,false,p_minimum_event_count,p_lookback_seconds,
      p_threshold_score,p_signal_weights,v_actor
    );
  else
    v_policy_version := null;
  end if;
  update public.community_comment_spam_policy_state
  set active_policy_version = v_policy_version,
      state_version = state_version + 1,
      updated_by_discord_user_id = v_actor,
      updated_at = transaction_timestamp()
  where singleton returning * into v_state;
  v_result := jsonb_build_object(
    'outcome',case when p_activate then 'activated' else 'deactivated' end,
    'stateVersion',v_state.state_version,
    'activePolicyVersion',v_state.active_policy_version,'replayed',false
  );
  insert into public.community_comment_policy_requests(
    request_id,actor_discord_user_id,operation,request_hash,result
  ) values (p_request_id,v_actor,'spam_policy',v_hash,v_result);
  insert into public.community_comment_policy_events(
    policy_domain,action,from_state_version,to_state_version,
    from_policy_version,to_policy_version,actor_discord_user_id,request_id
  ) values (
    'spam',null,p_expected_state_version,v_state.state_version,
    v_from_policy_version,v_policy_version,v_actor,p_request_id
  );
  return v_result;
end;
$function$;

create or replace function public.apply_community_comment_abuse_budget(
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
  if nullif(btrim(p_author_discord_user_id),'') is null
    or p_action not in ('root','reply','edit','vote','report')
    or p_submission_id is null or p_submission_id <= 0
    or p_content_digest is null or p_content_digest !~ '^[0-9a-f]{64}$'
    or p_turnstile_verified is null or p_now is null
  then
    raise exception using errcode = '22023', message = 'COMMUNITY_COMMENT_ABUSE_INPUT_INVALID';
  end if;
  select policy.* into v_policy
  from public.community_comment_abuse_policy_states state
  join public.community_comment_abuse_policies policy
    on policy.action = state.action and policy.policy_version = state.active_policy_version
  where state.action = p_action;
  if not found then
    return jsonb_build_object('outcome','abuse_configuration_unavailable');
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'community-comment-abuse:' || p_author_discord_user_id || ':' || p_action, 0
  ));
  select * into v_bucket from public.community_comment_abuse_buckets bucket
  where bucket.author_discord_user_id = p_author_discord_user_id and bucket.action = p_action
  for update;
  if not found then
    insert into public.community_comment_abuse_buckets(
      author_discord_user_id,action,window_started_at,action_count,rejected_count,
      last_content_digest,last_submission_id,repeated_content_count,updated_at
    ) values (
      p_author_discord_user_id,p_action,p_now,0,0,null,null,0,p_now
    ) returning * into v_bucket;
  end if;
  if v_bucket.cooldown_until is not null and v_bucket.cooldown_until > p_now then
    v_retry_after := greatest(1,ceil(extract(epoch from (v_bucket.cooldown_until-p_now)))::integer);
    insert into public.community_comment_abuse_events(
      author_discord_user_id,action,submission_id,outcome,policy_version,created_at
    ) values (p_author_discord_user_id,p_action,p_submission_id,'cooldown',v_policy.policy_version,p_now);
    return jsonb_build_object('outcome','cooldown','retryAfter',v_retry_after);
  end if;
  if v_bucket.window_started_at + make_interval(secs=>v_policy.window_seconds) <= p_now then
    v_bucket.window_started_at := p_now;
    v_bucket.action_count := 0;
    v_bucket.rejected_count := 0;
    v_bucket.cooldown_until := null;
  end if;
  v_count := v_bucket.action_count + 1;
  v_repeat := case when v_bucket.last_content_digest = p_content_digest
    and v_bucket.last_submission_id is distinct from p_submission_id
    then v_bucket.repeated_content_count + 1 else 0 end;
  if v_count > v_policy.max_actions then
    update public.community_comment_abuse_buckets
    set action_count=v_count,cooldown_until=p_now+make_interval(secs=>v_policy.cooldown_seconds),
        last_content_digest=p_content_digest,last_submission_id=p_submission_id,
        repeated_content_count=v_repeat,version=version+1,updated_at=p_now
    where author_discord_user_id=p_author_discord_user_id and action=p_action;
    insert into public.community_comment_abuse_events(
      author_discord_user_id,action,submission_id,outcome,policy_version,created_at
    ) values (p_author_discord_user_id,p_action,p_submission_id,'cooldown',v_policy.policy_version,p_now);
    return jsonb_build_object('outcome','cooldown','retryAfter',v_policy.cooldown_seconds);
  end if;
  if v_count > v_policy.turnstile_after and not p_turnstile_verified then
    update public.community_comment_abuse_buckets
    set action_count=v_count,rejected_count=rejected_count+1,
        last_content_digest=p_content_digest,last_submission_id=p_submission_id,
        repeated_content_count=v_repeat,version=version+1,updated_at=p_now
    where author_discord_user_id=p_author_discord_user_id and action=p_action;
    insert into public.community_comment_abuse_events(
      author_discord_user_id,action,submission_id,outcome,policy_version,created_at
    ) values (p_author_discord_user_id,p_action,p_submission_id,'turnstile_required',v_policy.policy_version,p_now);
    return jsonb_build_object('outcome','turnstile_required');
  end if;
  update public.community_comment_abuse_buckets
  set action_count=v_count,last_content_digest=p_content_digest,last_submission_id=p_submission_id,
      repeated_content_count=v_repeat,version=version+1,updated_at=p_now
  where author_discord_user_id=p_author_discord_user_id and action=p_action;
  insert into public.community_comment_abuse_events(
    author_discord_user_id,action,submission_id,outcome,policy_version,created_at
  ) values (p_author_discord_user_id,p_action,p_submission_id,'allowed',v_policy.policy_version,p_now);
  return jsonb_build_object('outcome','allowed');
end;
$function$;

create or replace function public.mark_community_comment_rejected_input(
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
  from public.community_comment_abuse_policy_states state
  join public.community_comment_abuse_policies policy
    on policy.action = state.action
   and policy.policy_version = state.active_policy_version
  where state.action = p_action;

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

create or replace function public.open_or_update_community_comment_spam_case()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_policy public.community_comment_spam_review_policies%rowtype;
  v_case public.community_comment_spam_cases%rowtype;
  v_event_count bigint;
  v_event_score bigint;
  v_current_weight bigint;
  v_generation bigint;
  v_subject_username text;
  v_upsert jsonb;
begin
  if new.outcome = 'allowed' then return new; end if;
  select policy.* into v_policy
  from public.community_comment_spam_policy_state state
  join public.community_comment_spam_review_policies policy
    on policy.policy_version = state.active_policy_version
  where state.singleton;
  if not found then return new; end if;
  v_current_weight := coalesce((v_policy.signal_weights ->> (new.action||':'||new.outcome))::bigint,0);
  if v_current_weight <= 0 then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'community-comment-spam:' || new.author_discord_user_id,0
  ));
  select * into v_case from public.community_comment_spam_cases spam_case
  where spam_case.subject_discord_user_id=new.author_discord_user_id and spam_case.status='open'
  for update;
  if found then
    insert into public.community_comment_spam_signals(case_id,abuse_event_id,signal_class)
    values (v_case.id,new.id,new.action||':'||new.outcome)
    on conflict (abuse_event_id) do nothing;
    if found then
      update public.community_comment_spam_cases
      set signal_count=signal_count+1,signal_score=signal_score+v_current_weight,
          version=version+1,updated_at=transaction_timestamp()
      where id=v_case.id returning * into v_case;
      insert into public.community_comment_spam_events(
        case_id,event_type,case_version,signal_count,signal_score
      ) values (v_case.id,'signals_updated',v_case.version,v_case.signal_count,v_case.signal_score);
    end if;
    return new;
  end if;
  select count(*),coalesce(sum((v_policy.signal_weights ->> (event.action||':'||event.outcome))::bigint),0)
  into v_event_count,v_event_score
  from public.community_comment_abuse_events event
  where event.author_discord_user_id=new.author_discord_user_id
    and event.outcome<>'allowed'
    and v_policy.signal_weights ? (event.action||':'||event.outcome)
    and event.created_at>=new.created_at-make_interval(secs=>v_policy.lookback_seconds);
  if v_event_count<v_policy.minimum_event_count or v_event_score<v_policy.threshold_score then return new; end if;
  select coalesce(max(spam_case.generation),0)+1 into v_generation
  from public.community_comment_spam_cases spam_case
  where spam_case.subject_discord_user_id=new.author_discord_user_id;
  insert into public.community_comment_spam_cases(
    subject_discord_user_id,generation,policy_version,signal_count,signal_score
  ) values (
    new.author_discord_user_id,v_generation,v_policy.policy_version,v_event_count,v_event_score
  ) returning * into v_case;
  insert into public.community_comment_spam_signals(case_id,abuse_event_id,signal_class)
  select v_case.id,event.id,event.action||':'||event.outcome
  from public.community_comment_abuse_events event
  where event.author_discord_user_id=new.author_discord_user_id
    and event.outcome<>'allowed'
    and v_policy.signal_weights ? (event.action||':'||event.outcome)
    and event.created_at>=new.created_at-make_interval(secs=>v_policy.lookback_seconds)
  order by event.created_at desc,event.id desc limit 100
  on conflict (abuse_event_id) do nothing;
  insert into public.community_comment_spam_events(
    case_id,event_type,case_version,signal_count,signal_score
  ) values (v_case.id,'created',v_case.version,v_case.signal_count,v_case.signal_score);
  select coalesce(nullif(btrim(author.current_discord_username),''),
    nullif(btrim(author.current_display_name),''),'Community member') into v_subject_username
  from public.user_logs author where author.discord_user_id=new.author_discord_user_id;
  v_upsert:=public.upsert_team_inbox_case(
    'comment_spam','user:'||new.author_discord_user_id,v_case.version,
    new.author_discord_user_id,v_subject_username
  );
  update public.community_comment_spam_cases
  set team_inbox_case_id=(v_upsert->>'caseId')::uuid
  where id=v_case.id and team_inbox_case_id is distinct from (v_upsert->>'caseId')::uuid;
  return new;
end;
$function$;

create or replace function public.submit_community_comment_report(
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
  v_abuse jsonb;
  v_spam_case_id uuid;
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
      where report.comment_id = v_comment.id and report.reporter_discord_user_id = v_actor
    ) then
      v_result := jsonb_build_object('outcome', 'already_reported');
    else
      v_abuse := public.apply_community_comment_abuse_budget(
        v_actor, 'report', v_comment.submission_id, p_request_hash,
        p_turnstile_verified, transaction_timestamp()
      );
      if v_abuse ->> 'outcome' = 'abuse_configuration_unavailable' then
        v_result := jsonb_build_object('outcome', 'abuse_configuration_unavailable');
      elsif v_abuse ->> 'outcome' in ('cooldown', 'turnstile_required') then
        v_result := jsonb_build_object(
          'outcome', 'rate_limited',
          'retryAfter', coalesce((v_abuse ->> 'retryAfter')::integer, 1)
        );
        select spam_case.id into v_spam_case_id
        from public.community_comment_spam_cases spam_case
        where spam_case.subject_discord_user_id = v_actor
          and spam_case.status = 'open'
        for update;
        if found then
          insert into public.community_comment_spam_comment_refs(case_id, comment_id)
          values (v_spam_case_id, v_comment.id)
          on conflict (case_id, comment_id) do update
          set last_seen_at = transaction_timestamp(),
              reference_count = public.community_comment_spam_comment_refs.reference_count + 1;
        end if;
      elsif v_abuse ->> 'outcome' <> 'allowed' then
        raise exception using errcode = '55000', message = 'COMMUNITY_COMMENT_REPORT_ABUSE_RESULT_INVALID';
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
          v_case.id, case when v_was_solved then 'reopened' else 'report_received' end,
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
        where id = v_case.id
          and team_inbox_case_id is distinct from (v_upsert ->> 'caseId')::uuid;
        v_result := jsonb_build_object(
          'outcome', 'accepted', 'publicReportId', v_report.public_report_id
        );
      end if;
    end if;
  end if;
  insert into public.community_comment_report_requests(
    reporter_discord_user_id, request_id, request_hash, result
  ) values (v_actor, p_request_id, p_request_hash, v_result);
  return v_result;
end;
$function$;

create function public.attach_community_comment_report_spam_reference()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_case_id uuid;
begin
  select spam_case.id into v_case_id
  from public.community_comment_spam_cases spam_case
  where spam_case.subject_discord_user_id = new.reporter_discord_user_id
    and spam_case.status = 'open'
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

create trigger community_comment_reports_spam_reference
after insert on public.community_comment_reports
for each row execute function public.attach_community_comment_report_spam_reference();

alter table public.community_comment_abuse_policy_states owner to postgres;
alter table public.community_comment_spam_policy_state owner to postgres;
alter table public.community_comment_policy_requests owner to postgres;
alter table public.community_comment_policy_events owner to postgres;
alter table public.community_comment_release_state_events owner to postgres;
alter sequence public.community_comment_policy_events_id_seq owner to postgres;
alter sequence public.community_comment_release_state_events_id_seq owner to postgres;

alter function public.require_community_comment_owner_session(uuid) owner to postgres;
alter function public.get_community_comment_policy_management(uuid) owner to postgres;
alter function public.manage_community_comment_release_state(uuid,text,bigint,uuid) owner to postgres;
alter function public.manage_community_comment_abuse_policy(uuid,text,bigint,boolean,integer,integer,integer,integer,uuid) owner to postgres;
alter function public.manage_community_comment_spam_policy(uuid,bigint,boolean,integer,integer,bigint,jsonb,uuid) owner to postgres;
alter function public.apply_community_comment_abuse_budget(text,text,bigint,text,boolean,timestamptz) owner to postgres;
alter function public.mark_community_comment_rejected_input(text,text,bigint,timestamptz) owner to postgres;
alter function public.open_or_update_community_comment_spam_case() owner to postgres;
alter function public.submit_community_comment_report(uuid,uuid,text,text,uuid,text,boolean,boolean) owner to postgres;
alter function public.attach_community_comment_report_spam_reference() owner to postgres;

revoke all on function public.require_community_comment_owner_session(uuid) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_community_comment_policy_management(uuid) from public, anon, authenticated, discord_bot;
revoke all on function public.manage_community_comment_release_state(uuid,text,bigint,uuid) from public, anon, authenticated, discord_bot;
revoke all on function public.manage_community_comment_abuse_policy(uuid,text,bigint,boolean,integer,integer,integer,integer,uuid) from public, anon, authenticated, discord_bot;
revoke all on function public.manage_community_comment_spam_policy(uuid,bigint,boolean,integer,integer,bigint,jsonb,uuid) from public, anon, authenticated, discord_bot;
revoke all on function public.apply_community_comment_abuse_budget(text,text,bigint,text,boolean,timestamptz) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.mark_community_comment_rejected_input(text,text,bigint,timestamptz) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.open_or_update_community_comment_spam_case() from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.attach_community_comment_report_spam_reference() from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.submit_community_comment_report(uuid,uuid,text,text,uuid,text,boolean,boolean) from public, anon, authenticated, discord_bot;
grant execute on function public.get_community_comment_policy_management(uuid) to service_role;
grant execute on function public.manage_community_comment_release_state(uuid,text,bigint,uuid) to service_role;
grant execute on function public.manage_community_comment_abuse_policy(uuid,text,bigint,boolean,integer,integer,integer,integer,uuid) to service_role;
grant execute on function public.manage_community_comment_spam_policy(uuid,bigint,boolean,integer,integer,bigint,jsonb,uuid) to service_role;
grant execute on function public.submit_community_comment_report(uuid,uuid,text,text,uuid,text,boolean,boolean) to service_role;

do $postflight$
begin
  if (select count(*) from public.community_comment_abuse_policy_states) <> 5
    or (select count(*) from public.community_comment_spam_policy_state) <> 1
    or exists (select 1 from public.community_comment_abuse_policies)
    or exists (select 1 from public.community_comment_spam_review_policies)
    or exists (select 1 from public.community_comment_policy_requests)
    or exists (select 1 from public.community_comment_policy_events)
    or exists (select 1 from public.community_comment_release_state_events)
    or (select release_state from public.community_comment_settings where singleton) <> 'off'
    or (select version from public.community_comment_settings where singleton) <> 1
    or not has_function_privilege('service_role','public.get_community_comment_policy_management(uuid)','EXECUTE')
    or not has_function_privilege('service_role','public.manage_community_comment_release_state(uuid,text,bigint,uuid)','EXECUTE')
    or has_function_privilege('service_role','public.require_community_comment_owner_session(uuid)','EXECUTE')
    or has_function_privilege('service_role','public.apply_community_comment_abuse_budget(text,text,bigint,text,boolean,timestamp with time zone)','EXECUTE')
  then
    raise exception using errcode='55000',message='COMMENT_ABUSE_POLICY_MANAGEMENT_POSTFLIGHT_MISMATCH';
  end if;
end;
$postflight$;

commit;
