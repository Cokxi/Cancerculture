\set ON_ERROR_STOP on

begin;

do $guard$
begin
  if exists (
    select 1
    from public.voting_cycles
    where status::text in (
      'draft', 'active', 'submission_open', 'submission_closed', 'voting_open',
      'voting_closed', 'paused', 'finalizing'
    )
  ) then
    raise exception 'DEV_DYNAMIC_QUOTA_REQUIRES_NO_CURRENT_CYCLE';
  end if;
end;
$guard$;

do $contract$
declare
  v_cycle_id constant bigint := 9200000020;
  v_user constant text := 'codex-dynamic-quota-user';
  v_session constant uuid := '95000000-0000-4000-8000-000000000020';
  v_rules_version integer;
  v_idempotency_key uuid;
  v_operation_id uuid;
  v_fingerprint text;
  v_content_hash text;
  v_result jsonb;
  v_submission_number integer;
begin
  if exists (
    select 1 from public.voting_cycles where id = v_cycle_id
  ) or exists (
    select 1 from public.user_logs where discord_user_id = v_user
  ) then
    raise exception 'DEV_DYNAMIC_QUOTA_FIXTURE_COLLISION';
  end if;

  select current_version
  into v_rules_version
  from public.rules_meta
  where id = 1;

  insert into public.voting_cycles (
    id,
    status,
    starts_at,
    submission_starts_at,
    votes_per_user,
    submissions_per_user,
    upload_success_cooldown_seconds,
    allow_self_vote
  ) values (
    v_cycle_id,
    'submission_open',
    clock_timestamp() - interval '1 hour',
    clock_timestamp() - interval '1 hour',
    50,
    20,
    30,
    false
  );

  insert into public.user_logs (
    discord_user_id,
    current_discord_username,
    accepted_rules_version
  ) values (v_user, 'codex-dynamic-quota', v_rules_version);

  insert into public.discord_member_state (
    discord_user_id,
    current_discord_username,
    discord_joined_at,
    is_in_discord
  ) values (
    v_user,
    'codex-dynamic-quota',
    clock_timestamp() - interval '1 day',
    true
  );

  insert into public.sessions (id, discord_user_id)
  values (v_session, v_user);

  for v_submission_number in 1..20 loop
    v_idempotency_key := gen_random_uuid();
    v_fingerprint := encode(
      digest('quota-fingerprint-' || v_submission_number::text, 'sha256'),
      'hex'
    );
    v_content_hash := encode(
      digest('quota-content-' || v_submission_number::text, 'sha256'),
      'hex'
    );

    v_result := public.reserve_submission_upload(
      v_session,
      v_idempotency_key,
      v_fingerprint,
      v_content_hash,
      'image/webp',
      100
    );
    if v_result ->> 'outcome' <> 'reserved' then
      raise exception 'SEQUENTIAL_QUOTA_RESERVE_%_FAILED: %',
        v_submission_number,
        v_result;
    end if;

    v_operation_id := (v_result ->> 'operationId')::uuid;
    perform public.mark_submission_upload_r2_uploaded(
      v_operation_id,
      v_session,
      null
    );

    v_result := public.commit_submission_upload(
      v_operation_id,
      v_session,
      'quota-wallet-' || v_submission_number::text,
      'keep',
      null,
      null
    );
    if v_result ->> 'outcome' <> 'completed'
      or (v_result ->> 'used')::integer <> v_submission_number
      or (v_result ->> 'limit')::integer <> 20
      or (v_result ->> 'remaining')::integer <>
        20 - v_submission_number
    then
      raise exception 'SEQUENTIAL_QUOTA_COMMIT_%_FAILED: %',
        v_submission_number,
        v_result;
    end if;

    if v_submission_number = 1 then
      v_result := public.reserve_submission_upload(
        v_session,
        v_idempotency_key,
        v_fingerprint,
        v_content_hash,
        'image/webp',
        100
      );
      if v_result ->> 'outcome' <> 'already_completed' then
        raise exception 'COOLDOWN_BROKE_COMPLETED_REPLAY: %', v_result;
      end if;
    end if;

    if v_submission_number < 20 then
      update public.submission_upload_operations
      set completed_at = clock_timestamp() - interval '31 seconds'
      where id = v_operation_id;
    end if;
  end loop;

  v_result := public.reserve_submission_upload(
    v_session,
    gen_random_uuid(),
    repeat('a', 64),
    repeat('b', 64),
    'image/webp',
    100
  );
  if v_result ->> 'outcome' <> 'upload_limit_reached' then
    raise exception 'TWENTY_FIRST_UPLOAD_WAS_NOT_REJECTED: %', v_result;
  end if;

  v_result := public.get_submission_upload_quota(v_cycle_id, v_user);
  if (v_result ->> 'used')::integer <> 20
    or (v_result ->> 'limit')::integer <> 20
    or (v_result ->> 'remaining')::integer <> 0
    or (v_result ->> 'cooldownRemainingSeconds')::integer <> 0
  then
    raise exception 'FINAL_QUOTA_PROJECTION_INVALID: %', v_result;
  end if;
end;
$contract$;

rollback;
