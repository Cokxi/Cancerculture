import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { authorizeInternalTrigger } from "../../lib/auth/internalTriggerAuth.ts";

const configuredSecret = "m".repeat(48);

test("media cleanup auth fails closed for missing or weak configuration", () => {
  assert.equal(
    authorizeInternalTrigger({
      authorizationHeader: `Bearer ${configuredSecret}`,
      configuredSecret: undefined,
    }),
    "misconfigured"
  );
  assert.equal(
    authorizeInternalTrigger({
      authorizationHeader: "Bearer short",
      configuredSecret: "short",
    }),
    "misconfigured"
  );
});

test("media cleanup auth rejects missing, malformed, and wrong bearer values", () => {
  for (const authorizationHeader of [
    null,
    configuredSecret,
    `Basic ${configuredSecret}`,
    `Bearer  ${configuredSecret}`,
    `Bearer ${configuredSecret} trailing`,
    `Bearer ${"x".repeat(48)}`,
  ]) {
    assert.equal(
      authorizeInternalTrigger({
        authorizationHeader,
        configuredSecret,
      }),
      "unauthorized"
    );
  }
});

test("exact media cleanup bearer value is accepted", () => {
  assert.equal(
    authorizeInternalTrigger({
      authorizationHeader: `Bearer ${configuredSecret}`,
      configuredSecret,
    }),
    "authorized"
  );
});

test("media cleanup route has a dedicated secret and accepts no work selection input", async () => {
  const routeSource = await readFile(
    new URL(
      "../../app/api/internal/media-cleanup/process-due/route.ts",
      import.meta.url
    ),
    "utf8"
  );

  assert.match(routeSource, /export async function POST/);
  assert.doesNotMatch(
    routeSource,
    /export async function (GET|PUT|PATCH|DELETE)/
  );
  assert.match(routeSource, /MEDIA_CLEANUP_TRIGGER_SECRET/);
  assert.doesNotMatch(routeSource, /CYCLE_AUTOMATION_TRIGGER_SECRET/);
  assert.doesNotMatch(routeSource, /req\.json|req\.text|req\.formData/);
  assert.doesNotMatch(
    routeSource,
    /SUPABASE_SERVICE_ROLE_KEY|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY|R2_BUCKET_NAME/
  );
  assert.doesNotMatch(routeSource, /storage_key|lease_token|queueId|bucket/i);
  assert.match(routeSource, /Cache-Control/);
  assert.match(routeSource, /await processDueR2CleanupQueue\(\)/u);
  assert.match(routeSource, /await getMediaCleanupQueueHealth\(\)/u);
  assert.match(routeSource, /MEDIA_CLEANUP_ENVIRONMENT_HEADER/u);
});

test("reset leases only cleanup jobs created by that reset", async () => {
  const resetRouteSource = await readFile(
    new URL("../../app/api/admin/cycles/reset/route.ts", import.meta.url),
    "utf8"
  );

  assert.match(resetRouteSource, /await resetCycleTransactional/);
  assert.match(
    resetRouteSource,
    /processTargetedR2CleanupQueue\([\s\S]*reset\.r2CleanupQueueIds/
  );
  assert.match(resetRouteSource, /verifyR2CleanupQueuePostflight/u);
  assert.doesNotMatch(resetRouteSource, /r2CleanupQueueIds\.slice/u);
  assert.doesNotMatch(resetRouteSource, /await processR2CleanupQueue\(\)/u);
  assert.match(
    resetRouteSource,
    /Cycle reset succeeded, but queued media cleanup could not be started/
  );
});

test("reset reports immutable moderation dependencies as a safe conflict", async () => {
  const resetSource = await readFile(
    new URL("../../lib/cycles/resetCycle.ts", import.meta.url),
    "utf8"
  );

  assert.match(
    resetSource,
    /submission_disqualification_events_submission_id_fkey/
  );
  assert.match(resetSource, /user_flag_cases_submission_id_fkey/);
  assert.match(resetSource, /error\.code === "23503"/);
  assert.match(
    resetSource,
    /Cycle contains immutable moderation history and cannot be reset/
  );
  assert.match(resetSource, /status: 409/);
  assert.match(resetSource, /\[cycle reset\]\[rpc\][\s\S]*code:/);
  assert.doesNotMatch(
    resetSource,
    /console\.error\("\[cycle reset\]\[rpc\]", error\)/
  );
});
