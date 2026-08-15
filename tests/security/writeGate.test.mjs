import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  evaluateWriteGateRequest,
  isAnonymousPublicReadPath,
  isDrainRequest,
  resolveWriteGateMode,
  WRITE_GATE_RETRY_AFTER_SECONDS,
} from "../../lib/writeGate.ts";

test("Production defaults missing and invalid write modes to closed", () => {
  for (const configuredMode of [undefined, null, "", "maintenance", "OPENED"]) {
    assert.equal(
      resolveWriteGateMode({ configuredMode, nodeEnvironment: "production" }),
      "closed"
    );
  }
  assert.equal(
    resolveWriteGateMode({ configuredMode: undefined, nodeEnvironment: "test" }),
    "open"
  );
});

test("the three exact write modes are accepted case-insensitively", () => {
  for (const [configuredMode, expected] of [
    ["open", "open"],
    [" DRAIN ", "drain"],
    ["CLOSED", "closed"],
  ]) {
    assert.equal(
      resolveWriteGateMode({ configuredMode, nodeEnvironment: "production" }),
      expected
    );
  }
});

test("closed permits only anonymous GET and HEAD requests on the public allowlist", () => {
  for (const pathname of [
    "/",
    "/spread",
    "/spread/42",
    "/cycle-history",
    "/api/community-feed",
    "/api/community-feed/cycles",
    "/api/community-feed/media/42",
    "/api/sponsor/banner",
    "/profile/00000000-0000-4000-8000-000000000001/avatar",
    "/icons/pwa-icon-192.png",
    "/manifest.webmanifest",
    "/sw.js",
    "/_next/static/chunks/app.js",
  ]) {
    assert.equal(isAnonymousPublicReadPath(pathname), true, pathname);
    for (const method of ["GET", "HEAD"]) {
      assert.deepEqual(
        evaluateWriteGateRequest({
          mode: "closed",
          method,
          pathname,
          hasWebsiteSession: false,
        }),
        { allowed: true, reason: "public_read" }
      );
    }
  }
});

test("closed rejects every mutating method, including Server Action POSTs", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    assert.deepEqual(
      evaluateWriteGateRequest({
        mode: "closed",
        method,
        pathname: "/",
        hasWebsiteSession: false,
      }),
      { allowed: false, reason: "closed_method" }
    );
  }
});

test("closed rejects authenticated reads before route or session touch", () => {
  assert.deepEqual(
    evaluateWriteGateRequest({
      mode: "closed",
      method: "GET",
      pathname: "/spread",
      hasWebsiteSession: true,
    }),
    { allowed: false, reason: "closed_session" }
  );
});

test("closed rejects all known GET writers and protected or internal reads", () => {
  for (const pathname of [
    "/api/auth/discord/login",
    "/api/auth/discord/callback",
    "/api/auth/discord/status",
    "/api/community-feed/sponsor/click/1",
    "/api/sponsor/click",
    "/admin",
    "/my-profile",
    "/api/internal/discord/health",
    "/api/internal/media-cleanup/process-due",
  ]) {
    assert.deepEqual(
      evaluateWriteGateRequest({
        mode: "closed",
        method: "GET",
        pathname,
        hasWebsiteSession: false,
      }),
      { allowed: false, reason: "closed_path" },
      pathname
    );
  }
});

test("drain permits only exact separately authenticated internal route shapes", () => {
  assert.equal(isDrainRequest("POST", "/api/internal/media-cleanup/process-due"), true);
  assert.equal(isDrainRequest("GET", "/api/internal/discord/health"), true);
  assert.equal(isDrainRequest("POST", "/api/internal/discord/heartbeat"), false);
  assert.equal(isDrainRequest("GET", "/spread"), false);

  assert.deepEqual(
    evaluateWriteGateRequest({
      mode: "drain",
      method: "POST",
      pathname: "/api/internal/media-cleanup/process-due",
      hasWebsiteSession: false,
    }),
    { allowed: true, reason: "drain" }
  );
});

test("proxy returns a neutral 503 contract and covers every route", () => {
  const source = readFileSync(new URL("../../proxy.ts", import.meta.url), "utf8");
  assert.match(source, /matcher:\s*\["\/:path\*"\]/u);
  assert.match(source, /request[.]cookies[.]has\("session_id"\)/u);
  assert.match(source, /status:\s*503/u);
  assert.match(source, /"Retry-After"/u);
  assert.equal(WRITE_GATE_RETRY_AFTER_SECONDS, 300);
});

test("PWA worker remains network-only and has no replay-capable fetch handler", () => {
  const source = readFileSync(
    new URL("../../app/sw.js/route.ts", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(source, /addEventListener\(["']fetch["']/u);
  assert.doesNotMatch(source, /caches[.](?:open|match)/u);
});

test("authenticated reads, GET writers and internal endpoints enforce the gate in depth", () => {
  const sources = new Map(
    [
      "lib/auth/requireSession.ts",
      "app/api/auth/discord/login/route.ts",
      "app/api/auth/discord/callback/route.ts",
      "app/api/auth/logout/route.ts",
      "app/api/sponsor/click/route.ts",
      "app/api/sponsor/impression/route.ts",
      "app/api/community-feed/sponsor/click/[submissionId]/route.ts",
      "app/api/community-feed/sponsor/impression/[submissionId]/route.ts",
      "app/api/internal/cycles/process-due/route.ts",
      "app/api/internal/discord/heartbeat/route.ts",
      "app/api/internal/discord/membership-sync/route.ts",
      "app/api/internal/discord/health/route.ts",
      "app/api/internal/media-cleanup/process-due/route.ts",
    ].map((file) => [
      file,
      readFileSync(new URL(`../../${file}`, import.meta.url), "utf8"),
    ])
  );
  const sessionSource = sources.get("lib/auth/requireSession.ts");
  assert.match(sessionSource, /assertServerMutationAllowed\(\)/u);
  assert.ok(
    sessionSource.indexOf("UUID_PATTERN.test(sessionId)") <
      sessionSource.indexOf("assertServerMutationAllowed()") &&
      sessionSource.indexOf("assertServerMutationAllowed()") <
        sessionSource.indexOf("supabaseAdmin.rpc")
  );
  for (const [file, source] of sources) {
    if (file === "lib/auth/requireSession.ts") continue;
    assert.match(source, /enforceRouteMutationGate/u, file);
  }
  assert.match(
    sources.get("app/api/internal/media-cleanup/process-due/route.ts"),
    /enforceRouteMutationGate\(\{ allowDrain: true \}\)/u
  );
  assert.match(
    sources.get("app/api/internal/discord/health/route.ts"),
    /enforceRouteMutationGate\(\{ allowDrain: true \}\)/u
  );
});

test("representative RPC and R2 mutation services cannot bypass request routing", () => {
  for (const file of [
    "lib/r2/processMediaCleanupQueue.ts",
    "lib/sponsors/tracking.ts",
    "lib/sponsors/retention.server.ts",
    "lib/cycles/startCycle.ts",
    "lib/cycles/resetCycle.ts",
    "lib/cycles/finalizeCycle.ts",
    "lib/cycles/manageCycle.ts",
    "lib/cycles/phaseAutomation.ts",
    "lib/moderation/moderateSubmission.ts",
    "lib/voteRefund/refund.server.ts",
    "lib/reports/submissionReportRpc.server.ts",
    "lib/auth/teamRoleMutations.ts",
    "lib/content/rules/manage.server.ts",
    "lib/content/faq/manage.server.ts",
  ]) {
    const source = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
    assert.match(source, /assertServerMutationAllowed/u, file);
  }
});
