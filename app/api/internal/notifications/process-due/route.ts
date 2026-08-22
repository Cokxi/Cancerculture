export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { authorizeInternalTrigger } from "@/lib/auth/internalTriggerAuth";
import { processDueNotificationWork } from "@/lib/notifications/pushDelivery.server";
import { enforceRouteMutationGate } from "@/lib/writeGate.server";

const headers = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  const gate = enforceRouteMutationGate();
  if (gate) return gate;
  const authorization = authorizeInternalTrigger({
    authorizationHeader: request.headers.get("authorization"),
    configuredSecret: process.env.NOTIFICATION_DELIVERY_TRIGGER_SECRET,
  });
  if (authorization === "misconfigured") {
    return NextResponse.json({ error: "TRIGGER_UNAVAILABLE" }, { status: 503, headers });
  }
  if (authorization !== "authorized") {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401, headers });
  }
  try {
    return NextResponse.json(await processDueNotificationWork(), { headers });
  } catch (error) {
    console.error("[PUSH] due delivery processing failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json({ error: "DELIVERY_UNAVAILABLE" }, { status: 503, headers });
  }
}
