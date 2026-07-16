\set ON_ERROR_STOP on

begin;

create or replace function public.codex_upload_test_raise()
returns trigger
language plpgsql
as $$
begin
  raise exception 'CODEX_UPLOAD_TEST_INJECTED_FAILURE';
end;
$$;

create or replace function public.codex_upload_test_constraint_failure()
returns trigger
language plpgsql
as $$
begin
  new.payout_choice := 'invalid';
  return new;
end;
$$;

-- Keep the real DEV Cycle unchanged while making room for the synthetic
-- current Cycle inside this rollback-only transaction.
update public.voting_cycles
set status = 'archived'
where status::text in (
  'draft', 'active', 'submission_open', 'submission_closed', 'voting_open',
  'voting_closed', 'paused', 'finalizing'
);

do $$
declare
  v_cycle_id constant bigint := 9100000001;
  v_rules_version integer;
  v_user_a constant text := 'codex-upload-saga-user-a';
  v_user_b constant text := 'codex-upload-saga-user-b';
  v_user_c constant text := 'codex-upload-saga-user-c';
  v_session_a constant uuid := '91000000-0000-4000-8000-000000000001';
  v_session_b constant uuid := '91000000-0000-4000-8000-000000000002';
  v_session_c constant uuid := '91000000-0000-4000-8000-000000000003';
  v_idempotency_a constant uuid := '92000000-0000-4000-8000-000000000001';
  v_operation_id uuid;
  v_submission_id bigint;
  v_storage_key text;
  v_rotated_key text;
  v_result jsonb;
  v_failure_user text;
  v_failure_session uuid;
  v_failure_idempotency uuid;
  v_failure_operation uuid;
  v_failure_stage integer;
  v_trigger_sql text;
begin
  if exists (
    select 1 from public.voting_cycles where id = v_cycle_id
  ) or exists (
    select 1
    from public.user_logs
    where discord_user_id like 'codex-upload-saga-%'
       or discord_user_id like 'codex-upload-failure-%'
  ) then
    raise exception 'SUBMISSION_UPLOAD_TEST_FIXTURE_COLLISION';
  end if;

  select current_version
  into v_rules_version
  from public.rules_meta
  where id = 1;

  if v_rules_version is null then
    raise exception 'SUBMISSION_UPLOAD_TEST_RULES_MISSING';
  end if;

  insert into public.voting_cycles (
    id,
    status,
    starts_at,
    submission_starts_at,
    votes_per_user,
    allow_self_vote
  ) values (
    v_cycle_id,
    'submission_open',
    transaction_timestamp() - interval '1 hour',
    transaction_timestamp() - interval '1 hour',
    2,
    false
  );

  insert into public.user_logs (
    discord_user_id,
    current_discord_username,
    accepted_rules_version,
    show_socials_on_submissions
  ) values
    (v_user_a, 'codex-a', v_rules_version, true),
    (v_user_b, 'codex-b', v_rules_version, false),
    (v_user_c, 'codex-c', v_rules_version, false);

  insert into public.discord_member_state (
    discord_user_id,
    current_discord_username,
    discord_joined_at,
    is_in_discord
  ) values
    (v_user_a, 'codex-a', transaction_timestamp() - interval '1 day', true),
    (v_user_b, 'codex-b', transaction_timestamp() - interval '1 day', true),
    (v_user_c, 'codex-c', transaction_timestamp() - interval '1 day', true);

  insert into public.sessions (id, discord_user_id)
  values
    (v_session_a, v_user_a),
    (v_session_b, v_user_b),
    (v_session_c, v_user_c);

  insert into public.user_social_links (
    discord_user_id,
    platform,
    handle,
    profile_url,
    is_verified,
    verified_at
  ) values (
    v_user_a,
    'x',
    '@codex_test',
    'https://x.com/codex_test',
    true,
    transaction_timestamp()
  );

  v_result := public.reserve_submission_upload(
    null,
    v_idempotency_a,
    repeat('a', 64),
    repeat('b', 64),
    'image/webp',
    100
  );
  if v_result ->> 'outcome' <> 'not_authenticated' then
    raise exception 'UNAUTHENTICATED_RESERVATION_ACCEPTED: %', v_result;
  end if;

  v_result := public.reserve_submission_upload(
    v_session_a,
    v_idempotency_a,
    repeat('a', 64),
    repeat('b', 64),
    'image/webp',
    100
  );
  if v_result ->> 'outcome' <> 'reserved' then
    raise exception 'UPLOAD_RESERVATION_FAILED: %', v_result;
  end if;

  v_operation_id := (v_result ->> 'operationId')::uuid;
  v_storage_key := v_result ->> 'storageKey';

  if v_storage_key !~ ('^' || v_cycle_id::text || '/[0-9A-Fa-f-]{36}[.]webp$')
    or exists (
      select 1 from public.submissions where cycle_id = v_cycle_id
    )
  then
    raise exception 'RESERVED_UPLOAD_BECAME_VISIBLE_OR_KEY_INVALID';
  end if;

  v_result := public.reserve_submission_upload(
    v_session_a,
    v_idempotency_a,
    repeat('a', 64),
    repeat('b', 64),
    'image/webp',
    100
  );
  if v_result ->> 'outcome' <> 'in_progress' then
    raise exception 'SAME_REQUEST_WAS_NOT_DEDUPLICATED: %', v_result;
  end if;

  v_result := public.reserve_submission_upload(
    v_session_a,
    v_idempotency_a,
    repeat('c', 64),
    repeat('b', 64),
    'image/webp',
    100
  );
  if v_result ->> 'outcome' <> 'idempotency_conflict' then
    raise exception 'IDEMPOTENCY_MISMATCH_ACCEPTED: %', v_result;
  end if;

  v_result := public.reserve_submission_upload(
    v_session_a,
    '92000000-0000-4000-8000-000000000002',
    repeat('d', 64),
    repeat('e', 64),
    'image/webp',
    100
  );
  if v_result ->> 'outcome' <> 'upload_in_progress' then
    raise exception 'SECOND_ACTIVE_USER_UPLOAD_ACCEPTED: %', v_result;
  end if;

  v_result := public.mark_submission_upload_r2_uploaded(
    v_operation_id,
    v_session_a,
    'synthetic-etag'
  );
  if v_result ->> 'outcome' <> 'r2_uploaded' then
    raise exception 'R2_CONFIRMATION_FAILED: %', v_result;
  end if;

  if exists (
    select 1 from public.submissions where cycle_id = v_cycle_id
  ) then
    raise exception 'R2_UPLOADED_OPERATION_BECAME_VISIBLE_BEFORE_COMMIT';
  end if;

  v_result := public.commit_submission_upload(
    v_operation_id,
    v_session_a,
    'wallet-a',
    'split',
    50,
    'Synthetic Charity'
  );
  if v_result ->> 'outcome' <> 'completed' then
    raise exception 'ATOMIC_UPLOAD_COMMIT_FAILED: %', v_result;
  end if;

  v_submission_id := (v_result ->> 'submissionId')::bigint;

  if (select count(*) from public.submissions where id = v_submission_id) <> 1
    or (select count(*) from public.submission_private_data where submission_id = v_submission_id) <> 1
    or (select count(*) from public.submission_social_links where submission_id = v_submission_id) <> 1
    or (select count(*) from public.upload_logs where submission_id = v_submission_id::text and status = 'success') <> 1
    or not exists (
      select 1
      from public.submission_upload_operations
      where id = v_operation_id
        and status = 'completed'
        and submission_id = v_submission_id
        and completed_at is not null
        and cleanup_required = false
    )
  then
    raise exception 'ATOMIC_UPLOAD_ROWS_INCOMPLETE';
  end if;

  v_result := public.reserve_submission_upload(
    v_session_a,
    v_idempotency_a,
    repeat('a', 64),
    repeat('b', 64),
    'image/webp',
    100
  );
  if v_result ->> 'outcome' <> 'already_completed'
    or (v_result ->> 'submissionId')::bigint <> v_submission_id
    or (select count(*) from public.submissions where cycle_id = v_cycle_id and discord_user_id = v_user_a) <> 1
  then
    raise exception 'COMPLETED_RETRY_WAS_NOT_STABLE: %', v_result;
  end if;

  v_result := public.reserve_submission_upload(
    v_session_b,
    '92000000-0000-4000-8000-000000000003',
    repeat('f', 64),
    repeat('0', 64),
    'image/webp',
    100
  );
  if v_result ->> 'outcome' <> 'reserved' then
    raise exception 'SECOND_USER_WAS_NOT_INDEPENDENT: %', v_result;
  end if;

  perform public.mark_submission_upload_r2_uploaded(
    (v_result ->> 'operationId')::uuid,
    v_session_b,
    null
  );
  v_result := public.commit_submission_upload(
    (select id from public.submission_upload_operations where discord_user_id = v_user_b),
    v_session_b,
    'wallet-b',
    'keep',
    null,
    null
  );
  if v_result ->> 'outcome' <> 'completed' then
    raise exception 'SECOND_USER_COMMIT_FAILED: %', v_result;
  end if;

  v_result := public.reserve_submission_upload(
    v_session_a,
    '92000000-0000-4000-8000-000000000004',
    repeat('1', 64),
    repeat('2', 64),
    'image/webp',
    100
  );
  if v_result ->> 'outcome' <> 'upload_limit_reached' then
    raise exception 'UPLOAD_LIMIT_NOT_AUTHORITATIVE: %', v_result;
  end if;

  v_result := public.reserve_submission_upload(
    v_session_c,
    '92000000-0000-4000-8000-000000000005',
    repeat('3', 64),
    repeat('4', 64),
    'image/webp',
    100
  );
  v_failure_operation := (v_result ->> 'operationId')::uuid;
  perform public.mark_submission_upload_r2_uploaded(
    v_failure_operation,
    v_session_c,
    null
  );

  update public.voting_cycles
  set status = 'paused', paused_from_status = 'submission_open'
  where id = v_cycle_id;

  v_result := public.commit_submission_upload(
    v_failure_operation,
    v_session_c,
    'wallet-c',
    'keep',
    null,
    null
  );
  if v_result ->> 'outcome' <> 'cycle_not_open'
    or exists (
      select 1
      from public.submissions
      where cycle_id = v_cycle_id and discord_user_id = v_user_c
    )
  then
    raise exception 'PAUSED_CYCLE_ACCEPTED_LATE_UPLOAD: %', v_result;
  end if;

  v_result := public.enqueue_submission_upload_cleanup(
    v_failure_operation,
    v_session_c,
    'CYCLE_PAUSED'
  );
  if v_result ->> 'outcome' <> 'cleanup_pending'
    or not exists (
      select 1
      from public.media_cleanup_queue
      where storage_key = (
        select storage_key
        from public.submission_upload_operations
        where id = v_failure_operation
      )
        and status = 'pending'
    )
  then
    raise exception 'POST_R2_COMPENSATION_NOT_DURABLE: %', v_result;
  end if;

  update public.voting_cycles
  set status = 'submission_open', paused_from_status = null
  where id = v_cycle_id;

  -- Five injected database failures: submission, private data, social snapshot,
  -- success audit, and the final operation-completion update. Each statement
  -- must roll back all rows and leave the operation compensatable.
  for v_failure_stage in 1..5 loop
    v_failure_user := 'codex-upload-failure-' || v_failure_stage::text;
    v_failure_session := (
      '93000000-0000-4000-8000-' || lpad(v_failure_stage::text, 12, '0')
    )::uuid;
    v_failure_idempotency := (
      '94000000-0000-4000-8000-' || lpad(v_failure_stage::text, 12, '0')
    )::uuid;

    insert into public.user_logs (
      discord_user_id,
      current_discord_username,
      accepted_rules_version,
      show_socials_on_submissions
    ) values (
      v_failure_user,
      'codex-failure-' || v_failure_stage::text,
      v_rules_version,
      v_failure_stage = 3
    );

    insert into public.discord_member_state (
      discord_user_id,
      current_discord_username,
      discord_joined_at,
      is_in_discord
    ) values (
      v_failure_user,
      'codex-failure-' || v_failure_stage::text,
      transaction_timestamp() - interval '1 day',
      true
    );

    insert into public.sessions (id, discord_user_id)
    values (v_failure_session, v_failure_user);

    if v_failure_stage = 3 then
      insert into public.user_social_links (
        discord_user_id,
        platform,
        handle,
        profile_url,
        is_verified,
        verified_at
      ) values (
        v_failure_user,
        'x',
        '@failure',
        'https://x.com/failure',
        true,
        transaction_timestamp()
      );
    end if;

    v_result := public.reserve_submission_upload(
      v_failure_session,
      v_failure_idempotency,
      encode(digest('fingerprint-' || v_failure_stage::text, 'sha256'), 'hex'),
      encode(digest('content-' || v_failure_stage::text, 'sha256'), 'hex'),
      'image/webp',
      100
    );
    if v_result ->> 'outcome' <> 'reserved' then
      raise exception 'FAILURE_FIXTURE_RESERVATION_FAILED: %', v_result;
    end if;

    v_failure_operation := (v_result ->> 'operationId')::uuid;
    perform public.mark_submission_upload_r2_uploaded(
      v_failure_operation,
      v_failure_session,
      null
    );

    v_trigger_sql := case v_failure_stage
      when 1 then 'create trigger codex_upload_failure before insert on public.submissions for each row execute function public.codex_upload_test_raise()'
      when 2 then 'create trigger codex_upload_failure before insert on public.submission_private_data for each row execute function public.codex_upload_test_raise()'
      when 3 then 'create trigger codex_upload_failure before insert on public.submission_social_links for each row execute function public.codex_upload_test_raise()'
      when 4 then 'create trigger codex_upload_failure before insert on public.upload_logs for each row execute function public.codex_upload_test_raise()'
      else 'create trigger codex_upload_failure before update on public.submission_upload_operations for each row when (new.status = ''completed'') execute function public.codex_upload_test_raise()'
    end;

    begin
      execute v_trigger_sql;
      perform public.commit_submission_upload(
        v_failure_operation,
        v_failure_session,
        'wallet-failure',
        'keep',
        null,
        null
      );
      raise exception 'INJECTED_DATABASE_FAILURE_WAS_NOT_RAISED';
    exception
      when others then
        if sqlerrm <> 'CODEX_UPLOAD_TEST_INJECTED_FAILURE' then
          raise;
        end if;
    end;

    if exists (
      select 1 from public.submissions where discord_user_id = v_failure_user
    ) or exists (
      select 1
      from public.submission_private_data private_data
      join public.submissions submission on submission.id = private_data.submission_id
      where submission.discord_user_id = v_failure_user
    ) or exists (
      select 1
      from public.submission_social_links social
      where social.discord_user_id = v_failure_user
    ) or exists (
      select 1
      from public.upload_logs
      where discord_user_id = v_failure_user and status = 'success'
    ) or not exists (
      select 1
      from public.submission_upload_operations
      where id = v_failure_operation and status = 'r2_uploaded'
    ) then
      raise exception 'INJECTED_FAILURE_LEFT_PARTIAL_DATABASE_STATE_%', v_failure_stage;
    end if;

    v_result := public.enqueue_submission_upload_cleanup(
      v_failure_operation,
      v_failure_session,
      'DB_FAILURE_STAGE_' || v_failure_stage::text
    );
    if v_result ->> 'outcome' <> 'cleanup_pending' then
      raise exception 'INJECTED_FAILURE_WAS_NOT_COMPENSATABLE_%', v_failure_stage;
    end if;
  end loop;

  -- A real constraint failure during private insert must also roll back.
  v_failure_user := 'codex-upload-failure-constraint';
  v_failure_session := '93000000-0000-4000-8000-000000000099';
  insert into public.user_logs (
    discord_user_id,
    current_discord_username,
    accepted_rules_version
  ) values (v_failure_user, 'codex-constraint', v_rules_version);
  insert into public.discord_member_state (
    discord_user_id,
    current_discord_username,
    discord_joined_at,
    is_in_discord
  ) values (
    v_failure_user,
    'codex-constraint',
    transaction_timestamp() - interval '1 day',
    true
  );
  insert into public.sessions (id, discord_user_id)
  values (v_failure_session, v_failure_user);

  v_result := public.reserve_submission_upload(
    v_failure_session,
    '94000000-0000-4000-8000-000000000099',
    repeat('5', 64),
    repeat('6', 64),
    'image/webp',
    100
  );
  v_failure_operation := (v_result ->> 'operationId')::uuid;
  perform public.mark_submission_upload_r2_uploaded(
    v_failure_operation,
    v_failure_session,
    null
  );

  begin
    execute 'create trigger codex_upload_constraint_failure before insert on public.submission_private_data for each row execute function public.codex_upload_test_constraint_failure()';
    perform public.commit_submission_upload(
      v_failure_operation,
      v_failure_session,
      'wallet-constraint',
      'keep',
      null,
      null
    );
    raise exception 'CONSTRAINT_FAILURE_WAS_NOT_RAISED';
  exception
    when check_violation then null;
  end;

  if exists (
    select 1 from public.submissions where discord_user_id = v_failure_user
  ) then
    raise exception 'CONSTRAINT_FAILURE_LEFT_SUBMISSION';
  end if;

  perform public.enqueue_submission_upload_cleanup(
    v_failure_operation,
    v_failure_session,
    'CONSTRAINT_FAILURE'
  );

  -- Stale intents become durable cleanup jobs; after completed cleanup the
  -- same idempotency key may reserve a new key without changing its binding.
  v_failure_user := 'codex-upload-failure-stale';
  v_failure_session := '93000000-0000-4000-8000-000000000100';
  insert into public.user_logs (
    discord_user_id,
    current_discord_username,
    accepted_rules_version
  ) values (v_failure_user, 'codex-stale', v_rules_version);
  insert into public.discord_member_state (
    discord_user_id,
    current_discord_username,
    discord_joined_at,
    is_in_discord
  ) values (
    v_failure_user,
    'codex-stale',
    transaction_timestamp() - interval '1 day',
    true
  );
  insert into public.sessions (id, discord_user_id)
  values (v_failure_session, v_failure_user);

  v_result := public.reserve_submission_upload(
    v_failure_session,
    '94000000-0000-4000-8000-000000000100',
    repeat('7', 64),
    repeat('8', 64),
    'image/webp',
    100
  );
  v_failure_operation := (v_result ->> 'operationId')::uuid;
  v_storage_key := v_result ->> 'storageKey';

  update public.submission_upload_operations
  set updated_at = transaction_timestamp() - interval '2 minutes'
  where id = v_failure_operation;

  v_result := public.recover_stale_submission_uploads(10, 60);
  if (v_result ->> 'recovered')::integer <> 1
    or not exists (
      select 1
      from public.submission_upload_operations
      where id = v_failure_operation
        and status = 'cleanup_pending'
        and cleanup_required = true
    )
  then
    raise exception 'STALE_UPLOAD_RECOVERY_FAILED: %', v_result;
  end if;

  update public.media_cleanup_queue
  set
    status = 'completed',
    next_attempt_at = null,
    processed_at = transaction_timestamp(),
    updated_at = transaction_timestamp()
  where storage_key = v_storage_key;

  v_result := public.reserve_submission_upload(
    v_failure_session,
    '94000000-0000-4000-8000-000000000100',
    repeat('7', 64),
    repeat('8', 64),
    'image/webp',
    100
  );
  v_rotated_key := v_result ->> 'storageKey';
  if v_result ->> 'outcome' <> 'reserved'
    or v_rotated_key is null
    or v_rotated_key = v_storage_key
  then
    raise exception 'CLEANED_RETRY_DID_NOT_ROTATE_STORAGE_KEY: %', v_result;
  end if;

  if has_function_privilege(
    'anon',
    'public.reserve_submission_upload(uuid,uuid,text,text,text,integer)',
    'execute'
  ) or has_function_privilege(
    'authenticated',
    'public.commit_submission_upload(uuid,uuid,text,text,integer,text)',
    'execute'
  ) or has_function_privilege(
    'authenticated',
    'public.enqueue_submission_upload_cleanup(uuid,uuid,text)',
    'execute'
  ) or not has_function_privilege(
    'service_role',
    'public.recover_stale_submission_uploads(integer,integer)',
    'execute'
  ) then
    raise exception 'SUBMISSION_UPLOAD_RPC_PRIVILEGES_INVALID';
  end if;
end;
$$;

rollback;
