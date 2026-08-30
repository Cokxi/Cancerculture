export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { authorizeInternalTrigger } from "@/lib/auth/internalTriggerAuth";
import {
  parseWarningExpiryLimit,
  processDueUserWarningExpiries,
} from "@/lib/warnings/processDueUserWarningExpiries.server";
import { enforceRouteMutationGate } from "@/lib/writeGate.server";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  const gate = enforceRouteMutationGate();
  if (gate) return gate;

  const authorization = authorizeInternalTrigger({
    authorizationHeader: request.headers.get("authorization"),
    configuredSecret: process.env.CYCLE_AUTOMATION_TRIGGER_SECRET,
  });

  if (authorization === "misconfigured") {
    return NextResponse.json(
      { error: "WARNING_EXPIRY_TRIGGER_UNAVAILABLE" },
      { status: 503, headers: NO_STORE_HEADERS }
    );
  }
  if (authorization !== "authorized") {
    return NextResponse.json(
      { error: "UNAUTHORIZED" },
      { status: 401, headers: NO_STORE_HEADERS }
    );
  }

  const limit = parseWarningExpiryLimit(request.url);
  if (limit === null) {
    return NextResponse.json(
      { error: "INVALID_LIMIT" },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }

  try {
    const result = await processDueUserWarningExpiries(limit);
    return NextResponse.json(
      { success: true, ...result },
      { headers: NO_STORE_HEADERS }
    );
  } catch (error) {
    console.error("[WARNING_EXPIRY] due processing failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      { error: "WARNING_EXPIRY_UNAVAILABLE" },
      { status: 503, headers: NO_STORE_HEADERS }
    );
  }
}
