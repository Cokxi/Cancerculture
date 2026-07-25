import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const migrationUrl = new URL(
  "../../supabase/migrations/20260724000100_discord_joined_at_provenance.sql",
  import.meta.url
);
const migration = await readFile(migrationUrl, "utf8");

test("the additive migration stages validated join provenance", () => {
  assert.match(
    migration,
    /add column if not exists discord_joined_at timestamptz/
  );
  assert.match(
    migration,
    /add column if not exists membership_observed_at timestamptz/
  );
  assert.match(
    migration,
    /discord_joined_at is null\s+or membership_observed_at is not null/
  );
  assert.match(
    migration,
    /discord_joined_at is null\s+or discord_joined_at <= membership_observed_at/
  );
});

test("the live path uses a distinct service-role-only V2 RPC", () => {
  assert.match(
    migration,
    /create or replace function public\.apply_discord_member_join_v2\(/
  );
  assert.match(
    migration,
    /discord_joined_at = coalesce\(p_joined_at, p_observed_at\)/
  );
  assert.match(
    migration,
    /revoke all on function public\.apply_discord_member_join_v2\([\s\S]*?\) from public, anon, authenticated, discord_bot, service_role;/
  );
  assert.match(
    migration,
    /grant execute on function public\.apply_discord_member_join_v2\([\s\S]*?\) to service_role;/
  );
  assert.doesNotMatch(
    migration,
    /drop function (?:if exists )?public\.apply_discord_member_join\(/
  );
});

test("snapshot duplicates conflict instead of using last-write-wins", () => {
  assert.match(
    migration,
    /discord_joined_at is distinct from v_joined_at/
  );
  assert.match(
    migration,
    /membership_observed_at\s+is distinct from v_membership_observed_at/
  );
  assert.match(migration, /error_code = 'CONFLICTING_MEMBER_RECORD'/);
  assert.match(
    migration,
    /return jsonb_build_object\('outcome', 'snapshot_conflict'\)/
  );
});

test("snapshot ordering remains based on snapshot observation time", () => {
  assert.match(
    migration,
    /v_snapshot\.observed_at > v_state\.discord_membership_observed_at/
  );
  assert.match(
    migration,
    /when v_snapshot_joined_at is not null\s+then v_snapshot_joined_at\s+when is_in_discord then discord_joined_at\s+else v_snapshot\.observed_at/
  );
  assert.match(
    migration,
    /discord_membership_observed_at = v_snapshot\.observed_at/
  );
  assert.doesNotMatch(migration, /\b(?:least|min)\s*\(\s*discord_joined_at/i);
});
