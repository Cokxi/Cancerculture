-- Controlled DEV only; LIVE execution is expressly prohibited.
-- Stop the DEV bot and local DEV website, or establish equivalent exclusive
-- maintenance, before running:
-- psql -v ON_ERROR_STOP=1 -v cc_allow_global_snapshot_finalizer_test=1 -f tests/db/discordJoinedAtProvenance.dev.sql
-- The final ROLLBACK prevents durable changes, but the snapshot finalizer still
-- processes every existing discord_member_state row and can temporarily update
-- or lock those rows and cause lock contention during this transaction.
\set ON_ERROR_STOP on

\if :{?cc_allow_global_snapshot_finalizer_test}
\else
  \set cc_allow_global_snapshot_finalizer_test 0
\endif

\if :cc_allow_global_snapshot_finalizer_test
\else
  \echo 'Refusing global snapshot-finalizer DEV test: set -v cc_allow_global_snapshot_finalizer_test=1 explicitly.'
  \echo 'The finalizer processes every existing discord_member_state row.'
  \echo 'Run only with the DEV bot and local DEV website stopped, or under equivalent exclusive maintenance.'
  \echo 'ROLLBACK prevents durable changes, but not temporary updates, row locks, or lock contention. LIVE is prohibited.'
  \quit 3
\endif

begin;

set local lock_timeout = '15s';
set local statement_timeout = '10min';

-- Stable namespace/key pair reserved for discordJoinedAtProvenance.dev.sql.
select pg_advisory_xact_lock(2147483001, 20260724);

do $$
declare
  v_seed bigint := 960000000000000000
    + floor(random() * 1000000000000000)::bigint;
  v_live text := v_seed::text;
  v_live_legacy text := (v_seed + 1)::text;
  v_offline_ready text := (v_seed + 2)::text;
  v_offline_wait text := (v_seed + 3)::text;
  v_correction text := (v_seed + 4)::text;
  v_snapshot_legacy text := (v_seed + 5)::text;
  v_banned text := (v_seed + 6)::text;
  v_duplicate text := (v_seed + 7)::text;
  v_suffix text := gen_random_uuid()::text;
  v_now timestamptz := transaction_timestamp();
  v_base timestamptz := transaction_timestamp() - interval '2 hours';
  v_snapshot_observed timestamptz := transaction_timestamp();
  v_live_joined timestamptz := transaction_timestamp() - interval '20 minutes';
  v_rejoin_joined timestamptz := transaction_timestamp() - interval '1 minute';
  v_ready_joined timestamptz := transaction_timestamp() - interval '14 minutes';
  v_wait_joined timestamptz := transaction_timestamp() - interval '4 minutes';
  v_correct_joined timestamptz := transaction_timestamp() - interval '30 minutes';
  v_result jsonb;
  v_snapshot_id uuid := gen_random_uuid();
  v_later_snapshot_id uuid := gen_random_uuid();
  v_stale_snapshot_id uuid := gen_random_uuid();
  v_duplicate_snapshot_id uuid := gen_random_uuid();
begin
  insert into public.discord_member_state (
    discord_user_id,
    current_discord_username,
    discord_joined_at,
    left_discord_at,
    is_in_discord,
    discord_ban_active,
    discord_membership_observed_at,
    discord_ban_observed_at
  ) values
    (v_live, 'joined-at-live', null, v_base, false, false, v_base, v_base),
    (
      v_live_legacy,
      'joined-at-live-legacy',
      null,
      v_base,
      false,
      false,
      v_base,
      v_base
    ),
    (
      v_offline_ready,
      'joined-at-ready',
      null,
      v_base,
      false,
      false,
      v_base,
      v_base
    ),
    (
      v_offline_wait,
      'joined-at-wait',
      null,
      v_base,
      false,
      false,
      v_base,
      v_base
    ),
    (
      v_correction,
      'joined-at-correction',
      v_now - interval '2 minutes',
      null,
      true,
      false,
      v_base,
      v_base
    ),
    (
      v_snapshot_legacy,
      'joined-at-snapshot-legacy',
      null,
      v_base,
      false,
      false,
      v_base,
      v_base
    ),
    (
      v_banned,
      'joined-at-banned',
      null,
      v_base,
      false,
      true,
      v_base,
      v_base
    ),
    (
      v_duplicate,
      'joined-at-duplicate',
      null,
      v_base,
      false,
      false,
      v_base,
      v_base
    );

  v_result := public.apply_discord_member_join_v2(
    'joined-at-live-' || v_suffix,
    v_now,
    repeat('a', 64),
    v_live,
    'joined-at-live',
    v_live_joined
  );

  if v_result ->> 'outcome' <> 'applied' or not exists (
    select 1
    from public.discord_member_state
    where discord_user_id = v_live
      and is_in_discord
      and discord_joined_at = v_live_joined
      and discord_membership_observed_at = v_now
  ) then
    raise exception 'live join did not preserve the Discord joinedAt';
  end if;

  v_result := public.apply_discord_member_join_v2(
    'joined-at-live-delayed-' || v_suffix,
    v_now + interval '1 second',
    repeat('b', 64),
    v_live,
    'joined-at-live-renamed',
    v_base
  );

  if v_result ->> 'outcome' <> 'no_change' or not exists (
    select 1
    from public.discord_member_state
    where discord_user_id = v_live
      and discord_joined_at = v_live_joined
      and discord_membership_observed_at = v_now + interval '1 second'
  ) then
    raise exception 'delayed live join backdated an active membership';
  end if;

  v_result := public.apply_discord_member_join_v2(
    'joined-at-live-legacy-' || v_suffix,
    v_now,
    repeat('c', 64),
    v_live_legacy,
    'joined-at-live-legacy',
    null
  );

  if v_result ->> 'outcome' <> 'applied' or not exists (
    select 1
    from public.discord_member_state
    where discord_user_id = v_live_legacy
      and discord_joined_at = v_now
  ) then
    raise exception 'legacy live join did not fall back to observedAt';
  end if;

  v_result := public.begin_discord_reconciliation_snapshot(
    'joined-at-snapshot-start-' || v_suffix,
    v_snapshot_observed,
    repeat('d', 64),
    v_snapshot_id,
    5,
    1
  );

  v_result := public.append_discord_reconciliation_chunk(
    'joined-at-snapshot-members-' || v_suffix,
    'snapshot_members_chunk',
    v_snapshot_observed,
    repeat('e', 64),
    v_snapshot_id,
    jsonb_build_array(
      jsonb_build_object(
        'discordUserId', v_offline_ready,
        'discordUsername', 'joined-at-ready',
        'joinedAt', v_ready_joined,
        'membershipObservedAt', v_snapshot_observed
      ),
      jsonb_build_object(
        'discordUserId', v_offline_wait,
        'discordUsername', 'joined-at-wait',
        'joinedAt', v_wait_joined,
        'membershipObservedAt', v_snapshot_observed
      ),
      jsonb_build_object(
        'discordUserId', v_correction,
        'discordUsername', 'joined-at-correction',
        'joinedAt', v_correct_joined,
        'membershipObservedAt', v_snapshot_observed
      ),
      jsonb_build_object(
        'discordUserId', v_snapshot_legacy,
        'discordUsername', 'joined-at-snapshot-legacy'
      ),
      jsonb_build_object(
        'discordUserId', v_banned,
        'discordUsername', 'joined-at-banned',
        'joinedAt', v_ready_joined,
        'membershipObservedAt', v_snapshot_observed
      )
    )
  );

  if v_result ->> 'outcome' <> 'applied' then
    raise exception 'joinedAt member chunk failed: %', v_result;
  end if;

  v_result := public.append_discord_reconciliation_chunk(
    'joined-at-snapshot-bans-' || v_suffix,
    'snapshot_bans_chunk',
    v_snapshot_observed,
    repeat('f', 64),
    v_snapshot_id,
    jsonb_build_array(jsonb_build_object(
      'discordUserId', v_banned,
      'discordUsername', 'joined-at-banned'
    ))
  );

  v_result := public.finalize_discord_reconciliation_snapshot(
    'joined-at-snapshot-final-' || v_suffix,
    v_snapshot_observed,
    repeat('0', 64),
    v_snapshot_id
  );

  if v_result ->> 'outcome' <> 'applied' then
    raise exception 'joinedAt snapshot failed: %', v_result;
  end if;

  if not exists (
    select 1
    from public.discord_member_state
    where discord_user_id = v_offline_ready
      and is_in_discord
      and discord_joined_at = v_ready_joined
      and discord_joined_at <= v_now - interval '10 minutes'
      and discord_membership_observed_at = v_snapshot_observed
  ) then
    raise exception 'offline ready member did not retain eligible joinedAt';
  end if;

  if not exists (
    select 1
    from public.discord_member_state
    where discord_user_id = v_offline_wait
      and discord_joined_at = v_wait_joined
      and discord_joined_at > v_now - interval '10 minutes'
  ) then
    raise exception 'offline waiting member did not retain remaining cooldown';
  end if;

  if not exists (
    select 1
    from public.discord_member_state
    where discord_user_id = v_correction
      and is_in_discord
      and discord_joined_at = v_correct_joined
      and discord_membership_observed_at = v_snapshot_observed
  ) then
    raise exception 'snapshot did not correct an active membership episode';
  end if;

  if not exists (
    select 1
    from public.discord_member_state
    where discord_user_id = v_snapshot_legacy
      and discord_joined_at = v_snapshot_observed
  ) then
    raise exception 'legacy snapshot member did not use conservative fallback';
  end if;

  if not exists (
    select 1
    from public.discord_member_state
    where discord_user_id = v_banned
      and discord_ban_active
      and not is_in_discord
  ) then
    raise exception 'snapshot joinedAt overrode an active ban';
  end if;

  v_result := public.begin_discord_reconciliation_snapshot(
    'joined-at-later-start-' || v_suffix,
    v_snapshot_observed + interval '1 minute',
    repeat('1', 64),
    v_later_snapshot_id,
    1,
    0
  );
  v_result := public.append_discord_reconciliation_chunk(
    'joined-at-later-members-' || v_suffix,
    'snapshot_members_chunk',
    v_snapshot_observed + interval '1 minute',
    repeat('2', 64),
    v_later_snapshot_id,
    jsonb_build_array(jsonb_build_object(
      'discordUserId', v_correction,
      'discordUsername', 'joined-at-correction',
      'joinedAt', v_correct_joined,
      'membershipObservedAt', v_snapshot_observed + interval '1 minute'
    ))
  );
  v_result := public.finalize_discord_reconciliation_snapshot(
    'joined-at-later-final-' || v_suffix,
    v_snapshot_observed + interval '1 minute',
    repeat('3', 64),
    v_later_snapshot_id
  );

  if not exists (
    select 1
    from public.discord_member_state
    where discord_user_id = v_correction
      and discord_joined_at = v_correct_joined
      and discord_joined_at
        <> v_snapshot_observed + interval '1 minute'
  ) then
    raise exception 'later snapshot shifted joinedAt to observation time';
  end if;

  v_result := public.apply_discord_member_remove(
    'joined-at-remove-' || v_suffix,
    v_snapshot_observed + interval '2 minutes',
    repeat('4', 64),
    v_correction,
    'joined-at-correction'
  );
  v_result := public.apply_discord_member_join_v2(
    'joined-at-rejoin-' || v_suffix,
    v_snapshot_observed + interval '3 minutes',
    repeat('5', 64),
    v_correction,
    'joined-at-correction',
    v_rejoin_joined
  );

  if not exists (
    select 1
    from public.discord_member_state
    where discord_user_id = v_correction
      and is_in_discord
      and discord_joined_at = v_rejoin_joined
  ) then
    raise exception 'leave and rejoin did not begin a new episode';
  end if;

  v_result := public.begin_discord_reconciliation_snapshot(
    'joined-at-stale-start-' || v_suffix,
    v_snapshot_observed + interval '150 seconds',
    repeat('6', 64),
    v_stale_snapshot_id,
    1,
    0
  );
  v_result := public.append_discord_reconciliation_chunk(
    'joined-at-stale-members-' || v_suffix,
    'snapshot_members_chunk',
    v_snapshot_observed + interval '150 seconds',
    repeat('7', 64),
    v_stale_snapshot_id,
    jsonb_build_array(jsonb_build_object(
      'discordUserId', v_correction,
      'discordUsername', 'joined-at-correction',
      'joinedAt', v_correct_joined,
      'membershipObservedAt', v_snapshot_observed + interval '150 seconds'
    ))
  );
  v_result := public.finalize_discord_reconciliation_snapshot(
    'joined-at-stale-final-' || v_suffix,
    v_snapshot_observed + interval '4 minutes',
    repeat('8', 64),
    v_stale_snapshot_id
  );

  if not exists (
    select 1
    from public.discord_member_state
    where discord_user_id = v_correction
      and discord_joined_at = v_rejoin_joined
      and discord_membership_observed_at
        = v_snapshot_observed + interval '3 minutes'
  ) then
    raise exception 'stale snapshot overwrote a newer rejoin';
  end if;

  v_result := public.begin_discord_reconciliation_snapshot(
    'joined-at-duplicate-start-' || v_suffix,
    v_snapshot_observed + interval '5 minutes',
    repeat('9', 64),
    v_duplicate_snapshot_id,
    1,
    0
  );
  v_result := public.append_discord_reconciliation_chunk(
    'joined-at-duplicate-one-' || v_suffix,
    'snapshot_members_chunk',
    v_snapshot_observed + interval '5 minutes',
    repeat('a', 64),
    v_duplicate_snapshot_id,
    jsonb_build_array(jsonb_build_object(
      'discordUserId', v_duplicate,
      'discordUsername', 'joined-at-duplicate',
      'joinedAt', v_ready_joined,
      'membershipObservedAt', v_snapshot_observed
    ))
  );

  v_result := public.append_discord_reconciliation_chunk(
    'joined-at-duplicate-one-' || v_suffix,
    'snapshot_members_chunk',
    v_snapshot_observed + interval '5 minutes',
    repeat('a', 64),
    v_duplicate_snapshot_id,
    jsonb_build_array(jsonb_build_object(
      'discordUserId', v_duplicate,
      'discordUsername', 'joined-at-duplicate',
      'joinedAt', v_ready_joined,
      'membershipObservedAt', v_snapshot_observed
    ))
  );
  if v_result ->> 'outcome' <> 'replay' then
    raise exception 'same chunk event was not idempotent';
  end if;

  v_result := public.append_discord_reconciliation_chunk(
    'joined-at-duplicate-two-' || v_suffix,
    'snapshot_members_chunk',
    v_snapshot_observed + interval '5 minutes',
    repeat('b', 64),
    v_duplicate_snapshot_id,
    jsonb_build_array(jsonb_build_object(
      'discordUserId', v_duplicate,
      'discordUsername', 'joined-at-duplicate',
      'joinedAt', v_ready_joined,
      'membershipObservedAt', v_snapshot_observed
    ))
  );
  if v_result ->> 'outcome' <> 'applied' then
    raise exception 'exact duplicate member record was not accepted';
  end if;

  v_result := public.append_discord_reconciliation_chunk(
    'joined-at-duplicate-conflict-' || v_suffix,
    'snapshot_members_chunk',
    v_snapshot_observed + interval '5 minutes',
    repeat('c', 64),
    v_duplicate_snapshot_id,
    jsonb_build_array(jsonb_build_object(
      'discordUserId', v_duplicate,
      'discordUsername', 'joined-at-duplicate',
      'joinedAt', v_ready_joined - interval '1 minute',
      'membershipObservedAt', v_snapshot_observed
    ))
  );
  if v_result ->> 'outcome' <> 'snapshot_conflict' or not exists (
    select 1
    from public.discord_reconciliation_snapshots
    where id = v_duplicate_snapshot_id
      and status = 'failed'
      and error_code = 'CONFLICTING_MEMBER_RECORD'
  ) then
    raise exception 'conflicting duplicate member record was not rejected';
  end if;

  if has_function_privilege(
    'anon',
    'public.apply_discord_member_join_v2(text,timestamptz,text,text,text,timestamptz)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.apply_discord_member_join_v2(text,timestamptz,text,text,text,timestamptz)',
    'EXECUTE'
  ) or has_function_privilege(
    'discord_bot',
    'public.apply_discord_member_join_v2(text,timestamptz,text,text,text,timestamptz)',
    'EXECUTE'
  ) then
    raise exception 'joinedAt RPC is executable by a non-service role';
  end if;
end;
$$;

rollback;

select 'discord_joined_at_provenance_ok' as result;
