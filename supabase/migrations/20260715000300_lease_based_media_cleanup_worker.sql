begin;

alter table public.media_cleanup_queue
  add column if not exists next_attempt_at timestamptz default now(),
  add column if not exists locked_at timestamptz,
  add column if not exists locked_until timestamptz,
  add column if not exists lease_token uuid,
  add column if not exists last_attempt_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

alter table public.media_cleanup_queue
  drop constraint if exists media_cleanup_queue_status_check;

alter table public.media_cleanup_queue
  add constraint media_cleanup_queue_status_check
    check (status in ('pending', 'processing', 'failed', 'completed', 'dead'));

-- Existing rows have only pending/failed/completed states. Preserve their
-- attempt history, make legacy retryable rows due now, and canonicalize
-- completed rows without guessing about their original provider outcome.
update public.media_cleanup_queue
set
  next_attempt_at = case
    when status in ('pending', 'failed') and attempts < 7
      then coalesce(next_attempt_at, transaction_timestamp())
    else null
  end,
  locked_at = null,
  locked_until = null,
  lease_token = null,
  last_attempt_at = case
    when attempts > 0
      then coalesce(last_attempt_at, processed_at, created_at)
    else last_attempt_at
  end,
  processed_at = case
    when status = 'completed'
      then coalesce(processed_at, created_at)
    else null
  end,
  last_error_code = case
    when status = 'completed' then null
    when status = 'pending' and attempts < 7 then null
    when attempts >= 7 then left(
      regexp_replace(
        coalesce(nullif(btrim(last_error_code), ''), 'MAX_ATTEMPTS_EXCEEDED'),
        '[^A-Za-z0-9_.-]',
        '_',
        'g'
      ),
      120
    )
    else left(
      regexp_replace(
        coalesce(nullif(btrim(last_error_code), ''), 'LEGACY_CLEANUP_FAILURE'),
        '[^A-Za-z0-9_.-]',
        '_',
        'g'
      ),
      120
    )
  end,
  status = case
    when status in ('pending', 'failed') and attempts >= 7 then 'dead'
    else status
  end,
  updated_at = coalesce(processed_at, created_at, transaction_timestamp());

alter table public.media_cleanup_queue
  alter column next_attempt_at set default now();

alter table public.media_cleanup_queue
  drop constraint if exists media_cleanup_queue_lease_state_check,
  drop constraint if exists media_cleanup_queue_retry_schedule_check,
  drop constraint if exists media_cleanup_queue_processed_state_check,
  drop constraint if exists media_cleanup_queue_error_code_length_check;

alter table public.media_cleanup_queue
  add constraint media_cleanup_queue_lease_state_check
    check (
      (
        status = 'processing'
        and lease_token is not null
        and locked_at is not null
        and locked_until is not null
        and locked_until > locked_at
      )
      or (
        status <> 'processing'
        and lease_token is null
        and locked_at is null
        and locked_until is null
      )
    ),
  add constraint media_cleanup_queue_retry_schedule_check
    check (
      (status in ('pending', 'failed') and next_attempt_at is not null)
      or (status not in ('pending', 'failed') and next_attempt_at is null)
    ),
  add constraint media_cleanup_queue_processed_state_check
    check (
      (status = 'completed' and processed_at is not null)
      or (status <> 'completed' and processed_at is null)
    ),
  add constraint media_cleanup_queue_error_code_length_check
    check (last_error_code is null or length(last_error_code) <= 120);

comment on column public.media_cleanup_queue.attempts is
  'Number of processing leases issued. Claim increments exactly once; complete/fail never increments it.';
comment on column public.media_cleanup_queue.next_attempt_at is
  'Database time at which a pending/failed job becomes claimable. Null for processing and terminal states.';
comment on column public.media_cleanup_queue.lease_token is
  'Opaque ownership token replaced on every claim, including recovery of an expired processing lease.';
comment on column public.media_cleanup_queue.locked_at is
  'Database time at which the current processing lease was issued.';
comment on column public.media_cleanup_queue.locked_until is
  'Hard lease expiry. A result arriving at or after this time is stale even if no new worker has claimed the job yet.';
comment on column public.media_cleanup_queue.last_attempt_at is
  'Database time of the latest successful claim, independent of its eventual outcome.';
comment on column public.media_cleanup_queue.processed_at is
  'Completion timestamp. This existing column is the canonical completed_at equivalent.';
comment on column public.media_cleanup_queue.updated_at is
  'Database time of the latest queue state change.';

create index if not exists media_cleanup_queue_due_idx
  on public.media_cleanup_queue (next_attempt_at, created_at, id)
  where status in ('pending', 'failed');

create index if not exists media_cleanup_queue_expired_lease_idx
  on public.media_cleanup_queue (locked_until, id)
  where status = 'processing';

create or replace function public.media_cleanup_retry_delay(
  p_attempt integer
)
returns interval
language sql
immutable
strict
set search_path = public, pg_temp
as $$
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

comment on function public.media_cleanup_retry_delay(integer) is
  'Deterministic retry delay after a failed claimed attempt. Attempt 7 is terminal and therefore has no delay.';

create or replace function public.claim_media_cleanup_jobs(
  p_limit integer default 10,
  p_lease_seconds integer default 120
)
returns table (
  job_id bigint,
  storage_provider text,
  storage_key text,
  lease_token uuid,
  attempt_count integer,
  locked_until timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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

comment on function public.claim_media_cleanup_jobs(integer, integer) is
  'Claims at most 20 due jobs with FOR UPDATE SKIP LOCKED. Attempts count issued leases; expired leases receive a new token and one new attempt.';

create or replace function public.complete_media_cleanup_job(
  p_job_id bigint,
  p_lease_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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

comment on function public.complete_media_cleanup_job(bigint, uuid) is
  'Completes only a processing job whose token still owns an unexpired lease. Stale workers receive a structured no-op.';

create or replace function public.fail_media_cleanup_job(
  p_job_id bigint,
  p_lease_token uuid,
  p_error_code text,
  p_permanent boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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

comment on function public.fail_media_cleanup_job(bigint, uuid, text, boolean) is
  'Fails only the current unexpired lease. Attempts 1-6 use 1m/5m/15m/1h/6h/24h backoff; attempt 7 or a permanent validation/configuration error becomes dead.';

revoke all on function public.media_cleanup_retry_delay(integer)
  from public, anon, authenticated;
revoke all on function public.claim_media_cleanup_jobs(integer, integer)
  from public, anon, authenticated;
revoke all on function public.complete_media_cleanup_job(bigint, uuid)
  from public, anon, authenticated;
revoke all on function public.fail_media_cleanup_job(bigint, uuid, text, boolean)
  from public, anon, authenticated;

grant execute on function public.media_cleanup_retry_delay(integer)
  to service_role;
grant execute on function public.claim_media_cleanup_jobs(integer, integer)
  to service_role;
grant execute on function public.complete_media_cleanup_job(bigint, uuid)
  to service_role;
grant execute on function public.fail_media_cleanup_job(bigint, uuid, text, boolean)
  to service_role;

commit;
