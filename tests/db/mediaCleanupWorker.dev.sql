\set ON_ERROR_STOP on

begin;

do $$
declare
  v_claim record;
  v_result jsonb;
  v_count integer;
  v_old_token constant uuid := '10000000-0000-4000-8000-000000000003';
  v_active_token constant uuid := '10000000-0000-4000-8000-000000000004';
  v_expired_token constant uuid := '10000000-0000-4000-8000-000000000005';
begin
  if exists (
    select 1
    from public.media_cleanup_queue
    where id between 2100000001 and 2100000999
  ) then
    raise exception 'MEDIA_CLEANUP_TEST_ID_COLLISION';
  end if;

  if public.media_cleanup_retry_delay(1) <> interval '1 minute'
    or public.media_cleanup_retry_delay(2) <> interval '5 minutes'
    or public.media_cleanup_retry_delay(3) <> interval '15 minutes'
    or public.media_cleanup_retry_delay(4) <> interval '1 hour'
    or public.media_cleanup_retry_delay(5) <> interval '6 hours'
    or public.media_cleanup_retry_delay(6) <> interval '24 hours'
    or public.media_cleanup_retry_delay(7) is not null
  then
    raise exception 'MEDIA_CLEANUP_BACKOFF_SCHEDULE_INVALID';
  end if;

  -- Pending claim, active-lease protection, stale token, completion, replay.
  insert into public.media_cleanup_queue (
    id, storage_provider, storage_key, reason, status
  ) overriding system value values (
    2100000001,
    'r2',
    'codex-tests/media-cleanup/pending.webp',
    'codex_media_cleanup_worker_test',
    'pending'
  );

  select *
  into v_claim
  from public.claim_media_cleanup_jobs(1, 120);

  if v_claim.job_id <> 2100000001
    or v_claim.attempt_count <> 1
    or v_claim.lease_token is null
    or not exists (
      select 1
      from public.media_cleanup_queue
      where id = 2100000001
        and status = 'processing'
        and attempts = 1
        and last_attempt_at = transaction_timestamp()
        and next_attempt_at is null
    )
  then
    raise exception 'PENDING_JOB_CLAIM_FAILED';
  end if;

  select count(*)::integer
  into v_count
  from public.claim_media_cleanup_jobs(1, 120);

  if v_count <> 0 then
    raise exception 'ACTIVE_LEASE_WAS_STOLEN';
  end if;

  v_result := public.complete_media_cleanup_job(
    2100000001,
    'ffffffff-ffff-4fff-8fff-ffffffffffff'
  );

  if v_result ->> 'outcome' <> 'stale_lease' then
    raise exception 'WRONG_COMPLETION_TOKEN_WAS_ACCEPTED: %', v_result;
  end if;

  v_result := public.complete_media_cleanup_job(
    2100000001,
    v_claim.lease_token
  );

  if v_result ->> 'outcome' <> 'completed'
    or not exists (
      select 1
      from public.media_cleanup_queue
      where id = 2100000001
        and status = 'completed'
        and processed_at = transaction_timestamp()
        and attempts = 1
        and lease_token is null
        and locked_until is null
    )
  then
    raise exception 'LEASE_COMPLETION_FAILED: %', v_result;
  end if;

  v_result := public.complete_media_cleanup_job(
    2100000001,
    v_claim.lease_token
  );

  if v_result ->> 'outcome' <> 'stale_lease' then
    raise exception 'COMPLETION_REPLAY_WAS_NOT_NOOP: %', v_result;
  end if;

  -- Future failed job is not due; due retry gets attempt 2 and five minutes.
  insert into public.media_cleanup_queue (
    id,
    storage_provider,
    storage_key,
    reason,
    status,
    attempts,
    next_attempt_at,
    last_error_code
  ) overriding system value values (
    2100000002,
    'r2',
    'codex-tests/media-cleanup/retry.webp',
    'codex_media_cleanup_worker_test',
    'failed',
    1,
    transaction_timestamp() + interval '1 hour',
    'ServiceUnavailable'
  );

  select count(*)::integer
  into v_count
  from public.claim_media_cleanup_jobs(1, 120);

  if v_count <> 0 then
    raise exception 'NOT_DUE_FAILED_JOB_WAS_CLAIMED';
  end if;

  update public.media_cleanup_queue
  set next_attempt_at = transaction_timestamp() - interval '1 second'
  where id = 2100000002;

  select *
  into v_claim
  from public.claim_media_cleanup_jobs(1, 120);

  if v_claim.job_id <> 2100000002 or v_claim.attempt_count <> 2 then
    raise exception 'DUE_FAILED_JOB_WAS_NOT_RECLAIMED';
  end if;

  v_result := public.fail_media_cleanup_job(
    2100000002,
    v_claim.lease_token,
    repeat('provider secret response! ', 20),
    false
  );

  if v_result ->> 'outcome' <> 'retry_scheduled'
    or not exists (
      select 1
      from public.media_cleanup_queue
      where id = 2100000002
        and status = 'failed'
        and attempts = 2
        and next_attempt_at = transaction_timestamp() + interval '5 minutes'
        and length(last_error_code) = 120
        and last_error_code ~ '^[A-Za-z0-9_.-]+$'
        and lease_token is null
    )
  then
    raise exception 'FAILED_JOB_BACKOFF_OR_SANITIZATION_INVALID: %', v_result;
  end if;

  select count(*)::integer
  into v_count
  from public.claim_media_cleanup_jobs(1, 120);

  if v_count <> 0 then
    raise exception 'BACKOFF_JOB_WAS_RECLAIMED_TOO_EARLY';
  end if;

  update public.media_cleanup_queue
  set next_attempt_at = transaction_timestamp() - interval '1 second'
  where id = 2100000002;

  select *
  into v_claim
  from public.claim_media_cleanup_jobs(1, 120);

  if v_claim.attempt_count <> 3 then
    raise exception 'RETRY_ATTEMPT_COUNT_INVALID';
  end if;

  v_result := public.complete_media_cleanup_job(
    2100000002,
    v_claim.lease_token
  );

  if v_result ->> 'outcome' <> 'completed' then
    raise exception 'RETRIED_JOB_DID_NOT_COMPLETE';
  end if;

  -- Expired processing lease is reclaimed with a new token and one attempt.
  insert into public.media_cleanup_queue (
    id,
    storage_provider,
    storage_key,
    reason,
    status,
    attempts,
    next_attempt_at,
    locked_at,
    locked_until,
    lease_token,
    last_attempt_at
  ) overriding system value values (
    2100000003,
    'r2',
    'codex-tests/media-cleanup/expired.webp',
    'codex_media_cleanup_worker_test',
    'processing',
    1,
    null,
    transaction_timestamp() - interval '10 minutes',
    transaction_timestamp() - interval '1 minute',
    v_old_token,
    transaction_timestamp() - interval '10 minutes'
  );

  select *
  into v_claim
  from public.claim_media_cleanup_jobs(1, 120);

  if v_claim.job_id <> 2100000003
    or v_claim.attempt_count <> 2
    or v_claim.lease_token = v_old_token
  then
    raise exception 'EXPIRED_LEASE_WAS_NOT_RECLAIMED';
  end if;

  v_result := public.complete_media_cleanup_job(2100000003, v_old_token);

  if v_result ->> 'outcome' <> 'stale_lease' then
    raise exception 'OLD_WORKER_COMPLETED_RECLAIMED_JOB';
  end if;

  v_result := public.fail_media_cleanup_job(
    2100000003,
    v_claim.lease_token,
    'ServiceUnavailable',
    false
  );

  if v_result ->> 'outcome' <> 'retry_scheduled' then
    raise exception 'RECLAIMED_JOB_FAILURE_NOT_SCHEDULED';
  end if;

  -- A live processing lease remains untouched.
  insert into public.media_cleanup_queue (
    id,
    storage_provider,
    storage_key,
    reason,
    status,
    attempts,
    next_attempt_at,
    locked_at,
    locked_until,
    lease_token,
    last_attempt_at
  ) overriding system value values (
    2100000004,
    'r2',
    'codex-tests/media-cleanup/active.webp',
    'codex_media_cleanup_worker_test',
    'processing',
    1,
    null,
    transaction_timestamp(),
    transaction_timestamp() + interval '2 minutes',
    v_active_token,
    transaction_timestamp()
  );

  select count(*)::integer
  into v_count
  from public.claim_media_cleanup_jobs(1, 120);

  if v_count <> 0
    or not exists (
      select 1
      from public.media_cleanup_queue
      where id = 2100000004
        and status = 'processing'
        and lease_token = v_active_token
        and attempts = 1
    )
  then
    raise exception 'LIVE_LEASE_WAS_CHANGED';
  end if;

  -- An expired token is stale even before another worker reclaims it.
  insert into public.media_cleanup_queue (
    id,
    storage_provider,
    storage_key,
    reason,
    status,
    attempts,
    next_attempt_at,
    locked_at,
    locked_until,
    lease_token,
    last_attempt_at
  ) overriding system value values (
    2100000005,
    'r2',
    'codex-tests/media-cleanup/stale-before-reclaim.webp',
    'codex_media_cleanup_worker_test',
    'processing',
    1,
    null,
    transaction_timestamp() - interval '2 minutes',
    transaction_timestamp() - interval '1 minute',
    v_expired_token,
    transaction_timestamp() - interval '2 minutes'
  );

  v_result := public.complete_media_cleanup_job(
    2100000005,
    v_expired_token
  );

  if v_result ->> 'outcome' <> 'stale_lease' then
    raise exception 'EXPIRED_UNRECLAIMED_LEASE_ACCEPTED_RESULT';
  end if;

  update public.media_cleanup_queue
  set
    status = 'dead',
    next_attempt_at = null,
    locked_at = null,
    locked_until = null,
    lease_token = null,
    last_error_code = 'TEST_TERMINAL'
  where id = 2100000005;

  -- Attempt seven and explicit permanent failures are terminal.
  insert into public.media_cleanup_queue (
    id,
    storage_provider,
    storage_key,
    reason,
    status,
    attempts,
    next_attempt_at,
    last_error_code
  ) overriding system value values (
    2100000006,
    'r2',
    'codex-tests/media-cleanup/max-attempt.webp',
    'codex_media_cleanup_worker_test',
    'failed',
    6,
    transaction_timestamp() - interval '1 second',
    'ServiceUnavailable'
  );

  select *
  into v_claim
  from public.claim_media_cleanup_jobs(1, 120);

  if v_claim.job_id <> 2100000006 or v_claim.attempt_count <> 7 then
    raise exception 'SEVENTH_ATTEMPT_NOT_CLAIMED';
  end if;

  v_result := public.fail_media_cleanup_job(
    2100000006,
    v_claim.lease_token,
    'ServiceUnavailable',
    false
  );

  if v_result ->> 'outcome' <> 'terminal_failure'
    or not exists (
      select 1
      from public.media_cleanup_queue
      where id = 2100000006
        and status = 'dead'
        and next_attempt_at is null
    )
  then
    raise exception 'MAX_ATTEMPT_DID_NOT_BECOME_TERMINAL';
  end if;

  insert into public.media_cleanup_queue (
    id, storage_provider, storage_key, reason, status
  ) overriding system value values (
    2100000007,
    'r2',
    'codex-tests/media-cleanup/permanent.webp',
    'codex_media_cleanup_worker_test',
    'pending'
  );

  select *
  into v_claim
  from public.claim_media_cleanup_jobs(1, 120);

  v_result := public.fail_media_cleanup_job(
    2100000007,
    v_claim.lease_token,
    'INVALID_STORAGE_KEY',
    true
  );

  if v_result ->> 'outcome' <> 'terminal_failure' then
    raise exception 'PERMANENT_FAILURE_WAS_RETRIED';
  end if;

  -- Hard batch maximum: 20 may be claimed, 21 is rejected.
  insert into public.media_cleanup_queue (
    id, storage_provider, storage_key, reason, status
  ) overriding system value
  select
    2100000100 + series,
    'r2',
    'codex-tests/media-cleanup/batch-' || series::text || '.webp',
    'codex_media_cleanup_worker_test',
    'pending'
  from generate_series(1, 25) series;

  select count(*)::integer
  into v_count
  from public.claim_media_cleanup_jobs(20, 120);

  if v_count <> 20
    or (select count(*) from public.media_cleanup_queue where id between 2100000101 and 2100000125 and status = 'pending') <> 5
  then
    raise exception 'MEDIA_CLEANUP_BATCH_LIMIT_NOT_ENFORCED';
  end if;

  begin
    perform public.claim_media_cleanup_jobs(21, 120);
    raise exception 'OVERSIZED_MEDIA_CLEANUP_BATCH_ACCEPTED';
  exception
    when others then
      if sqlerrm <> 'INVALID_MEDIA_CLEANUP_BATCH_SIZE' then
        raise;
      end if;
  end;

  if has_function_privilege(
    'anon',
    'public.claim_media_cleanup_jobs(integer,integer)',
    'execute'
  )
    or has_function_privilege(
      'authenticated',
      'public.complete_media_cleanup_job(bigint,uuid)',
      'execute'
    )
    or has_function_privilege(
      'authenticated',
      'public.fail_media_cleanup_job(bigint,uuid,text,boolean)',
      'execute'
    )
    or not has_function_privilege(
      'service_role',
      'public.claim_media_cleanup_jobs(integer,integer)',
      'execute'
    )
  then
    raise exception 'MEDIA_CLEANUP_RPC_PRIVILEGES_INVALID';
  end if;
end;
$$;

rollback;
