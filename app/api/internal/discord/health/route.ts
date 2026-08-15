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
import { enforceRouteMutationGate } from "@/lib/writeGate.server";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
};

const HEALTH_CONTRACT_VERSION = "2";
const WATCHDOG_PROBE_HEADER = "x-cancerculture-watchdog-probe-id";
const HEALTH_CONTRACT_HEADER = "x-cancerculture-health-contract";
const DEPLOYMENT_ID_HEADER = "x-cancerculture-deployment-id";
const COMMIT_SHA_HEADER = "x-cancerculture-commit-sha";
const PROBE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DEPLOYMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;

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

type HealthProbeContext = {
  probeId: string | null;
  deploymentId: string | null;
  commitSha: string | null;
};

type HealthProbeDiagnostic = {
  responseStatus: number;
  discordDependencyAvailable: boolean | null;
  schedulerDependencyAvailable: boolean | null;
  schedulerIncluded: boolean;
};

function jsonResponse(
  body: Record<string, unknown>,
  status: number,
  context?: HealthProbeContext
) {
  const headers = new Headers(NO_STORE_HEADERS);
  headers.set(HEALTH_CONTRACT_HEADER, HEALTH_CONTRACT_VERSION);
  if (context?.probeId) {
    headers.set(WATCHDOG_PROBE_HEADER, context.probeId);
  }
  if (context?.deploymentId) {
    headers.set(DEPLOYMENT_ID_HEADER, context.deploymentId);
  }
  if (context?.commitSha) {
    headers.set(COMMIT_SHA_HEADER, context.commitSha);
  }

  return NextResponse.json(body, {
    status,
    headers,
  });
}

function healthProbeContext(req: Request): HealthProbeContext {
  const requestedProbeId = req.headers.get(WATCHDOG_PROBE_HEADER);
  const deploymentId = process.env.VERCEL_DEPLOYMENT_ID;
  const commitSha = process.env.VERCEL_GIT_COMMIT_SHA;

  return {
    probeId:
      requestedProbeId && PROBE_ID_PATTERN.test(requestedProbeId)
        ? requestedProbeId
        : null,
    deploymentId:
      deploymentId && DEPLOYMENT_ID_PATTERN.test(deploymentId)
        ? deploymentId
        : null,
    commitSha:
      commitSha && COMMIT_SHA_PATTERN.test(commitSha)
        ? commitSha.toLowerCase()
        : null,
  };
}

function logHealthProbe(
  context: HealthProbeContext,
  diagnostic: HealthProbeDiagnostic
) {
  if (!context.probeId) {
    return;
  }

  try {
    console.log(
      JSON.stringify({
        event: "INTERNAL_DISCORD_HEALTH_PROBE",
        probeId: context.probeId,
        contractVersion: HEALTH_CONTRACT_VERSION,
        deploymentId: context.deploymentId,
        commitSha: context.commitSha,
        ...diagnostic,
      })
    );
  } catch {
    // Operational correlation must never affect the health response.
  }
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
  const gateResponse = enforceRouteMutationGate({ allowDrain: true });
  if (gateResponse) return gateResponse;

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

  const probeContext = healthProbeContext(req);
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

    const discordHealth =
      !discordResult.error && discordResult.data
        ? discordResult.data
        : null;
    const schedulerHealth =
      !schedulerResult.error &&
      isCycleSchedulerHealthRow(schedulerResult.data)
        ? schedulerResult.data
        : null;
    const discordDependencyAvailable = discordHealth !== null;
    const schedulerDependencyAvailable = schedulerHealth !== null;

    if (!discordDependencyAvailable || !schedulerDependencyAvailable) {
      logHealthProbe(probeContext, {
        responseStatus: 503,
        discordDependencyAvailable,
        schedulerDependencyAvailable,
        schedulerIncluded: false,
      });
      return jsonResponse(
        { error: "HEALTH_DEPENDENCY_UNAVAILABLE" },
        503,
        probeContext
      );
    }

    const evaluation = evaluateDiscordSyncHealth({
      now,
      lastHeartbeatAt: discordHealth.last_heartbeat_at,
      lastFullReconciliationSucceededAt:
        discordHealth.last_full_reconciliation_succeeded_at,
      lastFailureAt: discordHealth.last_failure_at,
    });
    const schedulerEvaluation = evaluateCycleSchedulerHealth({
      now,
      activeRunStartedAt: schedulerHealth.active_run_started_at,
      lastCompletedAt: schedulerHealth.last_completed_at,
      lastSucceededAt: schedulerHealth.last_succeeded_at,
      lastOutcome: schedulerHealth.last_outcome,
      consecutiveFailures: schedulerHealth.consecutive_failures,
    });

    logHealthProbe(probeContext, {
      responseStatus: 200,
      discordDependencyAvailable: true,
      schedulerDependencyAvailable: true,
      schedulerIncluded: true,
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
      200,
      probeContext
    );
  } catch {
    logHealthProbe(probeContext, {
      responseStatus: 503,
      discordDependencyAvailable: null,
      schedulerDependencyAvailable: null,
      schedulerIncluded: false,
    });
    return jsonResponse(
      { error: "HEALTH_DEPENDENCY_UNAVAILABLE" },
      503,
      probeContext
    );
  }
}
