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
  assert.equal(
    routeSource.match(/await processR2CleanupQueue\(\)/g)?.length,
    1
  );
});

test("reset leases only cleanup jobs created by that reset", async () => {
  const resetRouteSource = await readFile(
    new URL("../../app/api/admin/cycles/reset/route.ts", import.meta.url),
    "utf8"
  );

  assert.match(resetRouteSource, /await resetCycleTransactional/);
  assert.match(
    resetRouteSource,
    /processR2CleanupQueue\(\{[\s\S]*queueIds: targetedQueueIds[\s\S]*\}\)/
  );
  assert.match(resetRouteSource, /reset\.r2CleanupQueueIds\.slice\(0, 20\)/);
  assert.doesNotMatch(resetRouteSource, /await processR2CleanupQueue\(\)/);
  assert.match(
    resetRouteSource,
    /Cycle reset succeeded, but queued media cleanup could not be started/
  );
});
