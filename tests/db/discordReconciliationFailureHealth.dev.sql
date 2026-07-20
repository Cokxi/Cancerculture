\set ON_ERROR_STOP on

do $$
begin
  perform set_config(
    'cancerculture.discord_failure_health_test_suffix',
    gen_random_uuid()::text,
    false
  );
  perform set_config(
    'cancerculture.discord_failure_health_test_snapshot',
    gen_random_uuid()::text,
    false
  );
  perform set_config(
    'cancerculture.discord_failure_health_test_baseline',
    (
      select to_jsonb(health_row)::text
      from public.discord_sync_health as health_row
      where id = 1
    ),
    false
  );
end;
$$;

begin;

do $$
declare
  v_suffix text :=
    current_setting('cancerculture.discord_failure_health_test_suffix');
  v_snapshot_id uuid :=
    current_setting(
      'cancerculture.discord_failure_health_test_snapshot'
    )::uuid;
  v_observed timestamptz := '2000-01-01 00:00:00+00';
  v_heartbeat timestamptz :=
    transaction_timestamp() - interval '5 minutes';
  v_success timestamptz :=
    transaction_timestamp() - interval '2 days';
  v_old_failure timestamptz :=
    transaction_timestamp() - interval '1 day';
  v_safe_code text :=
    'FULL_RECONCILIATION_TIMEOUT_' || repeat('A', 50);
  v_expected_health_code text;
  v_unsafe_code text := 'https://bad code with free text';
  v_valid_event_id text := 'test-failure-health-' || v_suffix;
  v_unsafe_event_id text := 'test-failure-unsafe-' || v_suffix;
  v_missing_event_id text := 'test-failure-missing-' || v_suffix;
  v_result jsonb;
  v_first_failure_at timestamptz;
  v_health_before jsonb;
  v_health_after jsonb;
  v_audit_before integer;
begin
  if (select count(*) from public.discord_sync_health) <> 1
    or not exists (
      select 1
      from public.discord_sync_health
      where id = 1
    )
  then
    raise exception 'discord_sync_health singleton precondition failed';
  end if;

  insert into public.discord_reconciliation_snapshots (
    id,
    observed_at,
    expected_member_count,
    expected_ban_count
  ) values (
    v_snapshot_id,
    v_observed,
    1,
    0
  );

  v_result := public.finalize_discord_reconciliation_snapshot(
    'test-failure-incomplete-' || v_suffix,
    v_observed + interval '1 second',
    repeat('0', 64),
    v_snapshot_id
  );

  if v_result ->> 'outcome' <> 'incomplete_snapshot'
    or not exists (
      select 1
      from public.discord_reconciliation_snapshots
      where id = v_snapshot_id
        and status = 'failed'
        and error_code = 'INCOMPLETE_SNAPSHOT'
        and finalized_at is null
    )
  then
    raise exception 'existing incomplete snapshot failure semantics changed';
  end if;

  update public.discord_sync_health
  set
    last_heartbeat_at = v_heartbeat,
    last_member_snapshot_succeeded_at = v_success,
    last_ban_snapshot_succeeded_at = v_success,
    last_full_reconciliation_succeeded_at = v_success,
    last_failure_at = v_old_failure,
    last_failure_component = 'unknown',
    last_failure_code = 'PRIOR_FAILURE',
    updated_at = v_old_failure
  where id = 1;

  v_expected_health_code := left(v_safe_code, 64);

  select count(*)::integer
  into v_audit_before
  from public.admin_action_logs
  where action = 'discord_reconciliation_failed'
    and meta ->> 'errorCode' = v_safe_code;

  v_result := public.record_discord_reconciliation_failure(
    v_valid_event_id,
    transaction_timestamp(),
    repeat('1', 64),
    v_safe_code
  );

  if v_result ->> 'outcome' <> 'applied' then
    raise exception 'new valid reconciliation failure was not applied: %', v_result;
  end if;

  select last_failure_at
  into v_first_failure_at
  from public.discord_sync_health
  where id = 1;

  if not exists (
    select 1
    from public.discord_sync_health
    where id = 1
      and last_failure_at is not null
      and last_failure_at = updated_at
      and last_failure_at >= v_old_failure
      and last_failure_component = 'full_reconciliation'
      and last_failure_code = v_expected_health_code
      and length(last_failure_code) <= 64
      and last_failure_code ~ '^[A-Z0-9_]{1,64}$'
      and last_heartbeat_at = v_heartbeat
      and last_member_snapshot_succeeded_at = v_success
      and last_ban_snapshot_succeeded_at = v_success
      and last_full_reconciliation_succeeded_at = v_success
  ) then
    raise exception 'valid failure did not atomically update bounded failure health';
  end if;

  if not exists (
    select 1
    from public.discord_membership_sync_events
    where event_id = v_valid_event_id
      and event_type = 'reconciliation_failed'
      and result_status = 'failed'
      and payload_sha256 = repeat('1', 64)
  ) then
    raise exception 'existing reconciliation failure event status changed';
  end if;

  if (
    select count(*)::integer
    from public.admin_action_logs
    where action = 'discord_reconciliation_failed'
      and meta ->> 'errorCode' = v_safe_code
  ) <> v_audit_before + 1 then
    raise exception 'existing reconciliation failure audit payload changed';
  end if;

  select to_jsonb(health_row)
  into v_health_before
  from public.discord_sync_health as health_row
  where id = 1;

  v_result := public.record_discord_reconciliation_failure(
    v_valid_event_id,
    transaction_timestamp() + interval '1 second',
    repeat('1', 64),
    v_safe_code
  );

  select to_jsonb(health_row)
  into v_health_after
  from public.discord_sync_health as health_row
  where id = 1;

  if v_result ->> 'outcome' <> 'replay'
    or v_health_after is distinct from v_health_before
  then
    raise exception 'identical failure replay changed health';
  end if;

  v_result := public.record_discord_reconciliation_failure(
    v_valid_event_id,
    transaction_timestamp() + interval '2 seconds',
    repeat('2', 64),
    'DIFFERENT_FAILURE'
  );

  select to_jsonb(health_row)
  into v_health_after
  from public.discord_sync_health as health_row
  where id = 1;

  if v_result ->> 'outcome' <> 'invalid_event'
    or v_health_after is distinct from v_health_before
  then
    raise exception 'conflicting failure replay changed health';
  end if;

  v_result := public.record_discord_reconciliation_failure(
    'short',
    transaction_timestamp() + interval '3 seconds',
    repeat('3', 63) || 'g',
    'INVALID_EVENT'
  );

  select to_jsonb(health_row)
  into v_health_after
  from public.discord_sync_health as health_row
  where id = 1;

  if v_result ->> 'outcome' <> 'invalid_event'
    or v_health_after is distinct from v_health_before
  then
    raise exception 'invalid failure event changed health';
  end if;

  v_result := public.record_discord_reconciliation_failure(
    v_unsafe_event_id,
    transaction_timestamp() + interval '4 seconds',
    repeat('4', 64),
    v_unsafe_code
  );

  if v_result ->> 'outcome' <> 'applied'
    or not exists (
      select 1
      from public.discord_sync_health
      where id = 1
        and last_failure_at = updated_at
        and last_failure_at >= v_first_failure_at
        and last_failure_component = 'full_reconciliation'
        and last_failure_code = 'RECONCILIATION_FAILED'
        and last_failure_code ~ '^[A-Z0-9_]{1,64}$'
        and last_failure_code not like '%://%'
        and last_heartbeat_at = v_heartbeat
        and last_member_snapshot_succeeded_at = v_success
        and last_ban_snapshot_succeeded_at = v_success
        and last_full_reconciliation_succeeded_at = v_success
    )
  then
    raise exception 'unsafe raw failure code reached failure health';
  end if;

  if not exists (
    select 1
    from public.discord_reconciliation_snapshots
    where id = v_snapshot_id
      and status = 'failed'
      and error_code = 'INCOMPLETE_SNAPSHOT'
  ) then
    raise exception 'recorded failure changed failed snapshot status';
  end if;

  select to_jsonb(health_row)
  into v_health_before
  from public.discord_sync_health as health_row
  where id = 1;

  begin
    delete from public.discord_sync_health where id = 1;

    perform public.record_discord_reconciliation_failure(
      v_missing_event_id,
      transaction_timestamp() + interval '5 seconds',
      repeat('5', 64),
      'SINGLETON_TEST_FAILURE'
    );
    raise exception 'missing health singleton did not fail';
  exception
    when raise_exception then
      if sqlerrm <> 'DISCORD_SYNC_HEALTH_SINGLETON_MISSING' then
        raise;
      end if;
  end;

  select to_jsonb(health_row)
  into v_health_after
  from public.discord_sync_health as health_row
  where id = 1;

  if v_health_after is distinct from v_health_before
    or (select count(*) from public.discord_sync_health) <> 1
    or exists (
      select 1
      from public.discord_membership_sync_events
      where event_id = v_missing_event_id
    )
  then
    raise exception 'missing singleton was inserted or event claim survived rollback';
  end if;

  if (select count(*) from public.discord_sync_health) <> 1 then
    raise exception 'failure health test changed singleton cardinality';
  end if;
end;
$$;

rollback;

do $$
declare
  v_suffix text :=
    current_setting('cancerculture.discord_failure_health_test_suffix');
  v_snapshot_id uuid :=
    current_setting(
      'cancerculture.discord_failure_health_test_snapshot'
    )::uuid;
  v_current_health text;
begin
  select to_jsonb(health_row)::text
  into v_current_health
  from public.discord_sync_health as health_row
  where id = 1;

  if v_current_health is distinct from current_setting(
    'cancerculture.discord_failure_health_test_baseline'
  ) then
    raise exception 'failure health test changes were not fully rolled back';
  end if;

  if (select count(*) from public.discord_sync_health) <> 1
    or exists (
      select 1
      from public.discord_membership_sync_events
      where event_id like '%' || v_suffix
    )
    or exists (
      select 1
      from public.discord_reconciliation_snapshots
      where id = v_snapshot_id
    )
  then
    raise exception 'failure health test fixture cleanup failed';
  end if;
end;
$$;

select 'discord_reconciliation_failure_health_ok' as result;
