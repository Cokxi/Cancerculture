\set ON_ERROR_STOP on

begin;

select to_jsonb(health_row)::text as health_before
from public.discord_sync_health as health_row
where id = 1
for update
\gset

update public.discord_sync_health
set
  last_heartbeat_at = null,
  last_member_snapshot_succeeded_at = null,
  last_ban_snapshot_succeeded_at = null,
  last_full_reconciliation_succeeded_at = null,
  last_failure_at = null,
  last_failure_component = null,
  last_failure_code = null
where id = 1;

do $$
declare
  v_count integer;
begin
  if to_regclass('public.discord_sync_health') is null then
    raise exception 'discord_sync_health table is missing';
  end if;

  select count(*)::integer
  into v_count
  from public.discord_sync_health;

  if v_count <> 1
    or not exists (
      select 1
      from public.discord_sync_health
      where id = 1
    )
  then
    raise exception 'discord_sync_health singleton row is invalid';
  end if;

  begin
    insert into public.discord_sync_health (id) values (2);
    raise exception 'alternate singleton key was accepted';
  exception
    when check_violation then
      null;
  end;

  begin
    update public.discord_sync_health
    set
      last_failure_at = transaction_timestamp(),
      last_failure_component = 'unbounded_component',
      last_failure_code = 'TEST_FAILURE'
    where id = 1;
    raise exception 'invalid failure component was accepted';
  exception
    when check_violation then
      null;
  end;

  begin
    update public.discord_sync_health
    set
      last_failure_at = transaction_timestamp(),
      last_failure_component = 'unknown',
      last_failure_code = 'sensitive detail with spaces'
    where id = 1;
    raise exception 'invalid failure code was accepted';
  exception
    when check_violation then
      null;
  end;

  if has_table_privilege('anon', 'public.discord_sync_health', 'SELECT')
    or has_table_privilege('anon', 'public.discord_sync_health', 'INSERT')
    or has_table_privilege('anon', 'public.discord_sync_health', 'UPDATE')
    or has_table_privilege('anon', 'public.discord_sync_health', 'DELETE')
    or has_table_privilege('authenticated', 'public.discord_sync_health', 'SELECT')
    or has_table_privilege('authenticated', 'public.discord_sync_health', 'INSERT')
    or has_table_privilege('authenticated', 'public.discord_sync_health', 'UPDATE')
    or has_table_privilege('authenticated', 'public.discord_sync_health', 'DELETE')
  then
    raise exception 'public application roles retain direct health-table access';
  end if;

  if not has_table_privilege(
    'service_role',
    'public.discord_sync_health',
    'SELECT'
  ) or not has_table_privilege(
    'service_role',
    'public.discord_sync_health',
    'UPDATE'
  ) then
    raise exception 'service_role lacks required health-table access';
  end if;

  if has_table_privilege(
    'service_role',
    'public.discord_sync_health',
    'INSERT'
  ) or has_table_privilege(
    'service_role',
    'public.discord_sync_health',
    'DELETE'
  ) then
    raise exception 'service_role can replace or remove the singleton row';
  end if;
end;
$$;

set local role service_role;

select id
from public.discord_sync_health
where id = 1;

update public.discord_sync_health
set
  last_heartbeat_at = transaction_timestamp(),
  last_member_snapshot_succeeded_at = transaction_timestamp(),
  last_ban_snapshot_succeeded_at = transaction_timestamp(),
  last_full_reconciliation_succeeded_at = transaction_timestamp(),
  last_failure_at = transaction_timestamp(),
  last_failure_component = 'heartbeat',
  last_failure_code = 'TEST_FAILURE',
  updated_at = transaction_timestamp()
where id = 1;

reset role;

do $$
begin
  if not exists (
    select 1
    from public.discord_sync_health
    where id = 1
      and last_heartbeat_at is not null
      and last_member_snapshot_succeeded_at is not null
      and last_ban_snapshot_succeeded_at is not null
      and last_full_reconciliation_succeeded_at is not null
      and last_failure_at is not null
      and last_failure_component = 'heartbeat'
      and last_failure_code = 'TEST_FAILURE'
  ) then
    raise exception 'trusted health update was not stored';
  end if;

  if (select count(*) from public.discord_sync_health) <> 1 then
    raise exception 'health test created an additional singleton row';
  end if;
end;
$$;

rollback;

select 1 / coalesce((
    select to_jsonb(health_row)
    from public.discord_sync_health as health_row
    where id = 1
  ) = :'health_before'::jsonb, false)::integer as health_state_restored;

select 'discord_sync_health_foundation_ok' as result;
