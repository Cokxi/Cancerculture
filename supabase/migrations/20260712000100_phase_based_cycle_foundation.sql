create extension if not exists pgcrypto;

do $$
begin
  if exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public'
      and t.typname = 'voting_cycle_status'
  ) then
    alter type public.voting_cycle_status add value if not exists 'draft';
    alter type public.voting_cycle_status add value if not exists 'submission_open';
    alter type public.voting_cycle_status add value if not exists 'submission_closed';
    alter type public.voting_cycle_status add value if not exists 'voting_open';
    alter type public.voting_cycle_status add value if not exists 'voting_closed';
    alter type public.voting_cycle_status add value if not exists 'completed';
    alter type public.voting_cycle_status add value if not exists 'archived';
    alter type public.voting_cycle_status add value if not exists 'cancelled';

    comment on type public.voting_cycle_status is
      'Phase-based cycle statuses. Legacy values remain for compatibility: active should later map to submission_open or the correct current phase, and finished should later map to completed.';
  end if;
end $$;

alter table public.voting_cycles
  add column if not exists submission_starts_at timestamptz,
  add column if not exists submission_ends_at timestamptz,
  add column if not exists voting_starts_at timestamptz,
  add column if not exists voting_ends_at timestamptz,
  add column if not exists results_published_at timestamptz,
  add column if not exists archived_at timestamptz,
  add column if not exists submission_warn_threshold integer,
  add column if not exists submission_warned_at timestamptz,
  add column if not exists submission_auto_close_enabled boolean not null default false,
  add column if not exists submission_auto_close_threshold integer,
  add column if not exists submission_auto_closed_at timestamptz,
  add column if not exists votes_per_user integer not null default 2,
  add column if not exists allow_self_vote boolean not null default false,
  add column if not exists is_sponsored boolean not null default false,
  add column if not exists sponsorship_id bigint,
  add column if not exists sponsor_name_snapshot text,
  add column if not exists sponsor_link_snapshot text,
  add column if not exists sponsor_banner_url_snapshot text;

do $$
begin
  if to_regclass('public.cycle_sponsorships') is not null
    and not exists (
      select 1
      from pg_constraint
      where conname = 'voting_cycles_sponsorship_id_fkey'
        and conrelid = 'public.voting_cycles'::regclass
    )
  then
    alter table public.voting_cycles
      add constraint voting_cycles_sponsorship_id_fkey
      foreign key (sponsorship_id)
      references public.cycle_sponsorships(id)
      on delete set null;
  end if;
end $$;

comment on column public.voting_cycles.status is
  'Legacy statuses active/finalizing/finished remain valid during the phase migration. Later, active should map to submission_open or the correct phase, and finished should map to completed.';
comment on column public.voting_cycles.submission_starts_at is
  'Future phase timing: when submissions open for this cycle.';
comment on column public.voting_cycles.submission_ends_at is
  'Future phase timing: when submissions close for this cycle.';
comment on column public.voting_cycles.voting_starts_at is
  'Future phase timing: when voting opens for this cycle.';
comment on column public.voting_cycles.voting_ends_at is
  'Future phase timing: when voting closes for this cycle.';
comment on column public.voting_cycles.results_published_at is
  'Future phase timing: when results are published.';
comment on column public.voting_cycles.archived_at is
  'Future phase timing: when this cycle is archived.';
comment on column public.voting_cycles.submission_warn_threshold is
  'Future admin warning threshold for high submission counts.';
comment on column public.voting_cycles.submission_warned_at is
  'Tracks when the submission threshold warning was emitted.';
comment on column public.voting_cycles.submission_auto_close_enabled is
  'Future opt-in flag for automatically closing submissions at a configured threshold.';
comment on column public.voting_cycles.submission_auto_close_threshold is
  'Future submission count threshold for automatic submission close.';
comment on column public.voting_cycles.submission_auto_closed_at is
  'Tracks when submissions were automatically closed by threshold logic.';
comment on column public.voting_cycles.votes_per_user is
  'Future voting rule. Defaults to 2 to preserve the planned phase-based voting behavior without changing current code.';
comment on column public.voting_cycles.allow_self_vote is
  'Future voting rule. Defaults to false to keep self-voting disabled.';
comment on column public.voting_cycles.is_sponsored is
  'Sponsorship snapshot flag intended to avoid querying sponsorship metadata for every non-sponsored cycle.';
comment on column public.voting_cycles.sponsorship_id is
  'Optional reference to cycle_sponsorships. Kept nullable for backward compatibility and future sponsorship snapshots.';
comment on column public.voting_cycles.sponsor_name_snapshot is
  'Sponsorship snapshot copied onto the cycle for fast historical display.';
comment on column public.voting_cycles.sponsor_link_snapshot is
  'Sponsorship snapshot copied onto the cycle for fast historical display.';
comment on column public.voting_cycles.sponsor_banner_url_snapshot is
  'Sponsorship banner snapshot copied onto the cycle for fast historical display.';

do $$
begin
  if to_regclass('public.app_config') is not null then
    comment on table public.app_config is
      'Legacy runtime config. TODO phase migration: cycle_theme, next_cycle_theme, and cycle_end_at should later move into voting_cycles or a get_cycle_hud_state RPC.';
  end if;
end $$;

create table if not exists public.cycle_events (
  id uuid primary key default gen_random_uuid(),
  cycle_id bigint not null references public.voting_cycles(id) on delete cascade,
  event_type text not null,
  actor_type text not null default 'system',
  actor_discord_user_id text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  processed_by_bot_at timestamptz,
  discord_announced_at timestamptz,
  telegram_announced_at timestamptz
);

comment on table public.cycle_events is
  'Foundation table for phase/admin/bot events. Future Discord/Telegram bot can poll this without changing current cycle behavior.';
comment on column public.cycle_events.event_type is
  'Event name such as cycle_started, submission_closed, voting_opened, reminder_created, or cycle_completed.';
comment on column public.cycle_events.actor_type is
  'Actor category for audit/bot context, for example system, admin, moderator, or bot.';
comment on column public.cycle_events.payload is
  'Flexible metadata for future announcements and audit details.';
comment on column public.cycle_events.processed_by_bot_at is
  'Set by the future bot after it has processed this event.';

create index if not exists cycle_events_cycle_id_created_at_idx
  on public.cycle_events (cycle_id, created_at desc);

create index if not exists cycle_events_event_type_idx
  on public.cycle_events (event_type);

create index if not exists cycle_events_unprocessed_bot_idx
  on public.cycle_events (created_at)
  where processed_by_bot_at is null;

create table if not exists public.cycle_reminders (
  id uuid primary key default gen_random_uuid(),
  cycle_id bigint not null references public.voting_cycles(id) on delete cascade,
  phase text not null,
  reminder_type text not null,
  due_at timestamptz not null,
  message_payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  processed_at timestamptz,
  discord_sent_at timestamptz,
  telegram_sent_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table public.cycle_reminders is
  'Foundation table for due reminders that a future Hetzner Discord/Telegram bot can poll and process.';
comment on column public.cycle_reminders.phase is
  'Future phase associated with the reminder, such as submission_open, voting_open, or completed.';
comment on column public.cycle_reminders.reminder_type is
  'Reminder category such as cycle_ending_soon, voting_ending_soon, or results_pending.';
comment on column public.cycle_reminders.status is
  'Processing state for future bot polling. Defaults to pending.';
comment on column public.cycle_reminders.message_payload is
  'Flexible metadata for future Discord/Telegram reminder rendering.';

create index if not exists cycle_reminders_status_due_at_idx
  on public.cycle_reminders (status, due_at);

create index if not exists cycle_reminders_cycle_id_due_at_idx
  on public.cycle_reminders (cycle_id, due_at);
