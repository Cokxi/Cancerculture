\set ON_ERROR_STOP on

begin;

do $$
declare
  v_cycle_a bigint;
  v_cycle_b constant bigint := 9300000002;
  v_user_a constant text := 'codex-upload-abuse-user-a';
  v_user_b constant text := 'codex-upload-abuse-user-b';
  v_session_a constant uuid := '93000000-0000-4000-8000-000000000001';
  v_session_b constant uuid := '93000000-0000-4000-8000-000000000002';
  v_admin_id text;
  v_rules_version integer;
  v_result jsonb;
  v_attempt integer;
begin
  if exists (
    select 1 from public.voting_cycles where id = v_cycle_b
  ) or exists (
    select 1 from public.user_logs where discord_user_id like 'codex-upload-abuse-%'
  ) then
    raise exception 'UPLOAD_ABUSE_TEST_FIXTURE_COLLISION';
  end if;

  select current_version into v_rules_version
  from public.rules_meta where id = 1;
  select id into v_cycle_a
  from public.voting_cycles
  where status::text in ('submission_open', 'active')
  order by id desc limit 1;
  select discord_user_id into v_admin_id
  from public.team_members where role = 'admin'
  order by created_at limit 1;
  if v_rules_version is null or v_admin_id is null or v_cycle_a is null then
    raise exception 'UPLOAD_ABUSE_TEST_DEPENDENCY_MISSING';
  end if;

  insert into public.user_logs (
    discord_user_id, current_discord_username, accepted_rules_version
  ) values
    (v_user_a, 'codex-abuse-a', v_rules_version),
    (v_user_b, 'codex-abuse-b', v_rules_version);
  insert into public.discord_member_state (
    discord_user_id, current_discord_username, discord_joined_at, is_in_discord
  ) values
    (v_user_a, 'codex-abuse-a', transaction_timestamp() - interval '1 day', true),
    (v_user_b, 'codex-abuse-b', transaction_timestamp() - interval '1 day', true);
  insert into public.sessions (id, discord_user_id)
  values (v_session_a, v_user_a), (v_session_b, v_user_b);

  v_result := public.get_submission_upload_abuse_status(v_session_a);
  if v_result ->> 'outcome' <> 'status'
    or (v_result ->> 'blocked')::boolean
    or (v_result ->> 'invalidAttemptCount')::integer <> 0
  then
    raise exception 'INITIAL_ABUSE_STATUS_INVALID: %', v_result;
  end if;

  v_result := public.register_invalid_submission_upload(
    v_session_a, v_cycle_a, 'R2_PROVIDER_ERROR'
  );
  if v_result ->> 'outcome' <> 'not_countable'
    or exists (
      select 1 from public.submission_upload_abuse_states
      where discord_user_id = v_user_a and cycle_id = v_cycle_a
    )
  then
    raise exception 'NON_MEDIA_FAILURE_WAS_COUNTED: %', v_result;
  end if;

  for v_attempt in 1..4 loop
    v_result := public.register_invalid_submission_upload(
      v_session_a, v_cycle_a, 'MEDIA_CORRUPT'
    );
    if v_result ->> 'outcome' <> 'counted'
      or (v_result ->> 'invalidAttemptCount')::integer <> v_attempt
      or (v_result ->> 'blocked')::boolean
    then
      raise exception 'ATTEMPT_NOT_COUNTED_AT_%: %', v_attempt, v_result;
    end if;
  end loop;

  v_result := public.register_invalid_submission_upload(
    v_session_a, v_cycle_a, 'MEDIA_PIXEL_LIMIT_EXCEEDED'
  );
  if v_result ->> 'outcome' <> 'blocked'
    or not (v_result ->> 'blocked')::boolean
    or (v_result ->> 'invalidAttemptCount')::integer <> 5
  then
    raise exception 'FIFTH_ATTEMPT_DID_NOT_BLOCK: %', v_result;
  end if;

  v_result := public.register_invalid_submission_upload(
    v_session_a, v_cycle_a, 'MEDIA_CORRUPT'
  );
  if v_result ->> 'outcome' <> 'already_blocked' then
    raise exception 'SIXTH_ATTEMPT_NOT_EARLY_BLOCKED: %', v_result;
  end if;

  begin
    v_result := public.reserve_submission_upload(
      v_session_a,
      '93000000-0000-4000-8000-000000000011',
      repeat('a', 64), repeat('b', 64), 'image/webp', 100
    );
    raise exception 'BLOCKED_RESERVATION_RETURNED: %', v_result;
  exception
    when raise_exception then
      if sqlerrm <> 'UPLOAD_BLOCKED_FOR_CYCLE' then
        raise;
      end if;
  end;
  if exists (
    select 1 from public.submission_upload_operations
    where discord_user_id = v_user_a and cycle_id = v_cycle_a
  ) then
    raise exception 'BLOCKED_RESERVATION_CREATED_INTENT';
  end if;

  v_result := public.register_invalid_submission_upload(
    v_session_b, v_cycle_a, 'MEDIA_CORRUPT'
  );
  if (v_result ->> 'invalidAttemptCount')::integer <> 1
    or exists (
      select 1 from public.submission_upload_abuse_states
      where discord_user_id = v_user_b and cycle_id = v_cycle_a and blocked_at is not null
    )
  then
    raise exception 'INDEPENDENT_USER_AFFECTED';
  end if;

  v_result := public.unblock_submission_upload(
    v_user_a, v_cycle_a, v_admin_id, ''
  );
  if v_result ->> 'outcome' <> 'invalid_request' then
    raise exception 'EMPTY_UNBLOCK_REASON_ACCEPTED';
  end if;
  v_result := public.unblock_submission_upload(
    v_user_a, v_cycle_a, v_user_b, 'unauthorized test'
  );
  if v_result ->> 'outcome' <> 'forbidden' then
    raise exception 'UNAUTHORIZED_UNBLOCK_ACCEPTED';
  end if;
  v_result := public.unblock_submission_upload(
    v_user_a, v_cycle_a, v_admin_id, 'controlled DEV test unblock'
  );
  if v_result ->> 'outcome' <> 'unblocked' then
    raise exception 'ADMIN_UNBLOCK_FAILED: %', v_result;
  end if;
  if not exists (
    select 1
    from public.submission_upload_abuse_states
    where discord_user_id = v_user_a
      and cycle_id = v_cycle_a
      and invalid_attempt_count = 0
      and total_invalid_attempt_count = 5
      and block_count = 1
      and blocked_at is null
      and unblocked_at is not null
      and unblock_reason = 'controlled DEV test unblock'
  ) or not exists (
    select 1 from public.admin_action_logs
    where actor_id = v_admin_id
      and action = 'submission_upload_cycle_unblocked'
      and target_id = v_user_a
      and (meta ->> 'cycleId')::bigint = v_cycle_a
  ) then
    raise exception 'UNBLOCK_STATE_OR_AUDIT_MISSING';
  end if;
  v_result := public.unblock_submission_upload(
    v_user_a, v_cycle_a, v_admin_id, 'safe replay'
  );
  if v_result ->> 'outcome' <> 'already_unblocked' then
    raise exception 'REPEATED_UNBLOCK_NOT_SAFE: %', v_result;
  end if;

  v_result := public.reserve_submission_upload(
    v_session_a,
    '93000000-0000-4000-8000-000000000012',
    repeat('c', 64), repeat('d', 64), 'image/webp', 100
  );
  if v_result ->> 'outcome' <> 'reserved' then
    raise exception 'UNBLOCKED_USER_COULD_NOT_RESERVE: %', v_result;
  end if;

  update public.voting_cycles set status = 'archived' where id = v_cycle_a;
  insert into public.voting_cycles (
    id, status, starts_at, submission_starts_at, votes_per_user, allow_self_vote
  ) values (
    v_cycle_b, 'submission_open', transaction_timestamp(), transaction_timestamp(), 2, false
  );
  v_result := public.get_submission_upload_abuse_status(v_session_a);
  if (v_result ->> 'cycleId')::bigint <> v_cycle_b
    or (v_result ->> 'blocked')::boolean
    or (v_result ->> 'invalidAttemptCount')::integer <> 0
  then
    raise exception 'NEW_CYCLE_INHERITED_BLOCK: %', v_result;
  end if;
  update public.voting_cycles set status = 'submission_closed' where id = v_cycle_b;
  v_result := public.register_invalid_submission_upload(
    v_session_a, v_cycle_b, 'MEDIA_CORRUPT'
  );
  if v_result ->> 'outcome' <> 'cycle_not_open' then
    raise exception 'CLOSED_CYCLE_FAILURE_COUNTED: %', v_result;
  end if;
end;
$$;

do $$
declare
  v_bad_count integer;
begin
  select count(*) into v_bad_count
  from information_schema.routine_privileges
  where specific_schema = 'public'
    and routine_name in (
      'get_submission_upload_abuse_status',
      'register_invalid_submission_upload',
      'unblock_submission_upload'
    )
    and grantee in ('PUBLIC', 'anon', 'authenticated');
  if v_bad_count <> 0 then
    raise exception 'UPLOAD_ABUSE_RPC_PRIVILEGES_TOO_BROAD';
  end if;
end;
$$;

rollback;
