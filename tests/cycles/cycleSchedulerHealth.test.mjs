import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateCycleSchedulerHealth,
  SCHEDULER_FAILURE_THRESHOLD,
  SCHEDULER_STALE_AFTER_MS,
  SCHEDULER_STUCK_AFTER_MS,
} from "../../lib/cycles/cycleSchedulerHealth.ts";

const NOW = new Date("2026-08-02T12:00:00.000Z");

function ago(ageMs) {
  return new Date(NOW.getTime() - ageMs).toISOString();
}

function evaluate(overrides = {}) {
  return evaluateCycleSchedulerHealth({
    now: NOW,
    activeRunStartedAt: null,
    lastCompletedAt: ago(60_000),
    lastSucceededAt: ago(60_000),
    lastOutcome: "noop",
    consecutiveFailures: 0,
    ...overrides,
  });
}

test("fresh completed no-op is healthy", () => {
  assert.deepEqual(evaluate(), {
    status: "healthy",
    reasons: [],
    lastCompletedAgeMs: 60_000,
    lastSucceededAgeMs: 60_000,
    runningForMs: null,
    consecutiveFailures: 0,
    lastOutcome: "noop",
  });
});

test("threshold boundaries remain healthy", () => {
  assert.equal(
    evaluate({ lastCompletedAt: ago(SCHEDULER_STALE_AFTER_MS) }).status,
    "healthy"
  );
  assert.equal(
    evaluate({ activeRunStartedAt: ago(SCHEDULER_STUCK_AFTER_MS) }).status,
    "healthy"
  );
  assert.equal(
    evaluate({ consecutiveFailures: SCHEDULER_FAILURE_THRESHOLD - 1 })
      .status,
    "healthy"
  );
});

test("missing completion is degraded", () => {
  const result = evaluate({
    lastCompletedAt: null,
    lastSucceededAt: null,
    lastOutcome: null,
  });
  assert.deepEqual(result.reasons, ["scheduler_missing"]);
  assert.equal(result.lastCompletedAgeMs, null);
});

test("stale, stuck, and consecutive failure reasons are deterministic", () => {
  const result = evaluate({
    activeRunStartedAt: ago(SCHEDULER_STUCK_AFTER_MS + 1),
    lastCompletedAt: ago(SCHEDULER_STALE_AFTER_MS + 1),
    lastOutcome: "failed",
    consecutiveFailures: SCHEDULER_FAILURE_THRESHOLD,
  });

  assert.equal(result.status, "degraded");
  assert.deepEqual(result.reasons, [
    "scheduler_stale",
    "scheduler_stuck",
    "scheduler_consecutive_failures",
  ]);
});

test("future or malformed timestamps never appear healthy", () => {
  assert.deepEqual(
    evaluate({ lastCompletedAt: "not-a-date" }).reasons,
    ["scheduler_missing"]
  );
  assert.deepEqual(
    evaluate({ activeRunStartedAt: "2099-01-01T00:00:00.000Z" }).reasons,
    ["scheduler_stuck"]
  );
});
