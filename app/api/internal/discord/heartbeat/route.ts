export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import {
  DiscordMembershipSyncAuthError,
  verifyDiscordMembershipSyncRequest,
} from "@/lib/auth/discordMembershipSyncAuth";
import { supabaseAdmin } from "@/lib/db/admin";
import { enforceRouteMutationGate } from "@/lib/writeGate.server";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
};

function errorResponse(error: string, status: number) {
  return NextResponse.json(
    { error },
    { status, headers: NO_STORE_HEADERS }
  );
}

export async function POST(req: Request) {
  const gateResponse = enforceRouteMutationGate();
  if (gateResponse) return gateResponse;

  try {
    verifyDiscordMembershipSyncRequest({
      method: req.method,
      path: new URL(req.url).pathname,
      timestamp: req.headers.get("x-cc-timestamp"),
      eventId: req.headers.get("x-cc-event-id"),
      signature: req.headers.get("x-cc-signature"),
      body: "",
    });
  } catch (error) {
    if (error instanceof DiscordMembershipSyncAuthError) {
      return errorResponse(error.code, error.status);
    }

    return errorResponse("SYNC_NOT_CONFIGURED", 503);
  }

  const now = new Date().toISOString();

  try {
    const { data, error } = await supabaseAdmin
      .from("discord_sync_health")
      .update({
        last_heartbeat_at: now,
        updated_at: now,
      })
      .eq("id", 1)
      .select("id")
      .maybeSingle();

    if (error || data?.id !== 1) {
      console.error("[DISCORD_HEARTBEAT] database update failed", {
        code: error?.code ?? "SINGLETON_MISSING",
      });
      return errorResponse("HEARTBEAT_DEPENDENCY_UNAVAILABLE", 503);
    }
  } catch (error) {
    console.error("[DISCORD_HEARTBEAT] database update failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return errorResponse("HEARTBEAT_DEPENDENCY_UNAVAILABLE", 503);
  }

  return new NextResponse(null, {
    status: 204,
    headers: NO_STORE_HEADERS,
  });
}
