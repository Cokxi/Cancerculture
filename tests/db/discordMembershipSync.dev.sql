\set ON_ERROR_STOP on
begin;

do $$
declare
  v_user text := '990000000000000001';
  v_snapshot_member text := '990000000000000002';
  v_snapshot_ban text := '990000000000000003';
  v_snapshot_absent text := '990000000000000004';
  v_base timestamptz := transaction_timestamp() - interval '2 hours';
  v_result jsonb;
  v_audit_count integer;
  v_snapshot_id uuid := gen_random_uuid();
  v_incomplete_snapshot_id uuid := gen_random_uuid();
  v_session uuid := gen_random_uuid();
  v_new_session uuid := gen_random_uuid();
begin
  insert into public.user_logs (
    discord_user_id,
    current_discord_username,
    is_banned
  ) values
    (v_user, 'sync-test-user', false),
    (v_snapshot_member, 'sync-test-member', false),
    (v_snapshot_ban, 'sync-test-ban', false),
    (v_snapshot_absent, 'sync-test-absent', false)
  on conflict (discord_user_id) do update
  set is_banned = false;

  insert into public.discord_member_state (
    discord_user_id,
    current_discord_username,
    discord_joined_at,
    is_in_discord,
    discord_ban_active,
    discord_membership_observed_at,
    discord_ban_observed_at
  ) values
    (v_user, 'sync-test-user', v_base, true, false, v_base, v_base),
    (
      v_snapshot_member,
      'sync-test-member',
      null,
      false,
      true,
      v_base,
      v_base
    ),
    (
      v_snapshot_ban,
      'sync-test-ban',
      v_base,
      true,
      false,
      v_base,
      v_base
    ),
    (
      v_snapshot_absent,
      'sync-test-absent',
      v_base,
      true,
      false,
      v_base,
      v_base
    )
  on conflict (discord_user_id) do update
  set
    current_discord_username = excluded.current_discord_username,
    discord_joined_at = excluded.discord_joined_at,
    is_in_discord = excluded.is_in_discord,
    discord_ban_active = excluded.discord_ban_active,
    discord_membership_observed_at =
      excluded.discord_membership_observed_at,
    discord_ban_observed_at = excluded.discord_ban_observed_at;

  insert into public.sessions (id, discord_user_id)
  values (v_session, v_user);

  v_result := public.apply_discord_ban(
    'test-ban-0001',
    v_base + interval '10 minutes',
    repeat('a', 64),
    v_user,
    'sync-test-user'
  );

  if v_result ->> 'outcome' <> 'applied' then
    raise exception 'ban was not applied: %', v_result;
  end if;

  if not exists (
    select 1
    from public.discord_member_state
    where discord_user_id = v_user
      and discord_ban_active
      and not is_in_discord
      and discord_banned_at = v_base + interval '10 minutes'
  ) then
    raise exception 'ban invariant failed';
  end if;

  if not exists (
    select 1
    from public.sessions
    where id = v_session
      and revoked_at is not null
  ) then
    raise exception 'ban did not revoke the session';
  end if;

  select count(*)::integer
  into v_audit_count
  from public.admin_action_logs
  where action = 'discord_ban_detected'
    and target_id = v_user;

  v_result := public.apply_discord_ban(
    'test-ban-0001',
    v_base + interval '10 minutes',
    repeat('a', 64),
    v_user,
    'sync-test-user'
  );

  if v_result ->> 'outcome' <> 'replay' then
    raise exception 'same event ID was not treated as replay';
  end if;

  if (
    select count(*)::integer
    from public.admin_action_logs
    where action = 'discord_ban_detected'
      and target_id = v_user
  ) <> v_audit_count then
    raise exception 'replay duplicated the audit';
  end if;

  v_result := public.apply_discord_unban(
    'test-unban-0001',
    v_base + interval '20 minutes',
    repeat('b', 64),
    v_user,
    'sync-test-user'
  );

  if v_result ->> 'outcome' <> 'applied' or not exists (
    select 1
    from public.discord_member_state
    where discord_user_id = v_user
      and not discord_ban_active
      and not is_in_discord
      and discord_joined_at is null
  ) then
    raise exception 'unban restored access or membership';
  end if;

  v_result := public.apply_discord_ban(
    'test-stale-ban',
    v_base + interval '15 minutes',
    repeat('c', 64),
    v_user,
    'sync-test-user'
  );

  if v_result ->> 'outcome' <> 'stale' or exists (
    select 1 from public.discord_member_state
    where discord_user_id = v_user and discord_ban_active
  ) then
    raise exception 'stale ban overwrote newer unban';
  end if;

  v_result := public.apply_discord_member_join(
    'test-join-0001',
    v_base + interval '30 minutes',
    repeat('d', 64),
    v_user,
    'sync-test-user'
  );

  if v_result ->> 'outcome' <> 'applied' or not exists (
    select 1
    from public.discord_member_state
    where discord_user_id = v_user
      and is_in_discord
      and discord_joined_at = v_base + interval '30 minutes'
  ) then
    raise exception 'rejoin did not create a fresh join timestamp';
  end if;

  if exists (
    select 1 from public.sessions
    where id = v_session and revoked_at is null
  ) then
    raise exception 'rejoin reactivated an old session';
  end if;

  v_result := public.create_cancerculture_session(v_new_session, v_user);
  if v_result ->> 'outcome' <> 'created' then
    raise exception 'eligible rejoined user could not create session: %',
      v_result;
  end if;

  v_result := public.apply_discord_member_remove(
    'test-remove-01',
    v_base + interval '40 minutes',
    repeat('e', 64),
    v_user,
    'sync-test-user'
  );

  if v_result ->> 'outcome' <> 'applied' or not exists (
    select 1 from public.sessions
    where id = v_new_session and revoked_at is not null
  ) then
    raise exception 'normal remove did not block and revoke';
  end if;

  v_result := public.apply_discord_ban(
    'test-ban-0002',
    v_base + interval '50 minutes',
    repeat('f', 64),
    v_user,
    'sync-test-user'
  );
  v_result := public.apply_discord_member_remove(
    'test-remove-02',
    v_base + interval '51 minutes',
    repeat('1', 64),
    v_user,
    'sync-test-user'
  );

  if not exists (
    select 1 from public.discord_member_state
    where discord_user_id = v_user
      and discord_ban_active
      and not is_in_discord
  ) then
    raise exception 'ban before remove did not remain authoritative';
  end if;

  v_result := public.apply_discord_member_join(
    'test-stale-join',
    v_base + interval '49 minutes',
    repeat('2', 64),
    v_user,
    'sync-test-user'
  );
  if exists (
    select 1 from public.discord_member_state
    where discord_user_id = v_user and is_in_discord
  ) then
    raise exception 'stale join bypassed an active ban';
  end if;

  v_result := public.apply_discord_unban(
    'test-stale-unban',
    v_base + interval '45 minutes',
    repeat('3', 64),
    v_user,
    'sync-test-user'
  );
  if v_result ->> 'outcome' <> 'stale' then
    raise exception 'stale unban was not ignored';
  end if;

  update public.user_logs
  set is_banned = true
  where discord_user_id = v_user;
  v_result := public.apply_discord_unban(
    'test-unban-0002',
    v_base + interval '60 minutes',
    repeat('4', 64),
    v_user,
    'sync-test-user'
  );
  if not exists (
    select 1 from public.user_logs
    where discord_user_id = v_user and is_banned
  ) then
    raise exception 'Discord unban cleared the independent website ban';
  end if;

  insert into public.sessions (id, discord_user_id)
  values
    (gen_random_uuid(), v_snapshot_ban),
    (gen_random_uuid(), v_snapshot_absent);

  v_result := public.begin_discord_reconciliation_snapshot(
    'test-snap-start',
    v_base + interval '90 minutes',
    repeat('5', 64),
    v_snapshot_id,
    1,
    1
  );
  v_result := public.append_discord_reconciliation_chunk(
    'test-snap-member',
    'snapshot_members_chunk',
    v_base + interval '91 minutes',
    repeat('6', 64),
    v_snapshot_id,
    jsonb_build_array(jsonb_build_object(
      'discordUserId', v_snapshot_member,
      'discordUsername', 'sync-test-member'
    ))
  );
  v_result := public.append_discord_reconciliation_chunk(
    'test-snap-bans',
    'snapshot_bans_chunk',
    v_base + interval '92 minutes',
    repeat('7', 64),
    v_snapshot_id,
    jsonb_build_array(jsonb_build_object(
      'discordUserId', v_snapshot_ban,
      'discordUsername', 'sync-test-ban'
    ))
  );
  v_result := public.finalize_discord_reconciliation_snapshot(
    'test-snap-final',
    v_base + interval '93 minutes',
    repeat('8', 64),
    v_snapshot_id
  );

  if v_result ->> 'outcome' <> 'applied' then
    raise exception 'complete snapshot was not applied: %', v_result;
  end if;
  if not exists (
    select 1 from public.discord_member_state
    where discord_user_id = v_snapshot_ban
      and discord_ban_active and not is_in_discord
  ) or exists (
    select 1 from public.sessions
    where discord_user_id = v_snapshot_ban and revoked_at is null
  ) then
    raise exception 'snapshot missed ban was not applied atomically';
  end if;
  if not exists (
    select 1 from public.discord_member_state
    where discord_user_id = v_snapshot_member
      and not discord_ban_active
      and is_in_discord
      and discord_joined_at = v_base + interval '90 minutes'
  ) then
    raise exception 'snapshot unban/member did not start a conservative join';
  end if;
  if exists (
    select 1 from public.discord_member_state
    where discord_user_id = v_snapshot_absent and is_in_discord
  ) then
    raise exception 'snapshot did not detect absent member';
  end if;

  v_result := public.begin_discord_reconciliation_snapshot(
    'test-inc-start',
    v_base + interval '100 minutes',
    repeat('9', 64),
    v_incomplete_snapshot_id,
    1,
    0
  );
  v_result := public.finalize_discord_reconciliation_snapshot(
    'test-inc-final',
    v_base + interval '101 minutes',
    repeat('0', 64),
    v_incomplete_snapshot_id
  );
  if v_result ->> 'outcome' <> 'incomplete_snapshot' then
    raise exception 'incomplete snapshot was accepted';
  end if;

  if has_function_privilege(
    'anon',
    'public.apply_discord_ban(text,timestamptz,text,text,text)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.apply_discord_ban(text,timestamptz,text,text,text)',
    'EXECUTE'
  ) then
    raise exception 'membership RPC is executable by a public role';
  end if;

  if has_table_privilege(
    'discord_bot',
    'public.discord_member_state',
    'INSERT'
  ) or has_table_privilege(
    'discord_bot',
    'public.discord_member_state',
    'UPDATE'
  ) then
    raise exception 'discord_bot retained direct membership writes';
  end if;
end;
$$;

rollback;
