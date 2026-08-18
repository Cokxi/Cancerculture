import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL("../../supabase/migrations/20260818000900_winner_correction_ready_notification.sql", import.meta.url),
  "utf8"
);

test("general Winner Payouts corrections notify the winner exactly from their append-only Claim event", () => {
  assert.match(migration, /create function public\.produce_winner_correction_ready_notification/u);
  assert.match(migration, /after insert on public\.winner_claim_events/u);
  assert.match(migration, /new\.action = 'correction_ready' and new\.case_reference is null/u);
  assert.match(migration, /'winner-correction-ready:' \|\| new\.claim_id::text \|\| ':' \|\| new\.correction_version::text/u);
  assert.match(migration, /'winner_correction_ready',[\s\S]*'winners_claims'/u);
  assert.match(migration, /resolve_account_notification_visibility\(v_owner_id, 'winners_claims'\)/u);
});

test("Wallet Issue corrections keep their dedicated notification and cannot be duplicated by the generic trigger", () => {
  assert.match(migration, /when \(new\.action = 'correction_ready' and new\.case_reference is null\)/u);
  assert.match(migration, /Wallet Issue resolutions retain their separate event/u);
});

test("the notification center and database event allowlist expose the new Claim-ready copy", () => {
  assert.match(migration, /notification_event_type_check[\s\S]*'winner_correction_ready'/u);
  assert.match(migration, /when 'winner_correction_ready' then 'Winner claim ready'/u);
  assert.match(migration, /when 'winner_correction_ready' then 'Review the full recipient and confirm your Claim within 24 hours\.'/u);
  assert.match(migration, /revoke all on function public\.produce_winner_correction_ready_notification\(\)[\s\S]*service_role/u);
});
