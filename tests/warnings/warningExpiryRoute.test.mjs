import assert from "node:assert/strict";
import { mock, test } from "node:test";

const originalEnvironment = { ...process.env };
const secret = "w".repeat(48);
const state = { calls: [], error: null };

mock.module(
  new URL(
    "../../lib/warnings/processDueUserWarningExpiries.server.ts",
    import.meta.url
  ),
  {
    namedExports: {
      parseWarningExpiryLimit(requestUrl) {
        const values = new URL(requestUrl).searchParams.getAll("limit");
        if (values.length === 0) return 100;
        if (values.length !== 1 || !/^[1-9][0-9]*$/u.test(values[0])) {
          return null;
        }
        const value = Number(values[0]);
        return value <= 500 ? value : null;
      },
      async processDueUserWarningExpiries(limit) {
        state.calls.push(limit);
        if (state.error) throw state.error;
        return { processedTargets: 0, expiredWarnings: 0 };
      },
    },
  }
);

const route = await import(
  "../../app/api/internal/warnings/process-due/route.ts"
);

function request({ authorization = `Bearer ${secret}`, query = "" } = {}) {
  return new Request(
    `https://example.test/api/internal/warnings/process-due${query}`,
    { method: "POST", headers: { authorization } }
  );
}

test.beforeEach(() => {
  process.env.CANCERCULTURE_WRITE_MODE = "open";
  process.env.CYCLE_AUTOMATION_TRIGGER_SECRET = secret;
  state.calls = [];
  state.error = null;
});

test.after(() => {
  process.env = originalEnvironment;
});

test("authenticated requests use the safe default and return a no-store no-op", async () => {
  const response = await route.POST(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    success: true,
    processedTargets: 0,
    expiredWarnings: 0,
  });
  assert.deepEqual(state.calls, [100]);
});

test("missing or wrong authentication fails before processing", async () => {
  for (const authorization of [null, `Bearer ${"x".repeat(48)}`]) {
    const response = await route.POST(request({ authorization }));
    assert.equal(response.status, 401);
  }
  assert.deepEqual(state.calls, []);
});

test("misconfiguration and the Write Gate fail before processing", async () => {
  delete process.env.CYCLE_AUTOMATION_TRIGGER_SECRET;
  assert.equal((await route.POST(request())).status, 503);
  assert.deepEqual(state.calls, []);

  process.env.CYCLE_AUTOMATION_TRIGGER_SECRET = secret;
  process.env.CANCERCULTURE_WRITE_MODE = "closed";
  const response = await route.POST(request());
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(state.calls, []);
});

test("validated custom limits are forwarded and invalid limits are rejected", async () => {
  assert.equal((await route.POST(request({ query: "?limit=500" }))).status, 200);
  assert.deepEqual(state.calls, [500]);

  for (const query of ["?limit=0", "?limit=501", "?limit=1&limit=2"]) {
    assert.equal((await route.POST(request({ query }))).status, 400);
  }
  assert.deepEqual(state.calls, [500]);
});

test("processing failures expose neither secret nor sensitive detail", async () => {
  state.error = new Error("private Warning reason and provider response");
  const originalConsoleError = console.error;
  const logs = [];
  console.error = (...values) => logs.push(values);
  try {
    const response = await route.POST(request());
    const serialized = JSON.stringify(await response.json());
    assert.equal(response.status, 503);
    assert.doesNotMatch(serialized, /private Warning reason|provider response|wwww/iu);
    assert.doesNotMatch(JSON.stringify(logs), /private Warning reason|provider response|wwww/iu);
  } finally {
    console.error = originalConsoleError;
  }
});
