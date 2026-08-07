import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repoRoot = new URL("../../", import.meta.url);
const migration = await readFile(
  new URL(
    "supabase/migrations/20260807000100_cycle_vote_observation_foundation.sql",
    repoRoot
  ),
  "utf8"
);

test("the observation migration is guarded and uses the verified UTC conversion", () => {
  assert.match(migration, /^begin;\s/u);
  assert.match(migration, /commit;\s*$/u);
  assert.match(migration, /set local lock_timeout = '5s'/u);
  assert.match(migration, /CYCLE_VOTE_OBSERVATION_TIMESTAMP_BASELINE_MISMATCH/u);
  assert.match(migration, /CYCLE_VOTE_OBSERVATION_NULL_VOTE_TIMESTAMP/u);
  assert.match(
    migration,
    /alter column created_at type timestamptz\s+using created_at at time zone 'UTC'/u
  );
  assert.match(migration, /alter column created_at set default clock_timestamp\(\)/u);
  assert.match(migration, /alter column created_at set not null/u);
  assert.doesNotMatch(migration, /insert into public\.votes/iu);
});

test("policy revisions and attempt bindings are immutable and server-only", () => {
  for (const table of [
    "cycle_vote_signal_policies",
    "cycle_vote_signal_policy_state",
    "cycle_vote_signal_bindings",
  ]) {
    assert.match(migration, new RegExp(`create table public\\.${table}`, "u"));
    assert.match(
      migration,
      new RegExp(`alter table public\\.${table} enable row level security`, "u")
    );
    assert.match(
      migration,
      new RegExp(`revoke all on table public\\.${table}`, "u")
    );
  }

  assert.match(migration, /cycle_vote_signal_policies_immutable/u);
  assert.match(migration, /cycle_vote_signal_bindings_immutable/u);
  assert.match(migration, /primary key \(cycle_id, reset_count\)/u);
  assert.match(migration, /mode = 'aggregate_only'/u);
  assert.match(migration, /'bucket_seconds', 300/u);
  assert.match(migration, /'peak_window_seconds', 300/u);
  assert.match(
    migration,
    /'recent_window_seconds', jsonb_build_array\(300, 900, 3600\)/u
  );
  assert.doesNotMatch(migration, /grant (?:insert|update|delete|all)[^;]*cycle_vote_signal/iu);
});

test("future cycle attempts freeze at voting start and resets keep the binding", () => {
  assert.match(migration, /create trigger voting_cycles_bind_vote_signal_policy/u);
  assert.match(migration, /new\.status::text <> 'voting_open'/u);
  assert.match(migration, /new\.reset_count/u);
  assert.match(migration, /binding\.cycle_id = new\.id/u);
  assert.match(migration, /on conflict \(cycle_id, reset_count\) do nothing/u);
  assert.doesNotMatch(
    migration,
    /delete from public\.cycle_vote_signal_bindings/iu
  );
});

test("close only queues a non-blocking snapshot and finalization is untouched", () => {
  assert.match(migration, /create trigger voting_cycles_queue_vote_observation/u);
  assert.match(migration, /new\.status::text = 'voting_closed'/u);
  assert.match(migration, /status text not null default 'pending'/u);
  assert.match(
    migration,
    /Observation availability must never block close, reset, or finalization/u
  );
  assert.match(migration, /when others then\s+--[^\n]+\s+return new/u);
  assert.doesNotMatch(migration, /create or replace function public\.finalize_cycle/u);
  assert.doesNotMatch(migration, /create or replace function public\.finalize_cycle_managed/u);
});

test("the retryable calculation stores aggregate-only metrics and safe failures", () => {
  assert.match(
    migration,
    /create or replace function public\.calculate_cycle_vote_observation_snapshot/u
  );
  assert.match(migration, /pg_advisory_xact_lock/u);
  assert.match(migration, /set_config\('TimeZone', 'UTC', true\)/u);
  assert.match(migration, /snapshot\.status = 'ready'/u);
  assert.match(
    migration,
    /range between current row\s+and interval '299\.999999 seconds' following/u
  );
  assert.match(migration, /greatest\([\s\S]*interval '60 minutes'/u);
  assert.match(migration, /floor\([\s\S]*\/ 300/u);
  assert.match(migration, /count\(distinct vote\.discord_user_id\)/u);
  assert.match(migration, /status = 'failed'/u);
  assert.match(migration, /error_code = failure_code/u);
  const observationTable = migration.match(
    /create table public\.cycle_vote_submission_observations \([\s\S]*?\n\);/u
  )?.[0];
  assert.ok(observationTable);
  assert.doesNotMatch(observationTable, /discord_user_id/u);
  assert.doesNotMatch(migration, /vote_logs/u);
  assert.doesNotMatch(migration, /(?:ip_address|turnstile|browser_id|device_id)/iu);
});

test("observation storage and lifecycle audit are private and append-only where required", () => {
  for (const table of [
    "cycle_vote_observation_snapshots",
    "cycle_vote_submission_observations",
    "cycle_vote_observation_events",
  ]) {
    assert.match(migration, new RegExp(`create table public\\.${table}`, "u"));
    assert.match(
      migration,
      new RegExp(`alter table public\\.${table} enable row level security`, "u")
    );
    assert.match(
      migration,
      new RegExp(`grant select on table public\\.${table} to service_role`, "u")
    );
  }

  assert.match(migration, /cycle_vote_observation_events_append_only/u);
  assert.match(migration, /'policy_frozen'/u);
  assert.match(migration, /'snapshot_ready'/u);
  assert.match(migration, /'snapshot_failed'/u);
  assert.match(migration, /CYCLE_VOTE_OBSERVATION_FUNCTION_POSTFLIGHT_MISMATCH/u);
});
