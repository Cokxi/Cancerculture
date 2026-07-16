begin;

alter table public.discord_member_state
  add column if not exists discord_ban_active boolean not null default false,
  add column if not exists discord_banned_at timestamptz,
  add column if not exists discord_unbanned_at timestamptz,
  add column if not exists discord_ban_observed_at timestamptz,
  add column if not exists discord_membership_observed_at timestamptz;

alter table public.discord_member_state
  drop constraint if exists discord_member_state_ban_excludes_membership;

alter table public.discord_member_state
  add constraint discord_member_state_ban_excludes_membership
  check (not discord_ban_active or not is_in_discord);

create index if not exists discord_member_state_active_ban_idx
  on public.discord_member_state (discord_ban_observed_at desc)
  where discord_ban_active = true;

create index if not exists discord_member_state_membership_observed_idx
  on public.discord_member_state (discord_membership_observed_at desc);

create table if not exists public.discord_membership_sync_events (
  event_id text primary key,
  event_type text not null,
  observed_at timestamptz not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  result_status text not null default 'received',
  payload_sha256 text not null,
  expires_at timestamptz not null default (now() + interval '7 days'),
  constraint discord_membership_sync_events_event_id_check
    check (length(event_id) between 8 and 128),
  constraint discord_membership_sync_events_type_check
    check (event_type in (
      'member_joined',
      'member_removed',
      'ban_added',
      'ban_removed',
      'snapshot_started',
      'snapshot_members_chunk',
      'snapshot_bans_chunk',
      'snapshot_finalize',
      'reconciliation_failed'
    )),
  constraint discord_membership_sync_events_result_check
    check (result_status in (
      'received',
      'applied',
      'no_change',
      'stale',
      'replay',
      'rejected',
      'failed'
    )),
  constraint discord_membership_sync_events_hash_check
    check (payload_sha256 ~ '^[0-9a-f]{64}$')
);

create index if not exists discord_membership_sync_events_expires_idx
  on public.discord_membership_sync_events (expires_at);

create table if not exists public.discord_reconciliation_snapshots (
  id uuid primary key,
  observed_at timestamptz not null,
  status text not null default 'collecting',
  expected_member_count integer not null,
  expected_ban_count integer not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '1 hour'),
  finalized_at timestamptz,
  error_code text,
  constraint discord_reconciliation_snapshots_status_check
    check (status in ('collecting', 'applied', 'failed', 'expired')),
  constraint discord_reconciliation_snapshots_counts_check
    check (
      expected_member_count between 0 and 1000000
      and expected_ban_count between 0 and 1000000
    ),
  constraint discord_reconciliation_snapshots_error_check
    check (error_code is null or error_code ~ '^[A-Z0-9_]{1,80}$')
);

create index if not exists discord_reconciliation_snapshots_status_idx
  on public.discord_reconciliation_snapshots (status, expires_at);

create table if not exists public.discord_reconciliation_members (
  snapshot_id uuid not null
    references public.discord_reconciliation_snapshots(id) on delete cascade,
  discord_user_id text not null,
  discord_username text not null,
  primary key (snapshot_id, discord_user_id),
  constraint discord_reconciliation_members_user_check
    check (discord_user_id ~ '^[0-9]{5,32}$'),
  constraint discord_reconciliation_members_username_check
    check (length(discord_username) between 1 and 100)
);

create table if not exists public.discord_reconciliation_bans (
  snapshot_id uuid not null
    references public.discord_reconciliation_snapshots(id) on delete cascade,
  discord_user_id text not null,
  discord_username text not null,
  primary key (snapshot_id, discord_user_id),
  constraint discord_reconciliation_bans_user_check
    check (discord_user_id ~ '^[0-9]{5,32}$'),
  constraint discord_reconciliation_bans_username_check
    check (length(discord_username) between 1 and 100)
);

create table if not exists public.discord_sync_health (
  id smallint primary key default 1,
  last_event_at timestamptz,
  last_reconciliation_started_at timestamptz,
  last_reconciliation_succeeded_at timestamptz,
  last_ban_snapshot_at timestamptz,
  last_membership_snapshot_at timestamptz,
  last_error_at timestamptz,
  last_error_code text,
  updated_at timestamptz not null default now(),
  constraint discord_sync_health_singleton_check check (id = 1),
  constraint discord_sync_health_error_check
    check (last_error_code is null or last_error_code ~ '^[A-Z0-9_]{1,80}$')
);

insert into public.discord_sync_health (id)
values (1)
on conflict (id) do nothing;

alter table public.discord_membership_sync_events enable row level security;
alter table public.discord_reconciliation_snapshots enable row level security;
alter table public.discord_reconciliation_members enable row level security;
alter table public.discord_reconciliation_bans enable row level security;
alter table public.discord_sync_health enable row level security;

create or replace function public.claim_discord_membership_sync_event(
  p_event_id text,
  p_event_type text,
  p_observed_at timestamptz,
  p_payload_sha256 text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing public.discord_membership_sync_events%rowtype;
begin
  if p_event_id is null
    or length(p_event_id) not between 8 and 128
    or p_event_type is null
    or p_observed_at is null
    or p_payload_sha256 is null
    or p_payload_sha256 !~ '^[0-9a-f]{64}$'
  then
    return 'invalid';
  end if;

  insert into public.discord_membership_sync_events (
    event_id,
    event_type,
    observed_at,
    payload_sha256
  ) values (
    p_event_id,
    p_event_type,
    p_observed_at,
    p_payload_sha256
  )
  on conflict (event_id) do nothing;

  if found then
    return 'claimed';
  end if;

  select *
  into v_existing
  from public.discord_membership_sync_events
  where event_id = p_event_id;

  if v_existing.event_type = p_event_type
    and v_existing.payload_sha256 = p_payload_sha256
  then
    return 'replay';
  end if;

  return 'conflict';
end;
$$;

create or replace function public.finish_discord_membership_sync_event(
  p_event_id text,
  p_result_status text
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.discord_membership_sync_events
  set
    result_status = p_result_status,
    processed_at = now()
  where event_id = p_event_id;
$$;

create or replace function public.audit_discord_sync_action(
  p_action text,
  p_discord_user_id text,
  p_meta jsonb default '{}'::jsonb
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.admin_action_logs (
    actor_type,
    actor_id,
    action,
    target_type,
    target_id,
    meta
  ) values (
    'discord_sync',
    'membership_endpoint',
    p_action,
    case when p_discord_user_id is null then 'discord_sync' else 'discord_user' end,
    p_discord_user_id,
    coalesce(p_meta, '{}'::jsonb)
  );
$$;

create or replace function public.apply_discord_live_event(
  p_event_id text,
  p_event_type text,
  p_observed_at timestamptz,
  p_payload_sha256 text,
  p_discord_user_id text,
  p_discord_username text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_claim text;
  v_state public.discord_member_state%rowtype;
  v_result text := 'no_change';
  v_revoked_sessions integer := 0;
  v_was_member boolean;
  v_was_banned boolean;
begin
  if p_event_type not in (
    'member_joined',
    'member_removed',
    'ban_added',
    'ban_removed'
  )
    or p_discord_user_id is null
    or p_discord_user_id !~ '^[0-9]{5,32}$'
    or p_discord_username is null
    or length(btrim(p_discord_username)) not between 1 and 100
  then
    return jsonb_build_object('outcome', 'invalid_request');
  end if;

  v_claim := public.claim_discord_membership_sync_event(
    p_event_id,
    p_event_type,
    p_observed_at,
    p_payload_sha256
  );

  if v_claim = 'replay' then
    return jsonb_build_object('outcome', 'replay');
  elsif v_claim <> 'claimed' then
    return jsonb_build_object('outcome', 'invalid_event');
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('discord-member:' || p_discord_user_id, 0)
  );

  select *
  into v_state
  from public.discord_member_state
  where discord_user_id = p_discord_user_id
  for update;

  if not found then
    insert into public.discord_member_state (
      discord_user_id,
      current_discord_username,
      discord_joined_at,
      left_discord_at,
      is_in_discord,
      discord_ban_active,
      discord_membership_observed_at,
      discord_ban_observed_at,
      updated_at
    ) values (
      p_discord_user_id,
      btrim(p_discord_username),
      null,
      null,
      false,
      false,
      null,
      null,
      now()
    )
    returning * into v_state;
  end if;

  v_was_member := v_state.is_in_discord;
  v_was_banned := v_state.discord_ban_active;

  if p_event_type in ('member_joined', 'member_removed')
    and v_state.discord_membership_observed_at is not null
    and p_observed_at < v_state.discord_membership_observed_at
  then
    v_result := 'stale';
  elsif p_event_type = 'member_joined' then
    if v_state.discord_ban_active then
      v_result := 'stale';
    elsif v_state.is_in_discord then
      update public.discord_member_state
      set
        current_discord_username = btrim(p_discord_username),
        discord_membership_observed_at = greatest(
          discord_membership_observed_at,
          p_observed_at
        ),
        updated_at = now()
      where discord_user_id = p_discord_user_id;
      v_result := 'no_change';
    else
      update public.discord_member_state
      set
        current_discord_username = btrim(p_discord_username),
        is_in_discord = true,
        discord_joined_at = p_observed_at,
        left_discord_at = null,
        discord_membership_observed_at = p_observed_at,
        updated_at = now()
      where discord_user_id = p_discord_user_id;
      v_result := 'applied';
      perform public.audit_discord_sync_action(
        'discord_member_joined',
        p_discord_user_id,
        jsonb_build_object('source', 'live_event')
      );
    end if;
  elsif p_event_type = 'member_removed' then
    update public.discord_member_state
    set
      current_discord_username = btrim(p_discord_username),
      is_in_discord = false,
      left_discord_at = case
        when is_in_discord then p_observed_at
        else coalesce(left_discord_at, p_observed_at)
      end,
      discord_membership_observed_at = greatest(
        coalesce(discord_membership_observed_at, '-infinity'::timestamptz),
        p_observed_at
      ),
      updated_at = now()
    where discord_user_id = p_discord_user_id;

    update public.sessions
    set revoked_at = coalesce(revoked_at, p_observed_at)
    where discord_user_id = p_discord_user_id
      and revoked_at is null;
    get diagnostics v_revoked_sessions = row_count;

    if v_was_member then
      v_result := 'applied';
      perform public.audit_discord_sync_action(
        'discord_member_removed',
        p_discord_user_id,
        jsonb_build_object(
          'source', 'live_event',
          'sessionsRevoked', v_revoked_sessions
        )
      );
    else
      v_result := 'no_change';
    end if;
  elsif p_event_type = 'ban_added' then
    if v_state.discord_ban_observed_at is not null
      and p_observed_at < v_state.discord_ban_observed_at
    then
      v_result := 'stale';
    else
      update public.discord_member_state
      set
        current_discord_username = btrim(p_discord_username),
        discord_ban_active = true,
        discord_banned_at = case
          when discord_ban_active then discord_banned_at
          else p_observed_at
        end,
        discord_ban_observed_at = p_observed_at,
        is_in_discord = false,
        left_discord_at = case
          when is_in_discord then p_observed_at
          else coalesce(left_discord_at, p_observed_at)
        end,
        discord_membership_observed_at = greatest(
          coalesce(discord_membership_observed_at, '-infinity'::timestamptz),
          p_observed_at
        ),
        updated_at = now()
      where discord_user_id = p_discord_user_id;

      update public.sessions
      set revoked_at = coalesce(revoked_at, p_observed_at)
      where discord_user_id = p_discord_user_id
        and revoked_at is null;
      get diagnostics v_revoked_sessions = row_count;

      if not v_was_banned or v_revoked_sessions > 0 then
        v_result := 'applied';
        perform public.audit_discord_sync_action(
          'discord_ban_detected',
          p_discord_user_id,
          jsonb_build_object(
            'source', 'live_event',
            'sessionsRevoked', v_revoked_sessions
          )
        );
      else
        v_result := 'no_change';
      end if;
    end if;
  elsif p_event_type = 'ban_removed' then
    if v_state.discord_ban_observed_at is not null
      and p_observed_at <= v_state.discord_ban_observed_at
    then
      v_result := 'stale';
    else
      update public.discord_member_state
      set
        current_discord_username = btrim(p_discord_username),
        discord_ban_active = false,
        discord_unbanned_at = p_observed_at,
        discord_ban_observed_at = p_observed_at,
        is_in_discord = false,
        discord_joined_at = null,
        left_discord_at = coalesce(left_discord_at, p_observed_at),
        discord_membership_observed_at = greatest(
          coalesce(discord_membership_observed_at, '-infinity'::timestamptz),
          p_observed_at
        ),
        updated_at = now()
      where discord_user_id = p_discord_user_id;

      if v_was_banned then
        v_result := 'applied';
        perform public.audit_discord_sync_action(
          'discord_unban_detected',
          p_discord_user_id,
          jsonb_build_object('source', 'live_event')
        );
      else
        v_result := 'no_change';
      end if;
    end if;
  end if;

  if v_result = 'stale' then
    perform public.audit_discord_sync_action(
      'discord_sync_stale_event_ignored',
      p_discord_user_id,
      jsonb_build_object('eventType', p_event_type)
    );
  end if;

  perform public.finish_discord_membership_sync_event(
    p_event_id,
    v_result
  );

  update public.discord_sync_health
  set
    last_event_at = greatest(
      coalesce(last_event_at, '-infinity'::timestamptz),
      p_observed_at
    ),
    updated_at = now()
  where id = 1;

  return jsonb_build_object(
    'outcome', v_result,
    'sessionsRevoked', v_revoked_sessions
  );
end;
$$;

create or replace function public.apply_discord_member_join(
  p_event_id text,
  p_observed_at timestamptz,
  p_payload_sha256 text,
  p_discord_user_id text,
  p_discord_username text
)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.apply_discord_live_event(
    p_event_id,
    'member_joined',
    p_observed_at,
    p_payload_sha256,
    p_discord_user_id,
    p_discord_username
  );
$$;

create or replace function public.apply_discord_member_remove(
  p_event_id text,
  p_observed_at timestamptz,
  p_payload_sha256 text,
  p_discord_user_id text,
  p_discord_username text
)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.apply_discord_live_event(
    p_event_id,
    'member_removed',
    p_observed_at,
    p_payload_sha256,
    p_discord_user_id,
    p_discord_username
  );
$$;

create or replace function public.apply_discord_ban(
  p_event_id text,
  p_observed_at timestamptz,
  p_payload_sha256 text,
  p_discord_user_id text,
  p_discord_username text
)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.apply_discord_live_event(
    p_event_id,
    'ban_added',
    p_observed_at,
    p_payload_sha256,
    p_discord_user_id,
    p_discord_username
  );
$$;

create or replace function public.apply_discord_unban(
  p_event_id text,
  p_observed_at timestamptz,
  p_payload_sha256 text,
  p_discord_user_id text,
  p_discord_username text
)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.apply_discord_live_event(
    p_event_id,
    'ban_removed',
    p_observed_at,
    p_payload_sha256,
    p_discord_user_id,
    p_discord_username
  );
$$;

create or replace function public.begin_discord_reconciliation_snapshot(
  p_event_id text,
  p_observed_at timestamptz,
  p_payload_sha256 text,
  p_snapshot_id uuid,
  p_expected_member_count integer,
  p_expected_ban_count integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_claim text;
begin
  if p_snapshot_id is null
    or p_expected_member_count not between 0 and 1000000
    or p_expected_ban_count not between 0 and 1000000
  then
    return jsonb_build_object('outcome', 'invalid_request');
  end if;

  v_claim := public.claim_discord_membership_sync_event(
    p_event_id,
    'snapshot_started',
    p_observed_at,
    p_payload_sha256
  );

  if v_claim = 'replay' then
    return jsonb_build_object('outcome', 'replay');
  elsif v_claim <> 'claimed' then
    return jsonb_build_object('outcome', 'invalid_event');
  end if;

  update public.discord_reconciliation_snapshots
  set
    status = 'expired',
    error_code = 'SNAPSHOT_EXPIRED'
  where status = 'collecting'
    and expires_at <= now();

  delete from public.discord_membership_sync_events
  where expires_at <= now();

  insert into public.discord_reconciliation_snapshots (
    id,
    observed_at,
    expected_member_count,
    expected_ban_count
  ) values (
    p_snapshot_id,
    p_observed_at,
    p_expected_member_count,
    p_expected_ban_count
  )
  on conflict (id) do nothing;

  if not found then
    perform public.finish_discord_membership_sync_event(
      p_event_id,
      'rejected'
    );
    return jsonb_build_object('outcome', 'snapshot_conflict');
  end if;

  update public.discord_sync_health
  set
    last_reconciliation_started_at = now(),
    last_error_code = null,
    updated_at = now()
  where id = 1;

  perform public.audit_discord_sync_action(
    'discord_reconciliation_started',
    null,
    jsonb_build_object(
      'expectedMembers', p_expected_member_count,
      'expectedBans', p_expected_ban_count
    )
  );
  perform public.finish_discord_membership_sync_event(
    p_event_id,
    'applied'
  );

  return jsonb_build_object('outcome', 'applied');
end;
$$;

create or replace function public.append_discord_reconciliation_chunk(
  p_event_id text,
  p_event_type text,
  p_observed_at timestamptz,
  p_payload_sha256 text,
  p_snapshot_id uuid,
  p_records jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_claim text;
  v_snapshot public.discord_reconciliation_snapshots%rowtype;
  v_record jsonb;
  v_count integer;
  v_user_id text;
  v_username text;
begin
  if p_event_type not in (
    'snapshot_members_chunk',
    'snapshot_bans_chunk'
  )
    or p_snapshot_id is null
    or jsonb_typeof(p_records) <> 'array'
    or jsonb_array_length(p_records) > 250
  then
    return jsonb_build_object('outcome', 'invalid_request');
  end if;

  v_claim := public.claim_discord_membership_sync_event(
    p_event_id,
    p_event_type,
    p_observed_at,
    p_payload_sha256
  );

  if v_claim = 'replay' then
    return jsonb_build_object('outcome', 'replay');
  elsif v_claim <> 'claimed' then
    return jsonb_build_object('outcome', 'invalid_event');
  end if;

  select *
  into v_snapshot
  from public.discord_reconciliation_snapshots
  where id = p_snapshot_id
  for update;

  if not found
    or v_snapshot.status <> 'collecting'
    or v_snapshot.expires_at <= now()
    or p_observed_at < v_snapshot.observed_at
  then
    perform public.finish_discord_membership_sync_event(
      p_event_id,
      'rejected'
    );
    return jsonb_build_object('outcome', 'snapshot_unavailable');
  end if;

  for v_record in
    select value from jsonb_array_elements(p_records)
  loop
    v_user_id := nullif(btrim(v_record ->> 'discordUserId'), '');
    v_username := nullif(btrim(v_record ->> 'discordUsername'), '');

    if v_user_id is null
      or v_user_id !~ '^[0-9]{5,32}$'
      or v_username is null
      or length(v_username) > 100
    then
      perform public.finish_discord_membership_sync_event(
        p_event_id,
        'rejected'
      );
      return jsonb_build_object('outcome', 'invalid_record');
    end if;

    if p_event_type = 'snapshot_members_chunk' then
      insert into public.discord_reconciliation_members (
        snapshot_id,
        discord_user_id,
        discord_username
      ) values (
        p_snapshot_id,
        v_user_id,
        v_username
      )
      on conflict (snapshot_id, discord_user_id)
      do update set discord_username = excluded.discord_username;
    else
      insert into public.discord_reconciliation_bans (
        snapshot_id,
        discord_user_id,
        discord_username
      ) values (
        p_snapshot_id,
        v_user_id,
        v_username
      )
      on conflict (snapshot_id, discord_user_id)
      do update set discord_username = excluded.discord_username;
    end if;
  end loop;

  if p_event_type = 'snapshot_members_chunk' then
    select count(*)::integer
    into v_count
    from public.discord_reconciliation_members
    where snapshot_id = p_snapshot_id;
  else
    select count(*)::integer
    into v_count
    from public.discord_reconciliation_bans
    where snapshot_id = p_snapshot_id;
  end if;

  perform public.finish_discord_membership_sync_event(
    p_event_id,
    'applied'
  );
  return jsonb_build_object('outcome', 'applied', 'receivedCount', v_count);
end;
$$;

create or replace function public.finalize_discord_reconciliation_snapshot(
  p_event_id text,
  p_observed_at timestamptz,
  p_payload_sha256 text,
  p_snapshot_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_claim text;
  v_snapshot public.discord_reconciliation_snapshots%rowtype;
  v_member_count integer;
  v_ban_count integer;
  v_discord_user_id text;
  v_username text;
  v_in_member_snapshot boolean;
  v_in_ban_snapshot boolean;
  v_state public.discord_member_state%rowtype;
  v_was_member boolean;
  v_was_banned boolean;
  v_revoked integer;
  v_total_revoked integer := 0;
  v_bans_applied integer := 0;
  v_unbans_applied integer := 0;
  v_joins_applied integer := 0;
  v_removes_applied integer := 0;
begin
  v_claim := public.claim_discord_membership_sync_event(
    p_event_id,
    'snapshot_finalize',
    p_observed_at,
    p_payload_sha256
  );

  if v_claim = 'replay' then
    return jsonb_build_object('outcome', 'replay');
  elsif v_claim <> 'claimed' then
    return jsonb_build_object('outcome', 'invalid_event');
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('discord-reconciliation', 0)
  );

  select *
  into v_snapshot
  from public.discord_reconciliation_snapshots
  where id = p_snapshot_id
  for update;

  if not found
    or v_snapshot.status <> 'collecting'
    or v_snapshot.expires_at <= now()
  then
    perform public.finish_discord_membership_sync_event(
      p_event_id,
      'rejected'
    );
    return jsonb_build_object('outcome', 'snapshot_unavailable');
  end if;

  select count(*)::integer
  into v_member_count
  from public.discord_reconciliation_members
  where snapshot_id = p_snapshot_id;

  select count(*)::integer
  into v_ban_count
  from public.discord_reconciliation_bans
  where snapshot_id = p_snapshot_id;

  if v_member_count <> v_snapshot.expected_member_count
    or v_ban_count <> v_snapshot.expected_ban_count
  then
    update public.discord_reconciliation_snapshots
    set status = 'failed', error_code = 'INCOMPLETE_SNAPSHOT'
    where id = p_snapshot_id;
    update public.discord_sync_health
    set
      last_error_at = now(),
      last_error_code = 'INCOMPLETE_SNAPSHOT',
      updated_at = now()
    where id = 1;
    perform public.audit_discord_sync_action(
      'discord_reconciliation_failed',
      null,
      jsonb_build_object('errorCode', 'INCOMPLETE_SNAPSHOT')
    );
    perform public.finish_discord_membership_sync_event(
      p_event_id,
      'failed'
    );
    return jsonb_build_object('outcome', 'incomplete_snapshot');
  end if;

  for v_discord_user_id in
    select discord_user_id
    from public.discord_member_state
    union
    select discord_user_id
    from public.discord_reconciliation_members
    where snapshot_id = p_snapshot_id
    union
    select discord_user_id
    from public.discord_reconciliation_bans
    where snapshot_id = p_snapshot_id
  loop
    perform pg_advisory_xact_lock(
      hashtextextended('discord-member:' || v_discord_user_id, 0)
    );

    select exists (
      select 1
      from public.discord_reconciliation_members
      where snapshot_id = p_snapshot_id
        and discord_user_id = v_discord_user_id
    )
    into v_in_member_snapshot;

    select exists (
      select 1
      from public.discord_reconciliation_bans
      where snapshot_id = p_snapshot_id
        and discord_user_id = v_discord_user_id
    )
    into v_in_ban_snapshot;

    select coalesce(
      (
        select discord_username
        from public.discord_reconciliation_members
        where snapshot_id = p_snapshot_id
          and discord_user_id = v_discord_user_id
      ),
      (
        select discord_username
        from public.discord_reconciliation_bans
        where snapshot_id = p_snapshot_id
          and discord_user_id = v_discord_user_id
      ),
      (
        select current_discord_username
        from public.discord_member_state
        where discord_user_id = v_discord_user_id
      ),
      'unknown'
    )
    into v_username;

    select *
    into v_state
    from public.discord_member_state
    where discord_user_id = v_discord_user_id
    for update;

    if not found then
      insert into public.discord_member_state (
        discord_user_id,
        current_discord_username,
        is_in_discord,
        discord_ban_active,
        updated_at
      ) values (
        v_discord_user_id,
        v_username,
        false,
        false,
        now()
      )
      returning * into v_state;
    end if;

    v_was_member := v_state.is_in_discord;
    v_was_banned := v_state.discord_ban_active;

    if v_state.discord_ban_observed_at is null
      or v_snapshot.observed_at > v_state.discord_ban_observed_at
    then
      if v_in_ban_snapshot then
        update public.discord_member_state
        set
          current_discord_username = v_username,
          discord_ban_active = true,
          discord_banned_at = case
            when discord_ban_active then discord_banned_at
            else v_snapshot.observed_at
          end,
          discord_ban_observed_at = v_snapshot.observed_at,
          is_in_discord = false,
          left_discord_at = case
            when is_in_discord then v_snapshot.observed_at
            else coalesce(left_discord_at, v_snapshot.observed_at)
          end,
          updated_at = now()
        where discord_user_id = v_discord_user_id;

        update public.sessions
        set revoked_at = coalesce(revoked_at, v_snapshot.observed_at)
        where discord_user_id = v_discord_user_id
          and revoked_at is null;
        get diagnostics v_revoked = row_count;
        v_total_revoked := v_total_revoked + v_revoked;

        if not v_was_banned then
          v_bans_applied := v_bans_applied + 1;
          perform public.audit_discord_sync_action(
            'discord_ban_detected',
            v_discord_user_id,
            jsonb_build_object(
              'source', 'reconciliation',
              'sessionsRevoked', v_revoked
            )
          );
        end if;
      else
        update public.discord_member_state
        set
          current_discord_username = v_username,
          discord_ban_active = false,
          discord_unbanned_at = case
            when discord_ban_active then v_snapshot.observed_at
            else discord_unbanned_at
          end,
          discord_ban_observed_at = v_snapshot.observed_at,
          is_in_discord = case
            when discord_ban_active then false
            else is_in_discord
          end,
          discord_joined_at = case
            when discord_ban_active then null
            else discord_joined_at
          end,
          updated_at = now()
        where discord_user_id = v_discord_user_id;

        if v_was_banned then
          v_unbans_applied := v_unbans_applied + 1;
          perform public.audit_discord_sync_action(
            'discord_unban_detected',
            v_discord_user_id,
            jsonb_build_object('source', 'reconciliation')
          );
        end if;
      end if;
    end if;

    select *
    into v_state
    from public.discord_member_state
    where discord_user_id = v_discord_user_id
    for update;

    if v_state.discord_membership_observed_at is null
      or v_snapshot.observed_at > v_state.discord_membership_observed_at
    then
      if v_in_ban_snapshot or v_state.discord_ban_active then
        update public.discord_member_state
        set
          is_in_discord = false,
          left_discord_at = case
            when is_in_discord then v_snapshot.observed_at
            else coalesce(left_discord_at, v_snapshot.observed_at)
          end,
          discord_membership_observed_at = v_snapshot.observed_at,
          updated_at = now()
        where discord_user_id = v_discord_user_id;
      elsif v_in_member_snapshot then
        update public.discord_member_state
        set
          current_discord_username = v_username,
          is_in_discord = true,
          discord_joined_at = case
            when is_in_discord then discord_joined_at
            else v_snapshot.observed_at
          end,
          left_discord_at = null,
          discord_membership_observed_at = v_snapshot.observed_at,
          updated_at = now()
        where discord_user_id = v_discord_user_id;

        if not v_was_member then
          v_joins_applied := v_joins_applied + 1;
          perform public.audit_discord_sync_action(
            'discord_member_joined',
            v_discord_user_id,
            jsonb_build_object('source', 'reconciliation')
          );
        end if;
      else
        update public.discord_member_state
        set
          is_in_discord = false,
          left_discord_at = case
            when is_in_discord then v_snapshot.observed_at
            else coalesce(left_discord_at, v_snapshot.observed_at)
          end,
          discord_membership_observed_at = v_snapshot.observed_at,
          updated_at = now()
        where discord_user_id = v_discord_user_id;

        update public.sessions
        set revoked_at = coalesce(revoked_at, v_snapshot.observed_at)
        where discord_user_id = v_discord_user_id
          and revoked_at is null;
        get diagnostics v_revoked = row_count;
        v_total_revoked := v_total_revoked + v_revoked;

        if v_was_member then
          v_removes_applied := v_removes_applied + 1;
          perform public.audit_discord_sync_action(
            'discord_member_removed',
            v_discord_user_id,
            jsonb_build_object(
              'source', 'reconciliation',
              'sessionsRevoked', v_revoked
            )
          );
        end if;
      end if;
    end if;
  end loop;

  update public.discord_reconciliation_snapshots
  set
    status = 'applied',
    finalized_at = now(),
    error_code = null
  where id = p_snapshot_id;

  update public.discord_sync_health
  set
    last_reconciliation_succeeded_at = now(),
    last_ban_snapshot_at = v_snapshot.observed_at,
    last_membership_snapshot_at = v_snapshot.observed_at,
    last_error_code = null,
    updated_at = now()
  where id = 1;

  perform public.audit_discord_sync_action(
    'discord_reconciliation_completed',
    null,
    jsonb_build_object(
      'memberCount', v_member_count,
      'banCount', v_ban_count,
      'bansApplied', v_bans_applied,
      'unbansApplied', v_unbans_applied,
      'joinsApplied', v_joins_applied,
      'removesApplied', v_removes_applied,
      'sessionsRevoked', v_total_revoked
    )
  );
  perform public.finish_discord_membership_sync_event(
    p_event_id,
    'applied'
  );

  return jsonb_build_object(
    'outcome', 'applied',
    'memberCount', v_member_count,
    'banCount', v_ban_count,
    'sessionsRevoked', v_total_revoked
  );
end;
$$;

create or replace function public.record_discord_reconciliation_failure(
  p_event_id text,
  p_observed_at timestamptz,
  p_payload_sha256 text,
  p_error_code text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_claim text;
  v_error_code text;
begin
  v_error_code := upper(
    regexp_replace(coalesce(p_error_code, ''), '[^A-Z0-9_]', '_', 'g')
  );
  v_error_code := left(v_error_code, 80);

  if v_error_code = '' then
    v_error_code := 'RECONCILIATION_FAILED';
  end if;

  v_claim := public.claim_discord_membership_sync_event(
    p_event_id,
    'reconciliation_failed',
    p_observed_at,
    p_payload_sha256
  );

  if v_claim = 'replay' then
    return jsonb_build_object('outcome', 'replay');
  elsif v_claim <> 'claimed' then
    return jsonb_build_object('outcome', 'invalid_event');
  end if;

  update public.discord_sync_health
  set
    last_error_at = now(),
    last_error_code = v_error_code,
    updated_at = now()
  where id = 1;

  perform public.audit_discord_sync_action(
    'discord_reconciliation_failed',
    null,
    jsonb_build_object('errorCode', v_error_code)
  );
  perform public.finish_discord_membership_sync_event(
    p_event_id,
    'failed'
  );

  return jsonb_build_object('outcome', 'applied');
end;
$$;

create or replace function public.get_cancerculture_session_access(
  p_session_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.sessions%rowtype;
  v_user public.user_logs%rowtype;
  v_membership public.discord_member_state%rowtype;
begin
  if p_session_id is null then
    return jsonb_build_object('outcome', 'not_authenticated');
  end if;

  select *
  into v_session
  from public.sessions
  where id = p_session_id;

  if not found or v_session.revoked_at is not null then
    return jsonb_build_object('outcome', 'not_authenticated');
  end if;

  select *
  into v_user
  from public.user_logs
  where discord_user_id = v_session.discord_user_id;

  if not found then
    return jsonb_build_object('outcome', 'dependency_unavailable');
  end if;

  select *
  into v_membership
  from public.discord_member_state
  where discord_user_id = v_session.discord_user_id;

  if not found then
    return jsonb_build_object('outcome', 'not_in_discord');
  end if;

  if v_membership.discord_ban_active then
    update public.sessions
    set revoked_at = coalesce(revoked_at, now())
    where discord_user_id = v_session.discord_user_id
      and revoked_at is null;
    return jsonb_build_object('outcome', 'discord_banned');
  end if;

  if v_user.is_banned then
    return jsonb_build_object('outcome', 'website_banned');
  end if;

  if not v_membership.is_in_discord then
    return jsonb_build_object('outcome', 'not_in_discord');
  end if;

  if v_membership.discord_joined_at is null
    or v_membership.discord_joined_at > now() - interval '10 minutes'
  then
    return jsonb_build_object(
      'outcome', 'joined_too_recently',
      'joinedAt', v_membership.discord_joined_at
    );
  end if;

  update public.sessions
  set last_seen_at = now()
  where id = p_session_id;

  return jsonb_build_object(
    'outcome', 'allowed',
    'discordUserId', v_session.discord_user_id,
    'sessionId', v_session.id
  );
end;
$$;

create or replace function public.create_cancerculture_session(
  p_session_id uuid,
  p_discord_user_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user public.user_logs%rowtype;
  v_membership public.discord_member_state%rowtype;
  v_now timestamptz := transaction_timestamp();
begin
  if p_session_id is null
    or p_discord_user_id is null
    or p_discord_user_id !~ '^[0-9]{5,32}$'
  then
    return jsonb_build_object('outcome', 'invalid_request');
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('discord-member:' || p_discord_user_id, 0)
  );

  select *
  into v_user
  from public.user_logs
  where discord_user_id = p_discord_user_id
  for update;

  if not found then
    return jsonb_build_object('outcome', 'dependency_unavailable');
  end if;

  select *
  into v_membership
  from public.discord_member_state
  where discord_user_id = p_discord_user_id
  for update;

  if not found then
    return jsonb_build_object('outcome', 'not_in_discord');
  end if;

  if v_membership.discord_ban_active then
    update public.sessions
    set revoked_at = coalesce(revoked_at, v_now)
    where discord_user_id = p_discord_user_id
      and revoked_at is null;
    return jsonb_build_object('outcome', 'discord_banned');
  end if;

  if v_user.is_banned then
    return jsonb_build_object('outcome', 'website_banned');
  end if;

  if not v_membership.is_in_discord then
    return jsonb_build_object('outcome', 'not_in_discord');
  end if;

  if v_membership.discord_joined_at is null
    or v_membership.discord_joined_at > v_now - interval '10 minutes'
  then
    return jsonb_build_object(
      'outcome', 'joined_too_recently',
      'joinedAt', v_membership.discord_joined_at
    );
  end if;

  insert into public.sessions (
    id,
    discord_user_id,
    created_at,
    last_seen_at
  ) values (
    p_session_id,
    p_discord_user_id,
    v_now,
    v_now
  );

  return jsonb_build_object(
    'outcome', 'created',
    'sessionId', p_session_id
  );
end;
$$;

create or replace function public.enforce_discord_authenticated_action()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_discord_user_id text;
  v_user_banned boolean;
  v_membership public.discord_member_state%rowtype;
begin
  v_discord_user_id := new.discord_user_id;

  perform pg_advisory_xact_lock(
    hashtextextended('discord-member:' || v_discord_user_id, 0)
  );

  select is_banned
  into v_user_banned
  from public.user_logs
  where discord_user_id = v_discord_user_id;

  if not found then
    raise exception using errcode = 'P0001', message = 'AUTH_DEPENDENCY_UNAVAILABLE';
  end if;

  select *
  into v_membership
  from public.discord_member_state
  where discord_user_id = v_discord_user_id;

  if not found then
    raise exception using errcode = 'P0001', message = 'NOT_IN_DISCORD';
  end if;

  if v_membership.discord_ban_active then
    raise exception using errcode = 'P0001', message = 'DISCORD_BANNED';
  end if;

  if v_user_banned then
    raise exception using errcode = 'P0001', message = 'WEBSITE_BANNED';
  end if;

  if not v_membership.is_in_discord then
    raise exception using errcode = 'P0001', message = 'NOT_IN_DISCORD';
  end if;

  if v_membership.discord_joined_at is null
    or v_membership.discord_joined_at > now() - interval '10 minutes'
  then
    raise exception using errcode = 'P0001', message = 'JOINED_TOO_RECENTLY';
  end if;

  return new;
end;
$$;

drop trigger if exists votes_discord_access_trigger on public.votes;
create trigger votes_discord_access_trigger
before insert on public.votes
for each row
execute function public.enforce_discord_authenticated_action();

drop trigger if exists submission_upload_operations_discord_access_trigger
  on public.submission_upload_operations;
create trigger submission_upload_operations_discord_access_trigger
before insert or update of status
on public.submission_upload_operations
for each row
when (new.status in ('reserved', 'completed'))
execute function public.enforce_discord_authenticated_action();

drop trigger if exists submissions_discord_access_trigger
  on public.submissions;
create trigger submissions_discord_access_trigger
before insert on public.submissions
for each row
execute function public.enforce_discord_authenticated_action();

revoke all on table public.discord_membership_sync_events
  from public, anon, authenticated;
revoke all on table public.discord_reconciliation_snapshots
  from public, anon, authenticated;
revoke all on table public.discord_reconciliation_members
  from public, anon, authenticated;
revoke all on table public.discord_reconciliation_bans
  from public, anon, authenticated;
revoke all on table public.discord_sync_health
  from public, anon, authenticated;

revoke all on function public.claim_discord_membership_sync_event(text, text, timestamptz, text)
  from public, anon, authenticated;
revoke all on function public.finish_discord_membership_sync_event(text, text)
  from public, anon, authenticated;
revoke all on function public.audit_discord_sync_action(text, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.apply_discord_live_event(text, text, timestamptz, text, text, text)
  from public, anon, authenticated;
revoke all on function public.apply_discord_member_join(text, timestamptz, text, text, text)
  from public, anon, authenticated;
revoke all on function public.apply_discord_member_remove(text, timestamptz, text, text, text)
  from public, anon, authenticated;
revoke all on function public.apply_discord_ban(text, timestamptz, text, text, text)
  from public, anon, authenticated;
revoke all on function public.apply_discord_unban(text, timestamptz, text, text, text)
  from public, anon, authenticated;
revoke all on function public.begin_discord_reconciliation_snapshot(text, timestamptz, text, uuid, integer, integer)
  from public, anon, authenticated;
revoke all on function public.append_discord_reconciliation_chunk(text, text, timestamptz, text, uuid, jsonb)
  from public, anon, authenticated;
revoke all on function public.finalize_discord_reconciliation_snapshot(text, timestamptz, text, uuid)
  from public, anon, authenticated;
revoke all on function public.record_discord_reconciliation_failure(text, timestamptz, text, text)
  from public, anon, authenticated;
revoke all on function public.get_cancerculture_session_access(uuid)
  from public, anon, authenticated;
revoke all on function public.create_cancerculture_session(uuid, text)
  from public, anon, authenticated;
revoke all on function public.enforce_discord_authenticated_action()
  from public, anon, authenticated;

grant execute on function public.apply_discord_member_join(text, timestamptz, text, text, text)
  to service_role;
grant execute on function public.apply_discord_member_remove(text, timestamptz, text, text, text)
  to service_role;
grant execute on function public.apply_discord_ban(text, timestamptz, text, text, text)
  to service_role;
grant execute on function public.apply_discord_unban(text, timestamptz, text, text, text)
  to service_role;
grant execute on function public.begin_discord_reconciliation_snapshot(text, timestamptz, text, uuid, integer, integer)
  to service_role;
grant execute on function public.append_discord_reconciliation_chunk(text, text, timestamptz, text, uuid, jsonb)
  to service_role;
grant execute on function public.finalize_discord_reconciliation_snapshot(text, timestamptz, text, uuid)
  to service_role;
grant execute on function public.record_discord_reconciliation_failure(text, timestamptz, text, text)
  to service_role;
grant execute on function public.get_cancerculture_session_access(uuid)
  to service_role;
grant execute on function public.create_cancerculture_session(uuid, text)
  to service_role;

revoke insert, select, update on table public.discord_member_state
  from discord_bot;

comment on table public.discord_membership_sync_events is
  'Minimal replay and idempotency ledger for signed Discord membership synchronization requests.';
comment on table public.discord_reconciliation_snapshots is
  'Multi-phase authoritative Discord member and ban snapshots; only complete snapshots are applied.';
comment on function public.get_cancerculture_session_access(uuid) is
  'Fail-closed central session, website-ban, Discord-ban, membership, and join-cooldown authorization check.';

commit;
