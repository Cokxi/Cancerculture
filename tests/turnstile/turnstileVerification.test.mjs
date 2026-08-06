import assert from "node:assert/strict";
import test from "node:test";
import { TURNSTILE_TOKEN_HEADER } from "../../lib/turnstile/shared.ts";
import { verifyTurnstileRequest } from "../../lib/turnstile/verify.server.ts";

function request(token = "valid-token") {
  return new Request("https://example.test/api/vote", {
    method: "POST",
    headers: token ? { [TURNSTILE_TOKEN_HEADER]: token } : undefined,
  });
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("missing and oversized tokens are rejected without contacting Cloudflare", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse({ success: true, action: "vote" });
  };

  assert.deepEqual(
    await verifyTurnstileRequest(request(""), "vote", { fetchImpl }),
    { status: "rejected", code: "TURNSTILE_REQUIRED" }
  );
  assert.deepEqual(
    await verifyTurnstileRequest(request("x".repeat(2_049)), "vote", {
      fetchImpl,
    }),
    { status: "rejected", code: "TURNSTILE_INVALID" }
  );
  assert.equal(calls, 0);
});

test("verified requests bind the expected action and never send a raw IP", async () => {
  let body;
  const result = await verifyTurnstileRequest(request(), "vote", {
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      return jsonResponse({ success: true, action: "vote" });
    },
  });

  assert.deepEqual(result, { status: "verified" });
  assert.equal(body.response, "valid-token");
  assert.equal(typeof body.idempotency_key, "string");
  assert.equal("remoteip" in body, false);
});

test("action mismatches and ordinary Cloudflare rejections fail closed", async () => {
  assert.deepEqual(
    await verifyTurnstileRequest(request(), "submission_upload", {
      fetchImpl: async () =>
        jsonResponse({ success: true, action: "vote" }),
    }),
    { status: "rejected", code: "TURNSTILE_INVALID" }
  );

  assert.deepEqual(
    await verifyTurnstileRequest(request(), "vote", {
      fetchImpl: async () =>
        jsonResponse({
          success: false,
          "error-codes": ["timeout-or-duplicate"],
        }),
    }),
    { status: "rejected", code: "TURNSTILE_INVALID" }
  );
});

test("secret errors are configuration failures and never fail open", async () => {
  assert.deepEqual(
    await verifyTurnstileRequest(request(), "vote", {
      fetchImpl: async () =>
        jsonResponse({
          success: false,
          "error-codes": ["invalid-input-secret"],
        }),
    }),
    {
      status: "configuration_error",
      code: "TURNSTILE_CONFIGURATION_ERROR",
    }
  );
});

test("provider retries reuse one idempotency key and then fail open", async () => {
  const keys = [];
  let calls = 0;
  const result = await verifyTurnstileRequest(request(), "vote", {
    fetchImpl: async (_url, init) => {
      calls += 1;
      keys.push(JSON.parse(init.body).idempotency_key);
      return jsonResponse({
        success: false,
        "error-codes": ["internal-error"],
      });
    },
  });

  assert.deepEqual(result, { status: "provider_unavailable" });
  assert.equal(calls, 2);
  assert.equal(keys[0], keys[1]);
});

test("production cannot silently fall back to public test keys", async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalMode = process.env.TURNSTILE_MODE;

  try {
    process.env.NODE_ENV = "production";
    delete process.env.TURNSTILE_MODE;

    assert.deepEqual(
      await verifyTurnstileRequest(request(), "vote", {
        fetchImpl: async () =>
          jsonResponse({ success: true, action: "vote" }),
      }),
      {
        status: "configuration_error",
        code: "TURNSTILE_CONFIGURATION_ERROR",
      }
    );
  } finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;

    if (originalMode === undefined) delete process.env.TURNSTILE_MODE;
    else process.env.TURNSTILE_MODE = originalMode;
  }
});

test("managed mode requires an exact configured hostname", async () => {
  const original = {
    mode: process.env.TURNSTILE_MODE,
    siteKey: process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY,
    secretKey: process.env.TURNSTILE_SECRET_KEY,
    hostnames: process.env.TURNSTILE_ALLOWED_HOSTNAMES,
  };

  try {
    process.env.TURNSTILE_MODE = "managed";
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = "managed-site-key";
    process.env.TURNSTILE_SECRET_KEY = "managed-secret-key";
    process.env.TURNSTILE_ALLOWED_HOSTNAMES = "dev.example.test";

    assert.deepEqual(
      await verifyTurnstileRequest(request(), "vote", {
        fetchImpl: async () =>
          jsonResponse({
            success: true,
            action: "vote",
            hostname: "other.example.test",
          }),
      }),
      { status: "rejected", code: "TURNSTILE_INVALID" }
    );

    assert.deepEqual(
      await verifyTurnstileRequest(request(), "vote", {
        fetchImpl: async () =>
          jsonResponse({
            success: true,
            action: "vote",
            hostname: "DEV.EXAMPLE.TEST",
          }),
      }),
      { status: "verified" }
    );
  } finally {
    for (const [name, value] of [
      ["TURNSTILE_MODE", original.mode],
      ["NEXT_PUBLIC_TURNSTILE_SITE_KEY", original.siteKey],
      ["TURNSTILE_SECRET_KEY", original.secretKey],
      ["TURNSTILE_ALLOWED_HOSTNAMES", original.hostnames],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
