export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getAuthErrorStatus } from "@/lib/auth/AuthError";
import { requireSession } from "@/lib/auth/requireSession";
import { markAllOwnNotificationsRead } from "@/lib/notifications/ownerNotifications.server";
import { enforceRouteMutationGate } from "@/lib/writeGate.server";

const headers = { "Cache-Control": "no-store" };

export async function POST() {
  const gate = enforceRouteMutationGate();
  if (gate) return gate;
  try {
    const session = await requireSession();
    return NextResponse.json(
      await markAllOwnNotificationsRead(session.session_id),
      { headers }
    );
  } catch (error) {
    const status = getAuthErrorStatus(error) ?? 503;
    return NextResponse.json(
      { error: status === 401 ? "NOT_AUTHENTICATED" : "NOTIFICATIONS_UNAVAILABLE" },
      { status, headers }
    );
  }
}
