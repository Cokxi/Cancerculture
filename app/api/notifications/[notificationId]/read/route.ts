export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getAuthErrorStatus } from "@/lib/auth/AuthError";
import { requireSession } from "@/lib/auth/requireSession";
import { markOwnNotificationRead } from "@/lib/notifications/ownerNotifications.server";
import { enforceRouteMutationGate } from "@/lib/writeGate.server";

export async function POST(
  _request: Request,
  context: { params: Promise<{ notificationId: string }> }
) {
  const gate = enforceRouteMutationGate();
  if (gate) return gate;
  try {
    const session = await requireSession();
    const { notificationId } = await context.params;
    const result = await markOwnNotificationRead(session.session_id, notificationId);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = getAuthErrorStatus(error) ?? 503;
    return NextResponse.json(
      { error: status === 401 ? "NOT_AUTHENTICATED" : "NOTIFICATIONS_UNAVAILABLE" },
      { status, headers: { "Cache-Control": "no-store" } }
    );
  }
}
