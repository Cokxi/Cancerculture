import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { authorizeInternalTrigger } from "../../lib/auth/internalTriggerAuth.ts";

const authorizeCycleAutomationTrigger = authorizeInternalTrigger;

const configuredSecret = "s".repeat(48);

test("missing or weak server configuration fails closed", () => {
  assert.equal(
    authorizeCycleAutomationTrigger({
      authorizationHeader: `Bearer ${configuredSecret}`,
      configuredSecret: undefined,
    }),
    "misconfigured"
  );
  assert.equal(
    authorizeCycleAutomationTrigger({
      authorizationHeader: "Bearer short",
      configuredSecret: "short",
    }),
    "misconfigured"
  );
});

test("missing and malformed authorization are rejected", () => {
  for (const authorizationHeader of [
    null,
    configuredSecret,
    `Basic ${configuredSecret}`,
    `Bearer  ${configuredSecret}`,
    `Bearer ${configuredSecret} trailing`,
  ]) {
    assert.equal(
      authorizeCycleAutomationTrigger({
        authorizationHeader,
        configuredSecret,
      }),
      "unauthorized"
    );
  }
});

test("wrong secret is rejected and exact bearer secret is accepted", () => {
  assert.equal(
    authorizeCycleAutomationTrigger({
      authorizationHeader: `Bearer ${"x".repeat(48)}`,
      configuredSecret,
    }),
    "unauthorized"
  );
  assert.equal(
    authorizeCycleAutomationTrigger({
      authorizationHeader: `Bearer ${configuredSecret}`,
      configuredSecret,
    }),
    "authorized"
  );
});

test("internal route exposes POST only and never names infrastructure credentials", async () => {
  const routeSource = await readFile(
    new URL(
      "../../app/api/internal/cycles/process-due/route.ts",
      import.meta.url
    ),
    "utf8"
  );

  assert.match(routeSource, /export async function POST/);
  assert.doesNotMatch(
    routeSource,
    /export async function (GET|PUT|PATCH|DELETE)/
  );
  assert.doesNotMatch(
    routeSource,
    /SUPABASE_SERVICE_ROLE_KEY|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY/
  );
  assert.match(routeSource, /Cache-Control/);
});
