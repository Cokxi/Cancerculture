export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getAuthErrorStatus } from "@/lib/auth/AuthError";
import { requireSession } from "@/lib/auth/requireSession";
import { loadOwnNotifications } from "@/lib/notifications/ownerNotifications.server";

const headers = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  try {
    const session = await requireSession();
    const cursor = new URL(request.url).searchParams.get("after");
    const page = await loadOwnNotifications({ sessionId: session.session_id, cursor });
    return NextResponse.json(page, { headers });
  } catch (error) {
    const status = getAuthErrorStatus(error) ?? 503;
    return NextResponse.json(
      {
        error: status === 401
          ? "NOT_AUTHENTICATED"
          : status === 400
            ? "INVALID_CURSOR"
            : "NOTIFICATIONS_UNAVAILABLE",
      },
      { status, headers }
    );
  }
}
