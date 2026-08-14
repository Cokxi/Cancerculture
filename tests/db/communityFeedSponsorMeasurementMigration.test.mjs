import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL(
    "../../supabase/migrations/20260813000100_community_feed_sponsor_measurement.sql",
    import.meta.url,
  ),
  "utf8",
);

test("Sponsor measurement migration is additive, atomic, and 30-minute concurrency-safe", () => {
  assert.match(migration, /add column feed_kind text/u);
  assert.match(migration, /add column measurement_window_start timestamptz/u);
  assert.match(migration, /interval '30 minutes'/u);
  assert.match(migration, /sponsor_tracking_events_measurement_window_uidx/u);
  assert.match(migration, /on conflict do nothing/u);
  assert.match(migration, /return jsonb_build_object\('outcome', 'deduped'\)/u);
  assert.doesNotMatch(migration, /drop table|truncate table/iu);
});

test("Sponsor measurement RPCs are definer-hardened and Browser roles receive no execution", () => {
  for (const signature of [
    "record_sponsor_event_v2(bigint, text, text, text, text)",
    "prune_sponsor_measurement_retention()",
  ]) {
    assert.ok(migration.includes(`alter function public.${signature}`));
    assert.ok(migration.includes(`revoke all on function public.${signature}`));
    assert.ok(migration.includes(`grant execute on function public.${signature}`));
  }
  assert.match(migration, /security definer[\s\S]*set search_path = public, pg_temp/u);
  assert.match(migration, /revoke insert, update, delete, truncate[\s\S]*sponsor_tracking_events from service_role/u);
});

test("raw pseudonymous data and long-lived aggregates have explicit enforced retention", () => {
  assert.match(migration, /created_at < transaction_timestamp\(\) - interval '30 days'/u);
  assert.match(migration, /interval '25 months'/u);
  assert.match(migration, /sponsor_tracking_aggregates/u);
  assert.match(migration, /enable row level security/u);
  assert.match(migration, /has_table_privilege\('anon', 'public\.sponsor_tracking_aggregates', 'select'\)/u);
});
