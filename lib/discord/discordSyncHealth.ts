export const HEARTBEAT_DEGRADED_AFTER_MS = 12 * 60 * 1000;
export const HEARTBEAT_OFFLINE_AFTER_MS = 30 * 60 * 1000;
export const RECONCILIATION_STALE_AFTER_MS = 75 * 60 * 1000;

export type DiscordSyncHealthStatus = "healthy" | "degraded" | "offline";

export type DiscordSyncHealthReason =
  | "now_invalid"
  | "heartbeat_missing"
  | "heartbeat_stale"
  | "heartbeat_offline"
  | "heartbeat_invalid"
  | "reconciliation_missing"
  | "reconciliation_stale"
  | "reconciliation_invalid"
  | "failure_invalid"
  | "reconciliation_failed_after_success";

export type DiscordSyncHealthTimestamp = Date | string | null;

export type DiscordSyncHealthInput = {
  now: Date | string;
  lastHeartbeatAt: DiscordSyncHealthTimestamp;
  lastFullReconciliationSucceededAt: DiscordSyncHealthTimestamp;
  lastFailureAt: DiscordSyncHealthTimestamp;
};

export type DiscordSyncHealthEvaluation = {
  status: DiscordSyncHealthStatus;
  reasons: DiscordSyncHealthReason[];
  heartbeatAgeMs: number | null;
  reconciliationAgeMs: number | null;
  recoveredFromLatestFailure: boolean;
};

type ParsedTimestamp =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "valid"; timestampMs: number; ageMs: number };

function parseNow(value: Date | string) {
  const timestampMs =
    value instanceof Date ? value.getTime() : Date.parse(value);

  return Number.isFinite(timestampMs) ? timestampMs : null;
}

function parseTimestamp(
  value: DiscordSyncHealthTimestamp,
  nowMs: number
): ParsedTimestamp {
  if (value === null) return { kind: "missing" };

  const timestampMs =
    value instanceof Date ? value.getTime() : Date.parse(value);

  if (!Number.isFinite(timestampMs) || timestampMs > nowMs) {
    return { kind: "invalid" };
  }

  return {
    kind: "valid",
    timestampMs,
    ageMs: nowMs - timestampMs,
  };
}

export function evaluateDiscordSyncHealth(
  input: DiscordSyncHealthInput
): DiscordSyncHealthEvaluation {
  const nowMs = parseNow(input.now);

  if (nowMs === null) {
    return {
      status: "offline",
      reasons: ["now_invalid"],
      heartbeatAgeMs: null,
      reconciliationAgeMs: null,
      recoveredFromLatestFailure: false,
    };
  }

  const heartbeat = parseTimestamp(input.lastHeartbeatAt, nowMs);
  const reconciliation = parseTimestamp(
    input.lastFullReconciliationSucceededAt,
    nowMs
  );
  const failure = parseTimestamp(input.lastFailureAt, nowMs);
  const reasons: DiscordSyncHealthReason[] = [];
  let heartbeatOffline = false;

  if (heartbeat.kind === "missing") {
    reasons.push("heartbeat_missing");
    heartbeatOffline = true;
  } else if (heartbeat.kind === "invalid") {
    reasons.push("heartbeat_invalid");
    heartbeatOffline = true;
  } else if (heartbeat.ageMs > HEARTBEAT_OFFLINE_AFTER_MS) {
    reasons.push("heartbeat_offline");
    heartbeatOffline = true;
  } else if (heartbeat.ageMs > HEARTBEAT_DEGRADED_AFTER_MS) {
    reasons.push("heartbeat_stale");
  }

  if (reconciliation.kind === "missing") {
    reasons.push("reconciliation_missing");
  } else if (reconciliation.kind === "invalid") {
    reasons.push("reconciliation_invalid");
  } else if (reconciliation.ageMs > RECONCILIATION_STALE_AFTER_MS) {
    reasons.push("reconciliation_stale");
  }

  let recoveredFromLatestFailure = false;

  if (failure.kind === "invalid") {
    reasons.push("failure_invalid");
  } else if (
    failure.kind === "valid" &&
    reconciliation.kind === "valid"
  ) {
    if (failure.timestampMs > reconciliation.timestampMs) {
      reasons.push("reconciliation_failed_after_success");
    } else {
      recoveredFromLatestFailure = true;
    }
  }

  return {
    status: heartbeatOffline
      ? "offline"
      : reasons.length > 0
        ? "degraded"
        : "healthy",
    reasons,
    heartbeatAgeMs:
      heartbeat.kind === "valid" ? heartbeat.ageMs : null,
    reconciliationAgeMs:
      reconciliation.kind === "valid" ? reconciliation.ageMs : null,
    recoveredFromLatestFailure,
  };
}
