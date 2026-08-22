import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationPath = new URL(
  "../../supabase/migrations/20260822000400_push_delivery_event_time_eligibility.sql",
  import.meta.url,
);

test("Push delivery eligibility is evaluated at the immutable event time", async () => {
  const migration = await readFile(migrationPath, "utf8");

  assert.match(migration, /push_subscription_allows_event_at\(/u);
  assert.match(migration, /subscription\.created_at <= p_event_occurred_at/u);
  assert.match(migration, /preference\.updated_at <= p_event_occurred_at/u);
  assert.match(migration, /cycle\.updated_at <= p_event_occurred_at/u);
  assert.equal(
    migration.match(/v_event\.occurred_at/gu)?.length,
    2,
    "broadcast selection and per-device job creation must use the event time",
  );
  assert.match(migration, /last_error_code = 'event_not_eligible'/u);
  assert.match(migration, /job\.subscription_id, event\.event_type, event\.category_key,[\s\S]*event\.occurred_at/u);
  assert.match(migration, /security definer[\s\S]*set search_path = public, pg_temp/u);
  assert.match(migration, /revoke all on function public\.push_subscription_allows_event_at/u);
  assert.doesNotMatch(migration, /grant execute on function public\.push_subscription_allows_event_at/u);
});
