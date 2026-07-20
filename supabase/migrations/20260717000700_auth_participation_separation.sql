begin;

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

    if v_was_member then
      v_result := 'applied';
      perform public.audit_discord_sync_action(
        'discord_member_removed',
        p_discord_user_id,
        jsonb_build_object('source', 'live_event')
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
  v_membership_found boolean := false;
begin
  if p_session_id is null then
    return jsonb_build_object('outcome', 'not_authenticated');
  end if;

  select * into v_session
  from public.sessions
  where id = p_session_id;

  if not found or v_session.revoked_at is not null then
    return jsonb_build_object('outcome', 'not_authenticated');
  end if;

  select * into v_user
  from public.user_logs
  where discord_user_id = v_session.discord_user_id;

  if not found then
    return jsonb_build_object('outcome', 'dependency_unavailable');
  end if;

  select * into v_membership
  from public.discord_member_state
  where discord_user_id = v_session.discord_user_id;
  v_membership_found := found;

  if v_membership_found and v_membership.discord_ban_active then
    update public.sessions
    set revoked_at = coalesce(revoked_at, now())
    where discord_user_id = v_session.discord_user_id
      and revoked_at is null;
    return jsonb_build_object('outcome', 'discord_banned');
  end if;

  if v_user.is_banned then
    update public.sessions
    set revoked_at = coalesce(revoked_at, now())
    where discord_user_id = v_session.discord_user_id
      and revoked_at is null;
    return jsonb_build_object('outcome', 'website_banned');
  end if;

  update public.sessions
  set last_seen_at = now()
  where id = p_session_id;

  return jsonb_build_object(
    'outcome', 'allowed',
    'discordUserId', v_session.discord_user_id,
    'sessionId', v_session.id,
    'membershipKnown', v_membership_found
      and v_membership.discord_membership_observed_at is not null,
    'discordMember', v_membership_found
      and v_membership.is_in_discord,
    'joinedAt', case
      when v_membership_found then v_membership.discord_joined_at
      else null
    end
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
  v_membership_found boolean := false;
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

  select * into v_user
  from public.user_logs
  where discord_user_id = p_discord_user_id
  for update;

  if not found then
    return jsonb_build_object('outcome', 'dependency_unavailable');
  end if;

  select * into v_membership
  from public.discord_member_state
  where discord_user_id = p_discord_user_id
  for update;
  v_membership_found := found;

  if v_membership_found and v_membership.discord_ban_active then
    update public.sessions
    set revoked_at = coalesce(revoked_at, v_now)
    where discord_user_id = p_discord_user_id
      and revoked_at is null;
    return jsonb_build_object('outcome', 'discord_banned');
  end if;

  if v_user.is_banned then
    update public.sessions
    set revoked_at = coalesce(revoked_at, v_now)
    where discord_user_id = p_discord_user_id
      and revoked_at is null;
    return jsonb_build_object('outcome', 'website_banned');
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
    'sessionId', p_session_id,
    'membershipKnown', v_membership_found
      and v_membership.discord_membership_observed_at is not null,
    'discordMember', v_membership_found
      and v_membership.is_in_discord,
    'joinedAt', case
      when v_membership_found then v_membership.discord_joined_at
      else null
    end
  );
end;
$$;

create or replace function public.revoke_website_ban_sessions()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.is_banned
    and (
      tg_op = 'INSERT'
      or not coalesce(old.is_banned, false)
    )
  then
    update public.sessions
    set revoked_at = coalesce(revoked_at, transaction_timestamp())
    where discord_user_id = new.discord_user_id
      and revoked_at is null;
  end if;

  return new;
end;
$$;

drop trigger if exists user_logs_website_ban_session_revocation_trigger
  on public.user_logs;

create trigger user_logs_website_ban_session_revocation_trigger
after insert or update of is_banned
on public.user_logs
for each row
execute function public.revoke_website_ban_sessions();

revoke all on function public.revoke_website_ban_sessions()
  from public, anon, authenticated, discord_bot;

comment on function public.apply_discord_live_event(text, text, timestamptz, text, text, text) is
  'Applies ordered Discord membership and ban events. Membership removal restricts participation without revoking website sessions; bans still revoke sessions.';

comment on function public.finalize_discord_reconciliation_snapshot(text, timestamptz, text, uuid) is
  'Applies complete Discord membership and ban snapshots. Missing members retain website sessions while active bans revoke them.';

comment on function public.get_cancerculture_session_access(uuid) is
  'Validates website authentication independently from participation eligibility. Known Discord and website bans revoke active sessions.';

comment on function public.create_cancerculture_session(uuid, text) is
  'Creates restricted website sessions for valid non-banned Discord identities regardless of membership; participation remains guarded separately.';

comment on function public.revoke_website_ban_sessions() is
  'Atomically revokes active website sessions when a website ban becomes active; unban never reactivates sessions.';

commit;
