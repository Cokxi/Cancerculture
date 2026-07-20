export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { authorizeInternalTrigger } from "@/lib/auth/internalTriggerAuth";
import { supabaseAdmin } from "@/lib/db/admin";
import { evaluateDiscordSyncHealth } from "@/lib/discord/discordSyncHealth";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
};

const HEALTH_SELECT = [
  "last_heartbeat_at",
  "last_full_reconciliation_succeeded_at",
  "last_failure_at",
].join(", ");

type DiscordSyncHealthRow = {
  last_heartbeat_at: string | null;
  last_full_reconciliation_succeeded_at: string | null;
  last_failure_at: string | null;
};

function jsonResponse(
  body: Record<string, unknown>,
  status: number
) {
  return NextResponse.json(body, {
    status,
    headers: NO_STORE_HEADERS,
  });
}

function ageInSeconds(ageMs: number | null) {
  return ageMs === null ? null : Math.floor(ageMs / 1000);
}

export async function GET(req: Request) {
  const authorization = authorizeInternalTrigger({
    authorizationHeader: req.headers.get("authorization"),
    configuredSecret: process.env.DISCORD_SYNC_HEALTH_SECRET,
  });

  if (authorization === "misconfigured") {
    return jsonResponse({ error: "HEALTH_NOT_CONFIGURED" }, 503);
  }

  if (authorization !== "authorized") {
    return jsonResponse({ error: "UNAUTHORIZED" }, 401);
  }

  const now = new Date();

  try {
    const { data, error } = await supabaseAdmin
      .from("discord_sync_health")
      .select(HEALTH_SELECT)
      .eq("id", 1)
      .single<DiscordSyncHealthRow>();

    if (error || !data) {
      return jsonResponse(
        { error: "HEALTH_DEPENDENCY_UNAVAILABLE" },
        503
      );
    }

    const evaluation = evaluateDiscordSyncHealth({
      now,
      lastHeartbeatAt: data.last_heartbeat_at,
      lastFullReconciliationSucceededAt:
        data.last_full_reconciliation_succeeded_at,
      lastFailureAt: data.last_failure_at,
    });

    return jsonResponse(
      {
        status: evaluation.status,
        reasons: evaluation.reasons,
        heartbeatAgeSeconds: ageInSeconds(
          evaluation.heartbeatAgeMs
        ),
        reconciliationAgeSeconds: ageInSeconds(
          evaluation.reconciliationAgeMs
        ),
        recoveredFromLatestFailure:
          evaluation.recoveredFromLatestFailure,
      },
      200
    );
  } catch {
    return jsonResponse(
      { error: "HEALTH_DEPENDENCY_UNAVAILABLE" },
      503
    );
  }
}
