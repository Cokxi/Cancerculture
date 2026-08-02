import assert from "node:assert/strict";
import { mock, test } from "node:test";

const originalEnvironment = { ...process.env };
const secret = "a".repeat(48);
const runId = "018fc40c-86a0-7632-b158-9780e41a3724";
const state = {
  begins: [],
  beginOutcome: "started",
  finishes: [],
  processCalls: 0,
  processError: null,
};

mock.module(
  new URL("../../lib/cycles/cycleSchedulerRunHealth.ts", import.meta.url),
  {
    namedExports: {
      async beginCycleSchedulerRun(value) {
        state.begins.push(value);
        return { outcome: state.beginOutcome };
      },
      async finishCycleSchedulerRun(value) {
        state.finishes.push(value);
      },
    },
  }
);

mock.module(
  new URL("../../lib/cycles/phaseAutomation.ts", import.meta.url),
  {
    namedExports: {
      async processDueCycleTransitions() {
        state.processCalls += 1;
        if (state.processError) throw state.processError;
        return {
          outcome: "noop",
          cycleId: 7,
          previousStatus: "submission_open",
          status: "submission_open",
          transition: null,
          reason: "not_due",
          repairCodes: [],
          eventCreated: false,
          processedAt: "2026-08-02T12:00:00.000Z",
        };
      },
    },
  }
);

const route = await import(
  "../../app/api/internal/cycles/process-due/route.ts"
);

function request({ id = runId, authorization = `Bearer ${secret}` } = {}) {
  const headers = new Headers({ authorization });
  if (id !== null) headers.set("x-cc-scheduler-run-id", id);
  return new Request(
    "https://example.test/api/internal/cycles/process-due",
    { method: "POST", headers }
  );
}

test.beforeEach(() => {
  process.env.CYCLE_AUTOMATION_TRIGGER_SECRET = secret;
  state.begins = [];
  state.beginOutcome = "started";
  state.finishes = [];
  state.processCalls = 0;
  state.processError = null;
});

test.after(() => {
  process.env = originalEnvironment;
});

test("an authenticated run records start and successful completion", async () => {
  const response = await route.POST(request());
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(state.begins, [runId]);
  assert.deepEqual(state.finishes, [
    { runId, succeeded: true, outcome: "noop" },
  ]);
  assert.equal(state.processCalls, 1);
  assert.equal(body.success, true);
  assert.equal(body.runId, runId);
  assert.equal(body.result.outcome, "noop");
});

test("a completed run replay never invokes transition work again", async () => {
  state.beginOutcome = "replay";

  const response = await route.POST(request());
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(state.begins, [runId]);
  assert.deepEqual(state.finishes, []);
  assert.equal(state.processCalls, 0);
  assert.equal(body.runId, runId);
  assert.equal(body.result.outcome, "noop");
  assert.equal(body.result.reason, "scheduler_run_replay");
});

test("invalid run IDs are rejected before transition work", async () => {
  for (const id of [null, "not-a-uuid"]) {
    const response = await route.POST(request({ id }));
    assert.equal(response.status, 400);
  }

  assert.deepEqual(state.begins, []);
  assert.deepEqual(state.finishes, []);
  assert.equal(state.processCalls, 0);
});

test("unauthorized requests never inspect scheduler metadata", async () => {
  const response = await route.POST(
    request({ authorization: `Bearer ${"x".repeat(48)}` })
  );

  assert.equal(response.status, 401);
  assert.deepEqual(state.begins, []);
  assert.equal(state.processCalls, 0);
});

test("transition failures record a bounded failed result", async () => {
  state.processError = new Error("private dependency detail");
  const originalConsoleError = console.error;
  const logs = [];
  console.error = (...values) => logs.push(values);

  try {
    const response = await route.POST(request());
    const serialized = JSON.stringify(await response.json());

    assert.equal(response.status, 503);
    assert.deepEqual(state.finishes, [
      { runId, succeeded: false, outcome: "failed" },
    ]);
    assert.doesNotMatch(serialized, /private dependency detail/);
    assert.doesNotMatch(JSON.stringify(logs), /private dependency detail/);
  } finally {
    console.error = originalConsoleError;
  }
});
