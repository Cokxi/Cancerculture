export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getAuthErrorStatus } from "@/lib/auth/AuthError";
import { requireSession } from "@/lib/auth/requireSession";
import {
  loadNotificationSettings,
  setNotificationPreference,
} from "@/lib/notifications/notificationSettings.server";
import { enforceRouteMutationGate } from "@/lib/writeGate.server";

const headers = { "Cache-Control": "no-store" };

export async function GET() {
  try {
    const session = await requireSession();
    return NextResponse.json(await loadNotificationSettings(session.session_id), { headers });
  } catch (error) {
    const status = getAuthErrorStatus(error) ?? 503;
    return NextResponse.json({ error: status === 401 ? "NOT_AUTHENTICATED" : "UNAVAILABLE" }, { status, headers });
  }
}

export async function PATCH(request: Request) {
  const gate = enforceRouteMutationGate();
  if (gate) return gate;
  try {
    const session = await requireSession();
    const body = await request.json() as Record<string, unknown>;
    if (typeof body.categoryKey !== "string" || typeof body.inProductEnabled !== "boolean") {
      return NextResponse.json({ error: "INVALID_INPUT" }, { status: 400, headers });
    }
    const result = await setNotificationPreference(
      session.session_id,
      body.categoryKey,
      body.inProductEnabled
    );
    return NextResponse.json(result, { headers });
  } catch (error) {
    const status = getAuthErrorStatus(error) ?? 503;
    return NextResponse.json({ error: status === 401 ? "NOT_AUTHENTICATED" : "UNAVAILABLE" }, { status, headers });
  }
}
