begin;

set local lock_timeout = '5s';
set local statement_timeout = '90s';

do $preflight$
begin
  if to_regclass('public.user_logs') is null
    or to_regclass('public.team_members') is null
    or to_regclass('public.team_roles') is null
    or to_regclass('public.capability_catalog') is null
    or to_regclass('public.team_role_capabilities') is null
  then
    raise exception using
      errcode = '55000',
      message = 'USER_OVERWATCH_DEPENDENCY_UNAVAILABLE';
  end if;

  if (select count(*) from public.capability_catalog) <> 52
    or (select count(*) from public.capability_catalog where is_active) <> 48
    or (
      select count(*) from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 48
    or exists (
      select 1 from public.capability_catalog
      where key in ('users.overwatch.view', 'users.overwatch.manage')
    )
  then
    raise exception using
      errcode = '55000',
      message = 'USER_OVERWATCH_CAPABILITY_BASELINE_MISMATCH';
  end if;

  if exists (
    select 1 from public.team_role_capabilities
    where capability_key in ('users.overwatch.view', 'users.overwatch.manage')
  ) then
    raise exception using
      errcode = '55000',
      message = 'USER_OVERWATCH_UNEXPECTED_GRANT';
  end if;

  if to_regclass('public.user_overwatch_generations') is not null
    or to_regclass('public.user_overwatch_current') is not null
    or to_regclass('public.user_overwatch_events') is not null
    or to_regclass('public.user_overwatch_requests') is not null
    or exists (
      select 1
      from pg_proc function_row
      join pg_namespace namespace_row
        on namespace_row.oid = function_row.pronamespace
      where namespace_row.nspname = 'public'
        and function_row.proname like '%user_overwatch%'
    )
  then
    raise exception using
      errcode = '55000',
      message = 'USER_OVERWATCH_ALREADY_PRESENT';
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
    'users.overwatch.view',
    'View Overwatch',
    'View the separate Team-only Overwatch active queue and immutable generation history without changing state.',
    'User Moderation',
    array[
      'View active Overwatch entries for known users.',
      'View removed Overwatch generations and immutable Add/Remove event history.',
      'View bounded internal reasons and Team actor snapshots required for second-opinion follow-up.'
    ]::text[],
    array[
      'Adding or removing Overwatch entries.',
      'Warnings, manual or automatic Flag Cases, Bans, Participation Holds, Reports, Comments, rankings, visibility, or participation changes.',
      'Member, public, generic Notification, Push, behavior telemetry, or role administration access.'
    ]::text[],
    'high', true, true, 1,
    '7e1209f7100bbd5e88b809e0b884752274b98757a439f93830cc65eadba09fa1'
  ),
  (
    'users.overwatch.manage',
    'Manage Overwatch',
    'Add or remove one exact Team-only Overwatch generation through confirmed, expected-state, idempotent atomic mutations.',
    'User Moderation',
    array[
      'Load only the minimal selected-user target and current-version projection needed for Add or Remove.',
      'Add one active generation for a known user with a bounded internal reason and fresh request UUID.',
      'Remove only the exact active generation with a bounded internal reason while preserving immutable history.'
    ]::text[],
    array[
      'Browsing active Overwatch entries or history without the independent View capability.',
      'Creating or changing Warnings, manual or automatic Flag Cases, Bans, Participation Holds, Reports, Comments, rankings, visibility, or participation.',
      'Member notifications, Push, behavior telemetry, role grants, Team membership, or Owner access.'
    ]::text[],
    'critical', true, true, 1,
    'c43286028bd86157fd3d316227dcdea429eb889939f7e3e05395ee18529de92b'
  );

create table public.user_overwatch_generations (
  entry_id uuid primary key default gen_random_uuid(),
  public_entry_id uuid not null unique default gen_random_uuid(),
  target_discord_user_id text not null
    references public.user_logs(discord_user_id)
    on update restrict on delete restrict,
  generation bigint not null check (generation > 0),
  opened_at timestamptz not null,
  opened_by_discord_user_id text not null
    references public.user_logs(discord_user_id)
    on update restrict on delete restrict,
  opened_by_display_name text,
  opened_by_role_key text not null
    references public.team_roles(key)
    on update restrict on delete restrict,
  recorded_at timestamptz not null default transaction_timestamp(),
  unique (target_discord_user_id, generation),
  unique (entry_id, target_discord_user_id, generation)
);

create table public.user_overwatch_current (
  entry_id uuid primary key,
  target_discord_user_id text not null,
  generation bigint not null,
  state text not null,
  row_version bigint not null default 1 check (row_version > 0),
  closed_at timestamptz,
  updated_at timestamptz not null,
  foreign key (entry_id, target_discord_user_id, generation)
    references public.user_overwatch_generations(
      entry_id, target_discord_user_id, generation
    ) on update restrict on delete restrict,
  constraint user_overwatch_current_state_check check (
    (state = 'active' and closed_at is null)
    or (state = 'removed' and closed_at is not null)
  )
);

create unique index user_overwatch_one_active_target_idx
  on public.user_overwatch_current(target_discord_user_id)
  where state = 'active';
create index user_overwatch_current_history_idx
  on public.user_overwatch_current(state, updated_at desc, entry_id);

create table public.user_overwatch_events (
  event_id bigint generated always as identity primary key,
  entry_id uuid not null,
  target_discord_user_id text not null,
  generation bigint not null,
  event_type text not null check (event_type in ('added', 'removed')),
  reason text not null
    check (char_length(btrim(reason)) between 3 and 1000),
  actor_discord_user_id text not null
    references public.user_logs(discord_user_id)
    on update restrict on delete restrict,
  actor_display_name text,
  actor_role_key text not null
    references public.team_roles(key)
    on update restrict on delete restrict,
  entry_row_version bigint not null check (entry_row_version > 0),
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default transaction_timestamp(),
  foreign key (entry_id, target_discord_user_id, generation)
    references public.user_overwatch_generations(
      entry_id, target_discord_user_id, generation
    ) on update restrict on delete restrict,
  unique (entry_id, event_type),
  unique (entry_id, entry_row_version)
);

create index user_overwatch_events_history_idx
  on public.user_overwatch_events(entry_id, event_id);

create table public.user_overwatch_requests (
  request_id uuid primary key,
  operation text not null check (operation in ('add', 'remove')),
  actor_discord_user_id text not null
    references public.user_logs(discord_user_id)
    on update restrict on delete restrict,
  target_discord_user_id text not null
    references public.user_logs(discord_user_id)
    on update restrict on delete restrict,
  entry_id uuid not null
    references public.user_overwatch_generations(entry_id)
    on update restrict on delete restrict,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  request_payload jsonb not null check (jsonb_typeof(request_payload) = 'object'),
  receipt jsonb not null check (jsonb_typeof(receipt) = 'object'),
  created_at timestamptz not null default transaction_timestamp()
);

create index user_overwatch_requests_target_idx
  on public.user_overwatch_requests(target_discord_user_id, created_at);

alter table public.user_overwatch_generations enable row level security;
alter table public.user_overwatch_current enable row level security;
alter table public.user_overwatch_events enable row level security;
alter table public.user_overwatch_requests enable row level security;

create function public.protect_user_overwatch_append_only()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $function$
begin
  raise exception using
    errcode = '55000',
    message = 'USER_OVERWATCH_HISTORY_IS_APPEND_ONLY';
end;
$function$;

create trigger protect_user_overwatch_generations
before update or delete on public.user_overwatch_generations
for each row execute function public.protect_user_overwatch_append_only();
create trigger protect_user_overwatch_events
before update or delete on public.user_overwatch_events
for each row execute function public.protect_user_overwatch_append_only();
create trigger protect_user_overwatch_requests
before update or delete on public.user_overwatch_requests
for each row execute function public.protect_user_overwatch_append_only();

create function public.protect_user_overwatch_current()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception using
      errcode = '55000',
      message = 'USER_OVERWATCH_CURRENT_TRANSITION_FORBIDDEN';
  end if;

  if new.entry_id <> old.entry_id
    or new.target_discord_user_id <> old.target_discord_user_id
    or new.generation <> old.generation
    or old.state <> 'active'
    or new.state <> 'removed'
    or old.closed_at is not null
    or new.closed_at is null
    or new.row_version <> old.row_version + 1
    or new.updated_at < old.updated_at
  then
    raise exception using
      errcode = '55000',
      message = 'USER_OVERWATCH_CURRENT_TRANSITION_FORBIDDEN';
  end if;
  return new;
end;
$function$;

create trigger protect_user_overwatch_current_transition
before update or delete on public.user_overwatch_current
for each row execute function public.protect_user_overwatch_current();

create function public.authorize_user_overwatch_capability(
  p_actor_discord_user_id text,
  p_capability_key text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor_id text := btrim(p_actor_discord_user_id);
  v_role_key text;
  v_expected_hash text;
begin
  v_expected_hash := case p_capability_key
    when 'users.overwatch.view' then
      '7e1209f7100bbd5e88b809e0b884752274b98757a439f93830cc65eadba09fa1'
    when 'users.overwatch.manage' then
      'c43286028bd86157fd3d316227dcdea429eb889939f7e3e05395ee18529de92b'
    else null
  end;

  if nullif(v_actor_id, '') is null or v_expected_hash is null then
    raise exception using errcode = '42501', message = 'USER_OVERWATCH_FORBIDDEN';
  end if;

  if not exists (
    select 1
    from public.capability_catalog capability
    where capability.key = p_capability_key
      and capability.is_active
      and capability.assignable_to_non_admin
      and capability.implementation_version = 1
      and capability.definition_hash = v_expected_hash
  ) then
    raise exception using
      errcode = '55000',
      message = 'USER_OVERWATCH_CAPABILITY_DEPENDENCY_UNAVAILABLE';
  end if;

  select member.role
  into v_role_key
  from public.team_members member
  join public.team_roles role
    on role.key = member.role
   and role.is_active
  where member.discord_user_id = v_actor_id;

  if not found
    or (
      v_role_key <> 'admin'
      and not exists (
        select 1
        from public.team_role_capabilities grant_row
        where grant_row.role_key = v_role_key
          and grant_row.capability_key = p_capability_key
      )
    )
  then
    raise exception using errcode = '42501', message = 'USER_OVERWATCH_FORBIDDEN';
  end if;

  return v_role_key;
end;
$function$;

create function public.get_user_overwatch_manage_target(
  p_actor_discord_user_id text,
  p_target_discord_user_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_target_id text := btrim(p_target_discord_user_id);
  v_public_entry_id uuid;
  v_generation bigint;
  v_state text;
  v_row_version bigint;
begin
  perform public.authorize_user_overwatch_capability(
    p_actor_discord_user_id,
    'users.overwatch.manage'
  );

  if nullif(v_target_id, '') is null or not exists (
    select 1 from public.user_logs user_row
    where user_row.discord_user_id = v_target_id
  ) then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  select
    generation_row.public_entry_id,
    generation_row.generation,
    current_row.state,
    current_row.row_version
  into v_public_entry_id, v_generation, v_state, v_row_version
  from public.user_overwatch_generations generation_row
  join public.user_overwatch_current current_row
    on current_row.entry_id = generation_row.entry_id
  where generation_row.target_discord_user_id = v_target_id
  order by generation_row.generation desc
  limit 1;

  if not found then
    return jsonb_build_object(
      'outcome', 'found',
      'targetDiscordUserId', v_target_id,
      'currentState', 'absent',
      'entryId', null,
      'generation', 0,
      'rowVersion', 0
    );
  end if;

  return jsonb_build_object(
    'outcome', 'found',
    'targetDiscordUserId', v_target_id,
    'currentState', v_state,
    'entryId', v_public_entry_id,
    'generation', v_generation,
    'rowVersion', v_row_version
  );
end;
$function$;

create function public.list_user_overwatch_entries(
  p_actor_discord_user_id text,
  p_section text,
  p_limit integer,
  p_offset integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_items jsonb;
begin
  perform public.authorize_user_overwatch_capability(
    p_actor_discord_user_id,
    'users.overwatch.view'
  );

  if p_section not in ('active', 'history')
    or p_limit not between 1 and 100
    or p_offset not between 0 and 10000
  then
    raise exception using
      errcode = '22023',
      message = 'USER_OVERWATCH_LIST_INPUT_INVALID';
  end if;

  select coalesce(jsonb_agg(item.payload order by item.sort_at desc, item.entry_id), '[]'::jsonb)
  into v_items
  from (
    select
      generation_row.entry_id,
      current_row.updated_at as sort_at,
      jsonb_build_object(
        'entryId', generation_row.public_entry_id,
        'targetDiscordUserId', generation_row.target_discord_user_id,
        'publicProfileId', user_row.public_profile_id,
        'currentDiscordUsername', user_row.current_discord_username,
        'currentDiscordHandle', user_row.current_discord_handle,
        'currentDisplayName', user_row.current_display_name,
        'currentGuildNickname', user_row.current_guild_nickname,
        'generation', generation_row.generation,
        'state', current_row.state,
        'rowVersion', current_row.row_version,
        'openedAt', generation_row.opened_at,
        'closedAt', current_row.closed_at,
        'events', coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'eventType', event_row.event_type,
              'reason', event_row.reason,
              'actorDisplayName', event_row.actor_display_name,
              'actorRoleKey', event_row.actor_role_key,
              'entryRowVersion', event_row.entry_row_version,
              'occurredAt', event_row.occurred_at
            ) order by event_row.event_id
          )
          from public.user_overwatch_events event_row
          where event_row.entry_id = generation_row.entry_id
        ), '[]'::jsonb)
      ) as payload
    from public.user_overwatch_generations generation_row
    join public.user_overwatch_current current_row
      on current_row.entry_id = generation_row.entry_id
    join public.user_logs user_row
      on user_row.discord_user_id = generation_row.target_discord_user_id
    where (p_section = 'active' and current_row.state = 'active')
       or (p_section = 'history' and current_row.state = 'removed')
    order by current_row.updated_at desc, generation_row.entry_id
    limit p_limit offset p_offset
  ) item;

  return jsonb_build_object('items', v_items);
end;
$function$;

create function public.add_user_to_overwatch(
  p_actor_discord_user_id text,
  p_target_discord_user_id text,
  p_expected_state text,
  p_expected_row_version bigint,
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
  v_target_id text := btrim(p_target_discord_user_id);
  v_reason text := btrim(p_reason);
  v_role_key text;
  v_actor_display text;
  v_latest_generation bigint;
  v_latest_state text;
  v_latest_version bigint;
  v_entry_id uuid;
  v_public_entry_id uuid;
  v_generation bigint;
  v_now timestamptz;
  v_request_payload jsonb;
  v_request_hash text;
  v_existing_hash text;
  v_existing_receipt jsonb;
  v_receipt jsonb;
begin
  if nullif(v_target_id, '') is null
    or p_expected_state not in ('absent', 'removed')
    or p_expected_row_version is null
    or p_expected_row_version < 0
    or (p_expected_state = 'absent' and p_expected_row_version <> 0)
    or (p_expected_state = 'removed' and p_expected_row_version <= 0)
    or char_length(v_reason) not between 3 and 1000
    or p_request_id is null
  then
    raise exception using
      errcode = '22023',
      message = 'USER_OVERWATCH_ADD_INPUT_INVALID';
  end if;

  v_role_key := public.authorize_user_overwatch_capability(
    v_actor_id,
    'users.overwatch.manage'
  );
  v_request_payload := jsonb_build_object(
    'operation', 'add',
    'operationVersion', 1,
    'actorDiscordUserId', v_actor_id,
    'targetDiscordUserId', v_target_id,
    'expectedState', p_expected_state,
    'expectedRowVersion', p_expected_row_version,
    'reason', v_reason
  );
  v_request_hash := encode(
    extensions.digest(convert_to(v_request_payload::text, 'UTF8'), 'sha256'),
    'hex'
  );

  perform pg_advisory_xact_lock(
    hashtextextended('user-overwatch-request:' || p_request_id::text, 0)
  );
  select request_hash, receipt
  into v_existing_hash, v_existing_receipt
  from public.user_overwatch_requests request_row
  where request_row.request_id = p_request_id;
  if found then
    if v_existing_hash = v_request_hash then
      return jsonb_set(v_existing_receipt, '{replayed}', 'true'::jsonb);
    end if;
    raise exception using
      errcode = 'PT409',
      message = 'USER_OVERWATCH_IDEMPOTENCY_CONFLICT';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('user-overwatch-target:' || v_target_id, 0)
  );
  if not exists (
    select 1 from public.user_logs user_row
    where user_row.discord_user_id = v_target_id
  ) then
    raise exception using errcode = 'P0002', message = 'USER_OVERWATCH_TARGET_NOT_FOUND';
  end if;

  select generation_row.generation, current_row.state, current_row.row_version
  into v_latest_generation, v_latest_state, v_latest_version
  from public.user_overwatch_generations generation_row
  join public.user_overwatch_current current_row
    on current_row.entry_id = generation_row.entry_id
  where generation_row.target_discord_user_id = v_target_id
  order by generation_row.generation desc
  limit 1;

  if not found then
    v_latest_generation := 0;
    v_latest_state := 'absent';
    v_latest_version := 0;
  end if;
  if v_latest_state <> p_expected_state
    or v_latest_version <> p_expected_row_version
  then
    raise exception using errcode = 'PT409', message = 'USER_OVERWATCH_STALE_STATE';
  end if;

  v_generation := v_latest_generation + 1;
  v_now := clock_timestamp();
  select nullif(btrim(current_discord_username), '')
  into v_actor_display
  from public.user_logs user_row
  where user_row.discord_user_id = v_actor_id;

  insert into public.user_overwatch_generations (
    target_discord_user_id,
    generation,
    opened_at,
    opened_by_discord_user_id,
    opened_by_display_name,
    opened_by_role_key
  ) values (
    v_target_id,
    v_generation,
    v_now,
    v_actor_id,
    v_actor_display,
    v_role_key
  ) returning entry_id, public_entry_id into v_entry_id, v_public_entry_id;

  insert into public.user_overwatch_current (
    entry_id,
    target_discord_user_id,
    generation,
    state,
    row_version,
    closed_at,
    updated_at
  ) values (
    v_entry_id, v_target_id, v_generation, 'active', 1, null, v_now
  );

  insert into public.user_overwatch_events (
    entry_id,
    target_discord_user_id,
    generation,
    event_type,
    reason,
    actor_discord_user_id,
    actor_display_name,
    actor_role_key,
    entry_row_version,
    occurred_at
  ) values (
    v_entry_id, v_target_id, v_generation, 'added', v_reason,
    v_actor_id, v_actor_display, v_role_key, 1, v_now
  );

  v_receipt := jsonb_build_object(
    'operation', 'add',
    'entryId', v_public_entry_id,
    'targetDiscordUserId', v_target_id,
    'generation', v_generation,
    'state', 'active',
    'rowVersion', 1,
    'occurredAt', v_now,
    'replayed', false
  );
  insert into public.user_overwatch_requests (
    request_id, operation, actor_discord_user_id, target_discord_user_id,
    entry_id, request_hash, request_payload, receipt
  ) values (
    p_request_id, 'add', v_actor_id, v_target_id,
    v_entry_id, v_request_hash, v_request_payload, v_receipt
  );
  return v_receipt;
end;
$function$;

create function public.remove_user_from_overwatch(
  p_actor_discord_user_id text,
  p_target_discord_user_id text,
  p_public_entry_id uuid,
  p_expected_state text,
  p_expected_row_version bigint,
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
  v_target_id text := btrim(p_target_discord_user_id);
  v_reason text := btrim(p_reason);
  v_role_key text;
  v_actor_display text;
  v_entry public.user_overwatch_generations%rowtype;
  v_current public.user_overwatch_current%rowtype;
  v_now timestamptz;
  v_new_version bigint;
  v_request_payload jsonb;
  v_request_hash text;
  v_existing_hash text;
  v_existing_receipt jsonb;
  v_receipt jsonb;
begin
  if nullif(v_target_id, '') is null
    or p_public_entry_id is null
    or p_expected_state <> 'active'
    or p_expected_row_version is null
    or p_expected_row_version <= 0
    or char_length(v_reason) not between 3 and 1000
    or p_request_id is null
  then
    raise exception using
      errcode = '22023',
      message = 'USER_OVERWATCH_REMOVE_INPUT_INVALID';
  end if;

  v_role_key := public.authorize_user_overwatch_capability(
    v_actor_id,
    'users.overwatch.manage'
  );
  v_request_payload := jsonb_build_object(
    'operation', 'remove',
    'operationVersion', 1,
    'actorDiscordUserId', v_actor_id,
    'targetDiscordUserId', v_target_id,
    'entryId', p_public_entry_id,
    'expectedState', p_expected_state,
    'expectedRowVersion', p_expected_row_version,
    'reason', v_reason
  );
  v_request_hash := encode(
    extensions.digest(convert_to(v_request_payload::text, 'UTF8'), 'sha256'),
    'hex'
  );

  perform pg_advisory_xact_lock(
    hashtextextended('user-overwatch-request:' || p_request_id::text, 0)
  );
  select request_hash, receipt
  into v_existing_hash, v_existing_receipt
  from public.user_overwatch_requests request_row
  where request_row.request_id = p_request_id;
  if found then
    if v_existing_hash = v_request_hash then
      return jsonb_set(v_existing_receipt, '{replayed}', 'true'::jsonb);
    end if;
    raise exception using
      errcode = 'PT409',
      message = 'USER_OVERWATCH_IDEMPOTENCY_CONFLICT';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('user-overwatch-target:' || v_target_id, 0)
  );
  select generation_row.*
  into v_entry
  from public.user_overwatch_generations generation_row
  where generation_row.public_entry_id = p_public_entry_id
    and generation_row.target_discord_user_id = v_target_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'USER_OVERWATCH_TARGET_NOT_FOUND';
  end if;
  select current_row.*
  into v_current
  from public.user_overwatch_current current_row
  where current_row.entry_id = v_entry.entry_id
  for update;
  if not found then
    raise exception using
      errcode = '55000',
      message = 'USER_OVERWATCH_CURRENT_PROJECTION_UNAVAILABLE';
  end if;
  if v_current.state <> p_expected_state
    or v_current.row_version <> p_expected_row_version
  then
    raise exception using errcode = 'PT409', message = 'USER_OVERWATCH_STALE_STATE';
  end if;

  v_now := clock_timestamp();
  select nullif(btrim(current_discord_username), '')
  into v_actor_display
  from public.user_logs user_row
  where user_row.discord_user_id = v_actor_id;

  update public.user_overwatch_current
  set state = 'removed',
      row_version = row_version + 1,
      closed_at = v_now,
      updated_at = v_now
  where entry_id = v_entry.entry_id
  returning row_version into v_new_version;

  insert into public.user_overwatch_events (
    entry_id,
    target_discord_user_id,
    generation,
    event_type,
    reason,
    actor_discord_user_id,
    actor_display_name,
    actor_role_key,
    entry_row_version,
    occurred_at
  ) values (
    v_entry.entry_id, v_target_id, v_entry.generation, 'removed', v_reason,
    v_actor_id, v_actor_display, v_role_key, v_new_version, v_now
  );

  v_receipt := jsonb_build_object(
    'operation', 'remove',
    'entryId', v_entry.public_entry_id,
    'targetDiscordUserId', v_target_id,
    'generation', v_entry.generation,
    'state', 'removed',
    'rowVersion', v_new_version,
    'occurredAt', v_now,
    'replayed', false
  );
  insert into public.user_overwatch_requests (
    request_id, operation, actor_discord_user_id, target_discord_user_id,
    entry_id, request_hash, request_payload, receipt
  ) values (
    p_request_id, 'remove', v_actor_id, v_target_id,
    v_entry.entry_id, v_request_hash, v_request_payload, v_receipt
  );
  return v_receipt;
end;
$function$;

alter table public.user_overwatch_generations owner to postgres;
alter table public.user_overwatch_current owner to postgres;
alter table public.user_overwatch_events owner to postgres;
alter table public.user_overwatch_requests owner to postgres;
alter sequence public.user_overwatch_events_event_id_seq owner to postgres;

alter function public.protect_user_overwatch_append_only() owner to postgres;
alter function public.protect_user_overwatch_current() owner to postgres;
alter function public.authorize_user_overwatch_capability(text,text) owner to postgres;
alter function public.get_user_overwatch_manage_target(text,text) owner to postgres;
alter function public.list_user_overwatch_entries(text,text,integer,integer) owner to postgres;
alter function public.add_user_to_overwatch(text,text,text,bigint,text,uuid) owner to postgres;
alter function public.remove_user_from_overwatch(text,text,uuid,text,bigint,text,uuid) owner to postgres;

revoke all on table public.user_overwatch_generations
  from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.user_overwatch_current
  from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.user_overwatch_events
  from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.user_overwatch_requests
  from public, anon, authenticated, discord_bot, service_role;
revoke all on sequence public.user_overwatch_events_event_id_seq
  from public, anon, authenticated, discord_bot, service_role;

revoke all on function public.protect_user_overwatch_append_only()
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.protect_user_overwatch_current()
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.authorize_user_overwatch_capability(text,text)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_user_overwatch_manage_target(text,text)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.list_user_overwatch_entries(text,text,integer,integer)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.add_user_to_overwatch(text,text,text,bigint,text,uuid)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.remove_user_from_overwatch(text,text,uuid,text,bigint,text,uuid)
  from public, anon, authenticated, discord_bot, service_role;

grant execute on function public.get_user_overwatch_manage_target(text,text)
  to service_role;
grant execute on function public.list_user_overwatch_entries(text,text,integer,integer)
  to service_role;
grant execute on function public.add_user_to_overwatch(text,text,text,bigint,text,uuid)
  to service_role;
grant execute on function public.remove_user_from_overwatch(text,text,uuid,text,bigint,text,uuid)
  to service_role;

do $security_postflight$
declare
  v_signature text;
  v_table text;
  v_service_signatures text[] := array[
    'public.get_user_overwatch_manage_target(text,text)',
    'public.list_user_overwatch_entries(text,text,integer,integer)',
    'public.add_user_to_overwatch(text,text,text,bigint,text,uuid)',
    'public.remove_user_from_overwatch(text,text,uuid,text,bigint,text,uuid)'
  ];
  v_internal_definer_signatures text[] := array[
    'public.authorize_user_overwatch_capability(text,text)'
  ];
  v_internal_invoker_signatures text[] := array[
    'public.protect_user_overwatch_append_only()',
    'public.protect_user_overwatch_current()'
  ];
  v_tables text[] := array[
    'user_overwatch_generations',
    'user_overwatch_current',
    'user_overwatch_events',
    'user_overwatch_requests'
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
        message = 'USER_OVERWATCH_SERVICE_FUNCTION_SECURITY_MISMATCH',
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
        message = 'USER_OVERWATCH_INTERNAL_FUNCTION_SECURITY_MISMATCH',
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
        message = 'USER_OVERWATCH_INVOKER_FUNCTION_SECURITY_MISMATCH',
        detail = v_signature;
    end if;
  end loop;

  if exists (
    select 1
    from pg_proc function_row
    join pg_namespace namespace_row
      on namespace_row.oid = function_row.pronamespace
    where namespace_row.nspname = 'public'
      and function_row.proname like '%user_overwatch%'
      and function_row.oid <> all((
        v_service_signatures
        || v_internal_definer_signatures
        || v_internal_invoker_signatures
      )::regprocedure[])
  ) then
    raise exception using
      errcode = '55000',
      message = 'USER_OVERWATCH_FUNCTION_OVERLOAD_MISMATCH';
  end if;

  foreach v_table in array v_tables loop
    if not exists (
      select 1 from pg_class table_row
      where table_row.oid = format('public.%I', v_table)::regclass
        and table_row.relrowsecurity
        and pg_get_userbyid(table_row.relowner) = 'postgres'
    )
      or exists (
        select 1 from pg_policy policy_row
        where policy_row.polrelid = format('public.%I', v_table)::regclass
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
        message = 'USER_OVERWATCH_TABLE_SECURITY_MISMATCH',
        detail = v_table;
    end if;
  end loop;

  if (select count(*) from public.capability_catalog) <> 54
    or (select count(*) from public.capability_catalog where is_active) <> 50
    or (
      select count(*) from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 50
    or (
      select count(*) from public.capability_catalog
      where key in ('users.overwatch.view', 'users.overwatch.manage')
        and is_active
        and assignable_to_non_admin
        and implementation_version = 1
    ) <> 2
    or exists (
      select 1 from public.team_role_capabilities
      where capability_key in ('users.overwatch.view', 'users.overwatch.manage')
    )
    or exists (select 1 from public.user_overwatch_generations)
    or exists (select 1 from public.user_overwatch_current)
    or exists (select 1 from public.user_overwatch_events)
    or exists (select 1 from public.user_overwatch_requests)
    or has_sequence_privilege(
      'service_role', 'public.user_overwatch_events_event_id_seq', 'USAGE'
    )
  then
    raise exception using
      errcode = '55000',
      message = 'USER_OVERWATCH_POSTFLIGHT_MISMATCH';
  end if;
end;
$security_postflight$;

comment on table public.user_overwatch_generations is
  'Immutable Team-only Overwatch generation identity. Overwatch is a bookmark and second-opinion queue, never a sanction, Flag, Warning or telemetry source.';
comment on table public.user_overwatch_current is
  'Current state for each immutable Overwatch generation. Removal is the sole allowed transition and never deletes history.';
comment on table public.user_overwatch_events is
  'Append-only Add and Remove audit history with bounded internal reasons and Team actor snapshots.';
comment on table public.user_overwatch_requests is
  'Append-only global request-id ledger for idempotent Overwatch Add and Remove mutations.';

commit;
