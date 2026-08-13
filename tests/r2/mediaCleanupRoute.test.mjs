import assert from "node:assert/strict";
import { mock, test } from "node:test";

const originalEnvironment = { ...process.env };
const secret = "m".repeat(48);
const state = {
  processError: null,
  processCalls: 0,
  healthCalls: 0,
};

mock.module(
  new URL("../../lib/r2/processMediaCleanupQueue.ts", import.meta.url),
  {
    namedExports: {
      async processDueR2CleanupQueue() {
        state.processCalls += 1;
        if (state.processError) throw state.processError;
        return {
          claimed: 0,
          completed: 0,
          retryScheduled: 0,
          terminalFailures: 0,
          staleResults: 0,
          confirmationFailures: 0,
          deletionFailures: 0,
          batchesAttempted: 1,
          batchFailures: 0,
          drainComplete: true,
          recoveredUploads: 0,
          queuedFromRecovery: 0,
        };
      },
      async getMediaCleanupQueueHealth() {
        state.healthCalls += 1;
        return {
          retryPending: 0,
          dueRetryPending: 0,
          processing: 0,
          expiredProcessing: 0,
          dead: 0,
          outstanding: 0,
        };
      },
    },
  },
);

const route = await import(
  "../../app/api/internal/media-cleanup/process-due/route.ts"
);

function request({ authorization = `Bearer ${secret}`, environment = "dev" } = {}) {
  const headers = new Headers({ authorization });
  if (environment !== null) {
    headers.set("x-cancerculture-media-cleanup-environment", environment);
  }
  return new Request("https://example.test/api/internal/media-cleanup/process-due", {
    method: "POST",
    headers,
  });
}

test.beforeEach(() => {
  process.env.MEDIA_CLEANUP_TRIGGER_SECRET = secret;
  process.env.NEXT_PUBLIC_SUPABASE_URL =
    "https://gceljiuydyiwkomymuqh.supabase.co";
  state.processError = null;
  state.processCalls = 0;
  state.healthCalls = 0;
});

test.after(() => {
  process.env = originalEnvironment;
});

test("empty queue is an authenticated, environment-bound safe no-op", async () => {
  const response = await route.POST(request());
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(body.environment, "dev");
  assert.equal(body.claimed, 0);
  assert.equal(body.dueDrained, true);
  assert.equal(body.fullyDrained, true);
  assert.equal(state.processCalls, 1);
  assert.equal(state.healthCalls, 1);
});

test("missing, wrong, or mixed-environment authorization never starts cleanup", async () => {
  for (const options of [
    { authorization: `Bearer ${"x".repeat(48)}` },
    { environment: null },
    { environment: "live" },
  ]) {
    const response = await route.POST(request(options));
    assert.equal([401, 503].includes(response.status), true);
  }

  assert.equal(state.processCalls, 0);
  assert.equal(state.healthCalls, 0);
});

test("website processing failures are bounded and return 503", async () => {
  state.processError = new Error("private provider response");
  const originalConsoleError = console.error;
  const logs = [];
  console.error = (...values) => logs.push(values);

  try {
    const response = await route.POST(request());
    const serialized = JSON.stringify(await response.json());
    assert.equal(response.status, 503);
    assert.doesNotMatch(serialized, /private provider response/u);
    assert.doesNotMatch(JSON.stringify(logs), /private provider response/u);
  } finally {
    console.error = originalConsoleError;
  }
});
