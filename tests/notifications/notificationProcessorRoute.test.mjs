import assert from "node:assert/strict";
import { mock, test } from "node:test";

const originalEnvironment = { ...process.env };
const secret = "n".repeat(48);
const state = { calls: 0, error: null };

mock.module(
  new URL("../../lib/notifications/pushDelivery.server.ts", import.meta.url),
  {
    namedExports: {
      async processDueNotificationWork() {
        state.calls += 1;
        if (state.error) throw state.error;
        return {
          broadcastOutcome: "idle",
          broadcastProcessed: 0,
          claimed: 0,
          delivered: 0,
          retried: 0,
          failedPermanent: 0,
        };
      },
    },
  }
);

const route = await import("../../app/api/internal/notifications/process-due/route.ts");

function request(authorization = `Bearer ${secret}`) {
  return new Request("https://example.test/api/internal/notifications/process-due", {
    method: "POST",
    headers: { authorization },
  });
}

test.beforeEach(() => {
  process.env.CANCERCULTURE_WRITE_MODE = "open";
  process.env.NOTIFICATION_DELIVERY_TRIGGER_SECRET = secret;
  state.calls = 0;
  state.error = null;
});

test.after(() => {
  process.env = originalEnvironment;
});

test("the protected processor accepts only its exact secret and returns no-store", async () => {
  const response = await route.POST(request());
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(state.calls, 1);
  assert.equal(body.broadcastOutcome, "idle");

  for (const authorization of [null, `Bearer ${"x".repeat(48)}`]) {
    const denied = await route.POST(request(authorization));
    assert.equal(denied.status, 401);
  }
  assert.equal(state.calls, 1);
});

test("misconfiguration and the Write Gate fail closed before delivery", async () => {
  delete process.env.NOTIFICATION_DELIVERY_TRIGGER_SECRET;
  assert.equal((await route.POST(request())).status, 503);
  assert.equal(state.calls, 0);

  process.env.NOTIFICATION_DELIVERY_TRIGGER_SECRET = secret;
  process.env.CANCERCULTURE_WRITE_MODE = "closed";
  const gated = await route.POST(request());
  assert.equal(gated.status, 503);
  assert.equal(gated.headers.get("cache-control"), "no-store");
  assert.equal(state.calls, 0);
});

test("processor failures expose neither provider detail nor secrets", async () => {
  state.error = new Error("private provider response");
  const originalConsoleError = console.error;
  const logs = [];
  console.error = (...values) => logs.push(values);
  try {
    const response = await route.POST(request());
    const serialized = JSON.stringify(await response.json());
    assert.equal(response.status, 503);
    assert.doesNotMatch(serialized, /private provider response|nnnnnn/iu);
    assert.doesNotMatch(JSON.stringify(logs), /private provider response|nnnnnn/iu);
  } finally {
    console.error = originalConsoleError;
  }
});
