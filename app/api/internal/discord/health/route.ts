export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { authorizeInternalTrigger } from "@/lib/auth/internalTriggerAuth";
import {
  evaluateCycleSchedulerHealth,
  type CycleSchedulerOutcome,
} from "@/lib/cycles/cycleSchedulerHealth";
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

const SCHEDULER_HEALTH_SELECT = [
  "active_run_started_at",
  "last_completed_at",
  "last_succeeded_at",
  "last_outcome",
  "consecutive_failures",
].join(", ");

type DiscordSyncHealthRow = {
  last_heartbeat_at: string | null;
  last_full_reconciliation_succeeded_at: string | null;
  last_failure_at: string | null;
};

type CycleSchedulerHealthRow = {
  active_run_started_at: string | null;
  last_completed_at: string | null;
  last_succeeded_at: string | null;
  last_outcome: CycleSchedulerOutcome | null;
  consecutive_failures: number;
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

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isCycleSchedulerOutcome(
  value: unknown
): value is CycleSchedulerOutcome | null {
  return (
    value === null ||
    ["transitioned", "repaired", "noop", "diagnostic", "failed"].includes(
      String(value)
    )
  );
}

function isCycleSchedulerHealthRow(
  value: unknown
): value is CycleSchedulerHealthRow {
  if (!value || typeof value !== "object") {
    return false;
  }

  const row = value as Record<string, unknown>;
  return (
    isNullableString(row.active_run_started_at) &&
    isNullableString(row.last_completed_at) &&
    isNullableString(row.last_succeeded_at) &&
    isCycleSchedulerOutcome(row.last_outcome) &&
    typeof row.consecutive_failures === "number" &&
    Number.isSafeInteger(row.consecutive_failures) &&
    row.consecutive_failures >= 0
  );
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
    const [discordResult, schedulerResult] = await Promise.all([
      supabaseAdmin
        .from("discord_sync_health")
        .select(HEALTH_SELECT)
        .eq("id", 1)
        .single<DiscordSyncHealthRow>(),
      supabaseAdmin
        .from("cycle_scheduler_health")
        .select(SCHEDULER_HEALTH_SELECT)
        .eq("id", 1)
        .single<CycleSchedulerHealthRow>(),
    ]);

    if (
      discordResult.error ||
      !discordResult.data ||
      schedulerResult.error ||
      !isCycleSchedulerHealthRow(schedulerResult.data)
    ) {
      return jsonResponse(
        { error: "HEALTH_DEPENDENCY_UNAVAILABLE" },
        503
      );
    }

    const evaluation = evaluateDiscordSyncHealth({
      now,
      lastHeartbeatAt: discordResult.data.last_heartbeat_at,
      lastFullReconciliationSucceededAt:
        discordResult.data.last_full_reconciliation_succeeded_at,
      lastFailureAt: discordResult.data.last_failure_at,
    });
    const schedulerEvaluation = evaluateCycleSchedulerHealth({
      now,
      activeRunStartedAt: schedulerResult.data.active_run_started_at,
      lastCompletedAt: schedulerResult.data.last_completed_at,
      lastSucceededAt: schedulerResult.data.last_succeeded_at,
      lastOutcome: schedulerResult.data.last_outcome,
      consecutiveFailures: schedulerResult.data.consecutive_failures,
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
        scheduler: {
          status: schedulerEvaluation.status,
          reasons: schedulerEvaluation.reasons,
          lastCompletedAgeSeconds: ageInSeconds(
            schedulerEvaluation.lastCompletedAgeMs
          ),
          lastSucceededAgeSeconds: ageInSeconds(
            schedulerEvaluation.lastSucceededAgeMs
          ),
          runningForSeconds: ageInSeconds(
            schedulerEvaluation.runningForMs
          ),
          consecutiveFailures:
            schedulerEvaluation.consecutiveFailures,
          lastOutcome: schedulerEvaluation.lastOutcome,
        },
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
