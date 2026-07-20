import assert from "node:assert/strict";
import test from "node:test";
import {
  HEARTBEAT_DEGRADED_AFTER_MS,
  HEARTBEAT_OFFLINE_AFTER_MS,
  RECONCILIATION_STALE_AFTER_MS,
  evaluateDiscordSyncHealth,
} from "../../lib/discord/discordSyncHealth.ts";

const NOW = new Date("2026-07-18T12:00:00.000Z");

const beforeNow = (ageMs) =>
  new Date(NOW.getTime() - ageMs).toISOString();

const evaluate = (overrides = {}) =>
  evaluateDiscordSyncHealth({
    now: NOW,
    lastHeartbeatAt: beforeNow(60 * 1000),
    lastFullReconciliationSucceededAt: beforeNow(30 * 60 * 1000),
    lastFailureAt: null,
    ...overrides,
  });

test("a fully fresh state is healthy", () => {
  assert.deepEqual(evaluate(), {
    status: "healthy",
    reasons: [],
    heartbeatAgeMs: 60 * 1000,
    reconciliationAgeMs: 30 * 60 * 1000,
    recoveredFromLatestFailure: false,
  });
});

test("a heartbeat exactly 12 minutes old remains healthy", () => {
  const result = evaluate({
    lastHeartbeatAt: beforeNow(HEARTBEAT_DEGRADED_AFTER_MS),
  });

  assert.equal(result.status, "healthy");
  assert.deepEqual(result.reasons, []);
});

test("a heartbeat more than 12 minutes old is degraded", () => {
  const result = evaluate({
    lastHeartbeatAt: beforeNow(HEARTBEAT_DEGRADED_AFTER_MS + 1),
  });

  assert.equal(result.status, "degraded");
  assert.deepEqual(result.reasons, ["heartbeat_stale"]);
});

test("a heartbeat exactly 30 minutes old remains degraded", () => {
  const result = evaluate({
    lastHeartbeatAt: beforeNow(HEARTBEAT_OFFLINE_AFTER_MS),
  });

  assert.equal(result.status, "degraded");
  assert.deepEqual(result.reasons, ["heartbeat_stale"]);
});

test("a heartbeat more than 30 minutes old is offline", () => {
  const result = evaluate({
    lastHeartbeatAt: beforeNow(HEARTBEAT_OFFLINE_AFTER_MS + 1),
  });

  assert.equal(result.status, "offline");
  assert.deepEqual(result.reasons, ["heartbeat_offline"]);
});

test("a missing heartbeat is offline", () => {
  const result = evaluate({ lastHeartbeatAt: null });

  assert.equal(result.status, "offline");
  assert.deepEqual(result.reasons, ["heartbeat_missing"]);
  assert.equal(result.heartbeatAgeMs, null);
});

test("an invalid heartbeat is offline", () => {
  const result = evaluate({ lastHeartbeatAt: "not-a-date" });

  assert.equal(result.status, "offline");
  assert.deepEqual(result.reasons, ["heartbeat_invalid"]);
  assert.equal(result.heartbeatAgeMs, null);
});

test("a future heartbeat is not healthy", () => {
  const result = evaluate({
    lastHeartbeatAt: new Date(NOW.getTime() + 1).toISOString(),
  });

  assert.equal(result.status, "offline");
  assert.deepEqual(result.reasons, ["heartbeat_invalid"]);
});

test("a reconciliation exactly 75 minutes old remains current", () => {
  const result = evaluate({
    lastFullReconciliationSucceededAt: beforeNow(
      RECONCILIATION_STALE_AFTER_MS
    ),
  });

  assert.equal(result.status, "healthy");
  assert.deepEqual(result.reasons, []);
});

test("a reconciliation more than 75 minutes old is degraded", () => {
  const result = evaluate({
    lastFullReconciliationSucceededAt: beforeNow(
      RECONCILIATION_STALE_AFTER_MS + 1
    ),
  });

  assert.equal(result.status, "degraded");
  assert.deepEqual(result.reasons, ["reconciliation_stale"]);
});

test("a missing reconciliation is degraded", () => {
  const result = evaluate({
    lastFullReconciliationSucceededAt: null,
  });

  assert.equal(result.status, "degraded");
  assert.deepEqual(result.reasons, ["reconciliation_missing"]);
  assert.equal(result.reconciliationAgeMs, null);
});

test("an invalid reconciliation is degraded", () => {
  const result = evaluate({
    lastFullReconciliationSucceededAt: "not-a-date",
  });

  assert.equal(result.status, "degraded");
  assert.deepEqual(result.reasons, ["reconciliation_invalid"]);
});

test("a future reconciliation is degraded as invalid", () => {
  const result = evaluate({
    lastFullReconciliationSucceededAt: new Date(
      NOW.getTime() + 1
    ).toISOString(),
  });

  assert.equal(result.status, "degraded");
  assert.deepEqual(result.reasons, ["reconciliation_invalid"]);
});

test("an invalid failure timestamp degrades fail-closed", () => {
  const result = evaluate({ lastFailureAt: "not-a-date" });

  assert.equal(result.status, "degraded");
  assert.deepEqual(result.reasons, ["failure_invalid"]);
});

test("a future failure timestamp degrades fail-closed", () => {
  const result = evaluate({
    lastFailureAt: new Date(NOW.getTime() + 1).toISOString(),
  });

  assert.equal(result.status, "degraded");
  assert.deepEqual(result.reasons, ["failure_invalid"]);
});

test("a failure newer than the last success is degraded", () => {
  const result = evaluate({
    lastFullReconciliationSucceededAt: beforeNow(10 * 60 * 1000),
    lastFailureAt: beforeNow(5 * 60 * 1000),
  });

  assert.equal(result.status, "degraded");
  assert.deepEqual(result.reasons, [
    "reconciliation_failed_after_success",
  ]);
  assert.equal(result.recoveredFromLatestFailure, false);
});

test("a failure older than the last success permits healthy", () => {
  const result = evaluate({
    lastFullReconciliationSucceededAt: beforeNow(5 * 60 * 1000),
    lastFailureAt: beforeNow(10 * 60 * 1000),
  });

  assert.equal(result.status, "healthy");
  assert.deepEqual(result.reasons, []);
  assert.equal(result.recoveredFromLatestFailure, true);
});

test("an equal failure and success timestamp is not a newer failure", () => {
  const sharedTimestamp = beforeNow(5 * 60 * 1000);
  const result = evaluate({
    lastFullReconciliationSucceededAt: sharedTimestamp,
    lastFailureAt: sharedTimestamp,
  });

  assert.equal(result.status, "healthy");
  assert.equal(result.recoveredFromLatestFailure, true);
});

test("a fresh heartbeat does not recover a newer reconciliation failure", () => {
  const result = evaluate({
    lastHeartbeatAt: beforeNow(1),
    lastFullReconciliationSucceededAt: beforeNow(10 * 60 * 1000),
    lastFailureAt: beforeNow(5 * 60 * 1000),
  });

  assert.equal(result.status, "degraded");
  assert.deepEqual(result.reasons, [
    "reconciliation_failed_after_success",
  ]);
});

test("reason codes have a deterministic severity-independent order", () => {
  const result = evaluate({
    lastHeartbeatAt: beforeNow(HEARTBEAT_DEGRADED_AFTER_MS + 1),
    lastFullReconciliationSucceededAt: beforeNow(
      RECONCILIATION_STALE_AFTER_MS + 1
    ),
    lastFailureAt: beforeNow(1),
  });

  assert.deepEqual(result.reasons, [
    "heartbeat_stale",
    "reconciliation_stale",
    "reconciliation_failed_after_success",
  ]);
});

test("evaluation does not mutate Date inputs or the input object", () => {
  const now = new Date(NOW);
  const heartbeat = new Date(NOW.getTime() - 60 * 1000);
  const reconciliation = new Date(NOW.getTime() - 2 * 60 * 1000);
  const failure = new Date(NOW.getTime() - 3 * 60 * 1000);
  const input = {
    now,
    lastHeartbeatAt: heartbeat,
    lastFullReconciliationSucceededAt: reconciliation,
    lastFailureAt: failure,
  };
  const before = {
    now: now.getTime(),
    heartbeat: heartbeat.getTime(),
    reconciliation: reconciliation.getTime(),
    failure: failure.getTime(),
    keys: Object.keys(input),
  };

  evaluateDiscordSyncHealth(input);

  assert.deepEqual(
    {
      now: now.getTime(),
      heartbeat: heartbeat.getTime(),
      reconciliation: reconciliation.getTime(),
      failure: failure.getTime(),
      keys: Object.keys(input),
    },
    before
  );
});
