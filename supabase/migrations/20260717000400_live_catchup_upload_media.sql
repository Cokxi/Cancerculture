-- LIVE catch-up package D: Upload and media infrastructure
-- Mechanically composed from reviewed cleanup, upload-saga, and abuse-protection migrations.
-- No Recovery or cleanup function is invoked by this migration.
-- Historical migration files remain unchanged.

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

begin;

create table public.submission_upload_operations (
  id uuid primary key default gen_random_uuid(),
  discord_user_id text not null,
  cycle_id bigint not null
    references public.voting_cycles(id) on delete restrict,
  idempotency_key uuid not null,
  request_fingerprint text not null,
  content_sha256 text not null,
  storage_provider text not null default 'r2',
  storage_key text not null,
  media_type text not null,
  media_bytes integer not null,
  r2_etag text,
  status text not null default 'reserved',
  submission_id bigint unique
    references public.submissions(id) on delete set null,
  cleanup_required boolean not null default false,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_attempt_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint submission_upload_operations_user_id_not_blank_check
    check (btrim(discord_user_id) <> ''),
  constraint submission_upload_operations_fingerprint_check
    check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint submission_upload_operations_content_hash_check
    check (content_sha256 ~ '^[0-9a-f]{64}$'),
  constraint submission_upload_operations_storage_provider_check
    check (storage_provider = 'r2'),
  constraint submission_upload_operations_storage_key_check
    check (
      storage_key ~ ('^' || cycle_id::text || '/[0-9A-Fa-f-]{36}[.]webp$')
    ),
  constraint submission_upload_operations_media_type_check
    check (media_type = 'image/webp'),
  constraint submission_upload_operations_media_bytes_check
    check (media_bytes > 0 and media_bytes <= 16777216),
  constraint submission_upload_operations_etag_length_check
    check (r2_etag is null or length(r2_etag) <= 256),
  constraint submission_upload_operations_status_check
    check (status in (
      'reserved',
      'r2_uploaded',
      'cleanup_pending',
      'completed',
      'failed'
    )),
  constraint submission_upload_operations_error_length_check
    check (last_error_code is null or length(last_error_code) <= 120),
  constraint submission_upload_operations_state_check
    check (
      (
        status = 'completed'
        and submission_id is not null
        and cleanup_required = false
        and completed_at is not null
      )
      or (
        status <> 'completed'
        and submission_id is null
        and completed_at is null
      )
    ),
  constraint submission_upload_operations_cleanup_state_check
    check (
      (status = 'cleanup_pending' and cleanup_required = true)
      or (status <> 'cleanup_pending' and cleanup_required = false)
    ),
  constraint submission_upload_operations_user_idempotency_unique
    unique (discord_user_id, idempotency_key),
  constraint submission_upload_operations_storage_key_unique
    unique (storage_provider, storage_key)
);

comment on table public.submission_upload_operations is
  'Server-only durable upload intent and idempotency ledger bridging R2 and the atomic PostgreSQL submission commit.';
comment on column public.submission_upload_operations.idempotency_key is
  'Client-generated random UUID bound to one authenticated user and the operation cycle; it contains no user data.';
comment on column public.submission_upload_operations.request_fingerprint is
  'SHA-256 of canonical transformed media hash and normalized user-supplied payout metadata.';
comment on column public.submission_upload_operations.storage_key is
  'Canonical server-generated R2 key. The client never chooses a bucket, prefix, cycle, submission, or object key.';
comment on column public.submission_upload_operations.status is
  'reserved before R2, r2_uploaded after provider confirmation, completed only with the atomic submission commit, cleanup_pending while compensation is durable, and failed only after a non-public failed operation is safe to retry.';

create index submission_upload_operations_cycle_status_idx
  on public.submission_upload_operations (cycle_id, status, created_at);

create index submission_upload_operations_stale_idx
  on public.submission_upload_operations (updated_at, id)
  where status in ('reserved', 'r2_uploaded');

create unique index submission_upload_operations_one_active_user_cycle_idx
  on public.submission_upload_operations (discord_user_id, cycle_id)
  where status in ('reserved', 'r2_uploaded');

create unique index submission_private_data_submission_id_uidx
  on public.submission_private_data (submission_id);

create unique index submission_social_links_submission_source_uidx
  on public.submission_social_links (
    submission_id,
    source_user_social_link_id
  )
  where source_user_social_link_id is not null;

alter table public.submission_upload_operations enable row level security;

revoke all on table public.submission_upload_operations
  from public, anon, authenticated;
grant select, insert, update, delete
  on table public.submission_upload_operations to service_role;

create or replace function public.submission_upload_error_code(
  p_error_code text
)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
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

create or replace function public.reserve_submission_upload(
  p_session_id uuid,
  p_idempotency_key uuid,
  p_request_fingerprint text,
  p_content_sha256 text,
  p_media_type text,
  p_media_bytes integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
$$;

create or replace function public.mark_submission_upload_r2_uploaded(
  p_operation_id uuid,
  p_session_id uuid,
  p_r2_etag text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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

create or replace function public.commit_submission_upload(
  p_operation_id uuid,
  p_session_id uuid,
  p_wallet_address text,
  p_payout_choice text,
  p_split_percent integer,
  p_charity text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
$$;

create or replace function public.enqueue_submission_upload_cleanup(
  p_operation_id uuid,
  p_session_id uuid,
  p_error_code text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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

create or replace function public.recover_stale_submission_uploads(
  p_limit integer default 100,
  p_stale_after_seconds integer default 900
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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

create or replace function public.enqueue_deleted_submission_media()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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

drop trigger if exists submissions_enqueue_deleted_media
  on public.submissions;
create trigger submissions_enqueue_deleted_media
before delete on public.submissions
for each row
execute function public.enqueue_deleted_submission_media();

revoke all on function public.submission_upload_error_code(text)
  from public, anon, authenticated;
revoke all on function public.reserve_submission_upload(uuid, uuid, text, text, text, integer)
  from public, anon, authenticated;
revoke all on function public.mark_submission_upload_r2_uploaded(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.commit_submission_upload(uuid, uuid, text, text, integer, text)
  from public, anon, authenticated;
revoke all on function public.enqueue_submission_upload_cleanup(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.recover_stale_submission_uploads(integer, integer)
  from public, anon, authenticated;
revoke all on function public.enqueue_deleted_submission_media()
  from public, anon, authenticated;

grant execute on function public.submission_upload_error_code(text)
  to service_role;
grant execute on function public.reserve_submission_upload(uuid, uuid, text, text, text, integer)
  to service_role;
grant execute on function public.mark_submission_upload_r2_uploaded(uuid, uuid, text)
  to service_role;
grant execute on function public.commit_submission_upload(uuid, uuid, text, text, integer, text)
  to service_role;
grant execute on function public.enqueue_submission_upload_cleanup(uuid, uuid, text)
  to service_role;
grant execute on function public.recover_stale_submission_uploads(integer, integer)
  to service_role;
grant execute on function public.enqueue_deleted_submission_media()
  to service_role;

comment on function public.reserve_submission_upload(uuid, uuid, text, text, text, integer) is
  'Validates the confirmed session and current upload eligibility, serializes one user/cycle intent, and returns a server-generated R2 key. Replays are conflict-safe and completed operations are stable.';
comment on function public.commit_submission_upload(uuid, uuid, text, text, integer, text) is
  'Revalidates session, membership, ban, rules, rate limit, cycle phase, and per-cycle upload limit under locks, then atomically creates the submission, private data, verified social snapshots, success audit, and completed operation.';
comment on function public.enqueue_submission_upload_cleanup(uuid, uuid, text) is
  'Atomically marks an unfinished upload as cleanup_pending and deduplicates its canonical R2 key into the shared media cleanup queue.';
comment on function public.recover_stale_submission_uploads(integer, integer) is
  'Recovers crashed upload intents by marking them cleanup_pending and enqueueing their possibly-present R2 keys. Missing objects remain successful idempotent cleanup.';

commit;

begin;

create table public.submission_upload_abuse_states (
  discord_user_id text not null
    references public.user_logs(discord_user_id) on delete restrict,
  cycle_id bigint not null
    references public.voting_cycles(id) on delete restrict,
  invalid_attempt_count integer not null default 0,
  total_invalid_attempt_count integer not null default 0,
  last_error_code text,
  last_invalid_attempt_at timestamptz,
  blocked_at timestamptz,
  blocked_reason text,
  block_count integer not null default 0,
  last_blocked_at timestamptz,
  unblocked_at timestamptz,
  unblocked_by_discord_user_id text,
  unblock_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (discord_user_id, cycle_id),
  constraint submission_upload_abuse_attempt_count_check
    check (invalid_attempt_count between 0 and 5),
  constraint submission_upload_abuse_total_count_check
    check (total_invalid_attempt_count >= invalid_attempt_count),
  constraint submission_upload_abuse_block_count_check
    check (block_count >= 0),
  constraint submission_upload_abuse_error_code_check
    check (last_error_code is null or last_error_code ~ '^[A-Z0-9_]{1,80}$'),
  constraint submission_upload_abuse_state_check
    check (
      (blocked_at is null and invalid_attempt_count < 5 and blocked_reason is null)
      or
      (blocked_at is not null and invalid_attempt_count = 5 and blocked_reason is not null)
    ),
  constraint submission_upload_abuse_unblock_audit_check
    check (
      (unblocked_at is null and unblocked_by_discord_user_id is null and unblock_reason is null)
      or
      (unblocked_at is not null and unblocked_by_discord_user_id is not null and unblock_reason is not null)
    )
);

comment on table public.submission_upload_abuse_states is
  'Authoritative server-only per-user/per-cycle invalid submission-media counter and upload block state. Historical totals and block count survive an Admin unblock.';

create index submission_upload_abuse_blocked_idx
  on public.submission_upload_abuse_states (blocked_at desc, cycle_id)
  where blocked_at is not null;

create index submission_upload_abuse_cycle_updated_idx
  on public.submission_upload_abuse_states (cycle_id, updated_at desc);

alter table public.submission_upload_abuse_states enable row level security;

revoke all on table public.submission_upload_abuse_states
  from public, anon, authenticated;
grant select, insert, update, delete
  on table public.submission_upload_abuse_states to service_role;

create or replace function public.get_submission_upload_abuse_status(
  p_session_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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

create or replace function public.register_invalid_submission_upload(
  p_session_id uuid,
  p_cycle_id bigint,
  p_error_code text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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

create or replace function public.unblock_submission_upload(
  p_discord_user_id text,
  p_cycle_id bigint,
  p_actor_discord_user_id text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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

create or replace function public.enforce_submission_upload_abuse_block()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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

create trigger submission_upload_operations_abuse_block_trigger
before insert or update of status
on public.submission_upload_operations
for each row
execute function public.enforce_submission_upload_abuse_block();

revoke all on function public.get_submission_upload_abuse_status(uuid)
  from public, anon, authenticated;
revoke all on function public.register_invalid_submission_upload(uuid, bigint, text)
  from public, anon, authenticated;
revoke all on function public.unblock_submission_upload(text, bigint, text, text)
  from public, anon, authenticated;
revoke all on function public.enforce_submission_upload_abuse_block()
  from public, anon, authenticated;

grant execute on function public.get_submission_upload_abuse_status(uuid)
  to service_role;
grant execute on function public.register_invalid_submission_upload(uuid, bigint, text)
  to service_role;
grant execute on function public.unblock_submission_upload(text, bigint, text, text)
  to service_role;

commit;

begin;
drop trigger if exists submission_upload_operations_discord_access_trigger
  on public.submission_upload_operations;
create trigger submission_upload_operations_discord_access_trigger
before insert or update of status
on public.submission_upload_operations
for each row
when (new.status in ('reserved', 'completed'))
execute function public.enforce_discord_authenticated_action();
commit;
