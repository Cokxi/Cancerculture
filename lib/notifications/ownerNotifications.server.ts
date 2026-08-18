import "server-only";

import { AuthError } from "@/lib/auth/AuthError";
import { supabaseAdmin } from "@/lib/db/admin";
import {
  encodeNotificationCursor,
  parseNotificationCursor,
} from "@/lib/notifications/notificationCursor";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PAGE_SIZE = 20;
const EVENT_TYPES = new Set([
  "winner_claim_required",
  "winner_correction_ready",
  "winner_donation_finalized",
  "submission_disqualified",
  "submission_reinstated",
  "cycle_results_ready",
  "wallet_issue_received",
  "wallet_issue_correction_ready",
  "wallet_issue_resolved",
]);

export type OwnerNotification = Readonly<{
  id: string;
  categoryKey: string;
  eventType: string;
  title: string;
  body: string;
  actionLabel: string;
  createdAt: string;
  readAt: string | null;
}>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function parseItem(value: unknown): OwnerNotification | null {
  const item = record(value);
  if (
    typeof item.id !== "string" ||
    !UUID_PATTERN.test(item.id) ||
    typeof item.categoryKey !== "string" ||
    !/^[a-z][a-z0-9_]{2,63}$/u.test(item.categoryKey) ||
    typeof item.eventType !== "string" ||
    !EVENT_TYPES.has(item.eventType) ||
    typeof item.title !== "string" ||
    item.title.length > 120 ||
    typeof item.body !== "string" ||
    item.body.length > 240 ||
    typeof item.actionLabel !== "string" ||
    item.actionLabel.length > 40 ||
    typeof item.createdAt !== "string" ||
    !Number.isFinite(Date.parse(item.createdAt)) ||
    (item.readAt !== null &&
      (typeof item.readAt !== "string" || !Number.isFinite(Date.parse(item.readAt))))
  ) {
    return null;
  }
  return Object.freeze({
    id: item.id,
    categoryKey: item.categoryKey,
    eventType: item.eventType,
    title: item.title,
    body: item.body,
    actionLabel: item.actionLabel,
    createdAt: item.createdAt,
    readAt: item.readAt as string | null,
  });
}

async function rpc(label: string, functionName: string, parameters: object) {
  const { data, error } = await supabaseAdmin.rpc(functionName, parameters);
  if (error) {
    console.error(`[NOTIFICATIONS] ${label} failed`, { code: error.code });
    throw new AuthError(503, "Notifications temporarily unavailable", "NOTIFICATIONS_UNAVAILABLE");
  }
  return data;
}

export async function loadOwnNotifications({
  sessionId,
  cursor,
}: {
  sessionId: string;
  cursor: string | null;
}) {
  const parsedCursor = cursor ? parseNotificationCursor(cursor) : null;
  if (cursor && !parsedCursor) {
    throw new AuthError(400, "Invalid notification cursor", "NOTIFICATION_CURSOR_INVALID");
  }
  const data = record(
    await rpc("list", "get_own_notifications", {
      p_session_id: sessionId,
      p_before_created_at: parsedCursor?.at ?? null,
      p_before_id: parsedCursor?.id ?? null,
      p_limit: PAGE_SIZE,
    })
  );
  const rawItems = Array.isArray(data.items) ? data.items : [];
  const parsedItems = rawItems.map(parseItem).filter((item): item is OwnerNotification => Boolean(item));
  if (parsedItems.length !== rawItems.length) {
    throw new AuthError(503, "Notifications temporarily unavailable", "NOTIFICATIONS_INVALID_RESPONSE");
  }
  const hasMore = parsedItems.length > PAGE_SIZE;
  const items = parsedItems.slice(0, PAGE_SIZE);
  const tail = items.at(-1);
  return {
    items,
    nextCursor: hasMore && tail
      ? encodeNotificationCursor({ at: tail.createdAt, id: tail.id })
      : null,
  };
}

export async function loadOwnNotificationUnreadCount(sessionId: string) {
  const data = await rpc("unread count", "get_own_notification_unread_count", {
    p_session_id: sessionId,
  });
  const count = typeof data === "number" ? data : Number(data);
  if (!Number.isSafeInteger(count) || count < 0 || count > 999) return 0;
  return count;
}

export async function markOwnNotificationRead(sessionId: string, notificationId: string) {
  if (!UUID_PATTERN.test(notificationId)) {
    throw new AuthError(400, "Invalid notification", "NOTIFICATION_INVALID");
  }
  return record(await rpc("mark read", "mark_own_notification_read", {
    p_session_id: sessionId,
    p_notification_id: notificationId,
  }));
}

export async function markAllOwnNotificationsRead(sessionId: string) {
  const data = record(await rpc("mark all read", "mark_all_own_notifications_read", {
    p_session_id: sessionId,
  }));
  const updatedCount = Number(data.updatedCount);
  const readAt = data.readAt;
  if (
    data.outcome !== "read" ||
    !Number.isSafeInteger(updatedCount) ||
    updatedCount < 0 ||
    typeof readAt !== "string" ||
    !Number.isFinite(Date.parse(readAt))
  ) {
    throw new AuthError(503, "Notifications temporarily unavailable", "NOTIFICATIONS_INVALID_RESPONSE");
  }
  return { updatedCount, readAt };
}

export async function resolveOwnNotificationDestination(
  sessionId: string,
  notificationId: string
) {
  if (!UUID_PATTERN.test(notificationId)) return null;
  const data = record(await rpc("resolve destination", "get_own_notification_destination", {
    p_session_id: sessionId,
    p_notification_id: notificationId,
  }));
  const destination = data.outcome === "found" ? data.destination : null;
  return typeof destination === "string" && /^\/(?!\/)[A-Za-z0-9/_?#=&.-]{1,240}$/u.test(destination)
    ? destination
    : null;
}
