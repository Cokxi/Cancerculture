import assert from "node:assert/strict";
import { mock, test } from "node:test";

const state = { calls: [], data: null, error: null };

mock.module(new URL("../../lib/db/admin.ts", import.meta.url), {
  namedExports: {
    supabaseAdmin: {
      async rpc(name, parameters) {
        state.calls.push({ name, parameters });
        return { data: state.data, error: state.error };
      },
    },
  },
});

const processor = await import(
  "../../lib/warnings/processDueUserWarningExpiries.server.ts"
);

test.beforeEach(() => {
  state.calls = [];
  state.data = { processedTargets: 0, expiredWarnings: 0 };
  state.error = null;
});

test("limit parsing is strict, bounded, and defaults to 100", () => {
  assert.equal(
    processor.parseWarningExpiryLimit("https://example.test/internal"),
    100
  );
  for (const limit of ["1", "100", "500"]) {
    assert.equal(
      processor.parseWarningExpiryLimit(
        `https://example.test/internal?limit=${limit}`
      ),
      Number(limit)
    );
  }
  for (const query of [
    "limit=0",
    "limit=501",
    "limit=01",
    "limit=1.5",
    "limit=1&limit=2",
    "other=1",
  ]) {
    assert.equal(
      processor.parseWarningExpiryLimit(
        `https://example.test/internal?${query}`
      ),
      null
    );
  }
});

test("processor calls only the canonical RPC with the validated limit", async () => {
  state.data = { processedTargets: 2, expiredWarnings: 3 };
  const result = await processor.processDueUserWarningExpiries(100);
  assert.deepEqual(state.calls, [
    {
      name: "process_due_user_warning_expiries",
      parameters: { p_limit: 100 },
    },
  ]);
  assert.deepEqual(result, { processedTargets: 2, expiredWarnings: 3 });
});

test("a no-op response is accepted without creating other work", async () => {
  assert.deepEqual(await processor.processDueUserWarningExpiries(100), {
    processedTargets: 0,
    expiredWarnings: 0,
  });
  assert.equal(state.calls.length, 1);
});

test("malformed RPC responses fail closed", async () => {
  for (const data of [
    null,
    [],
    {},
    { processedTargets: -1, expiredWarnings: 0 },
    { processedTargets: 0, expiredWarnings: "0" },
    { processedTargets: 0, expiredWarnings: 0, sensitive: "detail" },
  ]) {
    state.data = data;
    await assert.rejects(
      processor.processDueUserWarningExpiries(100),
      /WARNING_EXPIRY_RESPONSE_INVALID/u
    );
  }
});

test("invalid direct limits never reach the database", async () => {
  for (const limit of [0, 501, 1.5, Number.NaN]) {
    await assert.rejects(
      processor.processDueUserWarningExpiries(limit),
      /WARNING_EXPIRY_LIMIT_INVALID/u
    );
  }
  assert.equal(state.calls.length, 0);
});

test("database failures expose neither provider detail nor Warning data", async () => {
  state.error = {
    code: "PRIVATE_CODE",
    message: "private Warning reason and provider response",
  };
  const originalConsoleError = console.error;
  const logs = [];
  console.error = (...values) => logs.push(values);
  try {
    await assert.rejects(
      processor.processDueUserWarningExpiries(100),
      /WARNING_EXPIRY_DATABASE_UNAVAILABLE/u
    );
    assert.doesNotMatch(
      JSON.stringify(logs),
      /private Warning reason|provider response/iu
    );
  } finally {
    console.error = originalConsoleError;
  }
});
