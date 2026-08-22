export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getAuthErrorStatus } from "@/lib/auth/AuthError";
import { requireSession } from "@/lib/auth/requireSession";
import { loadOwnNotificationUnreadCount } from "@/lib/notifications/ownerNotifications.server";

const headers = { "Cache-Control": "no-store" };

export async function GET() {
  try {
    const session = await requireSession();
    const unreadCount = await loadOwnNotificationUnreadCount(session.session_id);
    return NextResponse.json({ unreadCount }, { headers });
  } catch (error) {
    const status = getAuthErrorStatus(error) ?? 503;
    return NextResponse.json(
      { error: status === 401 ? "NOT_AUTHENTICATED" : "NOTIFICATIONS_UNAVAILABLE" },
      { status, headers }
    );
  }
}
