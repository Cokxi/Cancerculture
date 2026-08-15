import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runMediaCleanupCron } from "../../workers/media-cleanup-cron/src/index.ts";

const secret = "w".repeat(48);
const devEnv = {
  MEDIA_CLEANUP_ENVIRONMENT: "dev",
  MEDIA_CLEANUP_TARGET_URL:
    "http://127.0.0.1:3000/api/internal/media-cleanup/process-due",
  MEDIA_CLEANUP_TRIGGER_SECRET: secret,
};

function body(overrides = {}) {
  return {
    environment: "dev",
    claimed: 0,
    completed: 0,
    recoveredUploads: 0,
    queuedFromRecovery: 0,
    recoveredSponsorUploads: 0,
    queuedFromSponsorRecovery: 0,
    retryScheduled: 0,
    terminalFailures: 0,
    staleResults: 0,
    confirmationFailures: 0,
    deletionFailures: 0,
    batchesAttempted: 1,
    dueDrained: true,
    fullyDrained: true,
    queue: {
      retryPending: 0,
      dueRetryPending: 0,
      processing: 0,
      expiredProcessing: 0,
      dead: 0,
      outstanding: 0,
    },
    ...overrides,
  };
}

function response(value = body(), { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => value };
}

test("cron performs one secret-only POST and accepts the empty no-op", async () => {
  const calls = [];
  const result = await runMediaCleanupCron(devEnv, {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return response();
    },
  });

  assert.equal(result.fullyDrained, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${secret}`);
  assert.equal(
    calls[0].init.headers["x-cancerculture-media-cleanup-environment"],
    "dev",
  );
  assert.equal("body" in calls[0].init, false);
});

test("cron fails closed for missing secrets and DEV/LIVE target mix-ups", async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    return response();
  };

  await assert.rejects(
    runMediaCleanupCron(
      { ...devEnv, MEDIA_CLEANUP_TRIGGER_SECRET: "" },
      { fetchImpl },
    ),
    /MEDIA_CLEANUP_CRON_CONFIGURATION_ERROR/u,
  );
  await assert.rejects(
    runMediaCleanupCron(
      {
        ...devEnv,
        MEDIA_CLEANUP_ENVIRONMENT: "live",
      },
      { fetchImpl },
    ),
    /MEDIA_CLEANUP_CRON_TARGET_MISMATCH/u,
  );
  await assert.rejects(
    runMediaCleanupCron(
      {
        ...devEnv,
        MEDIA_CLEANUP_TARGET_URL:
          "https://cancerculture.fun/api/internal/media-cleanup/process-due",
      },
      { fetchImpl },
    ),
    /MEDIA_CLEANUP_CRON_TARGET_MISMATCH/u,
  );
  assert.equal(fetchCalls, 0);
});

test("website errors, invalid environment replies, and terminal work are observable failures", async () => {
  await assert.rejects(
    runMediaCleanupCron(devEnv, {
      fetchImpl: async () => response({}, { ok: false, status: 302 }),
    }),
    /MEDIA_CLEANUP_CRON_REDIRECT_REJECTED/u,
  );
  await assert.rejects(
    runMediaCleanupCron(devEnv, {
      fetchImpl: async () => response({}, { ok: false, status: 503 }),
    }),
    /MEDIA_CLEANUP_CRON_WEBSITE_UNAVAILABLE/u,
  );
  await assert.rejects(
    runMediaCleanupCron(devEnv, {
      fetchImpl: async () => response(body({ environment: "live" })),
    }),
    /MEDIA_CLEANUP_CRON_INVALID_RESPONSE/u,
  );
  await assert.rejects(
    runMediaCleanupCron(devEnv, {
      fetchImpl: async () =>
        response(
          body({
            terminalFailures: 1,
            fullyDrained: false,
            queue: { ...body().queue, dead: 1, outstanding: 1 },
          }),
        ),
    }),
    /MEDIA_CLEANUP_CRON_TERMINAL_FAILURE/u,
  );
});

test("temporary R2 retry remains scheduled without false full-drain confirmation", async () => {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...values) => warnings.push(values);
  try {
    const result = await runMediaCleanupCron(devEnv, {
      fetchImpl: async () =>
        response(
          body({
            claimed: 1,
            retryScheduled: 1,
            fullyDrained: false,
            queue: { ...body().queue, retryPending: 1, outstanding: 1 },
          }),
        ),
    });
    assert.equal(result.fullyDrained, false);
    assert.equal(result.queue.retryPending, 1);
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = originalWarn;
  }
});

test("worker timeout aborts the website call", async () => {
  await assert.rejects(
    runMediaCleanupCron(devEnv, {
      timeoutMs: 5,
      fetchImpl: async (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    }),
    /MEDIA_CLEANUP_CRON_TIMEOUT/u,
  );
});

test("worker deployment units are separate and contain no privileged credentials", async () => {
  const root = new URL("../../workers/media-cleanup-cron/", import.meta.url);
  const [source, devConfig, liveConfig] = await Promise.all([
    readFile(new URL("src/index.ts", root), "utf8"),
    readFile(new URL("wrangler.dev.jsonc", root), "utf8"),
    readFile(new URL("wrangler.live.jsonc", root), "utf8"),
  ]);
  const combined = `${source}\n${devConfig}\n${liveConfig}`;

  assert.match(devConfig, /cancerculture-media-cleanup-dev/u);
  assert.match(devConfig, /127\.0\.0\.1:3000/u);
  assert.doesNotMatch(devConfig, /"crons"/u);
  assert.match(liveConfig, /cancerculture-media-cleanup-live/u);
  assert.match(liveConfig, /"crons": \["\*\/10 \* \* \* \*"\]/u);
  assert.match(combined, /MEDIA_CLEANUP_TRIGGER_SECRET/u);
  assert.doesNotMatch(
    combined,
    /SUPABASE_SERVICE_ROLE|DATABASE_URL|R2_ACCESS_KEY|R2_SECRET|R2_BUCKET/u,
  );
  assert.doesNotMatch(source, /media_cleanup_queue|claim_media|DeleteObject/u);
});
