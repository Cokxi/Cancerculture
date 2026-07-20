begin;

alter table public.discord_sync_health
  add column last_heartbeat_at timestamptz,
  add column last_member_snapshot_succeeded_at timestamptz,
  add column last_ban_snapshot_succeeded_at timestamptz,
  add column last_full_reconciliation_succeeded_at timestamptz,
  add column last_failure_at timestamptz,
  add column last_failure_component text,
  add column last_failure_code text,
  add constraint discord_sync_health_failure_component_check
    check (
      last_failure_component is null
      or last_failure_component in (
        'heartbeat',
        'member_snapshot',
        'ban_snapshot',
        'full_reconciliation',
        'unknown'
      )
    ),
  add constraint discord_sync_health_failure_code_check
    check (
      last_failure_code is null
      or last_failure_code ~ '^[A-Z0-9_]{1,64}$'
    ),
  add constraint discord_sync_health_failure_fields_check
    check (
      (
        last_failure_at is null
        and last_failure_component is null
        and last_failure_code is null
      )
      or (
        last_failure_at is not null
        and last_failure_component is not null
        and last_failure_code is not null
      )
    );

insert into public.discord_sync_health (id)
values (1)
on conflict (id) do nothing;

alter table public.discord_sync_health enable row level security;

revoke all on table public.discord_sync_health
  from public, anon, authenticated, discord_bot;
revoke all on table public.discord_sync_health
  from service_role;
grant select, update on table public.discord_sync_health
  to service_role;

comment on column public.discord_sync_health.last_heartbeat_at is
  'Last Bot heartbeat successfully accepted by the Website.';
comment on column public.discord_sync_health.last_member_snapshot_succeeded_at is
  'Last completely successful Discord member snapshot.';
comment on column public.discord_sync_health.last_ban_snapshot_succeeded_at is
  'Last completely successful Discord ban snapshot.';
comment on column public.discord_sync_health.last_full_reconciliation_succeeded_at is
  'Last reconciliation for which both member and ban snapshots completely succeeded.';
comment on column public.discord_sync_health.last_failure_at is
  'Timestamp of the latest known heartbeat or Discord sync failure.';
comment on column public.discord_sync_health.last_failure_component is
  'Bounded machine-readable component for the latest known failure.';
comment on column public.discord_sync_health.last_failure_code is
  'Sanitized machine-readable failure code without sensitive details.';

commit;
