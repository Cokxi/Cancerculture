begin;

alter table public.discord_reconciliation_members
  add column if not exists discord_joined_at timestamptz,
  add column if not exists membership_observed_at timestamptz;

alter table public.discord_reconciliation_members
  drop constraint if exists discord_reconciliation_members_join_observation_check,
  drop constraint if exists discord_reconciliation_members_join_order_check;

alter table public.discord_reconciliation_members
  add constraint discord_reconciliation_members_join_observation_check
    check (
      discord_joined_at is null
      or membership_observed_at is not null
    ),
  add constraint discord_reconciliation_members_join_order_check
    check (
      discord_joined_at is null
      or discord_joined_at <= membership_observed_at
    );

create or replace function public.apply_discord_member_join_v2(
  p_event_id text,
  p_observed_at timestamptz,
  p_payload_sha256 text,
  p_discord_user_id text,
  p_discord_username text,
  p_joined_at timestamptz
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
begin
  if p_discord_user_id is null
    or p_discord_user_id !~ '^[0-9]{5,32}$'
    or p_discord_username is null
    or length(btrim(p_discord_username)) not between 1 and 100
    or p_observed_at is null
    or p_joined_at > p_observed_at
  then
    return jsonb_build_object('outcome', 'invalid_request');
  end if;

  v_claim := public.claim_discord_membership_sync_event(
    p_event_id,
    'member_joined',
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

  if v_state.discord_membership_observed_at is not null
    and p_observed_at < v_state.discord_membership_observed_at
  then
    v_result := 'stale';
  elsif v_state.discord_ban_active then
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
      discord_joined_at = coalesce(p_joined_at, p_observed_at),
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

  if v_result = 'stale' then
    perform public.audit_discord_sync_action(
      'discord_sync_stale_event_ignored',
      p_discord_user_id,
      jsonb_build_object('eventType', 'member_joined')
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

  return jsonb_build_object('outcome', v_result, 'sessionsRevoked', 0);
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
  v_joined_at timestamptz;
  v_membership_observed_at timestamptz;
  v_existing_member public.discord_reconciliation_members%rowtype;
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
    v_joined_at := null;
    v_membership_observed_at := null;

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
      if (v_record ? 'joinedAt' and jsonb_typeof(v_record -> 'joinedAt') <> 'string')
        or (
          v_record ? 'membershipObservedAt'
          and jsonb_typeof(v_record -> 'membershipObservedAt') <> 'string'
        )
        or (v_record ? 'joinedAt' and not (v_record ? 'membershipObservedAt'))
      then
        perform public.finish_discord_membership_sync_event(
          p_event_id,
          'rejected'
        );
        return jsonb_build_object('outcome', 'invalid_record');
      end if;

      begin
        if v_record ? 'joinedAt' then
          v_joined_at := (v_record ->> 'joinedAt')::timestamptz;
        end if;
        if v_record ? 'membershipObservedAt' then
          v_membership_observed_at :=
            (v_record ->> 'membershipObservedAt')::timestamptz;
        end if;
      exception
        when others then
          perform public.finish_discord_membership_sync_event(
            p_event_id,
            'rejected'
          );
          return jsonb_build_object('outcome', 'invalid_record');
      end;

      if (v_joined_at is not null and v_membership_observed_at is null)
        or v_joined_at > v_membership_observed_at
        or v_membership_observed_at > p_observed_at
      then
        perform public.finish_discord_membership_sync_event(
          p_event_id,
          'rejected'
        );
        return jsonb_build_object('outcome', 'invalid_record');
      end if;

      select *
      into v_existing_member
      from public.discord_reconciliation_members
      where snapshot_id = p_snapshot_id
        and discord_user_id = v_user_id;

      if found then
        if v_existing_member.discord_username is distinct from v_username
          or v_existing_member.discord_joined_at is distinct from v_joined_at
          or v_existing_member.membership_observed_at
            is distinct from v_membership_observed_at
        then
          update public.discord_reconciliation_snapshots
          set
            status = 'failed',
            error_code = 'CONFLICTING_MEMBER_RECORD'
          where id = p_snapshot_id;
          perform public.finish_discord_membership_sync_event(
            p_event_id,
            'rejected'
          );
          return jsonb_build_object('outcome', 'snapshot_conflict');
        end if;
      else
        insert into public.discord_reconciliation_members (
          snapshot_id,
          discord_user_id,
          discord_username,
          discord_joined_at,
          membership_observed_at
        ) values (
          p_snapshot_id,
          v_user_id,
          v_username,
          v_joined_at,
          v_membership_observed_at
        );
      end if;
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
  v_snapshot_joined_at timestamptz;
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
  v_success_at timestamptz;
  v_health_rows integer;
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

    select discord_joined_at
    into v_snapshot_joined_at
    from public.discord_reconciliation_members
    where snapshot_id = p_snapshot_id
      and discord_user_id = v_discord_user_id;

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
            when v_snapshot_joined_at is not null
              then v_snapshot_joined_at
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

        if v_was_member then
          v_removes_applied := v_removes_applied + 1;
          perform public.audit_discord_sync_action(
            'discord_member_removed',
            v_discord_user_id,
            jsonb_build_object('source', 'reconciliation')
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

  select greatest(
    clock_timestamp(),
    coalesce(
      last_member_snapshot_succeeded_at,
      '-infinity'::timestamptz
    ),
    coalesce(
      last_ban_snapshot_succeeded_at,
      '-infinity'::timestamptz
    ),
    coalesce(
      last_full_reconciliation_succeeded_at,
      '-infinity'::timestamptz
    )
  )
  into v_success_at
  from public.discord_sync_health
  where id = 1
  for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'DISCORD_SYNC_HEALTH_SINGLETON_MISSING';
  end if;

  update public.discord_sync_health
  set
    last_reconciliation_succeeded_at = now(),
    last_ban_snapshot_at = v_snapshot.observed_at,
    last_membership_snapshot_at = v_snapshot.observed_at,
    last_error_code = null,
    last_member_snapshot_succeeded_at = v_success_at,
    last_ban_snapshot_succeeded_at = v_success_at,
    last_full_reconciliation_succeeded_at = v_success_at,
    updated_at = v_success_at
  where id = 1;
  get diagnostics v_health_rows = row_count;

  if v_health_rows <> 1 then
    raise exception using
      errcode = 'P0001',
      message = 'DISCORD_SYNC_HEALTH_SINGLETON_UPDATE_FAILED';
  end if;

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

alter function public.apply_discord_member_join_v2(
  text,
  timestamptz,
  text,
  text,
  text,
  timestamptz
) owner to postgres;

revoke all on function public.apply_discord_member_join_v2(
  text,
  timestamptz,
  text,
  text,
  text,
  timestamptz
) from public, anon, authenticated, discord_bot, service_role;

grant execute on function public.apply_discord_member_join_v2(
  text,
  timestamptz,
  text,
  text,
  text,
  timestamptz
) to service_role;

revoke all on function public.append_discord_reconciliation_chunk(
  text,
  text,
  timestamptz,
  text,
  uuid,
  jsonb
) from public, anon, authenticated, discord_bot, service_role;

grant execute on function public.append_discord_reconciliation_chunk(
  text,
  text,
  timestamptz,
  text,
  uuid,
  jsonb
) to service_role;

revoke all on function public.finalize_discord_reconciliation_snapshot(
  text,
  timestamptz,
  text,
  uuid
) from public, anon, authenticated, discord_bot, service_role;

grant execute on function public.finalize_discord_reconciliation_snapshot(
  text,
  timestamptz,
  text,
  uuid
) to service_role;

comment on function public.apply_discord_member_join_v2(
  text,
  timestamptz,
  text,
  text,
  text,
  timestamptz
) is
  'Applies an ordered Discord join with an optional authoritative GuildMember joined timestamp while preserving the legacy join RPC.';

comment on function public.append_discord_reconciliation_chunk(
  text,
  text,
  timestamptz,
  text,
  uuid,
  jsonb
) is
  'Stages deterministic Discord reconciliation records including optional member join provenance and rejects conflicting member duplicates.';

comment on function public.finalize_discord_reconciliation_snapshot(
  text,
  timestamptz,
  text,
  uuid
) is
  'Atomically applies complete Discord membership and ban snapshots, using joined timestamps only as membership episode data and snapshot observation time for ordering.';

commit;
