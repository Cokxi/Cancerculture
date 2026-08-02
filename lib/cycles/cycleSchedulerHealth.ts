export const SCHEDULER_STALE_AFTER_MS = 3 * 60 * 1000;
export const SCHEDULER_STUCK_AFTER_MS = 2 * 60 * 1000;
export const SCHEDULER_FAILURE_THRESHOLD = 3;

export type CycleSchedulerHealthReason =
  | "scheduler_missing"
  | "scheduler_stale"
  | "scheduler_stuck"
  | "scheduler_consecutive_failures";

export type CycleSchedulerOutcome =
  | "transitioned"
  | "repaired"
  | "noop"
  | "diagnostic"
  | "failed";

export type CycleSchedulerHealthInput = {
  now: Date;
  activeRunStartedAt: string | null;
  lastCompletedAt: string | null;
  lastSucceededAt: string | null;
  lastOutcome: CycleSchedulerOutcome | null;
  consecutiveFailures: number;
};

export type CycleSchedulerHealthEvaluation = {
  status: "healthy" | "degraded";
  reasons: CycleSchedulerHealthReason[];
  lastCompletedAgeMs: number | null;
  lastSucceededAgeMs: number | null;
  runningForMs: number | null;
  consecutiveFailures: number;
  lastOutcome: CycleSchedulerOutcome | null;
};

type ParsedTimestamp =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "valid"; ageMs: number };

function parseTimestamp(value: string | null, nowMs: number): ParsedTimestamp {
  if (value === null) {
    return { kind: "missing" };
  }

  const timestampMs = Date.parse(value);
  if (!Number.isFinite(timestampMs) || timestampMs > nowMs) {
    return { kind: "invalid" };
  }

  return { kind: "valid", ageMs: nowMs - timestampMs };
}

export function evaluateCycleSchedulerHealth(
  input: CycleSchedulerHealthInput
): CycleSchedulerHealthEvaluation {
  const nowMs = input.now.getTime();
  const activeRun = parseTimestamp(input.activeRunStartedAt, nowMs);
  const completed = parseTimestamp(input.lastCompletedAt, nowMs);
  const succeeded = parseTimestamp(input.lastSucceededAt, nowMs);
  const reasons: CycleSchedulerHealthReason[] = [];

  if (completed.kind !== "valid") {
    reasons.push("scheduler_missing");
  } else if (completed.ageMs > SCHEDULER_STALE_AFTER_MS) {
    reasons.push("scheduler_stale");
  }

  if (
    activeRun.kind === "invalid" ||
    (activeRun.kind === "valid" && activeRun.ageMs > SCHEDULER_STUCK_AFTER_MS)
  ) {
    reasons.push("scheduler_stuck");
  }

  if (input.consecutiveFailures >= SCHEDULER_FAILURE_THRESHOLD) {
    reasons.push("scheduler_consecutive_failures");
  }

  return {
    status: reasons.length === 0 ? "healthy" : "degraded",
    reasons,
    lastCompletedAgeMs:
      completed.kind === "valid" ? completed.ageMs : null,
    lastSucceededAgeMs:
      succeeded.kind === "valid" ? succeeded.ageMs : null,
    runningForMs: activeRun.kind === "valid" ? activeRun.ageMs : null,
    consecutiveFailures: input.consecutiveFailures,
    lastOutcome: input.lastOutcome,
  };
}
