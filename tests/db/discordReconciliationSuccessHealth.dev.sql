\set ON_ERROR_STOP on

do $$
begin
  perform set_config(
    'cancerculture.discord_health_test_suffix',
    gen_random_uuid()::text,
    false
  );
  perform set_config(
    'cancerculture.discord_health_test_baseline',
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

create function public.discord_reconciliation_success_health_test_fail()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.event_type = 'snapshot_finalize'
    and new.result_status = 'applied'
    and new.event_id = (
      'test-health-error-'
      || current_setting('cancerculture.discord_health_test_suffix')
    )
  then
    raise exception 'DISCORD_RECONCILIATION_TEST_INTENTIONAL_FAILURE';
  end if;

  return new;
end;
$$;

create trigger discord_reconciliation_success_health_test_fail_trigger
before update of result_status
on public.discord_membership_sync_events
for each row
execute function public.discord_reconciliation_success_health_test_fail();

do $$
declare
  v_suffix text :=
    current_setting('cancerculture.discord_health_test_suffix');
  v_seed bigint := 970000000000000000
    + floor(random() * 1000000000000000)::bigint;
  v_member text := v_seed::text;
  v_ban text := (v_seed + 1)::text;
  v_error_member text := (v_seed + 2)::text;
  v_observed timestamptz := '2000-01-01 00:00:00+00';
  v_old_success timestamptz :=
    transaction_timestamp() - interval '2 days';
  v_future_success timestamptz :=
    transaction_timestamp() + interval '1 day';
  v_heartbeat timestamptz :=
    transaction_timestamp() - interval '5 minutes';
  v_failure_at timestamptz :=
    transaction_timestamp() - interval '10 minutes';
  v_success_snapshot uuid := gen_random_uuid();
  v_member_mismatch_snapshot uuid := gen_random_uuid();
  v_ban_mismatch_snapshot uuid := gen_random_uuid();
  v_error_snapshot uuid := gen_random_uuid();
  v_missing_health_snapshot uuid := gen_random_uuid();
  v_later_snapshot uuid := gen_random_uuid();
  v_result jsonb;
  v_member_success timestamptz;
  v_ban_success timestamptz;
  v_full_success timestamptz;
  v_updated_at timestamptz;
  v_health_before jsonb;
  v_health_after jsonb;
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

  if exists (
    select 1
    from public.discord_member_state
    where discord_user_id in (v_member, v_ban, v_error_member)
  ) then
    raise exception 'DISCORD_RECONCILIATION_HEALTH_TEST_FIXTURE_COLLISION';
  end if;

  update public.discord_sync_health
  set
    last_heartbeat_at = v_heartbeat,
    last_member_snapshot_succeeded_at = v_old_success,
    last_ban_snapshot_succeeded_at = v_old_success,
    last_full_reconciliation_succeeded_at = v_old_success,
    last_failure_at = v_failure_at,
    last_failure_component = 'full_reconciliation',
    last_failure_code = 'TEST_FAILURE',
    updated_at = v_old_success
  where id = 1;

  insert into public.discord_reconciliation_snapshots (
    id,
    observed_at,
    expected_member_count,
    expected_ban_count
  ) values (
    v_success_snapshot,
    v_observed,
    1,
    1
  );

  insert into public.discord_reconciliation_members (
    snapshot_id,
    discord_user_id,
    discord_username
  ) values (
    v_success_snapshot,
    v_member,
    'health-test-member'
  );

  insert into public.discord_reconciliation_bans (
    snapshot_id,
    discord_user_id,
    discord_username
  ) values (
    v_success_snapshot,
    v_ban,
    'health-test-ban'
  );

  v_result := public.finalize_discord_reconciliation_snapshot(
    'test-health-success-' || v_suffix,
    v_observed + interval '1 second',
    repeat('a', 64),
    v_success_snapshot
  );

  if v_result ->> 'outcome' <> 'applied' then
    raise exception 'complete reconciliation was not applied: %', v_result;
  end if;

  select
    last_member_snapshot_succeeded_at,
    last_ban_snapshot_succeeded_at,
    last_full_reconciliation_succeeded_at,
    updated_at
  into
    v_member_success,
    v_ban_success,
    v_full_success,
    v_updated_at
  from public.discord_sync_health
  where id = 1;

  if v_member_success is null
    or v_member_success <> v_ban_success
    or v_member_success <> v_full_success
    or v_member_success <> v_updated_at
    or v_member_success < v_old_success
  then
    raise exception 'successful reconciliation timestamps are not equal and monotonic';
  end if;

  if exists (
    select 1
    from public.discord_sync_health
    where id = 1
      and (
        last_heartbeat_at is distinct from v_heartbeat
        or last_failure_at is distinct from v_failure_at
        or last_failure_component is distinct from 'full_reconciliation'
        or last_failure_code is distinct from 'TEST_FAILURE'
      )
  ) then
    raise exception 'success changed heartbeat or failure health fields';
  end if;

  select to_jsonb(health_row)
  into v_health_before
  from public.discord_sync_health as health_row
  where id = 1;

  v_result := public.finalize_discord_reconciliation_snapshot(
    'test-health-success-' || v_suffix,
    v_observed + interval '1 second',
    repeat('a', 64),
    v_success_snapshot
  );

  if v_result ->> 'outcome' <> 'replay' then
    raise exception 'identical finalize event was not treated as replay: %', v_result;
  end if;

  select to_jsonb(health_row)
  into v_health_after
  from public.discord_sync_health as health_row
  where id = 1;

  if v_health_after is distinct from v_health_before then
    raise exception 'replayed finalize event changed health timestamps';
  end if;

  insert into public.discord_reconciliation_snapshots (
    id,
    observed_at,
    expected_member_count,
    expected_ban_count
  ) values (
    v_member_mismatch_snapshot,
    v_observed + interval '10 seconds',
    1,
    0
  );

  v_result := public.finalize_discord_reconciliation_snapshot(
    'test-health-member-mismatch-' || v_suffix,
    v_observed + interval '11 seconds',
    repeat('b', 64),
    v_member_mismatch_snapshot
  );

  if v_result ->> 'outcome' <> 'incomplete_snapshot'
    or exists (
      select 1
      from public.discord_sync_health
      where id = 1
        and (
          last_member_snapshot_succeeded_at <> v_member_success
          or last_ban_snapshot_succeeded_at <> v_ban_success
          or last_full_reconciliation_succeeded_at <> v_full_success
        )
    )
  then
    raise exception 'member-count mismatch changed success health';
  end if;

  insert into public.discord_reconciliation_snapshots (
    id,
    observed_at,
    expected_member_count,
    expected_ban_count
  ) values (
    v_ban_mismatch_snapshot,
    v_observed + interval '20 seconds',
    0,
    1
  );

  v_result := public.finalize_discord_reconciliation_snapshot(
    'test-health-ban-mismatch-' || v_suffix,
    v_observed + interval '21 seconds',
    repeat('c', 64),
    v_ban_mismatch_snapshot
  );

  if v_result ->> 'outcome' <> 'incomplete_snapshot'
    or exists (
      select 1
      from public.discord_sync_health
      where id = 1
        and (
          last_member_snapshot_succeeded_at <> v_member_success
          or last_ban_snapshot_succeeded_at <> v_ban_success
          or last_full_reconciliation_succeeded_at <> v_full_success
        )
    )
  then
    raise exception 'ban-count mismatch changed success health';
  end if;

  insert into public.discord_reconciliation_snapshots (
    id,
    observed_at,
    expected_member_count,
    expected_ban_count
  ) values (
    v_error_snapshot,
    v_observed + interval '30 seconds',
    1,
    0
  );

  insert into public.discord_reconciliation_members (
    snapshot_id,
    discord_user_id,
    discord_username
  ) values (
    v_error_snapshot,
    v_error_member,
    'health-test-error'
  );

  select to_jsonb(health_row)
  into v_health_before
  from public.discord_sync_health as health_row
  where id = 1;

  begin
    perform public.finalize_discord_reconciliation_snapshot(
      'test-health-error-' || v_suffix,
      v_observed + interval '31 seconds',
      repeat('d', 64),
      v_error_snapshot
    );
    raise exception 'intentional finalize failure was not raised';
  exception
    when raise_exception then
      if sqlerrm <> 'DISCORD_RECONCILIATION_TEST_INTENTIONAL_FAILURE' then
        raise;
      end if;
  end;

  select to_jsonb(health_row)
  into v_health_after
  from public.discord_sync_health as health_row
  where id = 1;

  if v_health_after is distinct from v_health_before
    or not exists (
      select 1
      from public.discord_reconciliation_snapshots
      where id = v_error_snapshot
        and status = 'collecting'
        and finalized_at is null
    )
    or exists (
      select 1
      from public.discord_member_state
      where discord_user_id = v_error_member
    )
  then
    raise exception 'intentional error did not roll back snapshot and health together';
  end if;

  insert into public.discord_reconciliation_snapshots (
    id,
    observed_at,
    expected_member_count,
    expected_ban_count
  ) values (
    v_missing_health_snapshot,
    v_observed + interval '40 seconds',
    0,
    0
  );

  select to_jsonb(health_row)
  into v_health_before
  from public.discord_sync_health as health_row
  where id = 1;

  begin
    delete from public.discord_sync_health where id = 1;

    perform public.finalize_discord_reconciliation_snapshot(
      'test-health-missing-' || v_suffix,
      v_observed + interval '41 seconds',
      repeat('e', 64),
      v_missing_health_snapshot
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
    or not exists (
      select 1
      from public.discord_reconciliation_snapshots
      where id = v_missing_health_snapshot
        and status = 'collecting'
        and finalized_at is null
    )
  then
    raise exception 'missing singleton was inserted or finalize was not rolled back';
  end if;

  update public.discord_sync_health
  set
    last_member_snapshot_succeeded_at = v_future_success,
    last_ban_snapshot_succeeded_at = v_future_success,
    last_full_reconciliation_succeeded_at = v_future_success,
    updated_at = v_future_success
  where id = 1;

  insert into public.discord_reconciliation_snapshots (
    id,
    observed_at,
    expected_member_count,
    expected_ban_count
  ) values (
    v_later_snapshot,
    v_observed + interval '50 seconds',
    0,
    0
  );

  v_result := public.finalize_discord_reconciliation_snapshot(
    'test-health-later-' || v_suffix,
    v_observed + interval '51 seconds',
    repeat('f', 64),
    v_later_snapshot
  );

  if v_result ->> 'outcome' <> 'applied'
    or exists (
      select 1
      from public.discord_sync_health
      where id = 1
        and (
          last_member_snapshot_succeeded_at < v_future_success
          or last_member_snapshot_succeeded_at
            <> last_ban_snapshot_succeeded_at
          or last_member_snapshot_succeeded_at
            <> last_full_reconciliation_succeeded_at
          or last_member_snapshot_succeeded_at <> updated_at
        )
    )
  then
    raise exception 'later successful reconciliation regressed health timestamps';
  end if;

  if (select count(*) from public.discord_sync_health) <> 1 then
    raise exception 'reconciliation health test changed singleton cardinality';
  end if;
end;
$$;

rollback;

do $$
declare
  v_suffix text :=
    current_setting('cancerculture.discord_health_test_suffix');
  v_current_health text;
begin
  select to_jsonb(health_row)::text
  into v_current_health
  from public.discord_sync_health as health_row
  where id = 1;

  if v_current_health is distinct from current_setting(
    'cancerculture.discord_health_test_baseline'
  ) then
    raise exception 'reconciliation health test changes were not fully rolled back';
  end if;

  if (select count(*) from public.discord_sync_health) <> 1
    or exists (
      select 1
      from public.discord_membership_sync_events
      where event_id like '%' || v_suffix
    )
    or to_regprocedure(
      'public.discord_reconciliation_success_health_test_fail()'
    ) is not null
    or exists (
      select 1
      from pg_trigger
      where tgname =
        'discord_reconciliation_success_health_test_fail_trigger'
        and not tgisinternal
    )
  then
    raise exception 'reconciliation health test cleanup failed';
  end if;
end;
$$;

select 'discord_reconciliation_success_health_ok' as result;
