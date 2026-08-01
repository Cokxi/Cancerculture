begin;

do $preflight$
begin
  if (select count(*) from public.capability_catalog) <> 10
    or (select count(*) from public.capability_catalog where is_active) <> 8
    or (
      select count(*)
      from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 8 then
    raise exception using
      errcode = '55000',
      message = 'USER_MODERATION_CAPABILITY_BASELINE_MISMATCH';
  end if;

  if exists (select 1 from public.team_role_capabilities) then
    raise exception using
      errcode = '55000',
      message = 'USER_MODERATION_UNEXPECTED_EXISTING_GRANT';
  end if;

  if exists (
    select 1
    from public.capability_catalog
    where key in (
      'users.directory.full.view',
      'users.upload_blocks.view',
      'users.website_bans.view',
      'users.website_bans.create',
      'users.website_bans.revoke',
      'logs.website_bans.view'
    )
  ) then
    raise exception using
      errcode = '55000',
      message = 'USER_MODERATION_CAPABILITY_ALREADY_PRESENT';
  end if;
end;
$preflight$;

insert into public.capability_catalog (
  key,
  display_name,
  description,
  category,
  included_actions,
  excluded_actions,
  risk_level,
  assignable_to_non_admin,
  is_active,
  implementation_version,
  definition_hash
)
values
  (
    'users.directory.full.view',
    'View Full User Directory',
    'View the extended user directory with identity history, activity timestamps, and aggregate participation statistics.',
    'User Moderation',
    array[
      'View current and known Discord names.',
      'View first-seen and last-seen timestamps.',
      'View aggregate submission and username-change statistics.',
      'Open the user''s current submission list.'
    ]::text[],
    array[
      'Viewing website-ban reasons or history.',
      'Creating or revoking website bans.',
      'Viewing flag reasons or flag history.',
      'Viewing vote, wallet, session, or infrastructure data.'
    ]::text[],
    'moderate', true, true, 1,
    '2a029efd6ee65c6e775ff6b596213f54e1fc1465b338c8a3cc5791c66aef0676'
  ),
  (
    'users.upload_blocks.view',
    'View Cycle Upload Blocks',
    'View cycle-scoped automatic upload-abuse blocks and their bounded counters without changing them.',
    'User Moderation',
    array[
      'View cycle-scoped invalid-upload counters and active automatic blocks.',
      'View when a block was triggered and the last bounded error category.'
    ]::text[],
    array[
      'Manually unblocking a user during the current cycle.',
      'Changing abuse thresholds or detection rules.',
      'Viewing raw network or infrastructure data.'
    ]::text[],
    'moderate', true, true, 1,
    '174c20de72228105c16c01b98a9da10f232ecdbe2f9e6c1f0b309a1c37479204'
  ),
  (
    'users.website_bans.view',
    'View Active Website Bans',
    'View active website bans and their current moderation context without changing ban state.',
    'User Moderation',
    array[
      'View actively website-banned users.',
      'View the current ban reason, source, actor, and timestamp.'
    ]::text[],
    array[
      'Creating or revoking website bans.',
      'Viewing the complete historical website-ban event log.',
      'Discord bans or team-member administration.'
    ]::text[],
    'high', true, true, 1,
    '4e8d362ef56b5f101e66ac6d3db552f505ecf6c4580dbefe36f397d4571e7388'
  ),
  (
    'users.website_bans.create',
    'Create Website Bans',
    'Create an auditable website ban for a known non-team user with a required reason.',
    'User Moderation',
    array[
      'Create a website ban for a known user who is not a team member.',
      'Read only whether the selected user currently has an active website ban.'
    ]::text[],
    array[
      'Revoking website bans.',
      'Banning active team members or Owner accounts.',
      'Discord bans, legal deletion, or historical data repair.'
    ]::text[],
    'critical', true, true, 1,
    '66118e044f0defc403ce7a63539a30156b4000bd0a05dbeeafe73a9661407470'
  ),
  (
    'users.website_bans.revoke',
    'Revoke Website Bans',
    'Revoke an active website ban for a non-team user with a required auditable reason.',
    'User Moderation',
    array[
      'Revoke an active website ban for a user who is not a team member.',
      'Read the current website-ban state required for the action.'
    ]::text[],
    array[
      'Creating website bans.',
      'Changing team membership or Owner access.',
      'Republishing submissions or repairing historical results.'
    ]::text[],
    'high', true, true, 1,
    '1a5b5dd1c07c638051dc76ea079561baff6b8204b17be017d04e186de6b09706'
  ),
  (
    'logs.website_bans.view',
    'View Website Ban History',
    'View the append-only website-ban and revocation event history without changing moderation state.',
    'Logs',
    array[
      'View immutable website-ban and revocation events.',
      'View event actors, timestamps, reasons, and state transitions.'
    ]::text[],
    array[
      'Creating or revoking website bans.',
      'Viewing unrelated user, flag, vote, upload, or infrastructure logs.',
      'Deleting or rewriting moderation history.'
    ]::text[],
    'high', true, true, 1,
    'a3ce56bd99c5e3aa74ff1d863a8969b73cd23717cc9ced50a7c8c375cda743e3'
  );

alter table public.user_logs
  add column website_ban_version bigint not null default 0;

alter table public.user_logs
  add constraint user_logs_website_ban_version_check
  check (website_ban_version >= 0);

create table public.website_ban_events (
  event_id uuid primary key default gen_random_uuid(),
  action text not null,
  target_discord_user_id text not null
    references public.user_logs(discord_user_id) on delete restrict,
  actor_discord_user_id text,
  actor_username text,
  source text,
  reason text,
  previous_is_banned boolean not null,
  new_is_banned boolean not null,
  ban_version bigint not null,
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  constraint website_ban_events_action_check
    check (action in ('website_ban_legacy_snapshot', 'website_ban_created', 'website_ban_revoked')),
  constraint website_ban_events_transition_check
    check (previous_is_banned <> new_is_banned),
  constraint website_ban_events_version_check
    check (ban_version > 0),
  constraint website_ban_events_reason_check
    check (reason is null or char_length(reason) between 3 and 1000),
  unique (target_discord_user_id, ban_version)
);

create index website_ban_events_target_time_idx
  on public.website_ban_events (target_discord_user_id, occurred_at desc);
create index website_ban_events_time_idx
  on public.website_ban_events (occurred_at desc, event_id desc);

create table public.website_ban_requests (
  idempotency_key uuid primary key,
  action text not null,
  actor_discord_user_id text not null,
  target_discord_user_id text not null
    references public.user_logs(discord_user_id) on delete restrict,
  request_hash text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  constraint website_ban_requests_action_check
    check (action in ('website_ban_created', 'website_ban_revoked')),
  constraint website_ban_requests_hash_check
    check (request_hash ~ '^[0-9a-f]{64}$')
);

create index website_ban_requests_target_time_idx
  on public.website_ban_requests (target_discord_user_id, created_at desc);

alter table public.website_ban_events enable row level security;
alter table public.website_ban_requests enable row level security;

revoke all on table public.website_ban_events
  from public, anon, authenticated, discord_bot;
revoke all on table public.website_ban_requests
  from public, anon, authenticated, discord_bot;
grant select, insert, update, delete on table public.website_ban_events to service_role;
grant select, insert, update, delete on table public.website_ban_requests to service_role;

create or replace function public.protect_website_ban_history()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  raise exception using
    errcode = '55000',
    message = 'WEBSITE_BAN_HISTORY_APPEND_ONLY';
end;
$function$;

create trigger website_ban_events_append_only
before update or delete on public.website_ban_events
for each row execute function public.protect_website_ban_history();

create trigger website_ban_requests_append_only
before update or delete on public.website_ban_requests
for each row execute function public.protect_website_ban_history();

with legacy_bans as (
  update public.user_logs
  set website_ban_version = 1
  where is_banned and website_ban_version = 0
  returning
    discord_user_id,
    banned_by_discord_user_id,
    banned_by_discord_username,
    ban_source,
    ban_reason,
    banned_at,
    website_ban_version
)
insert into public.website_ban_events (
  action,
  target_discord_user_id,
  actor_discord_user_id,
  actor_username,
  source,
  reason,
  previous_is_banned,
  new_is_banned,
  ban_version,
  occurred_at
)
select
  'website_ban_legacy_snapshot',
  discord_user_id,
  banned_by_discord_user_id,
  banned_by_discord_username,
  ban_source,
  ban_reason,
  false,
  true,
  website_ban_version,
  coalesce(banned_at, transaction_timestamp())
from legacy_bans;

create or replace function public.authorize_user_moderation_capability(
  p_actor_discord_user_id text,
  p_capability_key text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor_id text := btrim(p_actor_discord_user_id);
  v_actor_role text;
  v_expected_hash text;
begin
  v_expected_hash := case p_capability_key
    when 'users.directory.full.view' then '2a029efd6ee65c6e775ff6b596213f54e1fc1465b338c8a3cc5791c66aef0676'
    when 'users.upload_blocks.view' then '174c20de72228105c16c01b98a9da10f232ecdbe2f9e6c1f0b309a1c37479204'
    when 'users.website_bans.view' then '4e8d362ef56b5f101e66ac6d3db552f505ecf6c4580dbefe36f397d4571e7388'
    when 'users.website_bans.create' then '66118e044f0defc403ce7a63539a30156b4000bd0a05dbeeafe73a9661407470'
    when 'users.website_bans.revoke' then '1a5b5dd1c07c638051dc76ea079561baff6b8204b17be017d04e186de6b09706'
    when 'logs.website_bans.view' then 'a3ce56bd99c5e3aa74ff1d863a8969b73cd23717cc9ced50a7c8c375cda743e3'
    else null
  end;

  if nullif(v_actor_id, '') is null or v_expected_hash is null then
    raise exception using errcode = '42501', message = 'USER_MODERATION_FORBIDDEN';
  end if;

  if not exists (
    select 1
    from public.capability_catalog
    where key = p_capability_key
      and is_active
      and assignable_to_non_admin
      and implementation_version = 1
      and definition_hash = v_expected_hash
  ) then
    raise exception using
      errcode = '55000',
      message = 'USER_MODERATION_AUTHORIZATION_DEPENDENCY_UNAVAILABLE';
  end if;

  select member_row.role
  into v_actor_role
  from public.team_members as member_row
  join public.team_roles as role_row
    on role_row.key = member_row.role and role_row.is_active
  where member_row.discord_user_id = v_actor_id;

  if not found then
    raise exception using errcode = '42501', message = 'USER_MODERATION_FORBIDDEN';
  end if;

  if v_actor_role = 'admin' then
    return;
  end if;

  if not exists (
    select 1
    from public.team_role_capabilities as grant_row
    where grant_row.role = v_actor_role
      and grant_row.capability_key = p_capability_key
  ) then
    raise exception using errcode = '42501', message = 'USER_MODERATION_FORBIDDEN';
  end if;
end;
$function$;

create or replace function public.apply_website_ban_contract(
  p_actor_discord_user_id text,
  p_target_discord_user_id text,
  p_reason text,
  p_source text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor_id text := btrim(p_actor_discord_user_id);
  v_target_id text := btrim(p_target_discord_user_id);
  v_reason text := btrim(p_reason);
  v_source text := coalesce(nullif(btrim(p_source), ''), 'admin_manual');
  v_actor_username text;
  v_target public.user_logs%rowtype;
  v_now timestamptz := transaction_timestamp();
begin
  if nullif(v_actor_id, '') is null
    or nullif(v_target_id, '') is null
    or char_length(v_reason) not between 3 and 1000
    or v_source not in ('admin_manual', 'illegal_submission') then
    raise exception using errcode = '22023', message = 'INVALID_WEBSITE_BAN_REQUEST';
  end if;

  perform public.authorize_user_moderation_capability(
    v_actor_id,
    'users.website_bans.create'
  );

  if exists (
    select 1 from public.team_members where discord_user_id = v_target_id
  ) then
    raise exception using errcode = '42501', message = 'WEBSITE_BAN_TEAM_MEMBER_PROTECTED';
  end if;

  select * into v_target
  from public.user_logs
  where discord_user_id = v_target_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'WEBSITE_BAN_TARGET_NOT_FOUND';
  end if;
  if v_target.is_banned then
    raise exception using errcode = 'PT409', message = 'WEBSITE_BAN_ALREADY_ACTIVE';
  end if;

  select nullif(btrim(current_discord_username), '')
  into v_actor_username
  from public.user_logs
  where discord_user_id = v_actor_id;

  update public.user_logs
  set is_banned = true,
      ban_reason = v_reason,
      ban_source = v_source,
      banned_at = v_now,
      banned_by_discord_user_id = v_actor_id,
      banned_by_discord_username = v_actor_username,
      website_ban_version = v_target.website_ban_version + 1
  where discord_user_id = v_target_id;

  insert into public.website_ban_events (
    action, target_discord_user_id, actor_discord_user_id, actor_username,
    source, reason, previous_is_banned, new_is_banned, ban_version, occurred_at
  ) values (
    'website_ban_created', v_target_id, v_actor_id, v_actor_username,
    v_source, v_reason, false, true, v_target.website_ban_version + 1, v_now
  );
end;
$function$;

create or replace function public.ban_website_user_v2(
  p_actor_discord_user_id text,
  p_target_discord_user_id text,
  p_expected_ban_version bigint,
  p_reason text,
  p_source text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor_id text := btrim(p_actor_discord_user_id);
  v_target_id text := btrim(p_target_discord_user_id);
  v_reason text := btrim(p_reason);
  v_source text := coalesce(nullif(btrim(p_source), ''), 'admin_manual');
  v_payload jsonb;
  v_hash text;
  v_existing public.website_ban_requests%rowtype;
  v_target public.user_logs%rowtype;
  v_result jsonb;
begin
  if p_idempotency_key is null or p_expected_ban_version is null
    or p_expected_ban_version < 0 then
    raise exception using errcode = '22023', message = 'INVALID_WEBSITE_BAN_REQUEST';
  end if;

  perform public.authorize_user_moderation_capability(v_actor_id, 'users.website_bans.create');
  v_payload := jsonb_build_object(
    'action', 'website_ban_created', 'actorDiscordUserId', v_actor_id,
    'targetDiscordUserId', v_target_id, 'expectedBanVersion', p_expected_ban_version,
    'reason', v_reason, 'source', v_source
  );
  v_hash := encode(extensions.digest(convert_to(v_payload::text, 'UTF8'), 'sha256'), 'hex');
  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));

  select * into v_existing
  from public.website_ban_requests
  where idempotency_key = p_idempotency_key;
  if found then
    if v_existing.request_hash = v_hash then
      return jsonb_set(v_existing.result, '{replayed}', 'true'::jsonb);
    end if;
    raise exception using errcode = 'PT409', message = 'WEBSITE_BAN_IDEMPOTENCY_CONFLICT';
  end if;

  select * into v_target
  from public.user_logs
  where discord_user_id = v_target_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'WEBSITE_BAN_TARGET_NOT_FOUND';
  end if;
  if v_target.website_ban_version <> p_expected_ban_version then
    raise exception using errcode = 'PT409', message = 'WEBSITE_BAN_STALE_VERSION';
  end if;

  perform public.apply_website_ban_contract(v_actor_id, v_target_id, v_reason, v_source);
  v_result := jsonb_build_object(
    'success', true,
    'targetDiscordUserId', v_target_id,
    'isBanned', true,
    'banVersion', p_expected_ban_version + 1,
    'replayed', false
  );
  insert into public.website_ban_requests (
    idempotency_key, action, actor_discord_user_id, target_discord_user_id,
    request_hash, result
  ) values (
    p_idempotency_key, 'website_ban_created', v_actor_id, v_target_id,
    v_hash, v_result
  );
  return v_result;
end;
$function$;

create or replace function public.revoke_website_ban(
  p_actor_discord_user_id text,
  p_target_discord_user_id text,
  p_expected_ban_version bigint,
  p_reason text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor_id text := btrim(p_actor_discord_user_id);
  v_target_id text := btrim(p_target_discord_user_id);
  v_reason text := btrim(p_reason);
  v_payload jsonb;
  v_hash text;
  v_existing public.website_ban_requests%rowtype;
  v_target public.user_logs%rowtype;
  v_actor_username text;
  v_now timestamptz := transaction_timestamp();
  v_result jsonb;
begin
  if p_idempotency_key is null or p_expected_ban_version is null
    or p_expected_ban_version < 0 or char_length(v_reason) not between 3 and 1000 then
    raise exception using errcode = '22023', message = 'INVALID_WEBSITE_UNBAN_REQUEST';
  end if;

  perform public.authorize_user_moderation_capability(v_actor_id, 'users.website_bans.revoke');
  v_payload := jsonb_build_object(
    'action', 'website_ban_revoked', 'actorDiscordUserId', v_actor_id,
    'targetDiscordUserId', v_target_id, 'expectedBanVersion', p_expected_ban_version,
    'reason', v_reason
  );
  v_hash := encode(extensions.digest(convert_to(v_payload::text, 'UTF8'), 'sha256'), 'hex');
  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));

  select * into v_existing
  from public.website_ban_requests
  where idempotency_key = p_idempotency_key;
  if found then
    if v_existing.request_hash = v_hash then
      return jsonb_set(v_existing.result, '{replayed}', 'true'::jsonb);
    end if;
    raise exception using errcode = 'PT409', message = 'WEBSITE_BAN_IDEMPOTENCY_CONFLICT';
  end if;

  if exists (
    select 1 from public.team_members where discord_user_id = v_target_id
  ) then
    raise exception using errcode = '42501', message = 'WEBSITE_BAN_TEAM_MEMBER_PROTECTED';
  end if;

  select * into v_target
  from public.user_logs
  where discord_user_id = v_target_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'WEBSITE_BAN_TARGET_NOT_FOUND';
  end if;
  if v_target.website_ban_version <> p_expected_ban_version then
    raise exception using errcode = 'PT409', message = 'WEBSITE_BAN_STALE_VERSION';
  end if;
  if not v_target.is_banned then
    raise exception using errcode = 'PT409', message = 'WEBSITE_BAN_NOT_ACTIVE';
  end if;

  select nullif(btrim(current_discord_username), '')
  into v_actor_username
  from public.user_logs
  where discord_user_id = v_actor_id;

  update public.user_logs
  set is_banned = false,
      ban_reason = null,
      ban_source = null,
      banned_at = null,
      banned_by_discord_user_id = null,
      banned_by_discord_username = null,
      unban_reason = v_reason,
      unbanned_at = v_now,
      unbanned_by_discord_user_id = v_actor_id,
      unbanned_by_discord_username = v_actor_username,
      website_ban_version = v_target.website_ban_version + 1
  where discord_user_id = v_target_id;

  insert into public.website_ban_events (
    action, target_discord_user_id, actor_discord_user_id, actor_username,
    source, reason, previous_is_banned, new_is_banned, ban_version, occurred_at
  ) values (
    'website_ban_revoked', v_target_id, v_actor_id, v_actor_username,
    'manual_revoke', v_reason, true, false, v_target.website_ban_version + 1, v_now
  );

  v_result := jsonb_build_object(
    'success', true,
    'targetDiscordUserId', v_target_id,
    'isBanned', false,
    'banVersion', v_target.website_ban_version + 1,
    'replayed', false
  );
  insert into public.website_ban_requests (
    idempotency_key, action, actor_discord_user_id, target_discord_user_id,
    request_hash, result
  ) values (
    p_idempotency_key, 'website_ban_revoked', v_actor_id, v_target_id,
    v_hash, v_result
  );
  return v_result;
end;
$function$;

alter function public.protect_website_ban_history() owner to postgres;
alter function public.authorize_user_moderation_capability(text, text) owner to postgres;
alter function public.apply_website_ban_contract(text, text, text, text) owner to postgres;
alter function public.ban_website_user_v2(text, text, bigint, text, text, uuid) owner to postgres;
alter function public.revoke_website_ban(text, text, bigint, text, uuid) owner to postgres;

revoke all on function public.protect_website_ban_history()
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.authorize_user_moderation_capability(text, text)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.apply_website_ban_contract(text, text, text, text)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.ban_website_user_v2(text, text, bigint, text, text, uuid)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.revoke_website_ban(text, text, bigint, text, uuid)
  from public, anon, authenticated, discord_bot, service_role;

grant execute on function public.ban_website_user_v2(text, text, bigint, text, text, uuid)
  to service_role;
grant execute on function public.revoke_website_ban(text, text, bigint, text, uuid)
  to service_role;

do $postflight$
begin
  if (select count(*) from public.capability_catalog) <> 16
    or (select count(*) from public.capability_catalog where is_active) <> 14
    or (
      select count(*)
      from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 14 then
    raise exception using
      errcode = '55000',
      message = 'USER_MODERATION_FINAL_CATALOG_MISMATCH';
  end if;

  if exists (select 1 from public.team_role_capabilities) then
    raise exception using
      errcode = '55000',
      message = 'USER_MODERATION_NEW_CAPABILITIES_MUST_START_UNGRANTED';
  end if;
end;
$postflight$;

commit;
