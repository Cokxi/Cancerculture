import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  encodeNotificationCursor,
  parseNotificationCursor,
} from "../../lib/notifications/notificationCursor.ts";
import {
  PUSH_PAYLOAD_CATALOG,
  buildGenericPushPayload,
  getServiceWorkerPushAllowlist,
} from "../../lib/notifications/pushPayload.ts";

const root = new URL("../../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("notification cursors are opaque, bounded, and fail closed", () => {
  const cursor = encodeNotificationCursor({
    at: "2026-08-18T10:00:00.000Z",
    id: "123e4567-e89b-42d3-a456-426614174000",
  });
  assert.deepEqual(parseNotificationCursor(cursor), {
    at: "2026-08-18T10:00:00.000Z",
    id: "123e4567-e89b-42d3-a456-426614174000",
  });
  assert.equal(parseNotificationCursor("not-a-cursor"), null);
  assert.equal(parseNotificationCursor("x".repeat(513)), null);
});

test("push payloads are generic and contain no private producer data", () => {
  const payload = buildGenericPushPayload({
    eventType: "submission_disqualified",
    categoryKey: "submission_moderation",
    notificationId: "123e4567-e89b-42d3-a456-426614174000",
  });
  const serialized = JSON.stringify(payload);
  assert.deepEqual(Object.keys(payload).sort(), ["body", "category", "notificationId", "title"]);
  assert.doesNotMatch(serialized, /wallet|discord|reason|report|comment|team|secret|transaction|amount/iu);
  assert.throws(() => buildGenericPushPayload({
    eventType: "unknown",
    categoryKey: "submission_moderation",
    notificationId: "123e4567-e89b-42d3-a456-426614174000",
  }), /PUSH_PAYLOAD_INVALID/u);
  assert.throws(() => buildGenericPushPayload({
    eventType: "submission_disqualified",
    categoryKey: "winners_claims",
    notificationId: "123e4567-e89b-42d3-a456-426614174000",
  }), /PUSH_PAYLOAD_INVALID/u);
  assert.throws(() => buildGenericPushPayload({
    eventType: "submission_disqualified",
    categoryKey: "submission_moderation",
    notificationId: "not-a-uuid-------------------------",
  }), /PUSH_PAYLOAD_INVALID/u);
});

test("the central Push catalog covers every currently implemented notification event", () => {
  const expected = [
    "winner_claim_required",
    "winner_correction_ready",
    "winner_donation_finalized",
    "winner_payout_sent",
    "donation_recipient_change_required",
    "submission_disqualified",
    "submission_reinstated",
    "cycle_results_ready",
    "cycle_started",
    "cycle_submission_ending_15m",
    "cycle_submission_ending_10m",
    "cycle_submission_ending_5m",
    "cycle_submission_ended",
    "cycle_voting_ending_15m",
    "cycle_voting_ending_10m",
    "cycle_voting_ending_5m",
    "cycle_voting_ended",
    "community_vote_announced",
    "wallet_issue_received",
    "wallet_issue_correction_ready",
    "wallet_issue_resolved",
  ];
  assert.deepEqual(Object.keys(PUSH_PAYLOAD_CATALOG), expected);
  assert.equal(getServiceWorkerPushAllowlist().length, expected.length);

  for (const [eventType, content] of Object.entries(PUSH_PAYLOAD_CATALOG)) {
    const payload = buildGenericPushPayload({
      eventType,
      categoryKey: content.categoryKey,
      notificationId: "123e4567-e89b-42d3-a456-426614174000",
    });
    assert.deepEqual(payload, {
      title: content.title,
      body: content.body,
      category: content.categoryKey,
      notificationId: "123e4567-e89b-42d3-a456-426614174000",
    });
    assert.doesNotMatch(
      JSON.stringify(payload),
      /discord|report text|moderation reason|charity reason|transaction|team identity|secret/iu
    );
  }
});

test("the additive migration produces immutable idempotent events in source transactions", async () => {
  const migration = await source("supabase/migrations/20260818000200_notification_foundation_and_team_inbox.sql");
  assert.match(migration, /create table public\.notification_events/u);
  assert.match(migration, /producer_key text not null unique/u);
  assert.match(migration, /on conflict \(producer_key\) do nothing/u);
  assert.match(migration, /after insert on public\.winner_claims/u);
  assert.match(migration, /after insert on public\.submission_disqualification_events/u);
  assert.match(migration, /after insert on public\.cycle_events/u);
  assert.match(migration, /before update or delete on public\.notification_events/u);
  const dqProducer = migration.slice(
    migration.indexOf("create function public.produce_submission_moderation_notification"),
    migration.indexOf("create trigger submission_dq_events_produce_notification")
  );
  assert.doesNotMatch(dqProducer, /reason|actor|moderation_log|payload/iu);
  assert.match(dqProducer, /new\.subject_discord_user_id/u);
  assert.match(dqProducer, /\/my-profile\/disqualifications/u);
});

test("notification storage, outbox, subscriptions, and owner RPCs are closed and bounded", async () => {
  const [foundation, followUp] = await Promise.all([
    source("supabase/migrations/20260818000200_notification_foundation_and_team_inbox.sql"),
    source("supabase/migrations/20260818000300_notification_follow_up_hardening.sql"),
  ]);
  const migration = `${foundation}\n${followUp}`;
  for (const table of [
    "account_notifications", "push_subscriptions", "push_subscription_preferences",
    "push_delivery_jobs", "notification_broadcast_jobs",
  ]) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`, "u"));
    assert.match(migration, new RegExp(`revoke all on table public\\.${table}`, "u"));
  }
  assert.match(migration, /max_attempts integer not null default 5/u);
  assert.match(migration, /failed_permanent/u);
  assert.match(migration, /for update of job skip locked/u);
  assert.match(migration, /subscription_invalid/u);
  assert.match(followUp, /not exists \([\s\S]*leased\.subscription_id = job\.subscription_id[\s\S]*leased\.status = 'processing'/u);
  assert.match(followUp, /candidate\.subscription_id = job\.subscription_id[\s\S]*limit 1/u);
  assert.match(migration, /session_row\.revoked_at is null/u);
  assert.match(migration, /get_own_notifications\(uuid,timestamptz,uuid,integer\)/u);
  assert.match(migration, /get_own_notification_destination\(uuid,uuid\)/u);
  assert.match(migration, /grant execute[\s\S]+to service_role/u);
  assert.doesNotMatch(migration, /grant execute[\s\S]+to authenticated/u);
});

test("review adjustments keep history immutable while the visible center is voluntary and bounded", async () => {
  const [reviewMigration, channelMigration, service, list, drawer, account, listRoute, readAllRoute, unreadRoute] = await Promise.all([
    source("supabase/migrations/20260818000400_notification_center_review_adjustments.sql"),
    source("supabase/migrations/20260818000500_notification_channel_availability.sql"),
    source("lib/notifications/ownerNotifications.server.ts"),
    source("app/components/notifications/NotificationList.tsx"),
    source("app/components/notifications/NotificationDrawer.tsx"),
    source("app/components/auth/GlobalAccount.tsx"),
    source("app/api/notifications/route.ts"),
    source("app/api/notifications/read-all/route.ts"),
    source("app/api/notifications/unread-count/route.ts"),
  ]);
  const migration = `${reviewMigration}\n${channelMigration}`;
  assert.match(migration, /required_in_product = false/u);
  assert.match(migration, /default_in_product_enabled = true/u);
  assert.match(migration, /resolve_account_notification_visibility/u);
  assert.match(migration, /notification\.read_at > transaction_timestamp\(\) - interval '3 days'/u);
  assert.match(migration, /create function public\.mark_all_own_notifications_read\(p_session_id uuid\)/u);
  assert.match(channelMigration, /in_product_available boolean not null default true/u);
  assert.match(channelMigration, /where category_key = 'cycles_voting'/u);
  assert.match(channelMigration, /and not in_product_available/u);
  assert.match(channelMigration, /and category\.push_available/u);
  assert.match(migration, /'Submission disqualified'/u);
  assert.match(migration, /'Submission restored'/u);
  assert.match(migration, /'actionLabel'/u);
  assert.match(service, /mark_all_own_notifications_read/u);
  assert.match(listRoute, /Cache-Control": "no-store"/u);
  assert.match(readAllRoute, /enforceRouteMutationGate/u);
  assert.match(list, /Mark all as read/u);
  assert.match(list, /removed from this view after 3 days/u);
  assert.match(list, /notification\.actionLabel/u);
  assert.doesNotMatch(list, />\s*Open\s*</u);
  assert.match(drawer, /role="dialog"/u);
  assert.match(drawer, /aria-modal="true"/u);
  assert.match(drawer, /w-\[calc\(100vw-1rem\)\]/u);
  assert.match(drawer, /max-w-\[28rem\]/u);
  assert.match(drawer, /h-dvh/u);
  assert.match(drawer, /event\.key === "Escape"/u);
  assert.match(account, /<NotificationDrawer/u);
  assert.match(account, /onUnreadDelta/u);
  assert.match(account, /fetch\("\/api\/notifications\/unread-count"/u);
  assert.match(account, /window\.setTimeout\(refreshUnreadCount, 1_500\)/u);
  assert.match(account, /window\.addEventListener\("focus", refreshUnreadCount\)/u);
  assert.match(account, /window\.addEventListener\("pageshow", refreshUnreadCount\)/u);
  assert.match(account, /document\.addEventListener\("visibilitychange"/u);
  assert.doesNotMatch(account, /setInterval/u);
  assert.match(unreadRoute, /requireSession\(\)/u);
  assert.match(unreadRoute, /loadOwnNotificationUnreadCount/u);
  assert.match(unreadRoute, /Cache-Control": "no-store"/u);
});

test("Push UI never requests permission on load and keeps device categories independent", async () => {
  const [component, route, logout] = await Promise.all([
    source("app/components/notifications/PushNotificationSettings.tsx"),
    source("app/api/notifications/push-subscription/route.ts"),
    source("app/api/auth/logout/route.ts"),
  ]);
  const effect = component.slice(component.indexOf("useEffect"), component.indexOf("const enablePush"));
  assert.doesNotMatch(effect, /requestPermission|\.subscribe\(/u);
  assert.match(component, /Notification\.requestPermission\(\)/u);
  assert.ok(
    component.indexOf("Notification.requestPermission()") <
      component.indexOf("!state.configurationAvailable || !state.vapidPublicKey"),
    "the explicit user click must reach the browser permission prompt before delivery configuration is checked"
  );
  assert.match(component, /disabled=\{busy\}/u);
  assert.doesNotMatch(component, /disabled=\{busy \|\| !state\.configurationAvailable\}/u);
  assert.match(component, /Enable push notifications on this browser/u);
  assert.match(component, /browser cannot ask again until you allow notifications in its site permissions/u);
  assert.match(component, /brave:\/\/settings\/privacy/u);
  assert.match(component, /Use Google services for push messaging/u);
  assert.match(component, /error\.name === "AbortError"/u);
  assert.match(component, /userVisibleOnly: true/u);
  assert.match(component, /getRegistration\("\/"\)/u);
  assert.match(component, /role="switch"/u);
  assert.match(component, /aria-checked=\{checked\}/u);
  assert.match(component, /bg-\[var\(--orange-main\)\]/u);
  assert.match(component, /h-6 w-11/u);
  assert.match(component, /left-0\.5 top-0\.5 h-5 w-5/u);
  assert.match(component, /checked \? "translate-x-5" : "translate-x-0"/u);
  assert.match(component, /category\.description/u);
  assert.match(component, /type="checkbox"/u);
  assert.match(component, /remind_15_minutes/u);
  assert.match(component, /remind_10_minutes/u);
  assert.match(component, /remind_5_minutes/u);
  assert.match(component, /If you select any times, Push arrives only at those times/u);
  assert.doesNotMatch(component, /serviceWorker\.register/u);
  assert.match(route, /httpOnly: true/u);
  assert.match(route, /sameSite: "lax"/u);
  assert.match(logout, /deactivatePushSubscription\(sessionId, pushDeviceId\)/u);
});
