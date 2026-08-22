import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL("../../supabase/migrations/20260822000100_complete_notification_push_outbox.sql", import.meta.url),
  "utf8"
);

test("the Push completion migration is additive, guarded, and hardens the exact payout producer", () => {
  assert.match(migration, /^begin;/u);
  assert.match(migration, /NOTIFICATION_PUSH_OUTBOX_BASELINE_MISMATCH/u);
  assert.match(migration, /create or replace function public\.request_donation_recipient_correction\(/u);
  assert.match(migration, /security definer[\s\S]*set search_path = public, pg_temp/u);
  assert.match(migration, /owner to postgres/u);
  assert.match(migration, /revoke all on function public\.request_donation_recipient_correction[\s\S]*from public, anon, authenticated, discord_bot, service_role/u);
  assert.match(migration, /grant execute on function public\.request_donation_recipient_correction[\s\S]*to service_role/u);
  assert.match(migration, /NOTIFICATION_PUSH_OUTBOX_POSTFLIGHT_MISMATCH/u);
  assert.match(migration, /commit;\s*$/u);
});

test("donation correction preserves private in-app detail but queues only the generic central Push", () => {
  const replacement = migration.slice(
    migration.indexOf("create or replace function public.request_donation_recipient_correction"),
    migration.indexOf("alter function public.request_donation_recipient_correction")
  );
  assert.match(replacement, /insert into public\.notification_events[\s\S]*public_body[\s\S]*Reason: ' \|\| v_reason/u);
  assert.match(replacement, /perform public\.enqueue_account_notification_event\([\s\S]*'donation_recipient_change_required'[\s\S]*'winners_claims'/u);
  assert.doesNotMatch(replacement, /insert into public\.account_notifications/u);
  assert.doesNotMatch(replacement, /push_delivery_jobs|webpush|sendNotification/u);
});
