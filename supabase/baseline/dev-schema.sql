--
-- PostgreSQL database dump
--



SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: voting_cycle_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.voting_cycle_status AS ENUM (
    'active',
    'finalizing',
    'finished',
    'draft',
    'submission_open',
    'submission_closed',
    'voting_open',
    'voting_closed',
    'completed',
    'archived',
    'cancelled',
    'paused'
);


--
-- Name: TYPE voting_cycle_status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TYPE public.voting_cycle_status IS 'Phase-based cycle statuses. Legacy values remain for compatibility: active should later map to submission_open or the correct current phase, and finished should later map to completed.';


--
-- Name: append_discord_reconciliation_chunk(text, text, timestamp with time zone, text, uuid, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.append_discord_reconciliation_chunk(p_event_id text, p_event_type text, p_observed_at timestamp with time zone, p_payload_sha256 text, p_snapshot_id uuid, p_records jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
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
$_$;


--
-- Name: apply_discord_ban(text, timestamp with time zone, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.apply_discord_ban(p_event_id text, p_observed_at timestamp with time zone, p_payload_sha256 text, p_discord_user_id text, p_discord_username text) RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  select public.apply_discord_live_event(
    p_event_id,
    'ban_added',
    p_observed_at,
    p_payload_sha256,
    p_discord_user_id,
    p_discord_username
  );
$$;


--
-- Name: apply_discord_live_event(text, text, timestamp with time zone, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.apply_discord_live_event(p_event_id text, p_event_type text, p_observed_at timestamp with time zone, p_payload_sha256 text, p_discord_user_id text, p_discord_username text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
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
$_$;


--
-- Name: apply_discord_member_join(text, timestamp with time zone, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.apply_discord_member_join(p_event_id text, p_observed_at timestamp with time zone, p_payload_sha256 text, p_discord_user_id text, p_discord_username text) RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  select public.apply_discord_live_event(
    p_event_id,
    'member_joined',
    p_observed_at,
    p_payload_sha256,
    p_discord_user_id,
    p_discord_username
  );
$$;


--
-- Name: apply_discord_member_remove(text, timestamp with time zone, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.apply_discord_member_remove(p_event_id text, p_observed_at timestamp with time zone, p_payload_sha256 text, p_discord_user_id text, p_discord_username text) RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  select public.apply_discord_live_event(
    p_event_id,
    'member_removed',
    p_observed_at,
    p_payload_sha256,
    p_discord_user_id,
    p_discord_username
  );
$$;


--
-- Name: apply_discord_unban(text, timestamp with time zone, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.apply_discord_unban(p_event_id text, p_observed_at timestamp with time zone, p_payload_sha256 text, p_discord_user_id text, p_discord_username text) RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  select public.apply_discord_live_event(
    p_event_id,
    'ban_removed',
    p_observed_at,
    p_payload_sha256,
    p_discord_user_id,
    p_discord_username
  );
$$;


--
-- Name: audit_discord_sync_action(text, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.audit_discord_sync_action(p_action text, p_discord_user_id text, p_meta jsonb DEFAULT '{}'::jsonb) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
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


--
-- Name: begin_discord_reconciliation_snapshot(text, timestamp with time zone, text, uuid, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.begin_discord_reconciliation_snapshot(p_event_id text, p_observed_at timestamp with time zone, p_payload_sha256 text, p_snapshot_id uuid, p_expected_member_count integer, p_expected_ban_count integer) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
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


--
-- Name: cast_cycle_vote(bigint, bigint, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cast_cycle_vote(p_cycle_id bigint, p_submission_id bigint, p_discord_user_id text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  cycle_row public.voting_cycles%rowtype;
  submission_row public.submissions%rowtype;
  current_vote_count integer;
  v_user_banned boolean;
  v_membership public.discord_member_state%rowtype;
begin
  if p_discord_user_id is null or btrim(p_discord_user_id) = '' then
    raise exception using message = 'INVALID_DISCORD_USER';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('discord-member:' || p_discord_user_id, 0)
  );

  select is_banned
  into v_user_banned
  from public.user_logs
  where discord_user_id = p_discord_user_id;

  if not found then
    raise exception using message = 'AUTH_DEPENDENCY_UNAVAILABLE';
  end if;

  select *
  into v_membership
  from public.discord_member_state
  where discord_user_id = p_discord_user_id;

  if not found then
    raise exception using message = 'NOT_IN_DISCORD';
  end if;

  if v_membership.discord_ban_active then
    raise exception using message = 'DISCORD_BANNED';
  end if;

  if v_user_banned then
    raise exception using message = 'WEBSITE_BANNED';
  end if;

  if not v_membership.is_in_discord then
    raise exception using message = 'NOT_IN_DISCORD';
  end if;

  if v_membership.discord_joined_at is null
    or v_membership.discord_joined_at > now() - interval '10 minutes'
  then
    raise exception using message = 'JOINED_TOO_RECENTLY';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_cycle_id::text || ':' || p_discord_user_id, 0)
  );

  select *
  into cycle_row
  from public.voting_cycles
  where id = p_cycle_id
  for update;

  if not found or cycle_row.status::text <> 'voting_open' then
    raise exception using message = 'NO_ACTIVE_VOTING_PHASE';
  end if;

  select *
  into submission_row
  from public.submissions
  where id = p_submission_id
    and cycle_id = p_cycle_id
  for update;

  if not found then
    raise exception using message = 'SUBMISSION_NOT_FOUND';
  end if;

  if coalesce(submission_row.is_disqualified, false)
    or submission_row.public_visibility_status <> 'visible'
  then
    raise exception using
      message = 'SUBMISSION_NOT_COMPETITION_ELIGIBLE';
  end if;

  if cycle_row.allow_self_vote = false
    and submission_row.discord_user_id = p_discord_user_id
  then
    raise exception using message = 'SELF_VOTE';
  end if;

  if exists (
    select 1
    from public.votes
    where cycle_id = p_cycle_id
      and submission_id = p_submission_id
      and discord_user_id = p_discord_user_id
  ) then
    raise exception using message = 'DUPLICATE_SUBMISSION_VOTE';
  end if;

  select count(*)::integer
  into current_vote_count
  from public.votes
  where cycle_id = p_cycle_id
    and discord_user_id = p_discord_user_id;

  if current_vote_count >= cycle_row.votes_per_user then
    raise exception using message = 'VOTE_LIMIT_REACHED';
  end if;

  insert into public.votes (
    cycle_id,
    submission_id,
    discord_user_id
  ) values (
    p_cycle_id,
    p_submission_id,
    p_discord_user_id
  );

  current_vote_count := current_vote_count + 1;

  return jsonb_build_object(
    'voteCount', current_vote_count,
    'votesPerUser', cycle_row.votes_per_user,
    'hasVoted', current_vote_count >= cycle_row.votes_per_user
  );
end;
$$;


--
-- Name: FUNCTION cast_cycle_vote(p_cycle_id bigint, p_submission_id bigint, p_discord_user_id text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.cast_cycle_vote(p_cycle_id bigint, p_submission_id bigint, p_discord_user_id text) IS 'Atomically enforces fail-closed Website/Discord access plus voting phase, limits, no self-votes, and one vote per submission.';


--
-- Name: claim_discord_membership_sync_event(text, text, timestamp with time zone, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_discord_membership_sync_event(p_event_id text, p_event_type text, p_observed_at timestamp with time zone, p_payload_sha256 text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
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
$_$;


--
-- Name: claim_media_cleanup_jobs(integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_media_cleanup_jobs(p_limit integer DEFAULT 10, p_lease_seconds integer DEFAULT 120) RETURNS TABLE(job_id bigint, storage_provider text, storage_key text, lease_token uuid, attempt_count integer, locked_until timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_now timestamptz := transaction_timestamp();
begin
  if p_limit is null or p_limit < 1 or p_limit > 20 then
    raise exception using message = 'INVALID_MEDIA_CLEANUP_BATCH_SIZE';
  end if;

  if p_lease_seconds is null
    or p_lease_seconds < 30
    or p_lease_seconds > 300
  then
    raise exception using message = 'INVALID_MEDIA_CLEANUP_LEASE_SECONDS';
  end if;

  -- Exhausted legacy/retry rows and exhausted crashed leases become visible
  -- terminal failures instead of remaining permanently unclaimable.
  update public.media_cleanup_queue queue
  set
    status = 'dead',
    next_attempt_at = null,
    locked_at = null,
    locked_until = null,
    lease_token = null,
    processed_at = null,
    last_error_code = coalesce(
      nullif(queue.last_error_code, ''),
      'MAX_ATTEMPTS_EXCEEDED'
    ),
    updated_at = v_now
  where queue.attempts >= 7
    and (
      queue.status in ('pending', 'failed')
      or (
        queue.status = 'processing'
        and queue.locked_until <= v_now
      )
    );

  return query
  with candidates as (
    select queue.id
    from public.media_cleanup_queue queue
    where queue.attempts < 7
      and (
        (
          queue.status in ('pending', 'failed')
          and queue.next_attempt_at <= v_now
        )
        or (
          queue.status = 'processing'
          and queue.locked_until <= v_now
        )
      )
    order by
      case
        when queue.status = 'processing' then queue.locked_until
        else queue.next_attempt_at
      end,
      queue.created_at,
      queue.id
    for update skip locked
    limit p_limit
  ), claimed as (
    update public.media_cleanup_queue queue
    set
      status = 'processing',
      attempts = queue.attempts + 1,
      next_attempt_at = null,
      locked_at = v_now,
      locked_until = v_now + make_interval(secs => p_lease_seconds),
      lease_token = gen_random_uuid(),
      last_attempt_at = v_now,
      processed_at = null,
      updated_at = v_now
    from candidates
    where queue.id = candidates.id
    returning queue.*
  )
  select
    claimed.id,
    claimed.storage_provider,
    claimed.storage_key,
    claimed.lease_token,
    claimed.attempts,
    claimed.locked_until
  from claimed
  order by claimed.created_at, claimed.id;
end;
$$;


--
-- Name: FUNCTION claim_media_cleanup_jobs(p_limit integer, p_lease_seconds integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.claim_media_cleanup_jobs(p_limit integer, p_lease_seconds integer) IS 'Claims at most 20 due jobs with FOR UPDATE SKIP LOCKED. Attempts count issued leases; expired leases receive a new token and one new attempt.';


--
-- Name: commit_submission_upload(uuid, uuid, text, text, integer, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.commit_submission_upload(p_operation_id uuid, p_session_id uuid, p_wallet_address text, p_payout_choice text, p_split_percent integer, p_charity text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
declare
  v_now timestamptz := transaction_timestamp();
  v_discord_user_id text;
  v_operation public.submission_upload_operations%rowtype;
  v_cycle public.voting_cycles%rowtype;
  v_user public.user_logs%rowtype;
  v_membership public.discord_member_state%rowtype;
  v_rules_version integer;
  v_submission_id bigint;
  v_social_snapshot_count integer := 0;
  v_wallet_address text := coalesce(btrim(p_wallet_address), '');
  v_charity text := nullif(btrim(p_charity), '');
begin
  if p_operation_id is null or p_session_id is null then
    return jsonb_build_object('outcome', 'invalid_request');
  end if;

  if p_payout_choice is null
    or p_payout_choice not in ('keep', 'donate', 'split')
    or length(v_wallet_address) > 512
    or length(coalesce(v_charity, '')) > 256
    or (
      p_payout_choice = 'keep'
      and (
        v_wallet_address = ''
        or p_split_percent is not null
        or v_charity is not null
      )
    )
    or (
      p_payout_choice = 'donate'
      and (
        v_wallet_address <> ''
        or p_split_percent is not null
        or v_charity is null
      )
    )
    or (
      p_payout_choice = 'split'
      and (
        v_wallet_address = ''
        or p_split_percent is null
        or p_split_percent <= 0
        or p_split_percent >= 100
        or v_charity is null
      )
    )
  then
    return jsonb_build_object('outcome', 'invalid_private_data');
  end if;

  select session.discord_user_id
  into v_discord_user_id
  from public.sessions session
  where session.id = p_session_id
    and session.revoked_at is null;

  if not found then
    return jsonb_build_object('outcome', 'not_authenticated');
  end if;

  select operation.*
  into v_operation
  from public.submission_upload_operations operation
  where operation.id = p_operation_id
    and operation.discord_user_id = v_discord_user_id
  for update;

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_operation.status = 'completed' then
    return jsonb_build_object(
      'outcome', 'already_completed',
      'operationId', v_operation.id,
      'cycleId', v_operation.cycle_id,
      'submissionId', v_operation.submission_id
    );
  end if;

  if v_operation.status <> 'r2_uploaded' then
    return jsonb_build_object(
      'outcome', 'invalid_state',
      'status', v_operation.status
    );
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'submission-upload-user-cycle:' ||
      v_discord_user_id || ':' || v_operation.cycle_id::text,
      0
    )
  );

  select cycle.*
  into v_cycle
  from public.voting_cycles cycle
  where cycle.id = v_operation.cycle_id
  for update;

  if not found or v_cycle.status::text not in ('submission_open', 'active') then
    return jsonb_build_object('outcome', 'cycle_not_open');
  end if;

  select users.*
  into v_user
  from public.user_logs users
  where users.discord_user_id = v_discord_user_id;

  if not found then
    return jsonb_build_object('outcome', 'dependency_unavailable');
  end if;

  if v_user.is_banned then
    return jsonb_build_object('outcome', 'banned');
  end if;

  if coalesce(v_user.upload_fail_count, 0) >= 5 then
    return jsonb_build_object('outcome', 'rate_limited');
  end if;

  select rules.current_version
  into v_rules_version
  from public.rules_meta rules
  where rules.id = 1;

  if not found then
    return jsonb_build_object('outcome', 'dependency_unavailable');
  end if;

  if v_user.accepted_rules_version is distinct from v_rules_version then
    return jsonb_build_object('outcome', 'rules_not_accepted');
  end if;

  select membership.*
  into v_membership
  from public.discord_member_state membership
  where membership.discord_user_id = v_discord_user_id;

  if not found or not coalesce(v_membership.is_in_discord, false) then
    return jsonb_build_object('outcome', 'not_in_discord');
  end if;

  if v_membership.discord_joined_at is null
    or v_membership.discord_joined_at > v_now - interval '10 minutes'
  then
    return jsonb_build_object('outcome', 'joined_too_recently');
  end if;

  if exists (
    select 1
    from public.submissions submission
    where submission.cycle_id = v_operation.cycle_id
      and submission.discord_user_id = v_discord_user_id
  ) then
    return jsonb_build_object('outcome', 'upload_limit_reached');
  end if;

  if v_operation.storage_provider <> 'r2'
    or v_operation.storage_key !~ (
      '^' || v_operation.cycle_id::text || '/[0-9A-Fa-f-]{36}[.]webp$'
    )
    or v_operation.media_type <> 'image/webp'
    or v_operation.media_bytes <= 0
    or v_operation.content_sha256 !~ '^[0-9a-f]{64}$'
  then
    return jsonb_build_object('outcome', 'invalid_media_metadata');
  end if;

  insert into public.submissions (
    cycle_id,
    discord_user_id,
    r2_key,
    discord_username_at_upload
  ) values (
    v_operation.cycle_id,
    v_discord_user_id,
    v_operation.storage_key,
    coalesce(v_user.current_discord_username, 'unknown')
  )
  returning id into v_submission_id;

  insert into public.submission_private_data (
    submission_id,
    x_username,
    wallet_address,
    payout_choice,
    split_percent,
    charity
  ) values (
    v_submission_id,
    null,
    v_wallet_address,
    p_payout_choice,
    case when p_payout_choice = 'split' then p_split_percent else null end,
    case when p_payout_choice in ('donate', 'split') then v_charity else null end
  );

  if v_user.show_socials_on_submissions then
    insert into public.submission_social_links (
      submission_id,
      discord_user_id,
      platform,
      display_label,
      profile_url,
      is_verified_snapshot,
      source_user_social_link_id
    )
    select
      v_submission_id,
      v_discord_user_id,
      social.platform,
      case
        when nullif(btrim(social.handle), '') is not null
          and not (
            social.platform = 'facebook'
            and social.handle like 'id:%'
          )
          then social.handle
        else social.profile_url
      end,
      social.profile_url,
      true,
      social.id
    from public.user_social_links social
    where social.discord_user_id = v_discord_user_id
      and social.is_verified = true
    order by social.created_at, social.id;

    get diagnostics v_social_snapshot_count = row_count;
  end if;

  insert into public.upload_logs (
    cycle_id,
    discord_user_id,
    submission_id,
    status,
    reason
  ) values (
    v_operation.cycle_id::text,
    v_discord_user_id,
    v_submission_id::text,
    'success',
    null
  );

  update public.submission_upload_operations operation
  set
    status = 'completed',
    submission_id = v_submission_id,
    cleanup_required = false,
    last_error_code = null,
    updated_at = v_now,
    last_attempt_at = v_now,
    completed_at = v_now
  where operation.id = v_operation.id;

  return jsonb_build_object(
    'outcome', 'completed',
    'operationId', v_operation.id,
    'cycleId', v_operation.cycle_id,
    'submissionId', v_submission_id,
    'socialSnapshotCount', v_social_snapshot_count
  );
end;
$_$;


--
-- Name: FUNCTION commit_submission_upload(p_operation_id uuid, p_session_id uuid, p_wallet_address text, p_payout_choice text, p_split_percent integer, p_charity text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.commit_submission_upload(p_operation_id uuid, p_session_id uuid, p_wallet_address text, p_payout_choice text, p_split_percent integer, p_charity text) IS 'Revalidates session, membership, ban, rules, rate limit, cycle phase, and per-cycle upload limit under locks, then atomically creates the submission, private data, verified social snapshots, success audit, and completed operation.';


--
-- Name: complete_media_cleanup_job(bigint, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.complete_media_cleanup_job(p_job_id bigint, p_lease_token uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_now timestamptz := transaction_timestamp();
  v_attempts integer;
  v_status text;
begin
  if p_job_id is null or p_job_id <= 0 or p_lease_token is null then
    raise exception using message = 'INVALID_MEDIA_CLEANUP_COMPLETION';
  end if;

  update public.media_cleanup_queue queue
  set
    status = 'completed',
    next_attempt_at = null,
    locked_at = null,
    locked_until = null,
    lease_token = null,
    last_error_code = null,
    processed_at = v_now,
    updated_at = v_now
  where queue.id = p_job_id
    and queue.status = 'processing'
    and queue.lease_token = p_lease_token
    and queue.locked_until > v_now
  returning queue.attempts into v_attempts;

  if found then
    return jsonb_build_object(
      'outcome', 'completed',
      'jobId', p_job_id,
      'status', 'completed',
      'attemptCount', v_attempts
    );
  end if;

  select queue.status
  into v_status
  from public.media_cleanup_queue queue
  where queue.id = p_job_id;

  return jsonb_build_object(
    'outcome', case when found then 'stale_lease' else 'not_found' end,
    'jobId', p_job_id,
    'status', v_status
  );
end;
$$;


--
-- Name: FUNCTION complete_media_cleanup_job(p_job_id bigint, p_lease_token uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.complete_media_cleanup_job(p_job_id bigint, p_lease_token uuid) IS 'Completes only a processing job whose token still owns an unexpired lease. Stale workers receive a structured no-op.';


--
-- Name: create_cancerculture_session(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_cancerculture_session(p_session_id uuid, p_discord_user_id text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
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
$_$;


--
-- Name: enforce_discord_authenticated_action(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_discord_authenticated_action() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
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


--
-- Name: enforce_discord_ban_submissions(text, timestamp with time zone, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_discord_ban_submissions(p_discord_user_id text, p_observed_at timestamp with time zone, p_source text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_cycle_id bigint;
  v_hidden_count integer := 0;
  v_disqualified_count integer := 0;
  v_changed_count integer := 0;
  v_now timestamptz := transaction_timestamp();
begin
  if p_discord_user_id is null
    or btrim(p_discord_user_id) = ''
    or p_observed_at is null
    or p_source is null
    or length(btrim(p_source)) not between 1 and 80
  then
    raise exception using message = 'INVALID_DISCORD_BAN_ENFORCEMENT';
  end if;

  for v_cycle_id in
    select distinct submission.cycle_id
    from public.submissions submission
    where submission.discord_user_id = p_discord_user_id
      and submission.cycle_id is not null
    order by submission.cycle_id
  loop
    perform pg_advisory_xact_lock(
      hashtextextended(
        'cycle-finalization:' || v_cycle_id::text,
        0
      )
    );
    perform pg_advisory_xact_lock(
      hashtextextended(
        'cycle-reset:' || v_cycle_id::text,
        0
      )
    );
  end loop;

  perform 1
  from public.voting_cycles cycle
  where cycle.id in (
    select submission.cycle_id
    from public.submissions submission
    where submission.discord_user_id = p_discord_user_id
      and submission.cycle_id is not null
  )
  order by cycle.id
  for update;

  perform 1
  from public.submissions submission
  where submission.discord_user_id = p_discord_user_id
  order by submission.id
  for update;

  select
    count(*) filter (
      where submission.public_visibility_status <> 'removed'
    )::integer,
    count(*) filter (
      where coalesce(submission.is_disqualified, false) = false
        and cycle.status::text in (
          'draft',
          'active',
          'submission_open',
          'submission_closed',
          'voting_open',
          'voting_closed',
          'paused',
          'finalizing'
        )
    )::integer,
    count(*) filter (
      where submission.public_visibility_status <> 'removed'
        or submission.public_visibility_source <> 'discord_ban'
        or submission.public_republished_at is not null
        or (
          coalesce(submission.is_disqualified, false) = false
          and cycle.status::text in (
            'draft',
            'active',
            'submission_open',
            'submission_closed',
            'voting_open',
            'voting_closed',
            'paused',
            'finalizing'
          )
        )
    )::integer
  into
    v_hidden_count,
    v_disqualified_count,
    v_changed_count
  from public.submissions submission
  left join public.voting_cycles cycle
    on cycle.id = submission.cycle_id
  where submission.discord_user_id = p_discord_user_id;

  update public.submissions submission
  set
    public_visibility_status = 'removed',
    public_visibility_reason_code = 'discord_ban',
    public_visibility_reason_text = null,
    public_visibility_updated_at = v_now,
    public_visibility_updated_by_discord_user_id = null,
    public_visibility_updated_by_discord_username = 'Discord sync',
    public_visibility_source = 'discord_ban',
    discord_ban_hidden_at = v_now,
    discord_ban_hidden_observed_at = greatest(
      coalesce(
        submission.discord_ban_hidden_observed_at,
        '-infinity'::timestamptz
      ),
      p_observed_at
    ),
    public_republished_at = null,
    public_republished_by_discord_user_id = null,
    public_republish_reason = null,
    public_republish_review_confirmed = false,
    is_disqualified = case
      when cycle.status::text in (
        'draft',
        'active',
        'submission_open',
        'submission_closed',
        'voting_open',
        'voting_closed',
        'paused',
        'finalizing'
      )
      then true
      else submission.is_disqualified
    end,
    disqualification_type = case
      when coalesce(submission.is_disqualified, false) = false
        and cycle.status::text in (
          'draft',
          'active',
          'submission_open',
          'submission_closed',
          'voting_open',
          'voting_closed',
          'paused',
          'finalizing'
        )
      then 'discord_ban'
      else submission.disqualification_type
    end,
    disqualification_reason_code = case
      when coalesce(submission.is_disqualified, false) = false
        and cycle.status::text in (
          'draft',
          'active',
          'submission_open',
          'submission_closed',
          'voting_open',
          'voting_closed',
          'paused',
          'finalizing'
        )
      then 'discord_ban'
      else submission.disqualification_reason_code
    end,
    disqualification_reason_text = case
      when coalesce(submission.is_disqualified, false) = false
        and cycle.status::text in (
          'draft',
          'active',
          'submission_open',
          'submission_closed',
          'voting_open',
          'voting_closed',
          'paused',
          'finalizing'
        )
      then null
      else submission.disqualification_reason_text
    end,
    disqualified_at = case
      when coalesce(submission.is_disqualified, false) = false
        and cycle.status::text in (
          'draft',
          'active',
          'submission_open',
          'submission_closed',
          'voting_open',
          'voting_closed',
          'paused',
          'finalizing'
        )
      then v_now
      else submission.disqualified_at
    end,
    disqualified_by_discord_user_id = case
      when coalesce(submission.is_disqualified, false) = false
        and cycle.status::text in (
          'draft',
          'active',
          'submission_open',
          'submission_closed',
          'voting_open',
          'voting_closed',
          'paused',
          'finalizing'
        )
      then null
      else submission.disqualified_by_discord_user_id
    end,
    disqualified_by_discord_username = case
      when coalesce(submission.is_disqualified, false) = false
        and cycle.status::text in (
          'draft',
          'active',
          'submission_open',
          'submission_closed',
          'voting_open',
          'voting_closed',
          'paused',
          'finalizing'
        )
      then 'Discord sync'
      else submission.disqualified_by_discord_username
    end
  from public.voting_cycles cycle
  where submission.discord_user_id = p_discord_user_id
    and cycle.id = submission.cycle_id;

  update public.submissions submission
  set
    public_visibility_status = 'removed',
    public_visibility_reason_code = 'discord_ban',
    public_visibility_reason_text = null,
    public_visibility_updated_at = v_now,
    public_visibility_updated_by_discord_user_id = null,
    public_visibility_updated_by_discord_username = 'Discord sync',
    public_visibility_source = 'discord_ban',
    discord_ban_hidden_at = v_now,
    discord_ban_hidden_observed_at = greatest(
      coalesce(
        submission.discord_ban_hidden_observed_at,
        '-infinity'::timestamptz
      ),
      p_observed_at
    ),
    public_republished_at = null,
    public_republished_by_discord_user_id = null,
    public_republish_reason = null,
    public_republish_review_confirmed = false
  where submission.discord_user_id = p_discord_user_id
    and submission.cycle_id is null;

  if v_changed_count > 0 then
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
      'discord_ban_submissions_enforced',
      'discord_user',
      p_discord_user_id,
      jsonb_build_object(
        'source', left(btrim(p_source), 80),
        'observedAt', p_observed_at,
        'hiddenSubmissions', v_hidden_count,
        'disqualifiedSubmissions', v_disqualified_count
      )
    );
  end if;

  return jsonb_build_object(
    'outcome', case
      when v_changed_count > 0 then 'applied'
      else 'no_change'
    end,
    'hiddenSubmissions', v_hidden_count,
    'disqualifiedSubmissions', v_disqualified_count
  );
end;
$$;


--
-- Name: FUNCTION enforce_discord_ban_submissions(p_discord_user_id text, p_observed_at timestamp with time zone, p_source text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.enforce_discord_ban_submissions(p_discord_user_id text, p_observed_at timestamp with time zone, p_source text) IS 'Hides every Submission for one Discord-banned user and disqualifies only non-finalized competition entries without deleting media or historical result snapshots.';


--
-- Name: enforce_discord_ban_submissions_trigger(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_discord_ban_submissions_trigger() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  if new.discord_ban_active
    and (
      tg_op = 'INSERT'
      or not coalesce(old.discord_ban_active, false)
    )
  then
    perform public.enforce_discord_ban_submissions(
      new.discord_user_id,
      coalesce(
        new.discord_ban_observed_at,
        new.discord_banned_at,
        transaction_timestamp()
      ),
      'discord_ban_state_transition'
    );
  end if;

  return new;
end;
$$;


--
-- Name: enforce_submission_upload_abuse_block(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_submission_upload_abuse_block() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  if new.status in ('reserved', 'completed') and exists (
    select 1
    from public.submission_upload_abuse_states state
    where state.discord_user_id = new.discord_user_id
      and state.cycle_id = new.cycle_id
      and state.blocked_at is not null
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'UPLOAD_BLOCKED_FOR_CYCLE';
  end if;

  return new;
end;
$$;


--
-- Name: enqueue_deleted_submission_media(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enqueue_deleted_submission_media() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  if old.r2_key is not null and btrim(old.r2_key) <> '' then
    insert into public.media_cleanup_queue (
      storage_provider,
      storage_key,
      reason,
      status
    ) values (
      'r2',
      old.r2_key,
      'submission_deleted:' || old.id::text,
      'pending'
    )
    on conflict (storage_provider, storage_key) do nothing;
  end if;

  update public.submission_upload_operations operation
  set
    status = 'cleanup_pending',
    submission_id = null,
    cleanup_required = true,
    last_error_code = 'SUBMISSION_DELETED',
    updated_at = transaction_timestamp(),
    last_attempt_at = transaction_timestamp(),
    completed_at = null
  where operation.submission_id = old.id
    and operation.status = 'completed';

  return old;
end;
$$;


--
-- Name: enqueue_submission_upload_cleanup(uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enqueue_submission_upload_cleanup(p_operation_id uuid, p_session_id uuid, p_error_code text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_now timestamptz := transaction_timestamp();
  v_discord_user_id text;
  v_operation public.submission_upload_operations%rowtype;
  v_error_code text;
  v_queue_id bigint;
  v_queue_status text;
begin
  if p_operation_id is null or p_session_id is null then
    return jsonb_build_object('outcome', 'invalid_request');
  end if;

  select session.discord_user_id
  into v_discord_user_id
  from public.sessions session
  where session.id = p_session_id;

  if not found then
    return jsonb_build_object('outcome', 'not_authenticated');
  end if;

  select operation.*
  into v_operation
  from public.submission_upload_operations operation
  where operation.id = p_operation_id
    and operation.discord_user_id = v_discord_user_id
  for update;

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_operation.status = 'completed' then
    return jsonb_build_object(
      'outcome', 'already_completed',
      'operationId', v_operation.id,
      'submissionId', v_operation.submission_id
    );
  end if;

  v_error_code := public.submission_upload_error_code(p_error_code);

  insert into public.media_cleanup_queue (
    storage_provider,
    storage_key,
    reason,
    status
  ) values (
    v_operation.storage_provider,
    v_operation.storage_key,
    'submission_upload_compensation:' || v_operation.id::text,
    'pending'
  )
  on conflict (storage_provider, storage_key) do nothing;

  select queue.id, queue.status
  into v_queue_id, v_queue_status
  from public.media_cleanup_queue queue
  where queue.storage_provider = v_operation.storage_provider
    and queue.storage_key = v_operation.storage_key;

  update public.submission_upload_operations operation
  set
    status = 'cleanup_pending',
    submission_id = null,
    cleanup_required = true,
    last_error_code = v_error_code,
    updated_at = v_now,
    last_attempt_at = v_now,
    completed_at = null
  where operation.id = v_operation.id;

  return jsonb_build_object(
    'outcome', 'cleanup_pending',
    'operationId', v_operation.id,
    'queueId', v_queue_id,
    'queueStatus', v_queue_status
  );
end;
$$;


--
-- Name: FUNCTION enqueue_submission_upload_cleanup(p_operation_id uuid, p_session_id uuid, p_error_code text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.enqueue_submission_upload_cleanup(p_operation_id uuid, p_session_id uuid, p_error_code text) IS 'Atomically marks an unfinished upload as cleanup_pending and deduplicates its canonical R2 key into the shared media cleanup queue.';


--
-- Name: fail_media_cleanup_job(bigint, uuid, text, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fail_media_cleanup_job(p_job_id bigint, p_lease_token uuid, p_error_code text, p_permanent boolean DEFAULT false) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_now timestamptz := transaction_timestamp();
  v_job public.media_cleanup_queue%rowtype;
  v_error_code text;
  v_delay interval;
  v_next_attempt_at timestamptz;
  v_terminal boolean;
begin
  if p_job_id is null or p_job_id <= 0 or p_lease_token is null then
    raise exception using message = 'INVALID_MEDIA_CLEANUP_FAILURE';
  end if;

  v_error_code := left(
    regexp_replace(
      coalesce(nullif(btrim(p_error_code), ''), 'R2_DELETE_FAILED'),
      '[^A-Za-z0-9_.-]',
      '_',
      'g'
    ),
    120
  );

  select queue.*
  into v_job
  from public.media_cleanup_queue queue
  where queue.id = p_job_id
  for update;

  if not found then
    return jsonb_build_object(
      'outcome', 'not_found',
      'jobId', p_job_id,
      'status', null
    );
  end if;

  if v_job.status <> 'processing'
    or v_job.lease_token is distinct from p_lease_token
    or v_job.locked_until is null
    or v_job.locked_until <= v_now
  then
    return jsonb_build_object(
      'outcome', 'stale_lease',
      'jobId', p_job_id,
      'status', v_job.status
    );
  end if;

  v_terminal := coalesce(p_permanent, false) or v_job.attempts >= 7;
  v_delay := case
    when v_terminal then null
    else public.media_cleanup_retry_delay(v_job.attempts)
  end;
  v_next_attempt_at := case
    when v_delay is null then null
    else v_now + v_delay
  end;

  update public.media_cleanup_queue queue
  set
    status = case when v_terminal then 'dead' else 'failed' end,
    next_attempt_at = v_next_attempt_at,
    locked_at = null,
    locked_until = null,
    lease_token = null,
    last_error_code = v_error_code,
    processed_at = null,
    updated_at = v_now
  where queue.id = p_job_id;

  return jsonb_build_object(
    'outcome', case
      when v_terminal then 'terminal_failure'
      else 'retry_scheduled'
    end,
    'jobId', p_job_id,
    'status', case when v_terminal then 'dead' else 'failed' end,
    'attemptCount', v_job.attempts,
    'nextAttemptAt', v_next_attempt_at
  );
end;
$$;


--
-- Name: FUNCTION fail_media_cleanup_job(p_job_id bigint, p_lease_token uuid, p_error_code text, p_permanent boolean); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.fail_media_cleanup_job(p_job_id bigint, p_lease_token uuid, p_error_code text, p_permanent boolean) IS 'Fails only the current unexpired lease. Attempts 1-6 use 1m/5m/15m/1h/6h/24h backoff; attempt 7 or a permanent validation/configuration error becomes dead.';


--
-- Name: finalize_cycle(bigint, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.finalize_cycle(p_cycle_id bigint, p_actor_discord_user_id text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_initial_status text;
  v_finalized_at timestamptz := transaction_timestamp();
  v_ranked_submission_count integer := 0;
  v_winner_count integer := 0;
  v_highest_rank integer := 0;
begin
  if p_cycle_id is null or p_cycle_id <= 0 then
    raise exception using message = 'INVALID_CYCLE_ID';
  end if;

  if p_actor_discord_user_id is null
    or btrim(p_actor_discord_user_id) = ''
  then
    raise exception using message = 'INVALID_FINALIZATION_ACTOR';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('cycle-finalization:' || p_cycle_id::text, 0)
  );

  select status::text
  into v_initial_status
  from public.voting_cycles
  where id = p_cycle_id
  for update;

  if not found then
    raise exception using message = 'CYCLE_NOT_FOUND';
  end if;

  if v_initial_status = 'finished' then
    select
      count(*)::integer,
      count(*) filter (where is_winner = true)::integer,
      coalesce(max(rank_in_cycle), 0)::integer
    into
      v_ranked_submission_count,
      v_winner_count,
      v_highest_rank
    from public.cycle_results
    where cycle_id = p_cycle_id;

    if v_ranked_submission_count = 0
      or exists (
        select 1
        from public.cycle_results
        where cycle_id = p_cycle_id
          and (
            final_vote_count is null
            or rank_in_cycle is null
            or tie_group is null
            or finalized_at is null
            or feed_eligible is null
            or public_visibility_status_at_finalization is null
          )
      )
    then
      raise exception using
        message = 'FINALIZED_RESULT_SNAPSHOT_INCOMPLETE';
    end if;

    return jsonb_build_object(
      'cycleId', p_cycle_id,
      'finalStatus', 'finished',
      'rankedSubmissionCount', v_ranked_submission_count,
      'winnerCount', v_winner_count,
      'highestRank', v_highest_rank,
      'alreadyFinalized', true
    );
  end if;

  if v_initial_status not in (
    'voting_closed',
    'finalizing',
    'active'
  ) then
    raise exception using
      message = 'INVALID_CYCLE_STATE',
      detail = 'Cycle status is ' || v_initial_status;
  end if;

  update public.voting_cycles
  set status = 'finalizing'
  where id = p_cycle_id;

  insert into public.cycle_events (
    cycle_id,
    event_type,
    actor_type,
    actor_discord_user_id,
    payload
  )
  select
    p_cycle_id,
    'cycle_finalizing',
    'admin',
    p_actor_discord_user_id,
    jsonb_build_object(
      'phase', 'finalizing',
      'recovery', v_initial_status = 'finalizing'
    )
  where not exists (
    select 1
    from public.cycle_events
    where cycle_id = p_cycle_id
      and event_type = 'cycle_finalizing'
  );

  delete from public.winner_public_profiles
  where cycle_id = p_cycle_id;

  delete from public.cycle_results
  where cycle_id = p_cycle_id;

  with vote_totals as (
    select
      s.id as submission_id,
      count(v.id)::integer as final_vote_count,
      coalesce(
        nullif(btrim(s.public_visibility_status), ''),
        'visible'
      ) as visibility_status
    from public.submissions s
    left join public.votes v
      on v.cycle_id = p_cycle_id
      and v.submission_id = s.id
    where s.cycle_id = p_cycle_id
      and coalesce(s.is_disqualified, false) = false
    group by s.id, s.public_visibility_status
  ), ranked as (
    select
      submission_id,
      final_vote_count,
      dense_rank() over (
        order by final_vote_count desc
      )::integer as dense_rank,
      visibility_status
    from vote_totals
  )
  insert into public.cycle_results (
    cycle_id,
    submission_id,
    vote_count,
    is_winner,
    rank,
    final_vote_count,
    rank_in_cycle,
    tie_group,
    finalized_at,
    feed_eligible,
    public_visibility_status_at_finalization
  )
  select
    p_cycle_id,
    submission_id,
    final_vote_count,
    dense_rank = 1,
    dense_rank,
    final_vote_count,
    dense_rank,
    dense_rank,
    v_finalized_at,
    true,
    visibility_status
  from ranked;

  get diagnostics v_ranked_submission_count = row_count;

  if v_ranked_submission_count = 0 then
    raise exception using
      message = 'NO_COMPETITION_ELIGIBLE_SUBMISSIONS';
  end if;

  select
    count(*) filter (where rank_in_cycle = 1)::integer,
    coalesce(max(rank_in_cycle), 0)::integer
  into v_winner_count, v_highest_rank
  from public.cycle_results
  where cycle_id = p_cycle_id;

  if v_winner_count = 0 then
    raise exception using message = 'NO_FINALIZATION_WINNER';
  end if;

  if exists (
    select 1
    from public.cycle_results cr
    where cr.cycle_id = p_cycle_id
      and cr.rank_in_cycle = 1
      and not exists (
        select 1
        from public.submission_private_data spd
        where spd.submission_id = cr.submission_id
      )
  ) then
    raise exception using message = 'WINNER_PRIVATE_DATA_MISSING';
  end if;

  insert into public.winner_public_profiles (
    cycle_id,
    submission_id,
    x_username,
    wallet_address,
    payout_choice,
    split_percent,
    charity,
    win_share,
    wall,
    vote_count,
    r2_key
  )
  select
    p_cycle_id,
    cr.submission_id,
    coalesce(
      private_data.x_username,
      s.discord_username_at_upload,
      'unknown'
    ),
    private_data.wallet_address,
    private_data.payout_choice,
    private_data.split_percent,
    private_data.charity,
    1.0 / v_winner_count,
    case
      when private_data.payout_choice = 'donate' then 'fame'
      when private_data.payout_choice = 'split'
        and coalesce(private_data.split_percent, 100) < 100
      then 'fame'
      else 'shame'
    end,
    cr.final_vote_count,
    s.r2_key
  from public.cycle_results cr
  join public.submissions s
    on s.id = cr.submission_id
  join lateral (
    select
      spd.x_username,
      spd.wallet_address,
      spd.payout_choice,
      spd.split_percent,
      spd.charity
    from public.submission_private_data spd
    where spd.submission_id = cr.submission_id
    order by spd.id desc
    limit 1
  ) as private_data on true
  where cr.cycle_id = p_cycle_id
    and cr.rank_in_cycle = 1;

  update public.voting_cycles
  set
    status = 'finished',
    winners_published = true,
    finalized_at = v_finalized_at,
    results_published_at = v_finalized_at,
    ended_at = coalesce(ended_at, v_finalized_at)
  where id = p_cycle_id;

  update public.cycle_sponsorships
  set
    ends_at = coalesce(ends_at, v_finalized_at),
    updated_at = v_finalized_at
  where cycle_id = p_cycle_id;

  update public.app_config
  set value = null
  where key in ('cycle_end_at', 'cycle_theme');

  insert into public.cycle_events (
    cycle_id,
    event_type,
    actor_type,
    actor_discord_user_id,
    payload
  )
  select
    p_cycle_id,
    'cycle_completed',
    'admin',
    p_actor_discord_user_id,
    jsonb_build_object(
      'phase', 'finished',
      'finalized_at', v_finalized_at,
      'ranked_submissions', v_ranked_submission_count,
      'winners', v_winner_count,
      'highest_rank', v_highest_rank
    )
  where not exists (
    select 1
    from public.cycle_events
    where cycle_id = p_cycle_id
      and event_type = 'cycle_completed'
  );

  insert into public.admin_action_logs (
    actor_type,
    actor_id,
    action,
    target_type,
    target_id,
    meta
  )
  select
    'admin',
    p_actor_discord_user_id,
    'cycle_finalized',
    'cycle',
    p_cycle_id::text,
    jsonb_build_object(
      'ranked_submissions', v_ranked_submission_count,
      'winners', v_winner_count,
      'highest_rank', v_highest_rank,
      'finalized_at', v_finalized_at
    )
  where not exists (
    select 1
    from public.admin_action_logs
    where action = 'cycle_finalized'
      and target_type = 'cycle'
      and target_id = p_cycle_id::text
  );

  return jsonb_build_object(
    'cycleId', p_cycle_id,
    'finalStatus', 'finished',
    'rankedSubmissionCount', v_ranked_submission_count,
    'winnerCount', v_winner_count,
    'highestRank', v_highest_rank,
    'alreadyFinalized', false
  );
end;
$$;


--
-- Name: FUNCTION finalize_cycle(p_cycle_id bigint, p_actor_discord_user_id text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.finalize_cycle(p_cycle_id bigint, p_actor_discord_user_id text) IS 'Transactionally finalizes one voting_closed/finalizing cycle, with active accepted only for legacy compatibility.';


--
-- Name: finalize_discord_reconciliation_snapshot(text, timestamp with time zone, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.finalize_discord_reconciliation_snapshot(p_event_id text, p_observed_at timestamp with time zone, p_payload_sha256 text, p_snapshot_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
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


--
-- Name: finish_discord_membership_sync_event(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.finish_discord_membership_sync_event(p_event_id text, p_result_status text) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  update public.discord_membership_sync_events
  set
    result_status = p_result_status,
    processed_at = now()
  where event_id = p_event_id;
$$;


--
-- Name: get_cancerculture_session_access(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_cancerculture_session_access(p_session_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
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


--
-- Name: FUNCTION get_cancerculture_session_access(p_session_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_cancerculture_session_access(p_session_id uuid) IS 'Fail-closed central session, website-ban, Discord-ban, membership, and join-cooldown authorization check.';


--
-- Name: get_submission_upload_abuse_status(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_submission_upload_abuse_status(p_session_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_discord_user_id text;
  v_cycle_id bigint;
  v_state public.submission_upload_abuse_states%rowtype;
begin
  if p_session_id is null then
    return jsonb_build_object('outcome', 'not_authenticated');
  end if;

  select session.discord_user_id
  into v_discord_user_id
  from public.sessions session
  where session.id = p_session_id
    and session.revoked_at is null;

  if not found then
    return jsonb_build_object('outcome', 'not_authenticated');
  end if;

  select cycle.id
  into v_cycle_id
  from public.voting_cycles cycle
  where cycle.status::text in ('submission_open', 'active')
  order by cycle.id desc
  limit 1;

  if not found then
    return jsonb_build_object('outcome', 'cycle_not_open');
  end if;

  select state.*
  into v_state
  from public.submission_upload_abuse_states state
  where state.discord_user_id = v_discord_user_id
    and state.cycle_id = v_cycle_id;

  return jsonb_build_object(
    'outcome', 'status',
    'cycleId', v_cycle_id,
    'blocked', coalesce(v_state.blocked_at is not null, false),
    'invalidAttemptCount', coalesce(v_state.invalid_attempt_count, 0)
  );
end;
$$;


--
-- Name: mark_submission_upload_r2_uploaded(uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_submission_upload_r2_uploaded(p_operation_id uuid, p_session_id uuid, p_r2_etag text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_now timestamptz := transaction_timestamp();
  v_discord_user_id text;
  v_operation public.submission_upload_operations%rowtype;
begin
  if p_operation_id is null or p_session_id is null then
    return jsonb_build_object('outcome', 'invalid_request');
  end if;

  select session.discord_user_id
  into v_discord_user_id
  from public.sessions session
  where session.id = p_session_id
    and session.revoked_at is null;

  if not found then
    return jsonb_build_object('outcome', 'not_authenticated');
  end if;

  select operation.*
  into v_operation
  from public.submission_upload_operations operation
  where operation.id = p_operation_id
    and operation.discord_user_id = v_discord_user_id
  for update;

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_operation.status = 'completed' then
    return jsonb_build_object(
      'outcome', 'already_completed',
      'operationId', v_operation.id,
      'submissionId', v_operation.submission_id
    );
  end if;

  if v_operation.status = 'r2_uploaded' then
    return jsonb_build_object(
      'outcome', 'r2_uploaded',
      'operationId', v_operation.id
    );
  end if;

  if v_operation.status <> 'reserved' then
    return jsonb_build_object(
      'outcome', 'invalid_state',
      'status', v_operation.status
    );
  end if;

  update public.submission_upload_operations operation
  set
    status = 'r2_uploaded',
    r2_etag = case
      when p_r2_etag is null then null
      else left(p_r2_etag, 256)
    end,
    updated_at = v_now,
    last_attempt_at = v_now,
    last_error_code = null
  where operation.id = p_operation_id;

  return jsonb_build_object(
    'outcome', 'r2_uploaded',
    'operationId', p_operation_id
  );
end;
$$;


--
-- Name: media_cleanup_retry_delay(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.media_cleanup_retry_delay(p_attempt integer) RETURNS interval
    LANGUAGE sql IMMUTABLE STRICT
    SET search_path TO 'public', 'pg_temp'
    AS $$
  select case p_attempt
    when 1 then interval '1 minute'
    when 2 then interval '5 minutes'
    when 3 then interval '15 minutes'
    when 4 then interval '1 hour'
    when 5 then interval '6 hours'
    when 6 then interval '24 hours'
    else null
  end;
$$;


--
-- Name: FUNCTION media_cleanup_retry_delay(p_attempt integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.media_cleanup_retry_delay(p_attempt integer) IS 'Deterministic retry delay after a failed claimed attempt. Attempt 7 is terminal and therefore has no delay.';


--
-- Name: process_due_cycle_transitions(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.process_due_cycle_transitions(p_cycle_id bigint DEFAULT NULL::bigint) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_cycle public.voting_cycles%rowtype;
  v_now timestamptz := transaction_timestamp();
  v_previous_status text;
  v_voting_started_at timestamptz;
  v_submission_ended_at timestamptz;
  v_voting_closed_event_at timestamptz;
  v_repair_codes text[] := '{}'::text[];
  v_changed_rows integer := 0;
  v_step_rows integer := 0;
begin
  if p_cycle_id is not null and p_cycle_id <= 0 then
    raise exception using message = 'INVALID_CYCLE_ID';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('cycle-phase-automation-global', 0)
  );

  if p_cycle_id is not null then
    select *
    into v_cycle
    from public.voting_cycles
    where id = p_cycle_id
    for update;
  else
    select *
    into v_cycle
    from public.voting_cycles
    where status in (
      'active',
      'submission_open',
      'submission_closed',
      'voting_open',
      'voting_closed',
      'paused',
      'finalizing'
    )
    order by id desc
    limit 1
    for update;
  end if;

  if not found then
    return jsonb_build_object(
      'outcome', 'noop',
      'cycleId', null,
      'previousStatus', null,
      'status', null,
      'transition', null,
      'reason', 'no_current_cycle',
      'repairCodes', '[]'::jsonb,
      'eventCreated', false,
      'processedAt', v_now
    );
  end if;

  v_previous_status := v_cycle.status::text;

  if v_previous_status = 'paused' then
    return jsonb_build_object(
      'outcome', 'noop',
      'cycleId', v_cycle.id,
      'previousStatus', v_previous_status,
      'status', v_previous_status,
      'transition', null,
      'reason', 'paused',
      'repairCodes', '[]'::jsonb,
      'eventCreated', false,
      'processedAt', v_now
    );
  end if;

  if v_previous_status = 'active' then
    return jsonb_build_object(
      'outcome', 'diagnostic',
      'cycleId', v_cycle.id,
      'previousStatus', v_previous_status,
      'status', v_previous_status,
      'transition', null,
      'reason', 'legacy_active_phase_is_ambiguous',
      'repairCodes', '[]'::jsonb,
      'eventCreated', false,
      'processedAt', v_now
    );
  end if;

  if v_previous_status = 'submission_open' then
    if v_cycle.voting_ends_at is not null then
      return jsonb_build_object(
        'outcome', 'diagnostic',
        'cycleId', v_cycle.id,
        'previousStatus', v_previous_status,
        'status', v_previous_status,
        'transition', null,
        'reason', 'submission_open_has_voting_end',
        'repairCodes', '[]'::jsonb,
        'eventCreated', false,
        'processedAt', v_now
      );
    end if;

    if v_cycle.submission_ends_at is null then
      return jsonb_build_object(
        'outcome', case
          when v_cycle.voting_starts_at is null then 'noop'
          else 'diagnostic'
        end,
        'cycleId', v_cycle.id,
        'previousStatus', v_previous_status,
        'status', v_previous_status,
        'transition', null,
        'reason', case
          when v_cycle.voting_starts_at is null then 'submission_timer_not_set'
          else 'submission_open_has_voting_start_without_deadline'
        end,
        'repairCodes', '[]'::jsonb,
        'eventCreated', false,
        'processedAt', v_now
      );
    end if;

    if v_cycle.submission_ends_at > v_now then
      return jsonb_build_object(
        'outcome', case
          when v_cycle.voting_starts_at is null then 'noop'
          else 'diagnostic'
        end,
        'cycleId', v_cycle.id,
        'previousStatus', v_previous_status,
        'status', v_previous_status,
        'transition', null,
        'reason', case
          when v_cycle.voting_starts_at is null then 'submission_not_due'
          else 'submission_open_has_early_voting_start'
        end,
        'repairCodes', '[]'::jsonb,
        'eventCreated', false,
        'processedAt', v_now
      );
    end if;

    v_voting_started_at := coalesce(v_cycle.voting_starts_at, v_now);

    if v_cycle.voting_starts_at is not null then
      v_repair_codes := array_append(
        v_repair_codes,
        'preserved_existing_voting_start'
      );
    end if;

    update public.voting_cycles
    set
      status = 'voting_open',
      ends_at = null,
      voting_starts_at = v_voting_started_at,
      voting_ends_at = null,
      paused_from_status = null,
      phase_paused_at = null,
      phase_paused_remaining_seconds = null,
      phase_pause_reason = null
    where id = v_cycle.id;

    update public.cycle_reminders
    set status = 'cancelled'
    where cycle_id = v_cycle.id
      and phase = 'submission_open'
      and status = 'pending';

    update public.app_config
    set value = null
    where key = 'cycle_end_at';

    insert into public.cycle_events (
      cycle_id,
      event_type,
      actor_type,
      payload
    ) values (
      v_cycle.id,
      'voting_phase_opened',
      'system',
      jsonb_build_object(
        'from_phase', 'submission_open',
        'phase', 'voting_open',
        'automatic', true,
        'database_time', v_now,
        'submission_ended_at', v_cycle.submission_ends_at,
        'voting_starts_at', v_voting_started_at,
        'voting_ends_at', null,
        'votes_per_user', v_cycle.votes_per_user,
        'repair_codes', to_jsonb(v_repair_codes)
      )
    );

    return jsonb_build_object(
      'outcome', 'transitioned',
      'cycleId', v_cycle.id,
      'previousStatus', v_previous_status,
      'status', 'voting_open',
      'transition', 'submission_open_to_voting_open',
      'reason', 'submission_deadline_reached',
      'repairCodes', to_jsonb(v_repair_codes),
      'eventCreated', true,
      'processedAt', v_now
    );
  end if;

  if v_previous_status = 'submission_closed' then
    if v_cycle.voting_ends_at is not null then
      return jsonb_build_object(
        'outcome', 'diagnostic',
        'cycleId', v_cycle.id,
        'previousStatus', v_previous_status,
        'status', v_previous_status,
        'transition', null,
        'reason', 'submission_closed_has_voting_end',
        'repairCodes', '[]'::jsonb,
        'eventCreated', false,
        'processedAt', v_now
      );
    end if;

    v_submission_ended_at := coalesce(v_cycle.submission_ends_at, v_now);
    v_voting_started_at := coalesce(v_cycle.voting_starts_at, v_now);

    if v_cycle.submission_ends_at is null then
      v_repair_codes := array_append(
        v_repair_codes,
        'submission_end_recovered_at_processing_time'
      );
    end if;

    if v_cycle.voting_starts_at is null then
      v_repair_codes := array_append(
        v_repair_codes,
        'voting_start_recovered_at_processing_time'
      );
    end if;

    update public.voting_cycles
    set
      status = 'voting_open',
      ends_at = null,
      submission_ends_at = v_submission_ended_at,
      voting_starts_at = v_voting_started_at,
      voting_ends_at = null,
      paused_from_status = null,
      phase_paused_at = null,
      phase_paused_remaining_seconds = null,
      phase_pause_reason = null
    where id = v_cycle.id;

    update public.cycle_reminders
    set status = 'cancelled'
    where cycle_id = v_cycle.id
      and phase = 'submission_open'
      and status = 'pending';

    update public.app_config
    set value = null
    where key = 'cycle_end_at';

    insert into public.cycle_events (
      cycle_id,
      event_type,
      actor_type,
      payload
    ) values (
      v_cycle.id,
      'voting_phase_opened',
      'system',
      jsonb_build_object(
        'from_phase', 'submission_closed',
        'phase', 'voting_open',
        'automatic', true,
        'recovery', true,
        'database_time', v_now,
        'submission_ended_at', v_submission_ended_at,
        'voting_starts_at', v_voting_started_at,
        'voting_ends_at', null,
        'votes_per_user', v_cycle.votes_per_user,
        'repair_codes', to_jsonb(v_repair_codes)
      )
    );

    return jsonb_build_object(
      'outcome', 'transitioned',
      'cycleId', v_cycle.id,
      'previousStatus', v_previous_status,
      'status', 'voting_open',
      'transition', 'submission_closed_to_voting_open',
      'reason', 'recovered_stranded_submission_close',
      'repairCodes', to_jsonb(v_repair_codes),
      'eventCreated', true,
      'processedAt', v_now
    );
  end if;

  if v_previous_status = 'voting_open' then
    if v_cycle.voting_starts_at is null then
      return jsonb_build_object(
        'outcome', 'diagnostic',
        'cycleId', v_cycle.id,
        'previousStatus', v_previous_status,
        'status', v_previous_status,
        'transition', null,
        'reason', 'voting_open_missing_voting_start',
        'repairCodes', '[]'::jsonb,
        'eventCreated', false,
        'processedAt', v_now
      );
    end if;

    if v_cycle.submission_ends_at is null then
      v_submission_ended_at := v_cycle.voting_starts_at;
      v_repair_codes := array_append(
        v_repair_codes,
        'submission_end_aligned_to_voting_start'
      );
    else
      v_submission_ended_at := v_cycle.submission_ends_at;
    end if;

    if v_cycle.ends_at is not null then
      v_repair_codes := array_append(
        v_repair_codes,
        'legacy_cycle_end_cleared'
      );
    end if;

    if v_cycle.voting_ends_at is null
      or v_cycle.voting_ends_at > v_now
    then
      if cardinality(v_repair_codes) > 0 then
        update public.voting_cycles
        set
          ends_at = null,
          submission_ends_at = v_submission_ended_at
        where id = v_cycle.id;

        return jsonb_build_object(
          'outcome', 'repaired',
          'cycleId', v_cycle.id,
          'previousStatus', v_previous_status,
          'status', v_previous_status,
          'transition', null,
          'reason', 'voting_open_normalized',
          'repairCodes', to_jsonb(v_repair_codes),
          'eventCreated', false,
          'processedAt', v_now
        );
      end if;

      return jsonb_build_object(
        'outcome', 'noop',
        'cycleId', v_cycle.id,
        'previousStatus', v_previous_status,
        'status', v_previous_status,
        'transition', null,
        'reason', case
          when v_cycle.voting_ends_at is null then 'voting_timer_not_set'
          else 'voting_not_due'
        end,
        'repairCodes', '[]'::jsonb,
        'eventCreated', false,
        'processedAt', v_now
      );
    end if;

    update public.voting_cycles
    set
      status = 'voting_closed',
      ends_at = null,
      submission_ends_at = v_submission_ended_at,
      paused_from_status = null,
      phase_paused_at = null,
      phase_paused_remaining_seconds = null,
      phase_pause_reason = null
    where id = v_cycle.id;

    update public.cycle_reminders
    set status = 'cancelled'
    where cycle_id = v_cycle.id
      and phase = 'voting_open'
      and status = 'pending';

    update public.app_config
    set value = null
    where key = 'cycle_end_at';

    insert into public.cycle_events (
      cycle_id,
      event_type,
      actor_type,
      payload
    ) values (
      v_cycle.id,
      'voting_phase_closed',
      'system',
      jsonb_build_object(
        'from_phase', 'voting_open',
        'phase', 'voting_closed',
        'automatic', true,
        'database_time', v_now,
        'voting_ended_at', v_cycle.voting_ends_at,
        'repair_codes', to_jsonb(v_repair_codes)
      )
    );

    return jsonb_build_object(
      'outcome', 'transitioned',
      'cycleId', v_cycle.id,
      'previousStatus', v_previous_status,
      'status', 'voting_closed',
      'transition', 'voting_open_to_voting_closed',
      'reason', 'voting_deadline_reached',
      'repairCodes', to_jsonb(v_repair_codes),
      'eventCreated', true,
      'processedAt', v_now
    );
  end if;

  if v_previous_status = 'voting_closed' then
    select max(created_at)
    into v_voting_closed_event_at
    from public.cycle_events
    where cycle_id = v_cycle.id
      and event_type = 'voting_phase_closed';

    if v_cycle.ends_at is not null then
      v_repair_codes := array_append(
        v_repair_codes,
        'legacy_cycle_end_cleared'
      );
    end if;

    if v_cycle.submission_ends_at is null
      and v_cycle.voting_starts_at is not null
    then
      v_repair_codes := array_append(
        v_repair_codes,
        'submission_end_aligned_to_voting_start'
      );
    end if;

    if v_voting_closed_event_at is not null and (
      v_cycle.voting_ends_at is null
      or v_cycle.voting_ends_at > v_voting_closed_event_at
    ) then
      v_repair_codes := array_append(
        v_repair_codes,
        'voting_end_aligned_to_close_event'
      );
    end if;

    if cardinality(v_repair_codes) > 0 then
      update public.voting_cycles
      set
        ends_at = null,
        submission_ends_at = case
          when submission_ends_at is null and voting_starts_at is not null
            then voting_starts_at
          else submission_ends_at
        end,
        voting_ends_at = case
          when v_voting_closed_event_at is not null and (
            voting_ends_at is null
            or voting_ends_at > v_voting_closed_event_at
          ) then v_voting_closed_event_at
          else voting_ends_at
        end
      where id = v_cycle.id;

      get diagnostics v_changed_rows = row_count;
    end if;

    update public.cycle_reminders
    set status = 'cancelled'
    where cycle_id = v_cycle.id
      and phase = 'voting_open'
      and status = 'pending';

    get diagnostics v_step_rows = row_count;
    v_changed_rows := v_changed_rows + v_step_rows;

    update public.app_config
    set value = null
    where key = 'cycle_end_at'
      and value is not null;

    get diagnostics v_step_rows = row_count;
    v_changed_rows := v_changed_rows + v_step_rows;

    return jsonb_build_object(
      'outcome', case when v_changed_rows > 0 then 'repaired' else 'noop' end,
      'cycleId', v_cycle.id,
      'previousStatus', v_previous_status,
      'status', v_previous_status,
      'transition', null,
      'reason', case
        when v_changed_rows > 0 then 'voting_closed_normalized'
        else 'voting_already_closed'
      end,
      'repairCodes', to_jsonb(v_repair_codes),
      'eventCreated', false,
      'processedAt', v_now
    );
  end if;

  return jsonb_build_object(
    'outcome', 'noop',
    'cycleId', v_cycle.id,
    'previousStatus', v_previous_status,
    'status', v_previous_status,
    'transition', null,
    'reason', 'status_not_automated',
    'repairCodes', '[]'::jsonb,
    'eventCreated', false,
    'processedAt', v_now
  );
end;
$$;


--
-- Name: FUNCTION process_due_cycle_transitions(p_cycle_id bigint); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.process_due_cycle_transitions(p_cycle_id bigint) IS 'Uses database time plus a global advisory lock and row lock for idempotent automatic phase transitions. It repairs only explicit canonical cases; ambiguous legacy or contradictory states return diagnostics without mutation.';


--
-- Name: protect_discord_ban_republish(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.protect_discord_ban_republish() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  if old.public_visibility_source = 'discord_ban'
    and old.public_visibility_status = 'removed'
    and new.public_visibility_status = 'visible'
    and current_setting(
      'cancerculture.discord_ban_republish',
      true
    ) is distinct from 'authorized'
  then
    raise exception using
      message = 'DISCORD_BAN_REPUBLISH_REQUIRES_REVIEW';
  end if;

  return new;
end;
$$;


--
-- Name: record_discord_reconciliation_failure(text, timestamp with time zone, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_discord_reconciliation_failure(p_event_id text, p_observed_at timestamp with time zone, p_payload_sha256 text, p_error_code text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
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


--
-- Name: recover_stale_submission_uploads(integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.recover_stale_submission_uploads(p_limit integer DEFAULT 100, p_stale_after_seconds integer DEFAULT 900) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_now timestamptz := transaction_timestamp();
  v_recovered integer := 0;
  v_queued integer := 0;
begin
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception using message = 'INVALID_UPLOAD_RECOVERY_BATCH_SIZE';
  end if;

  if p_stale_after_seconds is null
    or p_stale_after_seconds < 60
    or p_stale_after_seconds > 86400
  then
    raise exception using message = 'INVALID_UPLOAD_RECOVERY_STALE_SECONDS';
  end if;

  with stale_operations as (
    select operation.id
    from public.submission_upload_operations operation
    where operation.status in ('reserved', 'r2_uploaded')
      and operation.updated_at <=
        v_now - make_interval(secs => p_stale_after_seconds)
    order by operation.updated_at, operation.id
    for update skip locked
    limit p_limit
  ), inserted_queue as (
    insert into public.media_cleanup_queue (
      storage_provider,
      storage_key,
      reason,
      status
    )
    select
      operation.storage_provider,
      operation.storage_key,
      'submission_upload_recovery:' || operation.id::text,
      'pending'
    from public.submission_upload_operations operation
    join stale_operations stale on stale.id = operation.id
    on conflict (storage_provider, storage_key) do nothing
    returning id
  ), updated_operations as (
    update public.submission_upload_operations operation
    set
      status = 'cleanup_pending',
      cleanup_required = true,
      last_error_code = 'STALE_UPLOAD_RECOVERED',
      updated_at = v_now,
      last_attempt_at = v_now
    from stale_operations stale
    where operation.id = stale.id
    returning operation.id
  )
  select
    (select count(*)::integer from updated_operations),
    (select count(*)::integer from inserted_queue)
  into v_recovered, v_queued;

  return jsonb_build_object(
    'recovered', v_recovered,
    'queued', v_queued
  );
end;
$$;


--
-- Name: FUNCTION recover_stale_submission_uploads(p_limit integer, p_stale_after_seconds integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.recover_stale_submission_uploads(p_limit integer, p_stale_after_seconds integer) IS 'Recovers crashed upload intents by marking them cleanup_pending and enqueueing their possibly-present R2 keys. Missing objects remain successful idempotent cleanup.';


--
-- Name: register_invalid_submission_upload(uuid, bigint, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.register_invalid_submission_upload(p_session_id uuid, p_cycle_id bigint, p_error_code text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_now timestamptz := transaction_timestamp();
  v_discord_user_id text;
  v_cycle public.voting_cycles%rowtype;
  v_state public.submission_upload_abuse_states%rowtype;
  v_allowed_codes constant text[] := array[
    'MEDIA_FILE_TOO_LARGE',
    'MEDIA_FORMAT_UNSUPPORTED',
    'MEDIA_MIME_MISMATCH',
    'MEDIA_CORRUPT',
    'MEDIA_ANIMATION_UNSUPPORTED',
    'MEDIA_WIDTH_EXCEEDED',
    'MEDIA_HEIGHT_EXCEEDED',
    'MEDIA_PIXEL_LIMIT_EXCEEDED',
    'MEDIA_DECOMPRESSION_LIMIT',
    'MEDIA_OUTPUT_TOO_LARGE'
  ];
begin
  if p_session_id is null or p_cycle_id is null then
    return jsonb_build_object('outcome', 'invalid_request');
  end if;

  if p_error_code is null or not (p_error_code = any(v_allowed_codes)) then
    return jsonb_build_object('outcome', 'not_countable');
  end if;

  select session.discord_user_id
  into v_discord_user_id
  from public.sessions session
  where session.id = p_session_id
    and session.revoked_at is null;

  if not found then
    return jsonb_build_object('outcome', 'not_authenticated');
  end if;

  select cycle.*
  into v_cycle
  from public.voting_cycles cycle
  where cycle.id = p_cycle_id
  for update;

  if not found or v_cycle.status::text not in ('submission_open', 'active') then
    return jsonb_build_object('outcome', 'cycle_not_open');
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'submission-upload-abuse:' || v_discord_user_id || ':' || p_cycle_id::text,
      0
    )
  );

  select state.*
  into v_state
  from public.submission_upload_abuse_states state
  where state.discord_user_id = v_discord_user_id
    and state.cycle_id = p_cycle_id
  for update;

  if found and v_state.blocked_at is not null then
    return jsonb_build_object(
      'outcome', 'already_blocked',
      'cycleId', p_cycle_id,
      'blocked', true,
      'invalidAttemptCount', 5
    );
  end if;

  insert into public.submission_upload_abuse_states (
    discord_user_id,
    cycle_id,
    invalid_attempt_count,
    total_invalid_attempt_count,
    last_error_code,
    last_invalid_attempt_at,
    blocked_at,
    blocked_reason,
    block_count,
    last_blocked_at,
    created_at,
    updated_at
  ) values (
    v_discord_user_id,
    p_cycle_id,
    1,
    1,
    p_error_code,
    v_now,
    null,
    null,
    0,
    null,
    v_now,
    v_now
  )
  on conflict (discord_user_id, cycle_id) do update
  set
    invalid_attempt_count = least(
      5,
      public.submission_upload_abuse_states.invalid_attempt_count + 1
    ),
    total_invalid_attempt_count =
      public.submission_upload_abuse_states.total_invalid_attempt_count + 1,
    last_error_code = excluded.last_error_code,
    last_invalid_attempt_at = v_now,
    blocked_at = case
      when public.submission_upload_abuse_states.invalid_attempt_count >= 4
        then v_now
      else null
    end,
    blocked_reason = case
      when public.submission_upload_abuse_states.invalid_attempt_count >= 4
        then 'five_invalid_media_attempts'
      else null
    end,
    block_count = public.submission_upload_abuse_states.block_count + case
      when public.submission_upload_abuse_states.invalid_attempt_count = 4
        then 1
      else 0
    end,
    last_blocked_at = case
      when public.submission_upload_abuse_states.invalid_attempt_count >= 4
        then v_now
      else public.submission_upload_abuse_states.last_blocked_at
    end,
    updated_at = v_now
  returning * into v_state;

  return jsonb_build_object(
    'outcome', case when v_state.blocked_at is null then 'counted' else 'blocked' end,
    'cycleId', v_state.cycle_id,
    'blocked', v_state.blocked_at is not null,
    'invalidAttemptCount', v_state.invalid_attempt_count
  );
end;
$$;


--
-- Name: republish_discord_ban_submission(bigint, text, text, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.republish_discord_ban_submission(p_submission_id bigint, p_actor_discord_user_id text, p_reason text, p_manual_review_confirmed boolean) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_submission public.submissions%rowtype;
  v_membership public.discord_member_state%rowtype;
  v_now timestamptz := transaction_timestamp();
begin
  if p_submission_id is null or p_submission_id <= 0 then
    raise exception using message = 'INVALID_SUBMISSION_ID';
  end if;

  if p_actor_discord_user_id is null
    or btrim(p_actor_discord_user_id) = ''
  then
    raise exception using message = 'INVALID_REPUBLISH_ACTOR';
  end if;

  if p_reason is null
    or length(btrim(p_reason)) not between 10 and 1000
  then
    raise exception using message = 'REPUBLISH_REASON_REQUIRED';
  end if;

  if p_manual_review_confirmed is distinct from true then
    raise exception using message = 'MANUAL_REVIEW_CONFIRMATION_REQUIRED';
  end if;

  select *
  into v_submission
  from public.submissions
  where id = p_submission_id;

  if not found then
    raise exception using message = 'SUBMISSION_NOT_FOUND';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'discord-member:' || v_submission.discord_user_id,
      0
    )
  );

  select *
  into v_membership
  from public.discord_member_state
  where discord_user_id = v_submission.discord_user_id
  for update;

  if not found then
    raise exception using message = 'MEMBERSHIP_STATE_MISSING';
  end if;

  if v_membership.discord_ban_active then
    raise exception using message = 'DISCORD_BAN_STILL_ACTIVE';
  end if;

  select *
  into v_submission
  from public.submissions
  where id = p_submission_id
  for update;

  if v_submission.public_visibility_source <> 'discord_ban' then
    if v_submission.public_visibility_status = 'visible'
      and v_submission.public_republished_at is not null
    then
      return jsonb_build_object(
        'outcome', 'already_republished',
        'submissionId', v_submission.id,
        'competitionDisqualified',
          coalesce(v_submission.is_disqualified, false)
      );
    end if;

    raise exception using message = 'SUBMISSION_NOT_DISCORD_BAN_HIDDEN';
  end if;

  perform set_config(
    'cancerculture.discord_ban_republish',
    'authorized',
    true
  );

  update public.submissions
  set
    public_visibility_status = 'visible',
    public_visibility_reason_code = null,
    public_visibility_reason_text = null,
    public_visibility_updated_at = v_now,
    public_visibility_updated_by_discord_user_id =
      p_actor_discord_user_id,
    public_visibility_updated_by_discord_username = null,
    public_visibility_source = 'manual_republish',
    public_republished_at = v_now,
    public_republished_by_discord_user_id =
      p_actor_discord_user_id,
    public_republish_reason = btrim(p_reason),
    public_republish_review_confirmed = true
  where id = p_submission_id
  returning * into v_submission;

  insert into public.admin_action_logs (
    actor_type,
    actor_id,
    action,
    target_type,
    target_id,
    meta
  ) values (
    'admin',
    p_actor_discord_user_id,
    'discord_ban_submission_republished',
    'submission',
    p_submission_id::text,
    jsonb_build_object(
      'reason', btrim(p_reason),
      'manualReviewConfirmed', true,
      'competitionStillDisqualified',
        coalesce(v_submission.is_disqualified, false)
    )
  );

  return jsonb_build_object(
    'outcome', 'republished',
    'submissionId', v_submission.id,
    'competitionDisqualified',
      coalesce(v_submission.is_disqualified, false)
  );
end;
$$;


--
-- Name: FUNCTION republish_discord_ban_submission(p_submission_id bigint, p_actor_discord_user_id text, p_reason text, p_manual_review_confirmed boolean); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.republish_discord_ban_submission(p_submission_id bigint, p_actor_discord_user_id text, p_reason text, p_manual_review_confirmed boolean) IS 'Admin-only manual visibility restoration after Discord unban; never restores competition eligibility or historical results.';


--
-- Name: reserve_submission_upload(uuid, uuid, text, text, text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reserve_submission_upload(p_session_id uuid, p_idempotency_key uuid, p_request_fingerprint text, p_content_sha256 text, p_media_type text, p_media_bytes integer) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
declare
  v_now timestamptz := transaction_timestamp();
  v_discord_user_id text;
  v_operation public.submission_upload_operations%rowtype;
  v_cycle public.voting_cycles%rowtype;
  v_user public.user_logs%rowtype;
  v_membership public.discord_member_state%rowtype;
  v_rules_version integer;
  v_cleanup_status text;
  v_storage_key text;
begin
  if p_session_id is null then
    return jsonb_build_object('outcome', 'not_authenticated');
  end if;

  if p_idempotency_key is null
    or p_request_fingerprint is null
    or p_request_fingerprint !~ '^[0-9a-f]{64}$'
    or p_content_sha256 is null
    or p_content_sha256 !~ '^[0-9a-f]{64}$'
    or p_media_type is distinct from 'image/webp'
    or p_media_bytes is null
    or p_media_bytes <= 0
    or p_media_bytes > 16777216
  then
    return jsonb_build_object('outcome', 'invalid_request');
  end if;

  select session.discord_user_id
  into v_discord_user_id
  from public.sessions session
  where session.id = p_session_id
    and session.revoked_at is null;

  if not found then
    return jsonb_build_object('outcome', 'not_authenticated');
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'submission-upload-idempotency:' ||
      v_discord_user_id || ':' || p_idempotency_key::text,
      0
    )
  );

  select operation.*
  into v_operation
  from public.submission_upload_operations operation
  where operation.discord_user_id = v_discord_user_id
    and operation.idempotency_key = p_idempotency_key
  for update;

  if found then
    if v_operation.request_fingerprint <> p_request_fingerprint
      or v_operation.content_sha256 <> p_content_sha256
      or v_operation.media_type <> p_media_type
      or v_operation.media_bytes <> p_media_bytes
    then
      return jsonb_build_object(
        'outcome', 'idempotency_conflict',
        'cycleId', v_operation.cycle_id
      );
    end if;

    if v_operation.status = 'completed' then
      return jsonb_build_object(
        'outcome', 'already_completed',
        'operationId', v_operation.id,
        'cycleId', v_operation.cycle_id,
        'submissionId', v_operation.submission_id
      );
    end if;

    if v_operation.status in ('reserved', 'r2_uploaded') then
      return jsonb_build_object(
        'outcome', 'in_progress',
        'operationId', v_operation.id,
        'cycleId', v_operation.cycle_id
      );
    end if;

    if v_operation.status = 'cleanup_pending' then
      select queue.status
      into v_cleanup_status
      from public.media_cleanup_queue queue
      where queue.storage_provider = v_operation.storage_provider
        and queue.storage_key = v_operation.storage_key;

      if v_cleanup_status is distinct from 'completed' then
        return jsonb_build_object(
          'outcome', case
            when v_cleanup_status = 'dead' then 'cleanup_blocked'
            else 'cleanup_pending'
          end,
          'operationId', v_operation.id,
          'cycleId', v_operation.cycle_id
        );
      end if;
    end if;
  end if;

  select cycle.*
  into v_cycle
  from public.voting_cycles cycle
  where cycle.status in ('submission_open', 'active')
  order by cycle.id desc
  limit 1
  for update;

  if not found then
    return jsonb_build_object('outcome', 'cycle_not_open');
  end if;

  if v_operation.id is not null
    and v_operation.cycle_id <> v_cycle.id
  then
    return jsonb_build_object(
      'outcome', 'idempotency_cycle_conflict',
      'cycleId', v_operation.cycle_id
    );
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'submission-upload-user-cycle:' ||
      v_discord_user_id || ':' || v_cycle.id::text,
      0
    )
  );

  select users.*
  into v_user
  from public.user_logs users
  where users.discord_user_id = v_discord_user_id;

  if not found then
    return jsonb_build_object('outcome', 'dependency_unavailable');
  end if;

  if v_user.is_banned then
    return jsonb_build_object('outcome', 'banned');
  end if;

  if coalesce(v_user.upload_fail_count, 0) >= 5 then
    return jsonb_build_object('outcome', 'rate_limited');
  end if;

  select rules.current_version
  into v_rules_version
  from public.rules_meta rules
  where rules.id = 1;

  if not found then
    return jsonb_build_object('outcome', 'dependency_unavailable');
  end if;

  if v_user.accepted_rules_version is distinct from v_rules_version then
    return jsonb_build_object('outcome', 'rules_not_accepted');
  end if;

  select membership.*
  into v_membership
  from public.discord_member_state membership
  where membership.discord_user_id = v_discord_user_id;

  if not found or not coalesce(v_membership.is_in_discord, false) then
    return jsonb_build_object('outcome', 'not_in_discord');
  end if;

  if v_membership.discord_joined_at is null
    or v_membership.discord_joined_at > v_now - interval '10 minutes'
  then
    return jsonb_build_object('outcome', 'joined_too_recently');
  end if;

  if exists (
    select 1
    from public.submissions submission
    where submission.cycle_id = v_cycle.id
      and submission.discord_user_id = v_discord_user_id
  ) then
    return jsonb_build_object('outcome', 'upload_limit_reached');
  end if;

  if exists (
    select 1
    from public.submission_upload_operations other_operation
    where other_operation.discord_user_id = v_discord_user_id
      and other_operation.cycle_id = v_cycle.id
      and other_operation.status in ('reserved', 'r2_uploaded')
      and (
        v_operation.id is null
        or other_operation.id <> v_operation.id
      )
  ) then
    return jsonb_build_object('outcome', 'upload_in_progress');
  end if;

  v_storage_key :=
    v_cycle.id::text || '/' || gen_random_uuid()::text || '.webp';

  if v_operation.id is null then
    insert into public.submission_upload_operations (
      discord_user_id,
      cycle_id,
      idempotency_key,
      request_fingerprint,
      content_sha256,
      storage_key,
      media_type,
      media_bytes,
      status,
      created_at,
      updated_at,
      last_attempt_at
    ) values (
      v_discord_user_id,
      v_cycle.id,
      p_idempotency_key,
      p_request_fingerprint,
      p_content_sha256,
      v_storage_key,
      p_media_type,
      p_media_bytes,
      'reserved',
      v_now,
      v_now,
      v_now
    )
    returning * into v_operation;
  else
    update public.submission_upload_operations operation
    set
      storage_key = v_storage_key,
      status = 'reserved',
      r2_etag = null,
      cleanup_required = false,
      last_error_code = null,
      updated_at = v_now,
      last_attempt_at = v_now,
      completed_at = null,
      submission_id = null
    where operation.id = v_operation.id
    returning * into v_operation;
  end if;

  return jsonb_build_object(
    'outcome', 'reserved',
    'operationId', v_operation.id,
    'cycleId', v_operation.cycle_id,
    'storageKey', v_operation.storage_key
  );
end;
$_$;


--
-- Name: FUNCTION reserve_submission_upload(p_session_id uuid, p_idempotency_key uuid, p_request_fingerprint text, p_content_sha256 text, p_media_type text, p_media_bytes integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.reserve_submission_upload(p_session_id uuid, p_idempotency_key uuid, p_request_fingerprint text, p_content_sha256 text, p_media_type text, p_media_bytes integer) IS 'Validates the confirmed session and current upload eligibility, serializes one user/cycle intent, and returns a server-generated R2 key. Replays are conflict-safe and completed operations are stable.';


--
-- Name: reset_cycle(bigint, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reset_cycle(p_cycle_id bigint, p_actor_discord_user_id text, p_reason text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
declare
  v_cycle public.voting_cycles%rowtype;
  v_previous_status text;
  v_reset_at timestamptz := transaction_timestamp();
  v_submission_ids bigint[] := '{}'::bigint[];
  v_r2_keys text[] := '{}'::text[];
  v_cleanup_queue_ids bigint[] := '{}'::bigint[];
  v_removed_submissions integer := 0;
  v_removed_votes integer := 0;
  v_affected_submitters integer := 0;
  v_removed_results integer := 0;
  v_removed_winner_rows integer := 0;
  v_has_attempt_dependencies boolean := false;
  v_cleanup_reason text;
begin
  if p_cycle_id is null or p_cycle_id <= 0 then
    raise exception using message = 'INVALID_CYCLE_ID';
  end if;

  if p_actor_discord_user_id is null
    or btrim(p_actor_discord_user_id) = ''
  then
    raise exception using message = 'INVALID_RESET_ACTOR';
  end if;

  if p_reason is null or btrim(p_reason) = '' then
    raise exception using message = 'RESET_REASON_REQUIRED';
  end if;

  if length(btrim(p_reason)) > 1000 then
    raise exception using message = 'RESET_REASON_TOO_LONG';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('cycle-reset:' || p_cycle_id::text, 0)
  );

  select *
  into v_cycle
  from public.voting_cycles
  where id = p_cycle_id
  for update;

  if not found then
    raise exception using message = 'CYCLE_NOT_FOUND';
  end if;

  v_previous_status := v_cycle.status::text;
  v_cleanup_reason := 'cycle_reset:' || p_cycle_id::text;

  if v_previous_status not in (
    'draft',
    'submission_open',
    'submission_closed',
    'voting_open',
    'voting_closed',
    'paused',
    'finalizing',
    'active'
  ) then
    raise exception using
      message = 'CYCLE_STATE_NOT_RESETTABLE',
      detail = 'Cycle status is ' || v_previous_status;
  end if;

  select
    coalesce(array_agg(s.id order by s.id), '{}'::bigint[]),
    count(*)::integer,
    count(distinct s.discord_user_id)::integer
  into
    v_submission_ids,
    v_removed_submissions,
    v_affected_submitters
  from public.submissions s
  where s.cycle_id = p_cycle_id;

  select count(*)::integer
  into v_removed_votes
  from public.votes
  where cycle_id = p_cycle_id;

  select count(*)::integer
  into v_removed_results
  from public.cycle_results
  where cycle_id = p_cycle_id;

  select count(*)::integer
  into v_removed_winner_rows
  from public.winner_public_profiles
  where cycle_id = p_cycle_id;

  select
    exists (
      select 1 from public.cycle_events where cycle_id = p_cycle_id
    )
    or exists (
      select 1 from public.cycle_reminders where cycle_id = p_cycle_id
    )
    or exists (
      select 1 from public.cycle_sponsorships where cycle_id = p_cycle_id
    )
    or exists (
      select 1 from public.user_cycle_acceptance where cycle_id = p_cycle_id
    )
  into v_has_attempt_dependencies;

  if v_previous_status = 'draft'
    and v_cycle.reset_at is not null
    and v_removed_submissions = 0
    and v_removed_votes = 0
    and v_removed_results = 0
    and v_removed_winner_rows = 0
    and not v_has_attempt_dependencies
  then
    select coalesce(array_agg(id order by id), '{}'::bigint[])
    into v_cleanup_queue_ids
    from public.media_cleanup_queue
    where reason = v_cleanup_reason
      and status in ('pending', 'failed');

    return jsonb_build_object(
      'cycleId', p_cycle_id,
      'cycleNumber', p_cycle_id,
      'previousStatus', 'draft',
      'status', 'draft',
      'removedSubmissions', 0,
      'removedVotes', 0,
      'affectedSubmitters', 0,
      'removedResults', 0,
      'removedWinnerRows', 0,
      'r2KeysPendingCleanup', cardinality(v_cleanup_queue_ids),
      'r2CleanupQueueIds', to_jsonb(v_cleanup_queue_ids),
      'alreadyReset', true,
      'resetCount', v_cycle.reset_count
    );
  end if;

  with candidate_keys as (
    select s.r2_key as storage_key
    from public.submissions s
    where s.cycle_id = p_cycle_id
      and s.r2_key ~ ('^' || p_cycle_id::text || '/[0-9A-Fa-f-]{36}[.]webp$')

    union

    select w.r2_key
    from public.winner_public_profiles w
    where w.cycle_id = p_cycle_id
      and w.r2_key ~ ('^' || p_cycle_id::text || '/[0-9A-Fa-f-]{36}[.]webp$')

    union

    select cs.banner_r2_key
    from public.cycle_sponsorships cs
    where cs.cycle_id = p_cycle_id
      and cs.banner_r2_key ~ '^sponsored-cycles/drafts/[0-9A-Fa-f-]{36}[.]webp$'

    union

    select v_cycle.sponsor_banner_key
    where v_cycle.sponsor_banner_key ~ '^sponsored-cycles/drafts/[0-9A-Fa-f-]{36}[.]webp$'
  ), unshared_keys as (
    select candidate.storage_key
    from candidate_keys candidate
    where not exists (
      select 1
      from public.submissions other_submission
      where other_submission.cycle_id is distinct from p_cycle_id
        and other_submission.r2_key = candidate.storage_key
    )
      and not exists (
        select 1
        from public.winner_public_profiles other_winner
        where other_winner.cycle_id <> p_cycle_id
          and other_winner.r2_key = candidate.storage_key
      )
      and not exists (
        select 1
        from public.cycle_sponsorships other_sponsorship
        where other_sponsorship.cycle_id <> p_cycle_id
          and other_sponsorship.banner_r2_key = candidate.storage_key
      )
      and not exists (
        select 1
        from public.voting_cycles other_cycle
        where other_cycle.id <> p_cycle_id
          and other_cycle.sponsor_banner_key = candidate.storage_key
      )
      and not exists (
        select 1
        from public.app_config config
        where config.key in (
          'next_cycle_sponsor_banner_r2_key',
          'next_cycle_sponsor_banner_key'
        )
          and config.value = candidate.storage_key
      )
      and not exists (
        select 1
        from public.app_config legacy_meta
        where legacy_meta.key like 'cycle_sponsor_meta_%'
          and legacy_meta.key <> 'cycle_sponsor_meta_' || p_cycle_id::text
          and legacy_meta.value like '%' || candidate.storage_key || '%'
      )
      and not exists (
        select 1
        from public.next_cycle_config next_config
        where next_config.sponsor_banner_key = candidate.storage_key
      )
  )
  select coalesce(array_agg(storage_key order by storage_key), '{}'::text[])
  into v_r2_keys
  from unshared_keys;

  insert into public.media_cleanup_queue (
    storage_provider,
    storage_key,
    reason,
    status
  )
  select
    'r2',
    storage_key,
    v_cleanup_reason,
    'pending'
  from unnest(v_r2_keys) as queued_key(storage_key)
  on conflict (storage_provider, storage_key) do nothing;

  select coalesce(array_agg(id order by id), '{}'::bigint[])
  into v_cleanup_queue_ids
  from public.media_cleanup_queue
  where storage_provider = 'r2'
    and storage_key = any(v_r2_keys)
    and status in ('pending', 'failed');

  delete from public.cycle_reminders
  where cycle_id = p_cycle_id;

  delete from public.cycle_events
  where cycle_id = p_cycle_id;

  delete from public.winner_public_profiles
  where cycle_id = p_cycle_id;

  delete from public.cycle_results
  where cycle_id = p_cycle_id;

  delete from public.votes
  where cycle_id = p_cycle_id;

  delete from public.submission_social_links
  where submission_id = any(v_submission_ids);

  delete from public.submission_private_data
  where submission_id = any(v_submission_ids);

  delete from public.submissions
  where cycle_id = p_cycle_id;

  delete from public.user_cycle_acceptance
  where cycle_id = p_cycle_id;

  update public.voting_cycles
  set
    status = 'draft',
    starts_at = null,
    ends_at = null,
    created_by_discord_id = null,
    ended_at = null,
    finalized_at = null,
    winners_published = false,
    theme = null,
    title = null,
    is_sponsored = false,
    sponsor_name = null,
    sponsor_link = null,
    reward_description = null,
    sponsor_banner_key = null,
    rule_template_id = null,
    submission_starts_at = null,
    submission_ends_at = null,
    voting_starts_at = null,
    voting_ends_at = null,
    results_published_at = null,
    archived_at = null,
    submission_warn_threshold = null,
    submission_warned_at = null,
    submission_auto_close_enabled = false,
    submission_auto_close_threshold = null,
    submission_auto_closed_at = null,
    votes_per_user = 2,
    allow_self_vote = false,
    sponsorship_id = null,
    sponsor_name_snapshot = null,
    sponsor_link_snapshot = null,
    sponsor_banner_url_snapshot = null,
    paused_from_status = null,
    phase_paused_at = null,
    phase_paused_remaining_seconds = null,
    phase_pause_reason = null,
    reset_count = reset_count + 1,
    reset_at = v_reset_at
  where id = p_cycle_id;

  delete from public.sponsor_tracking_events
  where sponsorship_id in (
    select id
    from public.cycle_sponsorships
    where cycle_id = p_cycle_id
  );

  delete from public.cycle_sponsorships
  where cycle_id = p_cycle_id;

  delete from public.app_config
  where key = 'cycle_sponsor_meta_' || p_cycle_id::text;

  update public.app_config
  set value = null
  where key in ('cycle_end_at', 'cycle_theme');

  insert into public.admin_action_logs (
    actor_type,
    actor_id,
    action,
    target_type,
    target_id,
    meta
  ) values (
    'admin',
    p_actor_discord_user_id,
    'cycle_reset',
    'cycle',
    p_cycle_id::text,
    jsonb_build_object(
      'cycle_id', p_cycle_id,
      'cycle_number', p_cycle_id,
      'reason', btrim(p_reason),
      'previous_status', v_previous_status,
      'removed_submissions', v_removed_submissions,
      'removed_votes', v_removed_votes,
      'affected_submitters', v_affected_submitters,
      'removed_results', v_removed_results,
      'removed_winner_rows', v_removed_winner_rows,
      'r2_keys_pending_cleanup', cardinality(v_cleanup_queue_ids),
      'reset_at', v_reset_at,
      'reset_count', v_cycle.reset_count + 1
    )
  );

  return jsonb_build_object(
    'cycleId', p_cycle_id,
    'cycleNumber', p_cycle_id,
    'previousStatus', v_previous_status,
    'status', 'draft',
    'removedSubmissions', v_removed_submissions,
    'removedVotes', v_removed_votes,
    'affectedSubmitters', v_affected_submitters,
    'removedResults', v_removed_results,
    'removedWinnerRows', v_removed_winner_rows,
    'r2KeysPendingCleanup', cardinality(v_cleanup_queue_ids),
    'r2CleanupQueueIds', to_jsonb(v_cleanup_queue_ids),
    'alreadyReset', false,
    'resetCount', v_cycle.reset_count + 1
  );
end;
$_$;


--
-- Name: FUNCTION reset_cycle(p_cycle_id bigint, p_actor_discord_user_id text, p_reason text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.reset_cycle(p_cycle_id bigint, p_actor_discord_user_id text, p_reason text) IS 'Atomically removes one unfinished cycle attempt, enqueues canonical unshared media keys, and returns the same cycle row to a reusable draft without a public cycle event.';


--
-- Name: reset_social_verification_on_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reset_social_verification_on_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if
    new.platform is distinct from old.platform
    or new.handle is distinct from old.handle
    or new.profile_url is distinct from old.profile_url
  then
    new.is_verified := false;
    new.verified_at := null;
    new.verified_by_discord_user_id := null;
    new.verification_note := null;
  end if;

  new.updated_at := now();
  return new;
end;
$$;


--
-- Name: set_user_logs_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_user_logs_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


--
-- Name: start_cycle(bigint, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.start_cycle(p_cycle_id bigint, p_actor_discord_user_id text, p_settings jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_current public.voting_cycles%rowtype;
  v_cycle public.voting_cycles%rowtype;
  v_now timestamptz := transaction_timestamp();
  v_actor_discord_id bigint;
  v_theme text;
  v_theme_source text;
  v_reward_description text;
  v_is_sponsored boolean := false;
  v_sponsor_name text;
  v_sponsor_link text;
  v_sponsor_banner_r2_key text;
  v_sponsor_banner_url text;
  v_sponsorship_id bigint;
  v_created_cycle boolean := false;
  v_reused_draft boolean := false;
  v_reused_reset_draft boolean := false;
begin
  if p_cycle_id is not null and p_cycle_id <= 0 then
    raise exception using message = 'INVALID_CYCLE_ID';
  end if;

  if p_actor_discord_user_id is null
    or btrim(p_actor_discord_user_id) = ''
  then
    raise exception using message = 'INVALID_START_ACTOR';
  end if;

  begin
    v_actor_discord_id := btrim(p_actor_discord_user_id)::bigint;
  exception
    when invalid_text_representation or numeric_value_out_of_range then
      raise exception using message = 'INVALID_START_ACTOR';
  end;

  if p_settings is null or jsonb_typeof(p_settings) <> 'object' then
    raise exception using message = 'INVALID_START_SETTINGS';
  end if;

  if p_settings #> '{sponsored,enabled}' is not null
    and jsonb_typeof(p_settings #> '{sponsored,enabled}') <> 'boolean'
  then
    raise exception using message = 'INVALID_SPONSOR_SETTINGS';
  end if;

  v_theme := nullif(btrim(p_settings ->> 'theme'), '');
  v_theme_source := coalesce(
    nullif(btrim(p_settings ->> 'themeSource'), ''),
    'none'
  );
  v_reward_description := nullif(
    btrim(p_settings ->> 'rewardDescription'),
    ''
  );
  v_is_sponsored := coalesce(
    (p_settings #>> '{sponsored,enabled}')::boolean,
    false
  );
  v_sponsor_name := nullif(
    btrim(p_settings #>> '{sponsored,companyName}'),
    ''
  );
  v_sponsor_link := nullif(
    btrim(p_settings #>> '{sponsored,sponsorLink}'),
    ''
  );
  v_sponsor_banner_r2_key := nullif(
    btrim(p_settings #>> '{sponsored,bannerR2Key}'),
    ''
  );
  v_sponsor_banner_url := nullif(
    btrim(p_settings #>> '{sponsored,bannerUrl}'),
    ''
  );

  if v_theme_source not in ('manual', 'next_cycle_theme', 'none') then
    raise exception using message = 'INVALID_THEME_SOURCE';
  end if;

  if v_is_sponsored and (
    v_sponsor_name is null
    or v_sponsor_link is null
    or v_sponsor_banner_r2_key is null
  ) then
    raise exception using message = 'INCOMPLETE_SPONSOR_SETTINGS';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('cycle-start-global', 0)
  );

  select *
  into v_current
  from public.voting_cycles
  where status in (
    'active',
    'submission_open',
    'submission_closed',
    'voting_open',
    'voting_closed',
    'paused',
    'finalizing'
  )
  order by id desc
  limit 1
  for update;

  if found then
    if p_cycle_id = v_current.id
      and v_current.status in ('submission_open', 'active')
    then
      return jsonb_build_object(
        'cycleId', v_current.id,
        'cycleNumber', v_current.id,
        'status', v_current.status::text,
        'startedAt', coalesce(
          v_current.submission_starts_at,
          v_current.starts_at
        ),
        'alreadyStarted', true,
        'createdCycle', false,
        'reusedDraft', true,
        'reusedResetDraft', v_current.reset_count > 0,
        'resetCount', v_current.reset_count
      );
    end if;

    raise exception using
      message = 'CURRENT_CYCLE_EXISTS',
      detail = 'An unfinished/current cycle already exists.';
  end if;

  if p_cycle_id is not null then
    select *
    into v_cycle
    from public.voting_cycles
    where id = p_cycle_id
    for update;

    if not found then
      raise exception using message = 'CYCLE_NOT_FOUND';
    end if;
  else
    select *
    into v_cycle
    from public.voting_cycles
    where status = 'draft'
    order by (reset_at is not null) desc, id desc
    limit 1
    for update;
  end if;

  if found then
    if v_cycle.status <> 'draft' then
      raise exception using
        message = 'CYCLE_NOT_STARTABLE',
        detail = 'Requested cycle status is ' || v_cycle.status::text;
    end if;

    if exists (
      select 1 from public.submissions where cycle_id = v_cycle.id
    )
      or exists (
        select 1 from public.votes where cycle_id = v_cycle.id
      )
      or exists (
        select 1 from public.cycle_results where cycle_id = v_cycle.id
      )
      or exists (
        select 1 from public.winner_public_profiles where cycle_id = v_cycle.id
      )
      or exists (
        select 1 from public.cycle_events where cycle_id = v_cycle.id
      )
      or exists (
        select 1 from public.cycle_reminders where cycle_id = v_cycle.id
      )
      or exists (
        select 1 from public.user_cycle_acceptance where cycle_id = v_cycle.id
      )
    then
      raise exception using message = 'CYCLE_DRAFT_NOT_CLEAN';
    end if;

    v_reused_draft := true;
    v_reused_reset_draft := v_cycle.reset_at is not null;

    update public.voting_cycles
    set
      status = 'submission_open',
      starts_at = v_now,
      ends_at = null,
      created_by_discord_id = v_actor_discord_id,
      ended_at = null,
      finalized_at = null,
      winners_published = false,
      theme = v_theme,
      title = null,
      is_sponsored = v_is_sponsored,
      sponsor_name = case when v_is_sponsored then v_sponsor_name else null end,
      sponsor_link = case when v_is_sponsored then v_sponsor_link else null end,
      reward_description = v_reward_description,
      sponsor_banner_key = case
        when v_is_sponsored then v_sponsor_banner_r2_key
        else null
      end,
      rule_template_id = null,
      submission_starts_at = v_now,
      submission_ends_at = null,
      voting_starts_at = null,
      voting_ends_at = null,
      results_published_at = null,
      archived_at = null,
      submission_warn_threshold = null,
      submission_warned_at = null,
      submission_auto_close_enabled = false,
      submission_auto_close_threshold = null,
      submission_auto_closed_at = null,
      votes_per_user = 2,
      allow_self_vote = false,
      sponsorship_id = null,
      sponsor_name_snapshot = case
        when v_is_sponsored then v_sponsor_name
        else null
      end,
      sponsor_link_snapshot = case
        when v_is_sponsored then v_sponsor_link
        else null
      end,
      sponsor_banner_url_snapshot = case
        when v_is_sponsored then v_sponsor_banner_url
        else null
      end,
      paused_from_status = null,
      phase_paused_at = null,
      phase_paused_remaining_seconds = null,
      phase_pause_reason = null,
      reset_at = null
    where id = v_cycle.id
    returning * into v_cycle;
  else
    insert into public.voting_cycles (
      status,
      starts_at,
      created_by_discord_id,
      theme,
      is_sponsored,
      sponsor_name,
      sponsor_link,
      reward_description,
      sponsor_banner_key,
      submission_starts_at,
      votes_per_user,
      allow_self_vote,
      sponsor_name_snapshot,
      sponsor_link_snapshot,
      sponsor_banner_url_snapshot
    ) values (
      'submission_open',
      v_now,
      v_actor_discord_id,
      v_theme,
      v_is_sponsored,
      case when v_is_sponsored then v_sponsor_name else null end,
      case when v_is_sponsored then v_sponsor_link else null end,
      v_reward_description,
      case when v_is_sponsored then v_sponsor_banner_r2_key else null end,
      v_now,
      2,
      false,
      case when v_is_sponsored then v_sponsor_name else null end,
      case when v_is_sponsored then v_sponsor_link else null end,
      case when v_is_sponsored then v_sponsor_banner_url else null end
    )
    returning * into v_cycle;

    v_created_cycle := true;
  end if;

  delete from public.cycle_sponsorships
  where cycle_id = v_cycle.id;

  if v_is_sponsored then
    insert into public.cycle_sponsorships (
      cycle_id,
      sponsor_name,
      sponsor_link,
      banner_r2_key,
      is_active,
      starts_at,
      ends_at,
      updated_at
    ) values (
      v_cycle.id,
      v_sponsor_name,
      v_sponsor_link,
      v_sponsor_banner_r2_key,
      true,
      v_now,
      null,
      v_now
    )
    returning id into v_sponsorship_id;

    update public.voting_cycles
    set sponsorship_id = v_sponsorship_id
    where id = v_cycle.id
    returning * into v_cycle;
  end if;

  insert into public.cycle_events (
    cycle_id,
    event_type,
    actor_type,
    actor_discord_user_id,
    payload
  ) values (
    v_cycle.id,
    'submission_phase_opened',
    'admin',
    p_actor_discord_user_id,
    jsonb_build_object(
      'phase', 'submission_open',
      'theme', v_theme,
      'reward_description', v_reward_description,
      'ends_at', null,
      'started_at', v_now,
      'reused_draft', v_reused_draft,
      'reused_reset_cycle', v_reused_reset_draft,
      'reset_count', v_cycle.reset_count,
      'sponsored_cycle', case
        when v_is_sponsored then jsonb_build_object(
          'company_name', v_sponsor_name,
          'sponsor_link', v_sponsor_link,
          'banner_r2_key', v_sponsor_banner_r2_key
        )
        else 'null'::jsonb
      end
    )
  );

  insert into public.admin_action_logs (
    actor_type,
    actor_id,
    action,
    target_type,
    target_id,
    meta
  ) values (
    'admin',
    p_actor_discord_user_id,
    'cycle_started',
    'cycle',
    v_cycle.id::text,
    jsonb_build_object(
      'phase', 'submission_open',
      'submission_starts_at', v_now,
      'submission_ends_at', null,
      'ends_at', null,
      'theme', v_theme,
      'theme_source', v_theme_source,
      'reward_description', v_reward_description,
      'reused_draft', v_reused_draft,
      'reused_reset_cycle', v_reused_reset_draft,
      'reset_count', v_cycle.reset_count,
      'sponsored_cycle', case
        when v_is_sponsored then jsonb_build_object(
          'company_name', v_sponsor_name,
          'sponsor_link', v_sponsor_link,
          'banner_r2_key', v_sponsor_banner_r2_key
        )
        else 'null'::jsonb
      end
    )
  );

  insert into public.app_config (key, value)
  values ('cycle_theme', v_theme)
  on conflict (key) do update set value = excluded.value;

  insert into public.app_config (key, value)
  values
    ('next_cycle_theme', null),
    ('next_cycle_reward_description', null),
    ('next_cycle_sponsored_enabled', 'false'),
    ('next_cycle_sponsor_name', null),
    ('next_cycle_sponsor_link', null),
    ('next_cycle_sponsor_banner_r2_key', null),
    ('next_cycle_is_sponsored', 'false')
  on conflict (key) do update set value = excluded.value;

  update public.user_logs
  set upload_fail_count = 0
  where upload_fail_count <> 0;

  return jsonb_build_object(
    'cycleId', v_cycle.id,
    'cycleNumber', v_cycle.id,
    'status', v_cycle.status::text,
    'startedAt', v_cycle.submission_starts_at,
    'alreadyStarted', false,
    'createdCycle', v_created_cycle,
    'reusedDraft', v_reused_draft,
    'reusedResetDraft', v_reused_reset_draft,
    'resetCount', v_cycle.reset_count
  );
end;
$$;


--
-- Name: FUNCTION start_cycle(p_cycle_id bigint, p_actor_discord_user_id text, p_settings jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.start_cycle(p_cycle_id bigint, p_actor_discord_user_id text, p_settings jsonb) IS 'Globally serializes Cycle Start, locks/reuses a clean draft when available, preserves reset history, and atomically writes cycle state, sponsorship, event, audit, and runtime config.';


--
-- Name: submission_upload_error_code(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.submission_upload_error_code(p_error_code text) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
  select left(
    regexp_replace(
      coalesce(nullif(btrim(p_error_code), ''), 'UPLOAD_FAILED'),
      '[^A-Za-z0-9_.-]',
      '_',
      'g'
    ),
    120
  );
$$;


--
-- Name: sync_discord_user_context(text, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_discord_user_context(p_discord_user_id text, p_discord_handle text, p_display_name text, p_guild_nickname text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_known_display_names text[];
  v_known_guild_nicknames text[];
begin

  select
    coalesce(known_display_names, '{}'),
    coalesce(known_guild_nicknames, '{}')
  into
    v_known_display_names,
    v_known_guild_nicknames
  from public.user_logs
  where discord_user_id = p_discord_user_id;


  if p_display_name is not null
     and p_display_name <> ''
     and not (p_display_name = any(v_known_display_names))
  then
    v_known_display_names :=
      array_append(v_known_display_names, p_display_name);
  end if;


  if p_guild_nickname is not null
     and p_guild_nickname <> ''
     and not (p_guild_nickname = any(v_known_guild_nicknames))
  then
    v_known_guild_nicknames :=
      array_append(v_known_guild_nicknames, p_guild_nickname);
  end if;

  update public.user_logs
  set
    current_discord_handle = p_discord_handle,
    current_display_name = p_display_name,
    current_guild_nickname = p_guild_nickname,
    known_display_names = v_known_display_names,
    known_guild_nicknames = v_known_guild_nicknames,
    last_seen_at = now()
  where discord_user_id = p_discord_user_id;

end;
$$;


--
-- Name: unblock_submission_upload(text, bigint, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.unblock_submission_upload(p_discord_user_id text, p_cycle_id bigint, p_actor_discord_user_id text, p_reason text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_now timestamptz := transaction_timestamp();
  v_reason text := nullif(btrim(p_reason), '');
  v_state public.submission_upload_abuse_states%rowtype;
begin
  if nullif(btrim(p_discord_user_id), '') is null
    or p_cycle_id is null
    or nullif(btrim(p_actor_discord_user_id), '') is null
    or v_reason is null
    or length(v_reason) > 500
  then
    return jsonb_build_object('outcome', 'invalid_request');
  end if;

  if not exists (
    select 1
    from public.team_members member
    where member.discord_user_id = p_actor_discord_user_id
      and member.role = 'admin'
  ) then
    return jsonb_build_object('outcome', 'forbidden');
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'submission-upload-abuse:' || p_discord_user_id || ':' || p_cycle_id::text,
      0
    )
  );

  select state.*
  into v_state
  from public.submission_upload_abuse_states state
  where state.discord_user_id = p_discord_user_id
    and state.cycle_id = p_cycle_id
  for update;

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_state.blocked_at is null then
    return jsonb_build_object(
      'outcome', 'already_unblocked',
      'cycleId', p_cycle_id
    );
  end if;

  update public.submission_upload_abuse_states state
  set
    invalid_attempt_count = 0,
    blocked_at = null,
    blocked_reason = null,
    unblocked_at = v_now,
    unblocked_by_discord_user_id = p_actor_discord_user_id,
    unblock_reason = v_reason,
    updated_at = v_now
  where state.discord_user_id = p_discord_user_id
    and state.cycle_id = p_cycle_id;

  update public.user_logs users
  set upload_fail_count = 0
  where users.discord_user_id = p_discord_user_id
    and coalesce(users.upload_fail_count, 0) <> 0;

  insert into public.admin_action_logs (
    actor_type,
    actor_id,
    action,
    target_type,
    target_id,
    meta
  ) values (
    'admin',
    p_actor_discord_user_id,
    'submission_upload_cycle_unblocked',
    'discord_user',
    p_discord_user_id,
    jsonb_build_object(
      'cycleId', p_cycle_id,
      'reason', v_reason,
      'invalidAttemptCountBeforeUnblock', v_state.invalid_attempt_count,
      'totalInvalidAttemptCount', v_state.total_invalid_attempt_count,
      'blockCount', v_state.block_count
    )
  );

  return jsonb_build_object(
    'outcome', 'unblocked',
    'cycleId', p_cycle_id
  );
end;
$$;


SET default_table_access_method = heap;

--
-- Name: admin_action_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_action_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    actor_type text NOT NULL,
    actor_id text NOT NULL,
    action text NOT NULL,
    target_type text,
    target_id text,
    meta jsonb
);


--
-- Name: admin_invites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_invites (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    invite_slug text NOT NULL,
    invited_by_discord_id text NOT NULL,
    note text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: app_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_config (
    key text NOT NULL,
    value text
);


--
-- Name: TABLE app_config; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.app_config IS 'Legacy runtime config. TODO phase migration: cycle_theme, next_cycle_theme, and cycle_end_at should later move into voting_cycles or a get_cycle_hud_state RPC.';


--
-- Name: avatar_upload_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.avatar_upload_logs (
    id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    discord_user_id text NOT NULL,
    status text NOT NULL,
    reason text,
    avatar_key text,
    cooldown_until timestamp with time zone,
    CONSTRAINT avatar_upload_logs_status_check CHECK ((status = ANY (ARRAY['success'::text, 'failed'::text])))
);


--
-- Name: avatar_upload_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.avatar_upload_logs ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.avatar_upload_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: blocked_cycle_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.blocked_cycle_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    discord_user_id text NOT NULL,
    cycle_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: blocked_user_meta; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.blocked_user_meta (
    discord_user_id text NOT NULL,
    admin_handled boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: coin_launches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.coin_launches (
    id bigint NOT NULL,
    chain text NOT NULL,
    platform text NOT NULL,
    token_symbol text,
    contract_address text,
    launch_url text,
    explorer_url text,
    is_active boolean DEFAULT false NOT NULL,
    is_primary boolean DEFAULT false NOT NULL,
    display_order integer DEFAULT 100 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE coin_launches; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.coin_launches IS 'Stores public token and launch link entries shown by the site.';


--
-- Name: coin_launches_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.coin_launches ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.coin_launches_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: cycle_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cycle_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    cycle_id bigint NOT NULL,
    event_type text NOT NULL,
    actor_type text DEFAULT 'system'::text NOT NULL,
    actor_discord_user_id text,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_by_bot_at timestamp with time zone,
    discord_announced_at timestamp with time zone,
    telegram_announced_at timestamp with time zone
);


--
-- Name: TABLE cycle_events; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.cycle_events IS 'Foundation table for phase/admin/bot events. Future Discord/Telegram bot can poll this without changing current cycle behavior.';


--
-- Name: COLUMN cycle_events.event_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cycle_events.event_type IS 'Event name such as cycle_started, submission_closed, voting_opened, reminder_created, or cycle_completed.';


--
-- Name: COLUMN cycle_events.actor_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cycle_events.actor_type IS 'Actor category for audit/bot context, for example system, admin, moderator, or bot.';


--
-- Name: COLUMN cycle_events.payload; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cycle_events.payload IS 'Flexible metadata for future announcements and audit details.';


--
-- Name: COLUMN cycle_events.processed_by_bot_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cycle_events.processed_by_bot_at IS 'Set by the future bot after it has processed this event.';


--
-- Name: cycle_reminders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cycle_reminders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    cycle_id bigint NOT NULL,
    phase text NOT NULL,
    reminder_type text NOT NULL,
    due_at timestamp with time zone NOT NULL,
    message_payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    processed_at timestamp with time zone,
    discord_sent_at timestamp with time zone,
    telegram_sent_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE cycle_reminders; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.cycle_reminders IS 'Foundation table for due reminders that a future Hetzner Discord/Telegram bot can poll and process.';


--
-- Name: COLUMN cycle_reminders.phase; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cycle_reminders.phase IS 'Future phase associated with the reminder, such as submission_open, voting_open, or completed.';


--
-- Name: COLUMN cycle_reminders.reminder_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cycle_reminders.reminder_type IS 'Reminder category such as cycle_ending_soon, voting_ending_soon, or results_pending.';


--
-- Name: COLUMN cycle_reminders.message_payload; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cycle_reminders.message_payload IS 'Flexible metadata for future Discord/Telegram reminder rendering.';


--
-- Name: COLUMN cycle_reminders.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cycle_reminders.status IS 'Processing state for future bot polling. Defaults to pending.';


--
-- Name: cycle_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cycle_results (
    id bigint NOT NULL,
    cycle_id bigint NOT NULL,
    submission_id bigint NOT NULL,
    vote_count integer NOT NULL,
    is_winner boolean DEFAULT false NOT NULL,
    rank integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    final_vote_count integer,
    rank_in_cycle integer,
    tie_group integer,
    finalized_at timestamp with time zone,
    feed_eligible boolean,
    public_visibility_status_at_finalization text
);


--
-- Name: COLUMN cycle_results.final_vote_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cycle_results.final_vote_count IS 'Immutable vote total captured by finalize_cycle.';


--
-- Name: COLUMN cycle_results.rank_in_cycle; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cycle_results.rank_in_cycle IS 'Immutable dense rank captured by finalize_cycle.';


--
-- Name: COLUMN cycle_results.tie_group; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cycle_results.tie_group IS 'Dense tie group captured by finalize_cycle; currently equal to rank_in_cycle.';


--
-- Name: COLUMN cycle_results.finalized_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cycle_results.finalized_at IS 'Timestamp shared by every result snapshot from one finalization.';


--
-- Name: COLUMN cycle_results.feed_eligible; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cycle_results.feed_eligible IS 'Competition-level feed eligibility. Current public visibility must still be checked separately.';


--
-- Name: COLUMN cycle_results.public_visibility_status_at_finalization; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cycle_results.public_visibility_status_at_finalization IS 'Visibility snapshot for audit context; current submissions.public_visibility_status remains authoritative for display.';


--
-- Name: cycle_results_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.cycle_results_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cycle_results_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.cycle_results_id_seq OWNED BY public.cycle_results.id;


--
-- Name: cycle_rule_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cycle_rule_templates (
    id bigint NOT NULL,
    name text NOT NULL,
    rules_text text NOT NULL,
    requires_acceptance boolean DEFAULT true NOT NULL,
    has_rewards boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cycle_rule_templates_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.cycle_rule_templates_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cycle_rule_templates_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.cycle_rule_templates_id_seq OWNED BY public.cycle_rule_templates.id;


--
-- Name: cycle_sponsorships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cycle_sponsorships (
    id bigint NOT NULL,
    cycle_id bigint NOT NULL,
    sponsor_name text NOT NULL,
    sponsor_link text NOT NULL,
    banner_r2_key text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    starts_at timestamp with time zone,
    ends_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cycle_sponsorships_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.cycle_sponsorships ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.cycle_sponsorships_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: discord_guard_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.discord_guard_logs (
    id bigint NOT NULL,
    discord_user_id text NOT NULL,
    discord_username text,
    event_type text NOT NULL,
    message_content text,
    matched_keywords text[],
    score integer,
    action_taken text,
    channel_id text,
    message_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    metadata jsonb
);


--
-- Name: discord_guard_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.discord_guard_logs ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.discord_guard_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: discord_member_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.discord_member_state (
    discord_user_id text NOT NULL,
    current_discord_username text NOT NULL,
    discord_joined_at timestamp with time zone,
    left_discord_at timestamp with time zone,
    is_in_discord boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    discord_ban_active boolean DEFAULT false NOT NULL,
    discord_banned_at timestamp with time zone,
    discord_unbanned_at timestamp with time zone,
    discord_ban_observed_at timestamp with time zone,
    discord_membership_observed_at timestamp with time zone,
    CONSTRAINT discord_member_state_ban_excludes_membership CHECK (((NOT discord_ban_active) OR (NOT is_in_discord)))
);


--
-- Name: discord_membership_sync_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.discord_membership_sync_events (
    event_id text NOT NULL,
    event_type text NOT NULL,
    observed_at timestamp with time zone NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone,
    result_status text DEFAULT 'received'::text NOT NULL,
    payload_sha256 text NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '7 days'::interval) NOT NULL,
    CONSTRAINT discord_membership_sync_events_event_id_check CHECK (((length(event_id) >= 8) AND (length(event_id) <= 128))),
    CONSTRAINT discord_membership_sync_events_hash_check CHECK ((payload_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT discord_membership_sync_events_result_check CHECK ((result_status = ANY (ARRAY['received'::text, 'applied'::text, 'no_change'::text, 'stale'::text, 'replay'::text, 'rejected'::text, 'failed'::text]))),
    CONSTRAINT discord_membership_sync_events_type_check CHECK ((event_type = ANY (ARRAY['member_joined'::text, 'member_removed'::text, 'ban_added'::text, 'ban_removed'::text, 'snapshot_started'::text, 'snapshot_members_chunk'::text, 'snapshot_bans_chunk'::text, 'snapshot_finalize'::text, 'reconciliation_failed'::text])))
);


--
-- Name: TABLE discord_membership_sync_events; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.discord_membership_sync_events IS 'Minimal replay and idempotency ledger for signed Discord membership synchronization requests.';


--
-- Name: discord_reconciliation_bans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.discord_reconciliation_bans (
    snapshot_id uuid NOT NULL,
    discord_user_id text NOT NULL,
    discord_username text NOT NULL,
    CONSTRAINT discord_reconciliation_bans_user_check CHECK ((discord_user_id ~ '^[0-9]{5,32}$'::text)),
    CONSTRAINT discord_reconciliation_bans_username_check CHECK (((length(discord_username) >= 1) AND (length(discord_username) <= 100)))
);


--
-- Name: discord_reconciliation_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.discord_reconciliation_members (
    snapshot_id uuid NOT NULL,
    discord_user_id text NOT NULL,
    discord_username text NOT NULL,
    CONSTRAINT discord_reconciliation_members_user_check CHECK ((discord_user_id ~ '^[0-9]{5,32}$'::text)),
    CONSTRAINT discord_reconciliation_members_username_check CHECK (((length(discord_username) >= 1) AND (length(discord_username) <= 100)))
);


--
-- Name: discord_reconciliation_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.discord_reconciliation_snapshots (
    id uuid NOT NULL,
    observed_at timestamp with time zone NOT NULL,
    status text DEFAULT 'collecting'::text NOT NULL,
    expected_member_count integer NOT NULL,
    expected_ban_count integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '01:00:00'::interval) NOT NULL,
    finalized_at timestamp with time zone,
    error_code text,
    CONSTRAINT discord_reconciliation_snapshots_counts_check CHECK ((((expected_member_count >= 0) AND (expected_member_count <= 1000000)) AND ((expected_ban_count >= 0) AND (expected_ban_count <= 1000000)))),
    CONSTRAINT discord_reconciliation_snapshots_error_check CHECK (((error_code IS NULL) OR (error_code ~ '^[A-Z0-9_]{1,80}$'::text))),
    CONSTRAINT discord_reconciliation_snapshots_status_check CHECK ((status = ANY (ARRAY['collecting'::text, 'applied'::text, 'failed'::text, 'expired'::text])))
);


--
-- Name: TABLE discord_reconciliation_snapshots; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.discord_reconciliation_snapshots IS 'Multi-phase authoritative Discord member and ban snapshots; only complete snapshots are applied.';


--
-- Name: discord_sync_health; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.discord_sync_health (
    id smallint DEFAULT 1 NOT NULL,
    last_event_at timestamp with time zone,
    last_reconciliation_started_at timestamp with time zone,
    last_reconciliation_succeeded_at timestamp with time zone,
    last_ban_snapshot_at timestamp with time zone,
    last_membership_snapshot_at timestamp with time zone,
    last_error_at timestamp with time zone,
    last_error_code text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT discord_sync_health_error_check CHECK (((last_error_code IS NULL) OR (last_error_code ~ '^[A-Z0-9_]{1,80}$'::text))),
    CONSTRAINT discord_sync_health_singleton_check CHECK ((id = 1))
);


--
-- Name: invite_auth_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invite_auth_logs (
    id bigint NOT NULL,
    invite_id uuid NOT NULL,
    invite_slug text NOT NULL,
    invited_discord_user_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    discord_username text,
    discord_discriminator text,
    discord_avatar text
);


--
-- Name: invite_auth_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.invite_auth_logs ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.invite_auth_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: media_cleanup_queue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_cleanup_queue (
    id bigint NOT NULL,
    storage_provider text NOT NULL,
    storage_key text NOT NULL,
    reason text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    last_error_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone,
    next_attempt_at timestamp with time zone DEFAULT now(),
    locked_at timestamp with time zone,
    locked_until timestamp with time zone,
    lease_token uuid,
    last_attempt_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT media_cleanup_queue_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT media_cleanup_queue_error_code_length_check CHECK (((last_error_code IS NULL) OR (length(last_error_code) <= 120))),
    CONSTRAINT media_cleanup_queue_lease_state_check CHECK ((((status = 'processing'::text) AND (lease_token IS NOT NULL) AND (locked_at IS NOT NULL) AND (locked_until IS NOT NULL) AND (locked_until > locked_at)) OR ((status <> 'processing'::text) AND (lease_token IS NULL) AND (locked_at IS NULL) AND (locked_until IS NULL)))),
    CONSTRAINT media_cleanup_queue_processed_state_check CHECK ((((status = 'completed'::text) AND (processed_at IS NOT NULL)) OR ((status <> 'completed'::text) AND (processed_at IS NULL)))),
    CONSTRAINT media_cleanup_queue_reason_not_blank_check CHECK ((btrim(reason) <> ''::text)),
    CONSTRAINT media_cleanup_queue_retry_schedule_check CHECK ((((status = ANY (ARRAY['pending'::text, 'failed'::text])) AND (next_attempt_at IS NOT NULL)) OR ((status <> ALL (ARRAY['pending'::text, 'failed'::text])) AND (next_attempt_at IS NULL)))),
    CONSTRAINT media_cleanup_queue_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'failed'::text, 'completed'::text, 'dead'::text]))),
    CONSTRAINT media_cleanup_queue_storage_key_not_blank_check CHECK ((btrim(storage_key) <> ''::text)),
    CONSTRAINT media_cleanup_queue_storage_provider_check CHECK ((storage_provider = 'r2'::text))
);


--
-- Name: TABLE media_cleanup_queue; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.media_cleanup_queue IS 'Server-only retry ledger for storage objects whose database references have already been removed.';


--
-- Name: COLUMN media_cleanup_queue.storage_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.media_cleanup_queue.storage_key IS 'Canonical provider object key only; never a signed or public URL.';


--
-- Name: COLUMN media_cleanup_queue.attempts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.media_cleanup_queue.attempts IS 'Number of processing leases issued. Claim increments exactly once; complete/fail never increments it.';


--
-- Name: COLUMN media_cleanup_queue.last_error_code; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.media_cleanup_queue.last_error_code IS 'Sanitized dependency error code only; never credentials, URLs, or raw provider messages.';


--
-- Name: COLUMN media_cleanup_queue.processed_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.media_cleanup_queue.processed_at IS 'Completion timestamp. This existing column is the canonical completed_at equivalent.';


--
-- Name: COLUMN media_cleanup_queue.next_attempt_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.media_cleanup_queue.next_attempt_at IS 'Database time at which a pending/failed job becomes claimable. Null for processing and terminal states.';


--
-- Name: COLUMN media_cleanup_queue.locked_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.media_cleanup_queue.locked_at IS 'Database time at which the current processing lease was issued.';


--
-- Name: COLUMN media_cleanup_queue.locked_until; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.media_cleanup_queue.locked_until IS 'Hard lease expiry. A result arriving at or after this time is stale even if no new worker has claimed the job yet.';


--
-- Name: COLUMN media_cleanup_queue.lease_token; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.media_cleanup_queue.lease_token IS 'Opaque ownership token replaced on every claim, including recovery of an expired processing lease.';


--
-- Name: COLUMN media_cleanup_queue.last_attempt_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.media_cleanup_queue.last_attempt_at IS 'Database time of the latest successful claim, independent of its eventual outcome.';


--
-- Name: COLUMN media_cleanup_queue.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.media_cleanup_queue.updated_at IS 'Database time of the latest queue state change.';


--
-- Name: media_cleanup_queue_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.media_cleanup_queue ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.media_cleanup_queue_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: moderation_action_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.moderation_action_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    actor_role text NOT NULL,
    actor_id text NOT NULL,
    action text NOT NULL,
    target_type text NOT NULL,
    target_id text NOT NULL,
    reason_code text NOT NULL,
    reason_text text,
    evidence jsonb,
    cycle_id integer,
    actor_discord_username text,
    target_discord_user_id text,
    target_discord_username text
);


--
-- Name: next_cycle_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.next_cycle_config (
    id boolean DEFAULT true NOT NULL,
    title text,
    theme text,
    is_sponsored boolean DEFAULT false NOT NULL,
    sponsor_name text,
    sponsor_link text,
    reward_description text,
    sponsor_banner_key text,
    rule_template_id bigint,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by_discord_user_id text,
    updated_by_discord_username text,
    CONSTRAINT next_cycle_config_singleton CHECK ((id = true))
);


--
-- Name: submissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.submissions (
    id bigint NOT NULL,
    cycle_id bigint,
    discord_user_id text NOT NULL,
    is_disqualified boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    disqualification_type text,
    disqualification_reason_code text,
    disqualification_reason_text text,
    moderation_status text DEFAULT 'clean'::text NOT NULL,
    disqualify_reason_code text,
    disqualify_note text,
    disqualified_at timestamp with time zone,
    disqualified_by_discord_user_id text,
    disqualified_by_discord_username text,
    r2_key text,
    discord_username_at_upload text,
    public_visibility_status text DEFAULT 'visible'::text NOT NULL,
    public_visibility_reason_code text,
    public_visibility_reason_text text,
    public_visibility_updated_at timestamp with time zone,
    public_visibility_updated_by_discord_user_id text,
    public_visibility_updated_by_discord_username text,
    hidden_from_profile_at timestamp with time zone,
    hidden_from_profile_by_discord_user_id text,
    public_visibility_source text DEFAULT 'manual'::text NOT NULL,
    discord_ban_hidden_at timestamp with time zone,
    discord_ban_hidden_observed_at timestamp with time zone,
    public_republished_at timestamp with time zone,
    public_republished_by_discord_user_id text,
    public_republish_reason text,
    public_republish_review_confirmed boolean DEFAULT false NOT NULL,
    CONSTRAINT submissions_public_republish_metadata_check CHECK ((((public_republished_at IS NULL) AND (public_republished_by_discord_user_id IS NULL) AND (public_republish_reason IS NULL) AND (public_republish_review_confirmed = false)) OR ((public_republished_at IS NOT NULL) AND (public_republished_by_discord_user_id IS NOT NULL) AND (public_republish_reason IS NOT NULL) AND (public_republish_review_confirmed = true)))),
    CONSTRAINT submissions_public_republish_reason_check CHECK (((public_republish_reason IS NULL) OR ((length(btrim(public_republish_reason)) >= 10) AND (length(btrim(public_republish_reason)) <= 1000)))),
    CONSTRAINT submissions_public_visibility_source_check CHECK ((public_visibility_source = ANY (ARRAY['manual'::text, 'discord_ban'::text, 'manual_republish'::text]))),
    CONSTRAINT submissions_public_visibility_status_check CHECK ((public_visibility_status = ANY (ARRAY['visible'::text, 'legal_review'::text, 'removed'::text])))
);


--
-- Name: votes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.votes (
    id bigint NOT NULL,
    cycle_id bigint NOT NULL,
    submission_id bigint,
    created_at timestamp without time zone DEFAULT now(),
    discord_user_id text NOT NULL
);

ALTER TABLE ONLY public.votes REPLICA IDENTITY FULL;


--
-- Name: TABLE votes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.votes IS 'votes';


--
-- Name: public_submissions_with_votes; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.public_submissions_with_votes AS
 SELECT s.id,
    s.cycle_id,
    s.discord_user_id,
    s.r2_key,
    count(v.id) AS vote_count,
    rank() OVER (PARTITION BY s.cycle_id ORDER BY (count(v.id)) DESC) AS rank
   FROM (public.submissions s
     LEFT JOIN public.votes v ON ((v.submission_id = s.id)))
  WHERE ((COALESCE(s.is_disqualified, false) = false) AND (s.public_visibility_status = 'visible'::text))
  GROUP BY s.id, s.cycle_id, s.discord_user_id, s.r2_key;


--
-- Name: rules_meta; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rules_meta (
    id integer NOT NULL,
    current_version integer NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    id uuid NOT NULL,
    discord_user_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone
);


--
-- Name: social_verification_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.social_verification_logs (
    id bigint NOT NULL,
    action text NOT NULL,
    actor_discord_user_id text NOT NULL,
    actor_role text NOT NULL,
    target_discord_user_id text NOT NULL,
    user_social_link_id bigint NOT NULL,
    platform text NOT NULL,
    profile_url text NOT NULL,
    handle text,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT social_verification_logs_action_check CHECK ((action = ANY (ARRAY['verify_social'::text, 'unverify_social'::text]))),
    CONSTRAINT social_verification_logs_actor_role_check CHECK ((actor_role = ANY (ARRAY['admin'::text, 'mod'::text]))),
    CONSTRAINT social_verification_logs_platform_check CHECK ((platform = ANY (ARRAY['x'::text, 'instagram'::text, 'tiktok'::text, 'facebook'::text])))
);


--
-- Name: social_verification_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.social_verification_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: social_verification_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.social_verification_logs_id_seq OWNED BY public.social_verification_logs.id;


--
-- Name: sponsor_tracking_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sponsor_tracking_events (
    id bigint NOT NULL,
    sponsorship_id bigint NOT NULL,
    event_type text NOT NULL,
    surface text NOT NULL,
    viewer_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sponsor_tracking_events_event_type_check CHECK ((event_type = ANY (ARRAY['impression'::text, 'click'::text]))),
    CONSTRAINT sponsor_tracking_events_surface_check CHECK ((surface = ANY (ARRAY['home_hud'::text, 'vote_modal'::text, 'history_modal'::text, 'fame_modal'::text, 'shame_modal'::text])))
);


--
-- Name: sponsor_tracking_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.sponsor_tracking_events ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.sponsor_tracking_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: submission_private_data; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.submission_private_data (
    id bigint NOT NULL,
    submission_id bigint NOT NULL,
    x_username text,
    wallet_address text NOT NULL,
    payout_choice text NOT NULL,
    split_percent integer,
    charity text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT submission_private_data_payout_choice_check CHECK ((payout_choice = ANY (ARRAY['keep'::text, 'donate'::text, 'split'::text])))
);


--
-- Name: submission_private_data_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.submission_private_data_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: submission_private_data_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.submission_private_data_id_seq OWNED BY public.submission_private_data.id;


--
-- Name: submission_social_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.submission_social_links (
    id bigint NOT NULL,
    submission_id bigint NOT NULL,
    discord_user_id text NOT NULL,
    platform text NOT NULL,
    display_label text NOT NULL,
    profile_url text NOT NULL,
    is_verified_snapshot boolean DEFAULT false NOT NULL,
    source_user_social_link_id bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT submission_social_links_platform_check CHECK ((platform = ANY (ARRAY['x'::text, 'instagram'::text, 'tiktok'::text, 'facebook'::text])))
);


--
-- Name: submission_social_links_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.submission_social_links_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: submission_social_links_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.submission_social_links_id_seq OWNED BY public.submission_social_links.id;


--
-- Name: submission_upload_abuse_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.submission_upload_abuse_states (
    discord_user_id text NOT NULL,
    cycle_id bigint NOT NULL,
    invalid_attempt_count integer DEFAULT 0 NOT NULL,
    total_invalid_attempt_count integer DEFAULT 0 NOT NULL,
    last_error_code text,
    last_invalid_attempt_at timestamp with time zone,
    blocked_at timestamp with time zone,
    blocked_reason text,
    block_count integer DEFAULT 0 NOT NULL,
    last_blocked_at timestamp with time zone,
    unblocked_at timestamp with time zone,
    unblocked_by_discord_user_id text,
    unblock_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT submission_upload_abuse_attempt_count_check CHECK (((invalid_attempt_count >= 0) AND (invalid_attempt_count <= 5))),
    CONSTRAINT submission_upload_abuse_block_count_check CHECK ((block_count >= 0)),
    CONSTRAINT submission_upload_abuse_error_code_check CHECK (((last_error_code IS NULL) OR (last_error_code ~ '^[A-Z0-9_]{1,80}$'::text))),
    CONSTRAINT submission_upload_abuse_state_check CHECK ((((blocked_at IS NULL) AND (invalid_attempt_count < 5) AND (blocked_reason IS NULL)) OR ((blocked_at IS NOT NULL) AND (invalid_attempt_count = 5) AND (blocked_reason IS NOT NULL)))),
    CONSTRAINT submission_upload_abuse_total_count_check CHECK ((total_invalid_attempt_count >= invalid_attempt_count)),
    CONSTRAINT submission_upload_abuse_unblock_audit_check CHECK ((((unblocked_at IS NULL) AND (unblocked_by_discord_user_id IS NULL) AND (unblock_reason IS NULL)) OR ((unblocked_at IS NOT NULL) AND (unblocked_by_discord_user_id IS NOT NULL) AND (unblock_reason IS NOT NULL))))
);


--
-- Name: TABLE submission_upload_abuse_states; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.submission_upload_abuse_states IS 'Authoritative server-only per-user/per-cycle invalid submission-media counter and upload block state. Historical totals and block count survive an Admin unblock.';


--
-- Name: submission_upload_operations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.submission_upload_operations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    discord_user_id text NOT NULL,
    cycle_id bigint NOT NULL,
    idempotency_key uuid NOT NULL,
    request_fingerprint text NOT NULL,
    content_sha256 text NOT NULL,
    storage_provider text DEFAULT 'r2'::text NOT NULL,
    storage_key text NOT NULL,
    media_type text NOT NULL,
    media_bytes integer NOT NULL,
    r2_etag text,
    status text DEFAULT 'reserved'::text NOT NULL,
    submission_id bigint,
    cleanup_required boolean DEFAULT false NOT NULL,
    last_error_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT submission_upload_operations_cleanup_state_check CHECK ((((status = 'cleanup_pending'::text) AND (cleanup_required = true)) OR ((status <> 'cleanup_pending'::text) AND (cleanup_required = false)))),
    CONSTRAINT submission_upload_operations_content_hash_check CHECK ((content_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT submission_upload_operations_error_length_check CHECK (((last_error_code IS NULL) OR (length(last_error_code) <= 120))),
    CONSTRAINT submission_upload_operations_etag_length_check CHECK (((r2_etag IS NULL) OR (length(r2_etag) <= 256))),
    CONSTRAINT submission_upload_operations_fingerprint_check CHECK ((request_fingerprint ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT submission_upload_operations_media_bytes_check CHECK (((media_bytes > 0) AND (media_bytes <= 16777216))),
    CONSTRAINT submission_upload_operations_media_type_check CHECK ((media_type = 'image/webp'::text)),
    CONSTRAINT submission_upload_operations_state_check CHECK ((((status = 'completed'::text) AND (submission_id IS NOT NULL) AND (cleanup_required = false) AND (completed_at IS NOT NULL)) OR ((status <> 'completed'::text) AND (submission_id IS NULL) AND (completed_at IS NULL)))),
    CONSTRAINT submission_upload_operations_status_check CHECK ((status = ANY (ARRAY['reserved'::text, 'r2_uploaded'::text, 'cleanup_pending'::text, 'completed'::text, 'failed'::text]))),
    CONSTRAINT submission_upload_operations_storage_key_check CHECK ((storage_key ~ (('^'::text || (cycle_id)::text) || '/[0-9A-Fa-f-]{36}[.]webp$'::text))),
    CONSTRAINT submission_upload_operations_storage_provider_check CHECK ((storage_provider = 'r2'::text)),
    CONSTRAINT submission_upload_operations_user_id_not_blank_check CHECK ((btrim(discord_user_id) <> ''::text))
);


--
-- Name: TABLE submission_upload_operations; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.submission_upload_operations IS 'Server-only durable upload intent and idempotency ledger bridging R2 and the atomic PostgreSQL submission commit.';


--
-- Name: COLUMN submission_upload_operations.idempotency_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.submission_upload_operations.idempotency_key IS 'Client-generated random UUID bound to one authenticated user and the operation cycle; it contains no user data.';


--
-- Name: COLUMN submission_upload_operations.request_fingerprint; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.submission_upload_operations.request_fingerprint IS 'SHA-256 of canonical transformed media hash and normalized user-supplied payout metadata.';


--
-- Name: COLUMN submission_upload_operations.storage_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.submission_upload_operations.storage_key IS 'Canonical server-generated R2 key. The client never chooses a bucket, prefix, cycle, submission, or object key.';


--
-- Name: COLUMN submission_upload_operations.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.submission_upload_operations.status IS 'reserved before R2, r2_uploaded after provider confirmation, completed only with the atomic submission commit, cleanup_pending while compensation is durable, and failed only after a non-public failed operation is safe to retry.';


--
-- Name: submissions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.submissions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: submissions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.submissions_id_seq OWNED BY public.submissions.id;


--
-- Name: submissions_with_votes; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.submissions_with_votes AS
 SELECT s.id,
    s.cycle_id,
    s.discord_user_id,
    s.is_disqualified,
    s.moderation_status,
    s.r2_key,
    count(v.id) AS vote_count,
    rank() OVER (PARTITION BY s.cycle_id ORDER BY (count(v.id)) DESC) AS rank,
    s.disqualification_reason_text,
    s.disqualified_by_discord_username,
    s.disqualification_reason_code
   FROM (public.submissions s
     LEFT JOIN public.votes v ON ((v.submission_id = s.id)))
  GROUP BY s.id, s.cycle_id, s.discord_user_id, s.is_disqualified, s.moderation_status, s.r2_key, s.disqualification_reason_text, s.disqualified_by_discord_username, s.disqualification_reason_code;


--
-- Name: team_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_members (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    discord_user_id text NOT NULL,
    role text NOT NULL,
    added_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    discord_username text,
    added_at timestamp with time zone DEFAULT now(),
    CONSTRAINT team_members_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'mod'::text])))
);


--
-- Name: upload_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.upload_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    cycle_id text NOT NULL,
    submission_id text,
    status text NOT NULL,
    reason text,
    discord_user_id text
);


--
-- Name: user_cycle_acceptance; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_cycle_acceptance (
    discord_user_id text NOT NULL,
    cycle_id bigint NOT NULL,
    accepted_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_logs (
    discord_user_id text NOT NULL,
    current_discord_username text NOT NULL,
    known_discord_usernames text[] DEFAULT '{}'::text[] NOT NULL,
    username_change_count integer DEFAULT 0 NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    flagged_for_review boolean DEFAULT false NOT NULL,
    flagged_at timestamp with time zone,
    flagged_by_discord_user_id text,
    internal_notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    flagged_by_discord_username text,
    unflagged_by_discord_username text,
    banned_by_discord_username text,
    unbanned_by_discord_username text,
    flag_reason_code text,
    flag_note text,
    is_banned boolean DEFAULT false NOT NULL,
    unflag_reason text,
    ban_reason text,
    ban_source text,
    banned_at timestamp with time zone,
    banned_by_discord_user_id text,
    unbanned_at timestamp with time zone,
    unban_reason text,
    unbanned_by_discord_user_id text,
    upload_fail_count integer DEFAULT 0,
    upload_fail_window_start timestamp without time zone,
    last_upload_fail_at timestamp without time zone,
    attention_events_count integer DEFAULT 0,
    upload_fail_cycle_count integer DEFAULT 0,
    upload_cooldown_until timestamp without time zone,
    auto_banned boolean DEFAULT false,
    accepted_rules_version integer,
    avatar_key text,
    avatar_updated_at timestamp with time zone,
    discord_avatar text,
    unflagged_at timestamp with time zone,
    unflagged_by_discord_user_id text,
    public_profile_id uuid DEFAULT gen_random_uuid() NOT NULL,
    show_socials boolean DEFAULT false NOT NULL,
    show_socials_on_submissions boolean DEFAULT false NOT NULL,
    discord_joined_at timestamp with time zone,
    current_discord_handle text,
    current_display_name text,
    current_guild_nickname text,
    known_display_names text[] DEFAULT '{}'::text[],
    known_guild_nicknames text[] DEFAULT '{}'::text[]
);


--
-- Name: user_logs_with_stats; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.user_logs_with_stats AS
 SELECT ul.discord_user_id,
    ul.current_discord_username,
    ul.known_discord_usernames,
    ul.username_change_count,
    ul.first_seen_at,
    ul.last_seen_at,
    ul.flagged_for_review,
    ul.flag_reason_code,
    ul.flag_note,
    ul.flagged_at,
    ul.flagged_by_discord_username,
    ul.unflag_reason,
    ul.unflagged_by_discord_username,
    ul.is_banned,
    ul.ban_reason,
    ul.banned_at,
    ul.banned_by_discord_username,
    ul.unbanned_at,
    ul.unbanned_by_discord_username,
    count(DISTINCT s.id) AS submission_count,
    max(s.created_at) AS last_submission_at
   FROM (public.user_logs ul
     LEFT JOIN public.submissions s ON ((s.discord_user_id = ul.discord_user_id)))
  GROUP BY ul.discord_user_id, ul.current_discord_username, ul.known_discord_usernames, ul.username_change_count, ul.first_seen_at, ul.last_seen_at, ul.flagged_for_review, ul.flag_reason_code, ul.flag_note, ul.flagged_at, ul.flagged_by_discord_username, ul.unflag_reason, ul.unflagged_by_discord_username, ul.is_banned, ul.ban_reason, ul.banned_at, ul.banned_by_discord_username, ul.unbanned_at, ul.unbanned_by_discord_username;


--
-- Name: user_social_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_social_links (
    id bigint NOT NULL,
    discord_user_id text NOT NULL,
    platform text NOT NULL,
    handle text,
    profile_url text NOT NULL,
    is_verified boolean DEFAULT false NOT NULL,
    verified_at timestamp with time zone,
    verified_by_discord_user_id text,
    verification_note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_social_links_platform_check CHECK ((platform = ANY (ARRAY['x'::text, 'instagram'::text, 'tiktok'::text, 'facebook'::text])))
);


--
-- Name: user_social_links_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_social_links_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_social_links_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_social_links_id_seq OWNED BY public.user_social_links.id;


--
-- Name: vote_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vote_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    cycle_id text NOT NULL,
    submission_id text,
    status text NOT NULL,
    reason text,
    discord_user_id text
);


--
-- Name: votes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.votes ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.votes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: voting_cycles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.voting_cycles (
    id bigint NOT NULL,
    starts_at timestamp with time zone,
    ends_at timestamp with time zone,
    created_by_discord_id bigint,
    created_at timestamp with time zone DEFAULT now(),
    ended_at timestamp with time zone,
    status public.voting_cycle_status DEFAULT 'active'::public.voting_cycle_status NOT NULL,
    finalized_at timestamp with time zone,
    winners_published boolean DEFAULT false,
    theme text,
    title text,
    is_sponsored boolean DEFAULT false NOT NULL,
    sponsor_name text,
    sponsor_link text,
    reward_description text,
    sponsor_banner_key text,
    rule_template_id bigint,
    submission_starts_at timestamp with time zone,
    submission_ends_at timestamp with time zone,
    voting_starts_at timestamp with time zone,
    voting_ends_at timestamp with time zone,
    results_published_at timestamp with time zone,
    archived_at timestamp with time zone,
    submission_warn_threshold integer,
    submission_warned_at timestamp with time zone,
    submission_auto_close_enabled boolean DEFAULT false NOT NULL,
    submission_auto_close_threshold integer,
    submission_auto_closed_at timestamp with time zone,
    votes_per_user integer DEFAULT 2 NOT NULL,
    allow_self_vote boolean DEFAULT false NOT NULL,
    sponsorship_id bigint,
    sponsor_name_snapshot text,
    sponsor_link_snapshot text,
    sponsor_banner_url_snapshot text,
    paused_from_status text,
    phase_paused_at timestamp with time zone,
    phase_paused_remaining_seconds integer,
    phase_pause_reason text,
    reset_count integer DEFAULT 0 NOT NULL,
    reset_at timestamp with time zone,
    CONSTRAINT voting_cycles_paused_from_status_check CHECK (((paused_from_status IS NULL) OR (paused_from_status = ANY (ARRAY['submission_open'::text, 'voting_open'::text])))),
    CONSTRAINT voting_cycles_paused_remaining_seconds_check CHECK (((phase_paused_remaining_seconds IS NULL) OR (phase_paused_remaining_seconds >= 0))),
    CONSTRAINT voting_cycles_reset_count_check CHECK ((reset_count >= 0)),
    CONSTRAINT voting_cycles_votes_per_user_check CHECK (((votes_per_user >= 1) AND (votes_per_user <= 10)))
);


--
-- Name: COLUMN voting_cycles.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.voting_cycles.status IS 'Legacy statuses active/finalizing/finished remain valid during the phase migration. Later, active should map to submission_open or the correct phase, and finished should map to completed.';


--
-- Name: COLUMN voting_cycles.is_sponsored; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.voting_cycles.is_sponsored IS 'Sponsorship snapshot flag intended to avoid querying sponsorship metadata for every non-sponsored cycle.';


--
-- Name: COLUMN voting_cycles.submission_starts_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.voting_cycles.submission_starts_at IS 'Future phase timing: when submissions open for this cycle.';


--
-- Name: COLUMN voting_cycles.submission_ends_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.voting_cycles.submission_ends_at IS 'Future phase timing: when submissions close for this cycle.';


--
-- Name: COLUMN voting_cycles.voting_starts_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.voting_cycles.voting_starts_at IS 'Future phase timing: when voting opens for this cycle.';


--
-- Name: COLUMN voting_cycles.voting_ends_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.voting_cycles.voting_ends_at IS 'Future phase timing: when voting closes for this cycle.';


--
-- Name: COLUMN voting_cycles.results_published_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.voting_cycles.results_published_at IS 'Future phase timing: when results are published.';


--
-- Name: COLUMN voting_cycles.archived_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.voting_cycles.archived_at IS 'Future phase timing: when this cycle is archived.';


--
-- Name: COLUMN voting_cycles.submission_warn_threshold; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.voting_cycles.submission_warn_threshold IS 'Future admin warning threshold for high submission counts.';


--
-- Name: COLUMN voting_cycles.submission_warned_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.voting_cycles.submission_warned_at IS 'Tracks when the submission threshold warning was emitted.';


--
-- Name: COLUMN voting_cycles.submission_auto_close_enabled; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.voting_cycles.submission_auto_close_enabled IS 'Future opt-in flag for automatically closing submissions at a configured threshold.';


--
-- Name: COLUMN voting_cycles.submission_auto_close_threshold; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.voting_cycles.submission_auto_close_threshold IS 'Future submission count threshold for automatic submission close.';


--
-- Name: COLUMN voting_cycles.submission_auto_closed_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.voting_cycles.submission_auto_closed_at IS 'Tracks when submissions were automatically closed by threshold logic.';


--
-- Name: COLUMN voting_cycles.votes_per_user; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.voting_cycles.votes_per_user IS 'Future voting rule. Defaults to 2 to preserve the planned phase-based voting behavior without changing current code.';


--
-- Name: COLUMN voting_cycles.allow_self_vote; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.voting_cycles.allow_self_vote IS 'Future voting rule. Defaults to false to keep self-voting disabled.';


--
-- Name: COLUMN voting_cycles.sponsorship_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.voting_cycles.sponsorship_id IS 'Optional reference to cycle_sponsorships. Kept nullable for backward compatibility and future sponsorship snapshots.';


--
-- Name: COLUMN voting_cycles.sponsor_name_snapshot; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.voting_cycles.sponsor_name_snapshot IS 'Sponsorship snapshot copied onto the cycle for fast historical display.';


--
-- Name: COLUMN voting_cycles.sponsor_link_snapshot; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.voting_cycles.sponsor_link_snapshot IS 'Sponsorship snapshot copied onto the cycle for fast historical display.';


--
-- Name: COLUMN voting_cycles.sponsor_banner_url_snapshot; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.voting_cycles.sponsor_banner_url_snapshot IS 'Sponsorship banner snapshot copied onto the cycle for fast historical display.';


--
-- Name: COLUMN voting_cycles.paused_from_status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.voting_cycles.paused_from_status IS 'Active phase that should be restored when an admin resumes a paused cycle.';


--
-- Name: COLUMN voting_cycles.phase_paused_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.voting_cycles.phase_paused_at IS 'Timestamp at which the current submission or voting phase was paused.';


--
-- Name: COLUMN voting_cycles.phase_paused_remaining_seconds; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.voting_cycles.phase_paused_remaining_seconds IS 'Frozen countdown remainder. Null means the paused phase had no timer.';


--
-- Name: COLUMN voting_cycles.phase_pause_reason; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.voting_cycles.phase_pause_reason IS 'Optional admin-facing reason for pausing the current phase.';


--
-- Name: COLUMN voting_cycles.reset_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.voting_cycles.reset_count IS 'Number of completed Admin recovery resets for this reusable cycle row.';


--
-- Name: COLUMN voting_cycles.reset_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.voting_cycles.reset_at IS 'Non-null only while this row is the clean draft produced by the latest reset. Cleared when that draft is restarted.';


--
-- Name: voting_cycles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.voting_cycles_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: voting_cycles_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.voting_cycles_id_seq OWNED BY public.voting_cycles.id;


--
-- Name: winner_public_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.winner_public_profiles (
    id bigint NOT NULL,
    cycle_id bigint NOT NULL,
    submission_id bigint NOT NULL,
    x_username text,
    wallet_address text NOT NULL,
    payout_choice text NOT NULL,
    split_percent integer,
    charity text,
    win_share numeric NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    wall text DEFAULT 'fame'::text NOT NULL,
    vote_count integer,
    r2_key text,
    image_url text,
    CONSTRAINT winner_public_profiles_wall_check CHECK ((wall = ANY (ARRAY['fame'::text, 'shame'::text])))
);


--
-- Name: winner_public_profiles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.winner_public_profiles_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: winner_public_profiles_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.winner_public_profiles_id_seq OWNED BY public.winner_public_profiles.id;


--
-- Name: cycle_results id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cycle_results ALTER COLUMN id SET DEFAULT nextval('public.cycle_results_id_seq'::regclass);


--
-- Name: cycle_rule_templates id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cycle_rule_templates ALTER COLUMN id SET DEFAULT nextval('public.cycle_rule_templates_id_seq'::regclass);


--
-- Name: social_verification_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.social_verification_logs ALTER COLUMN id SET DEFAULT nextval('public.social_verification_logs_id_seq'::regclass);


--
-- Name: submission_private_data id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.submission_private_data ALTER COLUMN id SET DEFAULT nextval('public.submission_private_data_id_seq'::regclass);


--
-- Name: submission_social_links id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.submission_social_links ALTER COLUMN id SET DEFAULT nextval('public.submission_social_links_id_seq'::regclass);


--
-- Name: submissions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.submissions ALTER COLUMN id SET DEFAULT nextval('public.submissions_id_seq'::regclass);


--
-- Name: user_social_links id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_social_links ALTER COLUMN id SET DEFAULT nextval('public.user_social_links_id_seq'::regclass);


--
-- Name: voting_cycles id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voting_cycles ALTER COLUMN id SET DEFAULT nextval('public.voting_cycles_id_seq'::regclass);


--
-- Name: winner_public_profiles id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.winner_public_profiles ALTER COLUMN id SET DEFAULT nextval('public.winner_public_profiles_id_seq'::regclass);


--
-- Name: admin_action_logs admin_action_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_action_logs
    ADD CONSTRAINT admin_action_logs_pkey PRIMARY KEY (id);


--
-- Name: admin_invites admin_invites_invite_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_invites
    ADD CONSTRAINT admin_invites_invite_slug_key UNIQUE (invite_slug);


--
-- Name: admin_invites admin_invites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_invites
    ADD CONSTRAINT admin_invites_pkey PRIMARY KEY (id);


--
-- Name: app_config app_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_config
    ADD CONSTRAINT app_config_pkey PRIMARY KEY (key);


--
-- Name: avatar_upload_logs avatar_upload_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.avatar_upload_logs
    ADD CONSTRAINT avatar_upload_logs_pkey PRIMARY KEY (id);


--
-- Name: blocked_cycle_events blocked_cycle_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blocked_cycle_events
    ADD CONSTRAINT blocked_cycle_events_pkey PRIMARY KEY (id);


--
-- Name: blocked_cycle_events blocked_cycle_events_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blocked_cycle_events
    ADD CONSTRAINT blocked_cycle_events_unique UNIQUE (discord_user_id, cycle_id);


--
-- Name: blocked_user_meta blocked_user_meta_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blocked_user_meta
    ADD CONSTRAINT blocked_user_meta_pkey PRIMARY KEY (discord_user_id);


--
-- Name: coin_launches coin_launches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coin_launches
    ADD CONSTRAINT coin_launches_pkey PRIMARY KEY (id);


--
-- Name: cycle_events cycle_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cycle_events
    ADD CONSTRAINT cycle_events_pkey PRIMARY KEY (id);


--
-- Name: cycle_reminders cycle_reminders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cycle_reminders
    ADD CONSTRAINT cycle_reminders_pkey PRIMARY KEY (id);


--
-- Name: cycle_results cycle_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cycle_results
    ADD CONSTRAINT cycle_results_pkey PRIMARY KEY (id);


--
-- Name: cycle_results cycle_results_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cycle_results
    ADD CONSTRAINT cycle_results_unique UNIQUE (cycle_id, submission_id);


--
-- Name: cycle_rule_templates cycle_rule_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cycle_rule_templates
    ADD CONSTRAINT cycle_rule_templates_pkey PRIMARY KEY (id);


--
-- Name: cycle_sponsorships cycle_sponsorships_cycle_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cycle_sponsorships
    ADD CONSTRAINT cycle_sponsorships_cycle_id_key UNIQUE (cycle_id);


--
-- Name: cycle_sponsorships cycle_sponsorships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cycle_sponsorships
    ADD CONSTRAINT cycle_sponsorships_pkey PRIMARY KEY (id);


--
-- Name: discord_guard_logs discord_guard_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discord_guard_logs
    ADD CONSTRAINT discord_guard_logs_pkey PRIMARY KEY (id);


--
-- Name: discord_member_state discord_member_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discord_member_state
    ADD CONSTRAINT discord_member_state_pkey PRIMARY KEY (discord_user_id);


--
-- Name: discord_membership_sync_events discord_membership_sync_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discord_membership_sync_events
    ADD CONSTRAINT discord_membership_sync_events_pkey PRIMARY KEY (event_id);


--
-- Name: discord_reconciliation_bans discord_reconciliation_bans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discord_reconciliation_bans
    ADD CONSTRAINT discord_reconciliation_bans_pkey PRIMARY KEY (snapshot_id, discord_user_id);


--
-- Name: discord_reconciliation_members discord_reconciliation_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discord_reconciliation_members
    ADD CONSTRAINT discord_reconciliation_members_pkey PRIMARY KEY (snapshot_id, discord_user_id);


--
-- Name: discord_reconciliation_snapshots discord_reconciliation_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discord_reconciliation_snapshots
    ADD CONSTRAINT discord_reconciliation_snapshots_pkey PRIMARY KEY (id);


--
-- Name: discord_sync_health discord_sync_health_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discord_sync_health
    ADD CONSTRAINT discord_sync_health_pkey PRIMARY KEY (id);


--
-- Name: invite_auth_logs invite_auth_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invite_auth_logs
    ADD CONSTRAINT invite_auth_logs_pkey PRIMARY KEY (id);


--
-- Name: media_cleanup_queue media_cleanup_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_cleanup_queue
    ADD CONSTRAINT media_cleanup_queue_pkey PRIMARY KEY (id);


--
-- Name: media_cleanup_queue media_cleanup_queue_storage_key_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_cleanup_queue
    ADD CONSTRAINT media_cleanup_queue_storage_key_unique UNIQUE (storage_provider, storage_key);


--
-- Name: moderation_action_logs moderation_action_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.moderation_action_logs
    ADD CONSTRAINT moderation_action_logs_pkey PRIMARY KEY (id);


--
-- Name: next_cycle_config next_cycle_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.next_cycle_config
    ADD CONSTRAINT next_cycle_config_pkey PRIMARY KEY (id);


--
-- Name: rules_meta rules_meta_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rules_meta
    ADD CONSTRAINT rules_meta_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: social_verification_logs social_verification_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.social_verification_logs
    ADD CONSTRAINT social_verification_logs_pkey PRIMARY KEY (id);


--
-- Name: sponsor_tracking_events sponsor_tracking_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sponsor_tracking_events
    ADD CONSTRAINT sponsor_tracking_events_pkey PRIMARY KEY (id);


--
-- Name: submission_private_data submission_private_data_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.submission_private_data
    ADD CONSTRAINT submission_private_data_pkey PRIMARY KEY (id);


--
-- Name: submission_social_links submission_social_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.submission_social_links
    ADD CONSTRAINT submission_social_links_pkey PRIMARY KEY (id);


--
-- Name: submission_upload_abuse_states submission_upload_abuse_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.submission_upload_abuse_states
    ADD CONSTRAINT submission_upload_abuse_states_pkey PRIMARY KEY (discord_user_id, cycle_id);


--
-- Name: submission_upload_operations submission_upload_operations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.submission_upload_operations
    ADD CONSTRAINT submission_upload_operations_pkey PRIMARY KEY (id);


--
-- Name: submission_upload_operations submission_upload_operations_storage_key_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.submission_upload_operations
    ADD CONSTRAINT submission_upload_operations_storage_key_unique UNIQUE (storage_provider, storage_key);


--
-- Name: submission_upload_operations submission_upload_operations_submission_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.submission_upload_operations
    ADD CONSTRAINT submission_upload_operations_submission_id_key UNIQUE (submission_id);


--
-- Name: submission_upload_operations submission_upload_operations_user_idempotency_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.submission_upload_operations
    ADD CONSTRAINT submission_upload_operations_user_idempotency_unique UNIQUE (discord_user_id, idempotency_key);


--
-- Name: submissions submissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.submissions
    ADD CONSTRAINT submissions_pkey PRIMARY KEY (id);


--
-- Name: team_members team_members_discord_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_discord_user_id_key UNIQUE (discord_user_id);


--
-- Name: team_members team_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_pkey PRIMARY KEY (id);


--
-- Name: upload_logs upload_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_logs
    ADD CONSTRAINT upload_logs_pkey PRIMARY KEY (id);


--
-- Name: user_cycle_acceptance user_cycle_acceptance_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_cycle_acceptance
    ADD CONSTRAINT user_cycle_acceptance_pkey PRIMARY KEY (discord_user_id, cycle_id);


--
-- Name: user_logs user_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_logs
    ADD CONSTRAINT user_logs_pkey PRIMARY KEY (discord_user_id);


--
-- Name: user_social_links user_social_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_social_links
    ADD CONSTRAINT user_social_links_pkey PRIMARY KEY (id);


--
-- Name: vote_logs vote_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vote_logs
    ADD CONSTRAINT vote_logs_pkey PRIMARY KEY (id);


--
-- Name: votes votes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.votes
    ADD CONSTRAINT votes_pkey PRIMARY KEY (id);


--
-- Name: voting_cycles voting_cycles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voting_cycles
    ADD CONSTRAINT voting_cycles_pkey PRIMARY KEY (id);


--
-- Name: winner_public_profiles winner_public_profiles_cycle_id_submission_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.winner_public_profiles
    ADD CONSTRAINT winner_public_profiles_cycle_id_submission_id_key UNIQUE (cycle_id, submission_id);


--
-- Name: winner_public_profiles winner_public_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.winner_public_profiles
    ADD CONSTRAINT winner_public_profiles_pkey PRIMARY KEY (id);


--
-- Name: coin_launches_active_display_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX coin_launches_active_display_order_idx ON public.coin_launches USING btree (is_active, display_order);


--
-- Name: coin_launches_primary_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX coin_launches_primary_idx ON public.coin_launches USING btree (display_order, id) WHERE (is_primary = true);


--
-- Name: cycle_events_cycle_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cycle_events_cycle_id_created_at_idx ON public.cycle_events USING btree (cycle_id, created_at DESC);


--
-- Name: cycle_events_event_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cycle_events_event_type_idx ON public.cycle_events USING btree (event_type);


--
-- Name: cycle_events_unprocessed_bot_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cycle_events_unprocessed_bot_idx ON public.cycle_events USING btree (created_at) WHERE (processed_by_bot_at IS NULL);


--
-- Name: cycle_reminders_cycle_id_due_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cycle_reminders_cycle_id_due_at_idx ON public.cycle_reminders USING btree (cycle_id, due_at);


--
-- Name: cycle_reminders_status_due_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cycle_reminders_status_due_at_idx ON public.cycle_reminders USING btree (status, due_at);


--
-- Name: cycle_results_cycle_rank_submission_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cycle_results_cycle_rank_submission_idx ON public.cycle_results USING btree (cycle_id, rank_in_cycle, submission_id);


--
-- Name: cycle_results_feed_cursor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cycle_results_feed_cursor_idx ON public.cycle_results USING btree (finalized_at DESC, cycle_id DESC, rank_in_cycle, submission_id) WHERE (feed_eligible = true);


--
-- Name: cycle_sponsorships_cycle_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cycle_sponsorships_cycle_id_idx ON public.cycle_sponsorships USING btree (cycle_id);


--
-- Name: discord_member_state_active_ban_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX discord_member_state_active_ban_idx ON public.discord_member_state USING btree (discord_ban_observed_at DESC) WHERE (discord_ban_active = true);


--
-- Name: discord_member_state_membership_observed_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX discord_member_state_membership_observed_idx ON public.discord_member_state USING btree (discord_membership_observed_at DESC);


--
-- Name: discord_membership_sync_events_expires_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX discord_membership_sync_events_expires_idx ON public.discord_membership_sync_events USING btree (expires_at);


--
-- Name: discord_reconciliation_snapshots_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX discord_reconciliation_snapshots_status_idx ON public.discord_reconciliation_snapshots USING btree (status, expires_at);


--
-- Name: idx_avatar_upload_logs_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_avatar_upload_logs_created_at ON public.avatar_upload_logs USING btree (created_at DESC);


--
-- Name: idx_avatar_upload_logs_discord_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_avatar_upload_logs_discord_user_id ON public.avatar_upload_logs USING btree (discord_user_id);


--
-- Name: idx_avatar_upload_logs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_avatar_upload_logs_status ON public.avatar_upload_logs USING btree (status);


--
-- Name: idx_discord_guard_logs_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_discord_guard_logs_user ON public.discord_guard_logs USING btree (discord_user_id);


--
-- Name: idx_discord_member_state_joined_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_discord_member_state_joined_at ON public.discord_member_state USING btree (discord_joined_at);


--
-- Name: idx_submission_private_data_submission_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_submission_private_data_submission_id ON public.submission_private_data USING btree (submission_id);


--
-- Name: idx_submissions_discord_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_submissions_discord_user_id ON public.submissions USING btree (discord_user_id);


--
-- Name: idx_submissions_discord_user_id_cycle_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_submissions_discord_user_id_cycle_id ON public.submissions USING btree (discord_user_id, cycle_id DESC);


--
-- Name: idx_submissions_public_visibility_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_submissions_public_visibility_status ON public.submissions USING btree (public_visibility_status);


--
-- Name: idx_upload_logs_discord_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_upload_logs_discord_user_id ON public.upload_logs USING btree (discord_user_id);


--
-- Name: idx_user_cycle_acceptance_cycle_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_cycle_acceptance_cycle_id ON public.user_cycle_acceptance USING btree (cycle_id);


--
-- Name: idx_user_cycle_acceptance_discord_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_cycle_acceptance_discord_user_id ON public.user_cycle_acceptance USING btree (discord_user_id);


--
-- Name: idx_user_logs_flagged; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_logs_flagged ON public.user_logs USING btree (flagged_for_review) WHERE (flagged_for_review = true);


--
-- Name: idx_user_logs_last_seen; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_logs_last_seen ON public.user_logs USING btree (last_seen_at DESC);


--
-- Name: idx_user_logs_public_profile_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_user_logs_public_profile_id ON public.user_logs USING btree (public_profile_id);


--
-- Name: idx_votes_discord_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_votes_discord_user_id ON public.votes USING btree (discord_user_id);


--
-- Name: idx_voting_cycles_is_sponsored; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_voting_cycles_is_sponsored ON public.voting_cycles USING btree (is_sponsored);


--
-- Name: media_cleanup_queue_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX media_cleanup_queue_due_idx ON public.media_cleanup_queue USING btree (next_attempt_at, created_at, id) WHERE (status = ANY (ARRAY['pending'::text, 'failed'::text]));


--
-- Name: media_cleanup_queue_expired_lease_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX media_cleanup_queue_expired_lease_idx ON public.media_cleanup_queue USING btree (locked_until, id) WHERE (status = 'processing'::text);


--
-- Name: media_cleanup_queue_retry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX media_cleanup_queue_retry_idx ON public.media_cleanup_queue USING btree (status, created_at) WHERE (status = ANY (ARRAY['pending'::text, 'failed'::text]));


--
-- Name: sessions_discord_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_discord_user_id_idx ON public.sessions USING btree (discord_user_id);


--
-- Name: sessions_revoked_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_revoked_at_idx ON public.sessions USING btree (revoked_at);


--
-- Name: social_verification_logs_social_link_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX social_verification_logs_social_link_idx ON public.social_verification_logs USING btree (user_social_link_id, created_at DESC);


--
-- Name: social_verification_logs_target_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX social_verification_logs_target_user_idx ON public.social_verification_logs USING btree (target_discord_user_id, created_at DESC);


--
-- Name: sponsor_tracking_events_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sponsor_tracking_events_lookup_idx ON public.sponsor_tracking_events USING btree (sponsorship_id, event_type, surface, viewer_hash, created_at DESC);


--
-- Name: sponsor_tracking_events_report_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sponsor_tracking_events_report_idx ON public.sponsor_tracking_events USING btree (sponsorship_id, event_type, created_at DESC);


--
-- Name: submission_private_data_submission_id_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX submission_private_data_submission_id_uidx ON public.submission_private_data USING btree (submission_id);


--
-- Name: submission_social_links_discord_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX submission_social_links_discord_user_id_idx ON public.submission_social_links USING btree (discord_user_id);


--
-- Name: submission_social_links_submission_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX submission_social_links_submission_id_idx ON public.submission_social_links USING btree (submission_id);


--
-- Name: submission_social_links_submission_source_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX submission_social_links_submission_source_uidx ON public.submission_social_links USING btree (submission_id, source_user_social_link_id) WHERE (source_user_social_link_id IS NOT NULL);


--
-- Name: submission_upload_abuse_blocked_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX submission_upload_abuse_blocked_idx ON public.submission_upload_abuse_states USING btree (blocked_at DESC, cycle_id) WHERE (blocked_at IS NOT NULL);


--
-- Name: submission_upload_abuse_cycle_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX submission_upload_abuse_cycle_updated_idx ON public.submission_upload_abuse_states USING btree (cycle_id, updated_at DESC);


--
-- Name: submission_upload_operations_cycle_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX submission_upload_operations_cycle_status_idx ON public.submission_upload_operations USING btree (cycle_id, status, created_at);


--
-- Name: submission_upload_operations_one_active_user_cycle_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX submission_upload_operations_one_active_user_cycle_idx ON public.submission_upload_operations USING btree (discord_user_id, cycle_id) WHERE (status = ANY (ARRAY['reserved'::text, 'r2_uploaded'::text]));


--
-- Name: submission_upload_operations_stale_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX submission_upload_operations_stale_idx ON public.submission_upload_operations USING btree (updated_at, id) WHERE (status = ANY (ARRAY['reserved'::text, 'r2_uploaded'::text]));


--
-- Name: submissions_cycle_id_discord_user_id_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX submissions_cycle_id_discord_user_id_uidx ON public.submissions USING btree (cycle_id, discord_user_id);


--
-- Name: submissions_discord_ban_hidden_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX submissions_discord_ban_hidden_idx ON public.submissions USING btree (discord_ban_hidden_at DESC, id) WHERE (public_visibility_source = 'discord_ban'::text);


--
-- Name: submissions_discord_user_visibility_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX submissions_discord_user_visibility_idx ON public.submissions USING btree (discord_user_id, public_visibility_status, cycle_id);


--
-- Name: submissions_profile_visibility_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX submissions_profile_visibility_idx ON public.submissions USING btree (discord_user_id, hidden_from_profile_at);


--
-- Name: user_social_links_discord_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_social_links_discord_user_id_idx ON public.user_social_links USING btree (discord_user_id);


--
-- Name: user_social_links_user_platform_url_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX user_social_links_user_platform_url_key ON public.user_social_links USING btree (discord_user_id, platform, profile_url);


--
-- Name: user_social_links_verified_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_social_links_verified_idx ON public.user_social_links USING btree (is_verified);


--
-- Name: votes_cycle_submission_user_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX votes_cycle_submission_user_uidx ON public.votes USING btree (cycle_id, submission_id, discord_user_id) NULLS NOT DISTINCT;


--
-- Name: voting_cycles_one_current_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX voting_cycles_one_current_idx ON public.voting_cycles USING btree ((1)) WHERE (status = ANY (ARRAY['active'::public.voting_cycle_status, 'submission_open'::public.voting_cycle_status, 'submission_closed'::public.voting_cycle_status, 'voting_open'::public.voting_cycle_status, 'voting_closed'::public.voting_cycle_status, 'paused'::public.voting_cycle_status, 'finalizing'::public.voting_cycle_status]));


--
-- Name: INDEX voting_cycles_one_current_idx; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON INDEX public.voting_cycles_one_current_idx IS 'Defense in depth: at most one legacy/current unfinished cycle may exist. Draft and terminal states are intentionally excluded.';


--
-- Name: discord_member_state discord_member_state_submission_enforcement_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER discord_member_state_submission_enforcement_trigger AFTER INSERT OR UPDATE OF discord_ban_active ON public.discord_member_state FOR EACH ROW EXECUTE FUNCTION public.enforce_discord_ban_submissions_trigger();


--
-- Name: submission_upload_operations submission_upload_operations_abuse_block_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER submission_upload_operations_abuse_block_trigger BEFORE INSERT OR UPDATE OF status ON public.submission_upload_operations FOR EACH ROW EXECUTE FUNCTION public.enforce_submission_upload_abuse_block();


--
-- Name: submission_upload_operations submission_upload_operations_discord_access_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER submission_upload_operations_discord_access_trigger BEFORE INSERT OR UPDATE OF status ON public.submission_upload_operations FOR EACH ROW WHEN ((new.status = ANY (ARRAY['reserved'::text, 'completed'::text]))) EXECUTE FUNCTION public.enforce_discord_authenticated_action();


--
-- Name: submissions submissions_discord_ban_republish_guard_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER submissions_discord_ban_republish_guard_trigger BEFORE UPDATE OF public_visibility_status ON public.submissions FOR EACH ROW EXECUTE FUNCTION public.protect_discord_ban_republish();


--
-- Name: submissions submissions_enqueue_deleted_media; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER submissions_enqueue_deleted_media BEFORE DELETE ON public.submissions FOR EACH ROW EXECUTE FUNCTION public.enqueue_deleted_submission_media();


--
-- Name: user_logs trg_user_logs_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_user_logs_updated_at BEFORE UPDATE ON public.user_logs FOR EACH ROW EXECUTE FUNCTION public.set_user_logs_updated_at();


--
-- Name: user_social_links user_social_links_reset_verification_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER user_social_links_reset_verification_trigger BEFORE UPDATE ON public.user_social_links FOR EACH ROW EXECUTE FUNCTION public.reset_social_verification_on_change();


--
-- Name: cycle_events cycle_events_cycle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cycle_events
    ADD CONSTRAINT cycle_events_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES public.voting_cycles(id) ON DELETE CASCADE;


--
-- Name: cycle_reminders cycle_reminders_cycle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cycle_reminders
    ADD CONSTRAINT cycle_reminders_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES public.voting_cycles(id) ON DELETE CASCADE;


--
-- Name: cycle_results cycle_results_cycle_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cycle_results
    ADD CONSTRAINT cycle_results_cycle_fkey FOREIGN KEY (cycle_id) REFERENCES public.voting_cycles(id) ON DELETE CASCADE;


--
-- Name: cycle_results cycle_results_submission_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cycle_results
    ADD CONSTRAINT cycle_results_submission_fkey FOREIGN KEY (submission_id) REFERENCES public.submissions(id) ON DELETE CASCADE;


--
-- Name: cycle_sponsorships cycle_sponsorships_cycle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cycle_sponsorships
    ADD CONSTRAINT cycle_sponsorships_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES public.voting_cycles(id) ON DELETE CASCADE;


--
-- Name: discord_reconciliation_bans discord_reconciliation_bans_snapshot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discord_reconciliation_bans
    ADD CONSTRAINT discord_reconciliation_bans_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES public.discord_reconciliation_snapshots(id) ON DELETE CASCADE;


--
-- Name: discord_reconciliation_members discord_reconciliation_members_snapshot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discord_reconciliation_members
    ADD CONSTRAINT discord_reconciliation_members_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES public.discord_reconciliation_snapshots(id) ON DELETE CASCADE;


--
-- Name: votes fk_votes_cycle; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.votes
    ADD CONSTRAINT fk_votes_cycle FOREIGN KEY (cycle_id) REFERENCES public.voting_cycles(id) ON DELETE CASCADE;


--
-- Name: votes fk_votes_submission; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.votes
    ADD CONSTRAINT fk_votes_submission FOREIGN KEY (submission_id) REFERENCES public.submissions(id) ON DELETE CASCADE;


--
-- Name: invite_auth_logs invite_auth_logs_invite_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invite_auth_logs
    ADD CONSTRAINT invite_auth_logs_invite_id_fkey FOREIGN KEY (invite_id) REFERENCES public.admin_invites(id) ON DELETE CASCADE;


--
-- Name: next_cycle_config next_cycle_config_rule_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.next_cycle_config
    ADD CONSTRAINT next_cycle_config_rule_template_id_fkey FOREIGN KEY (rule_template_id) REFERENCES public.cycle_rule_templates(id) ON DELETE SET NULL;


--
-- Name: sponsor_tracking_events sponsor_tracking_events_sponsorship_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sponsor_tracking_events
    ADD CONSTRAINT sponsor_tracking_events_sponsorship_id_fkey FOREIGN KEY (sponsorship_id) REFERENCES public.cycle_sponsorships(id) ON DELETE CASCADE;


--
-- Name: submission_private_data submission_private_data_submission_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.submission_private_data
    ADD CONSTRAINT submission_private_data_submission_id_fkey FOREIGN KEY (submission_id) REFERENCES public.submissions(id) ON DELETE CASCADE;


--
-- Name: submission_social_links submission_social_links_source_user_social_link_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.submission_social_links
    ADD CONSTRAINT submission_social_links_source_user_social_link_id_fkey FOREIGN KEY (source_user_social_link_id) REFERENCES public.user_social_links(id) ON DELETE SET NULL;


--
-- Name: submission_social_links submission_social_links_submission_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.submission_social_links
    ADD CONSTRAINT submission_social_links_submission_id_fkey FOREIGN KEY (submission_id) REFERENCES public.submissions(id) ON DELETE CASCADE;


--
-- Name: submission_upload_abuse_states submission_upload_abuse_states_cycle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.submission_upload_abuse_states
    ADD CONSTRAINT submission_upload_abuse_states_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES public.voting_cycles(id) ON DELETE RESTRICT;


--
-- Name: submission_upload_abuse_states submission_upload_abuse_states_discord_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.submission_upload_abuse_states
    ADD CONSTRAINT submission_upload_abuse_states_discord_user_id_fkey FOREIGN KEY (discord_user_id) REFERENCES public.user_logs(discord_user_id) ON DELETE RESTRICT;


--
-- Name: submission_upload_operations submission_upload_operations_cycle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.submission_upload_operations
    ADD CONSTRAINT submission_upload_operations_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES public.voting_cycles(id) ON DELETE RESTRICT;


--
-- Name: submission_upload_operations submission_upload_operations_submission_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.submission_upload_operations
    ADD CONSTRAINT submission_upload_operations_submission_id_fkey FOREIGN KEY (submission_id) REFERENCES public.submissions(id) ON DELETE SET NULL;


--
-- Name: submissions submissions_cycle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.submissions
    ADD CONSTRAINT submissions_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES public.voting_cycles(id) ON DELETE CASCADE;


--
-- Name: user_cycle_acceptance user_cycle_acceptance_cycle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_cycle_acceptance
    ADD CONSTRAINT user_cycle_acceptance_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES public.voting_cycles(id) ON DELETE CASCADE;


--
-- Name: voting_cycles voting_cycles_sponsorship_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voting_cycles
    ADD CONSTRAINT voting_cycles_sponsorship_id_fkey FOREIGN KEY (sponsorship_id) REFERENCES public.cycle_sponsorships(id) ON DELETE SET NULL;


--
-- Name: votes Allow realtime read access to votes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow realtime read access to votes" ON public.votes FOR SELECT TO authenticated, anon USING (true);


--
-- Name: admin_action_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.admin_action_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: admin_invites; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.admin_invites ENABLE ROW LEVEL SECURITY;

--
-- Name: app_config; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.app_config ENABLE ROW LEVEL SECURITY;

--
-- Name: avatar_upload_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.avatar_upload_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: blocked_cycle_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.blocked_cycle_events ENABLE ROW LEVEL SECURITY;

--
-- Name: blocked_user_meta; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.blocked_user_meta ENABLE ROW LEVEL SECURITY;

--
-- Name: coin_launches; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.coin_launches ENABLE ROW LEVEL SECURITY;

--
-- Name: cycle_results; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cycle_results ENABLE ROW LEVEL SECURITY;

--
-- Name: cycle_rule_templates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cycle_rule_templates ENABLE ROW LEVEL SECURITY;

--
-- Name: cycle_sponsorships; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cycle_sponsorships ENABLE ROW LEVEL SECURITY;

--
-- Name: discord_member_state discord_bot_full_access_member_state; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY discord_bot_full_access_member_state ON public.discord_member_state TO discord_bot USING (true) WITH CHECK (true);


--
-- Name: discord_guard_logs discord_bot_insert_guard_logs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY discord_bot_insert_guard_logs ON public.discord_guard_logs FOR INSERT TO discord_bot WITH CHECK (true);


--
-- Name: discord_guard_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.discord_guard_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: discord_member_state; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.discord_member_state ENABLE ROW LEVEL SECURITY;

--
-- Name: discord_membership_sync_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.discord_membership_sync_events ENABLE ROW LEVEL SECURITY;

--
-- Name: discord_reconciliation_bans; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.discord_reconciliation_bans ENABLE ROW LEVEL SECURITY;

--
-- Name: discord_reconciliation_members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.discord_reconciliation_members ENABLE ROW LEVEL SECURITY;

--
-- Name: discord_reconciliation_snapshots; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.discord_reconciliation_snapshots ENABLE ROW LEVEL SECURITY;

--
-- Name: discord_sync_health; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.discord_sync_health ENABLE ROW LEVEL SECURITY;

--
-- Name: invite_auth_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.invite_auth_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: media_cleanup_queue; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.media_cleanup_queue ENABLE ROW LEVEL SECURITY;

--
-- Name: moderation_action_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.moderation_action_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: next_cycle_config; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.next_cycle_config ENABLE ROW LEVEL SECURITY;

--
-- Name: cycle_results public_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY public_read ON public.cycle_results FOR SELECT TO authenticated, anon USING (true);


--
-- Name: voting_cycles public_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY public_read ON public.voting_cycles FOR SELECT TO authenticated, anon USING (true);


--
-- Name: winner_public_profiles public_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY public_read ON public.winner_public_profiles FOR SELECT TO authenticated, anon USING (true);


--
-- Name: rules_meta; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.rules_meta ENABLE ROW LEVEL SECURITY;

--
-- Name: sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: social_verification_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.social_verification_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: sponsor_tracking_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sponsor_tracking_events ENABLE ROW LEVEL SECURITY;

--
-- Name: submission_private_data; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.submission_private_data ENABLE ROW LEVEL SECURITY;

--
-- Name: submission_social_links; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.submission_social_links ENABLE ROW LEVEL SECURITY;

--
-- Name: submission_upload_abuse_states; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.submission_upload_abuse_states ENABLE ROW LEVEL SECURITY;

--
-- Name: submission_upload_operations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.submission_upload_operations ENABLE ROW LEVEL SECURITY;

--
-- Name: submissions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.submissions ENABLE ROW LEVEL SECURITY;

--
-- Name: team_members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;

--
-- Name: upload_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.upload_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: user_cycle_acceptance; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_cycle_acceptance ENABLE ROW LEVEL SECURITY;

--
-- Name: user_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: user_social_links; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_social_links ENABLE ROW LEVEL SECURITY;

--
-- Name: vote_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.vote_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: votes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.votes ENABLE ROW LEVEL SECURITY;

--
-- Name: voting_cycles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.voting_cycles ENABLE ROW LEVEL SECURITY;

--
-- Name: winner_public_profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.winner_public_profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: -
--

REVOKE USAGE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO service_role;
GRANT USAGE ON SCHEMA public TO discord_bot;


--
-- Name: FUNCTION append_discord_reconciliation_chunk(p_event_id text, p_event_type text, p_observed_at timestamp with time zone, p_payload_sha256 text, p_snapshot_id uuid, p_records jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.append_discord_reconciliation_chunk(p_event_id text, p_event_type text, p_observed_at timestamp with time zone, p_payload_sha256 text, p_snapshot_id uuid, p_records jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.append_discord_reconciliation_chunk(p_event_id text, p_event_type text, p_observed_at timestamp with time zone, p_payload_sha256 text, p_snapshot_id uuid, p_records jsonb) TO service_role;


--
-- Name: FUNCTION apply_discord_ban(p_event_id text, p_observed_at timestamp with time zone, p_payload_sha256 text, p_discord_user_id text, p_discord_username text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.apply_discord_ban(p_event_id text, p_observed_at timestamp with time zone, p_payload_sha256 text, p_discord_user_id text, p_discord_username text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.apply_discord_ban(p_event_id text, p_observed_at timestamp with time zone, p_payload_sha256 text, p_discord_user_id text, p_discord_username text) TO service_role;


--
-- Name: FUNCTION apply_discord_live_event(p_event_id text, p_event_type text, p_observed_at timestamp with time zone, p_payload_sha256 text, p_discord_user_id text, p_discord_username text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.apply_discord_live_event(p_event_id text, p_event_type text, p_observed_at timestamp with time zone, p_payload_sha256 text, p_discord_user_id text, p_discord_username text) FROM PUBLIC;


--
-- Name: FUNCTION apply_discord_member_join(p_event_id text, p_observed_at timestamp with time zone, p_payload_sha256 text, p_discord_user_id text, p_discord_username text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.apply_discord_member_join(p_event_id text, p_observed_at timestamp with time zone, p_payload_sha256 text, p_discord_user_id text, p_discord_username text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.apply_discord_member_join(p_event_id text, p_observed_at timestamp with time zone, p_payload_sha256 text, p_discord_user_id text, p_discord_username text) TO service_role;


--
-- Name: FUNCTION apply_discord_member_remove(p_event_id text, p_observed_at timestamp with time zone, p_payload_sha256 text, p_discord_user_id text, p_discord_username text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.apply_discord_member_remove(p_event_id text, p_observed_at timestamp with time zone, p_payload_sha256 text, p_discord_user_id text, p_discord_username text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.apply_discord_member_remove(p_event_id text, p_observed_at timestamp with time zone, p_payload_sha256 text, p_discord_user_id text, p_discord_username text) TO service_role;


--
-- Name: FUNCTION apply_discord_unban(p_event_id text, p_observed_at timestamp with time zone, p_payload_sha256 text, p_discord_user_id text, p_discord_username text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.apply_discord_unban(p_event_id text, p_observed_at timestamp with time zone, p_payload_sha256 text, p_discord_user_id text, p_discord_username text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.apply_discord_unban(p_event_id text, p_observed_at timestamp with time zone, p_payload_sha256 text, p_discord_user_id text, p_discord_username text) TO service_role;


--
-- Name: FUNCTION audit_discord_sync_action(p_action text, p_discord_user_id text, p_meta jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.audit_discord_sync_action(p_action text, p_discord_user_id text, p_meta jsonb) FROM PUBLIC;


--
-- Name: FUNCTION begin_discord_reconciliation_snapshot(p_event_id text, p_observed_at timestamp with time zone, p_payload_sha256 text, p_snapshot_id uuid, p_expected_member_count integer, p_expected_ban_count integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.begin_discord_reconciliation_snapshot(p_event_id text, p_observed_at timestamp with time zone, p_payload_sha256 text, p_snapshot_id uuid, p_expected_member_count integer, p_expected_ban_count integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.begin_discord_reconciliation_snapshot(p_event_id text, p_observed_at timestamp with time zone, p_payload_sha256 text, p_snapshot_id uuid, p_expected_member_count integer, p_expected_ban_count integer) TO service_role;


--
-- Name: FUNCTION cast_cycle_vote(p_cycle_id bigint, p_submission_id bigint, p_discord_user_id text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.cast_cycle_vote(p_cycle_id bigint, p_submission_id bigint, p_discord_user_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.cast_cycle_vote(p_cycle_id bigint, p_submission_id bigint, p_discord_user_id text) TO service_role;


--
-- Name: FUNCTION claim_discord_membership_sync_event(p_event_id text, p_event_type text, p_observed_at timestamp with time zone, p_payload_sha256 text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.claim_discord_membership_sync_event(p_event_id text, p_event_type text, p_observed_at timestamp with time zone, p_payload_sha256 text) FROM PUBLIC;


--
-- Name: FUNCTION claim_media_cleanup_jobs(p_limit integer, p_lease_seconds integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.claim_media_cleanup_jobs(p_limit integer, p_lease_seconds integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.claim_media_cleanup_jobs(p_limit integer, p_lease_seconds integer) TO service_role;


--
-- Name: FUNCTION commit_submission_upload(p_operation_id uuid, p_session_id uuid, p_wallet_address text, p_payout_choice text, p_split_percent integer, p_charity text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.commit_submission_upload(p_operation_id uuid, p_session_id uuid, p_wallet_address text, p_payout_choice text, p_split_percent integer, p_charity text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.commit_submission_upload(p_operation_id uuid, p_session_id uuid, p_wallet_address text, p_payout_choice text, p_split_percent integer, p_charity text) TO service_role;


--
-- Name: FUNCTION complete_media_cleanup_job(p_job_id bigint, p_lease_token uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.complete_media_cleanup_job(p_job_id bigint, p_lease_token uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.complete_media_cleanup_job(p_job_id bigint, p_lease_token uuid) TO service_role;


--
-- Name: FUNCTION create_cancerculture_session(p_session_id uuid, p_discord_user_id text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.create_cancerculture_session(p_session_id uuid, p_discord_user_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.create_cancerculture_session(p_session_id uuid, p_discord_user_id text) TO service_role;


--
-- Name: FUNCTION enforce_discord_authenticated_action(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.enforce_discord_authenticated_action() FROM PUBLIC;


--
-- Name: FUNCTION enforce_discord_ban_submissions(p_discord_user_id text, p_observed_at timestamp with time zone, p_source text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.enforce_discord_ban_submissions(p_discord_user_id text, p_observed_at timestamp with time zone, p_source text) FROM PUBLIC;


--
-- Name: FUNCTION enforce_discord_ban_submissions_trigger(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.enforce_discord_ban_submissions_trigger() FROM PUBLIC;


--
-- Name: FUNCTION enforce_submission_upload_abuse_block(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.enforce_submission_upload_abuse_block() FROM PUBLIC;


--
-- Name: FUNCTION enqueue_deleted_submission_media(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.enqueue_deleted_submission_media() FROM PUBLIC;
GRANT ALL ON FUNCTION public.enqueue_deleted_submission_media() TO service_role;


--
-- Name: FUNCTION enqueue_submission_upload_cleanup(p_operation_id uuid, p_session_id uuid, p_error_code text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.enqueue_submission_upload_cleanup(p_operation_id uuid, p_session_id uuid, p_error_code text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.enqueue_submission_upload_cleanup(p_operation_id uuid, p_session_id uuid, p_error_code text) TO service_role;


--
-- Name: FUNCTION fail_media_cleanup_job(p_job_id bigint, p_lease_token uuid, p_error_code text, p_permanent boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.fail_media_cleanup_job(p_job_id bigint, p_lease_token uuid, p_error_code text, p_permanent boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.fail_media_cleanup_job(p_job_id bigint, p_lease_token uuid, p_error_code text, p_permanent boolean) TO service_role;


--
-- Name: FUNCTION finalize_cycle(p_cycle_id bigint, p_actor_discord_user_id text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.finalize_cycle(p_cycle_id bigint, p_actor_discord_user_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.finalize_cycle(p_cycle_id bigint, p_actor_discord_user_id text) TO service_role;


--
-- Name: FUNCTION finalize_discord_reconciliation_snapshot(p_event_id text, p_observed_at timestamp with time zone, p_payload_sha256 text, p_snapshot_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.finalize_discord_reconciliation_snapshot(p_event_id text, p_observed_at timestamp with time zone, p_payload_sha256 text, p_snapshot_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.finalize_discord_reconciliation_snapshot(p_event_id text, p_observed_at timestamp with time zone, p_payload_sha256 text, p_snapshot_id uuid) TO service_role;


--
-- Name: FUNCTION finish_discord_membership_sync_event(p_event_id text, p_result_status text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.finish_discord_membership_sync_event(p_event_id text, p_result_status text) FROM PUBLIC;


--
-- Name: FUNCTION get_cancerculture_session_access(p_session_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_cancerculture_session_access(p_session_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_cancerculture_session_access(p_session_id uuid) TO service_role;


--
-- Name: FUNCTION get_submission_upload_abuse_status(p_session_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_submission_upload_abuse_status(p_session_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_submission_upload_abuse_status(p_session_id uuid) TO service_role;


--
-- Name: FUNCTION mark_submission_upload_r2_uploaded(p_operation_id uuid, p_session_id uuid, p_r2_etag text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.mark_submission_upload_r2_uploaded(p_operation_id uuid, p_session_id uuid, p_r2_etag text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.mark_submission_upload_r2_uploaded(p_operation_id uuid, p_session_id uuid, p_r2_etag text) TO service_role;


--
-- Name: FUNCTION media_cleanup_retry_delay(p_attempt integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.media_cleanup_retry_delay(p_attempt integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.media_cleanup_retry_delay(p_attempt integer) TO service_role;


--
-- Name: FUNCTION process_due_cycle_transitions(p_cycle_id bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.process_due_cycle_transitions(p_cycle_id bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.process_due_cycle_transitions(p_cycle_id bigint) TO service_role;


--
-- Name: FUNCTION protect_discord_ban_republish(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.protect_discord_ban_republish() FROM PUBLIC;


--
-- Name: FUNCTION record_discord_reconciliation_failure(p_event_id text, p_observed_at timestamp with time zone, p_payload_sha256 text, p_error_code text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.record_discord_reconciliation_failure(p_event_id text, p_observed_at timestamp with time zone, p_payload_sha256 text, p_error_code text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.record_discord_reconciliation_failure(p_event_id text, p_observed_at timestamp with time zone, p_payload_sha256 text, p_error_code text) TO service_role;


--
-- Name: FUNCTION recover_stale_submission_uploads(p_limit integer, p_stale_after_seconds integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.recover_stale_submission_uploads(p_limit integer, p_stale_after_seconds integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.recover_stale_submission_uploads(p_limit integer, p_stale_after_seconds integer) TO service_role;


--
-- Name: FUNCTION register_invalid_submission_upload(p_session_id uuid, p_cycle_id bigint, p_error_code text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.register_invalid_submission_upload(p_session_id uuid, p_cycle_id bigint, p_error_code text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.register_invalid_submission_upload(p_session_id uuid, p_cycle_id bigint, p_error_code text) TO service_role;


--
-- Name: FUNCTION republish_discord_ban_submission(p_submission_id bigint, p_actor_discord_user_id text, p_reason text, p_manual_review_confirmed boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.republish_discord_ban_submission(p_submission_id bigint, p_actor_discord_user_id text, p_reason text, p_manual_review_confirmed boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.republish_discord_ban_submission(p_submission_id bigint, p_actor_discord_user_id text, p_reason text, p_manual_review_confirmed boolean) TO service_role;


--
-- Name: FUNCTION reserve_submission_upload(p_session_id uuid, p_idempotency_key uuid, p_request_fingerprint text, p_content_sha256 text, p_media_type text, p_media_bytes integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.reserve_submission_upload(p_session_id uuid, p_idempotency_key uuid, p_request_fingerprint text, p_content_sha256 text, p_media_type text, p_media_bytes integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.reserve_submission_upload(p_session_id uuid, p_idempotency_key uuid, p_request_fingerprint text, p_content_sha256 text, p_media_type text, p_media_bytes integer) TO service_role;


--
-- Name: FUNCTION reset_cycle(p_cycle_id bigint, p_actor_discord_user_id text, p_reason text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.reset_cycle(p_cycle_id bigint, p_actor_discord_user_id text, p_reason text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.reset_cycle(p_cycle_id bigint, p_actor_discord_user_id text, p_reason text) TO service_role;


--
-- Name: FUNCTION start_cycle(p_cycle_id bigint, p_actor_discord_user_id text, p_settings jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.start_cycle(p_cycle_id bigint, p_actor_discord_user_id text, p_settings jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.start_cycle(p_cycle_id bigint, p_actor_discord_user_id text, p_settings jsonb) TO service_role;


--
-- Name: FUNCTION submission_upload_error_code(p_error_code text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.submission_upload_error_code(p_error_code text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.submission_upload_error_code(p_error_code text) TO service_role;


--
-- Name: FUNCTION sync_discord_user_context(p_discord_user_id text, p_discord_handle text, p_display_name text, p_guild_nickname text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.sync_discord_user_context(p_discord_user_id text, p_discord_handle text, p_display_name text, p_guild_nickname text) TO discord_bot;


--
-- Name: FUNCTION unblock_submission_upload(p_discord_user_id text, p_cycle_id bigint, p_actor_discord_user_id text, p_reason text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.unblock_submission_upload(p_discord_user_id text, p_cycle_id bigint, p_actor_discord_user_id text, p_reason text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.unblock_submission_upload(p_discord_user_id text, p_cycle_id bigint, p_actor_discord_user_id text, p_reason text) TO service_role;


--
-- Name: TABLE admin_action_logs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.admin_action_logs TO service_role;


--
-- Name: TABLE admin_invites; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.admin_invites TO service_role;


--
-- Name: TABLE app_config; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.app_config TO service_role;


--
-- Name: TABLE avatar_upload_logs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.avatar_upload_logs TO service_role;


--
-- Name: SEQUENCE avatar_upload_logs_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.avatar_upload_logs_id_seq TO service_role;


--
-- Name: TABLE blocked_cycle_events; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.blocked_cycle_events TO service_role;


--
-- Name: TABLE blocked_user_meta; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.blocked_user_meta TO service_role;


--
-- Name: TABLE coin_launches; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.coin_launches TO service_role;


--
-- Name: SEQUENCE coin_launches_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.coin_launches_id_seq TO service_role;


--
-- Name: TABLE cycle_events; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.cycle_events TO service_role;


--
-- Name: TABLE cycle_reminders; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.cycle_reminders TO service_role;


--
-- Name: TABLE cycle_results; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.cycle_results TO service_role;


--
-- Name: SEQUENCE cycle_results_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.cycle_results_id_seq TO service_role;


--
-- Name: TABLE cycle_rule_templates; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.cycle_rule_templates TO service_role;


--
-- Name: SEQUENCE cycle_rule_templates_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.cycle_rule_templates_id_seq TO service_role;


--
-- Name: TABLE cycle_sponsorships; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.cycle_sponsorships TO service_role;


--
-- Name: SEQUENCE cycle_sponsorships_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.cycle_sponsorships_id_seq TO service_role;


--
-- Name: TABLE discord_guard_logs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.discord_guard_logs TO service_role;
GRANT INSERT ON TABLE public.discord_guard_logs TO discord_bot;


--
-- Name: SEQUENCE discord_guard_logs_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.discord_guard_logs_id_seq TO service_role;
GRANT SELECT,USAGE ON SEQUENCE public.discord_guard_logs_id_seq TO discord_bot;


--
-- Name: TABLE discord_member_state; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.discord_member_state TO service_role;


--
-- Name: TABLE discord_membership_sync_events; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.discord_membership_sync_events TO service_role;


--
-- Name: TABLE discord_reconciliation_bans; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.discord_reconciliation_bans TO service_role;


--
-- Name: TABLE discord_reconciliation_members; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.discord_reconciliation_members TO service_role;


--
-- Name: TABLE discord_reconciliation_snapshots; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.discord_reconciliation_snapshots TO service_role;


--
-- Name: TABLE discord_sync_health; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.discord_sync_health TO service_role;


--
-- Name: TABLE invite_auth_logs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.invite_auth_logs TO service_role;


--
-- Name: SEQUENCE invite_auth_logs_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.invite_auth_logs_id_seq TO service_role;


--
-- Name: TABLE media_cleanup_queue; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.media_cleanup_queue TO service_role;


--
-- Name: SEQUENCE media_cleanup_queue_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.media_cleanup_queue_id_seq TO service_role;


--
-- Name: TABLE moderation_action_logs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.moderation_action_logs TO service_role;


--
-- Name: TABLE next_cycle_config; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.next_cycle_config TO service_role;


--
-- Name: TABLE submissions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.submissions TO service_role;


--
-- Name: TABLE votes; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.votes TO service_role;


--
-- Name: TABLE public_submissions_with_votes; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.public_submissions_with_votes TO service_role;


--
-- Name: TABLE rules_meta; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.rules_meta TO service_role;


--
-- Name: TABLE sessions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.sessions TO service_role;


--
-- Name: TABLE social_verification_logs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.social_verification_logs TO service_role;


--
-- Name: SEQUENCE social_verification_logs_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.social_verification_logs_id_seq TO service_role;


--
-- Name: TABLE sponsor_tracking_events; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.sponsor_tracking_events TO service_role;


--
-- Name: SEQUENCE sponsor_tracking_events_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.sponsor_tracking_events_id_seq TO service_role;


--
-- Name: TABLE submission_private_data; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.submission_private_data TO service_role;


--
-- Name: SEQUENCE submission_private_data_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.submission_private_data_id_seq TO service_role;


--
-- Name: TABLE submission_social_links; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.submission_social_links TO service_role;


--
-- Name: SEQUENCE submission_social_links_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.submission_social_links_id_seq TO service_role;


--
-- Name: TABLE submission_upload_abuse_states; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.submission_upload_abuse_states TO service_role;


--
-- Name: TABLE submission_upload_operations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.submission_upload_operations TO service_role;


--
-- Name: SEQUENCE submissions_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.submissions_id_seq TO service_role;


--
-- Name: TABLE submissions_with_votes; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.submissions_with_votes TO service_role;


--
-- Name: TABLE team_members; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.team_members TO service_role;


--
-- Name: TABLE upload_logs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.upload_logs TO service_role;


--
-- Name: TABLE user_cycle_acceptance; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.user_cycle_acceptance TO service_role;


--
-- Name: TABLE user_logs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.user_logs TO service_role;


--
-- Name: TABLE user_logs_with_stats; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.user_logs_with_stats TO service_role;


--
-- Name: TABLE user_social_links; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.user_social_links TO service_role;


--
-- Name: SEQUENCE user_social_links_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.user_social_links_id_seq TO service_role;


--
-- Name: TABLE vote_logs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.vote_logs TO service_role;


--
-- Name: SEQUENCE votes_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.votes_id_seq TO service_role;


--
-- Name: TABLE voting_cycles; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.voting_cycles TO service_role;


--
-- Name: SEQUENCE voting_cycles_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.voting_cycles_id_seq TO service_role;


--
-- Name: TABLE winner_public_profiles; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.winner_public_profiles TO service_role;


--
-- Name: SEQUENCE winner_public_profiles_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.winner_public_profiles_id_seq TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- PostgreSQL database dump complete
--
