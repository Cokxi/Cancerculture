import assert from "node:assert/strict";
import { mock, test } from "node:test";

const state = {
  calls: [],
  acceptedStep: 12345,
};

mock.module(new URL("../../lib/db/admin.ts", import.meta.url), {
  namedExports: {
    supabaseAdmin: {
      rpc(name, parameters) {
        state.calls.push({ name, parameters });
        if (name === "verify_account_team_access") {
          return Promise.resolve({ data: { outcome: "allowed", expiresAt: "2026-08-17T01:00:00Z" }, error: null });
        }
        if (name === "get_account_totp_factor_material") {
          return Promise.resolve({
            data: {
              outcome: "ok",
              factorId: "00000000-0000-4000-8000-000000000010",
              ciphertext: "ciphertext",
              nonce: "nonce",
              tag: "tag",
              keyVersion: 1,
            },
            error: null,
          });
        }
        if (name === "record_account_totp_failure") {
          return Promise.resolve({ data: { outcome: "rejected", retryAt: null }, error: null });
        }
        if (name === "grant_account_team_access") {
          return Promise.resolve({
            data: {
              outcome: "granted",
              sessionId: parameters.p_new_session_id,
              expiresAt: "2026-08-17T01:00:00Z",
            },
            error: null,
          });
        }
        throw new Error(`Unexpected RPC ${name}`);
      },
    },
  },
});

mock.module(new URL("../../lib/twoFactor/crypto.server.ts", import.meta.url), {
  namedExports: {
    decryptTwoFactorValue: () => "TOTPSECRET",
    digestTeamAccessContext: () => "c".repeat(64),
    digestTeamAccessToken: () => "t".repeat(64),
    findMatchingTotpStep: () => state.acceptedStep,
    generateTeamAccessToken: () => "A".repeat(43),
  },
});

const {
  grantTeamAreaAccess,
  verifyTeamAreaAccess,
} = await import("../../lib/auth/teamAccess.server.ts");

const session = {
  discord_user_id: "team-user-1",
  session_id: "00000000-0000-4000-8000-000000000001",
};
const requestHeaders = {
  get(name) {
    if (name === "x-vercel-forwarded-for") return "203.0.113.50";
    if (name === "user-agent") return "Mozilla/5.0 Firefox/142.0";
    return null;
  },
};

test.beforeEach(() => {
  state.calls = [];
  state.acceptedStep = 12345;
});

test("missing opaque Team cookie fails before database contact", async () => {
  await assert.rejects(
    verifyTeamAreaAccess({ session, token: null, requestHeaders }),
    { status: 403, code: "TEAM_TOTP_REQUIRED" }
  );
  assert.equal(state.calls.length, 0);
});

test("valid opaque cookie is checked only as keyed token and context digests", async () => {
  const result = await verifyTeamAreaAccess({
    session,
    token: "A".repeat(43),
    requestHeaders,
  });
  assert.equal(result.expiresAt, "2026-08-17T01:00:00Z");
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].name, "verify_account_team_access");
  assert.equal(state.calls[0].parameters.p_token_digest, "t".repeat(64));
  assert.equal(state.calls[0].parameters.p_context_digest, "c".repeat(64));
  assert.doesNotMatch(JSON.stringify(state.calls[0]), /203[.]0[.]113|Firefox/u);
});

test("invalid authenticator code is rate-accounted and never rotates a session", async () => {
  state.acceptedStep = null;
  await assert.rejects(
    grantTeamAreaAccess({ session, code: "000000", requestHeaders }),
    { status: 401, code: "TWO_FACTOR_CODE_INVALID" }
  );
  assert.deepEqual(state.calls.map((call) => call.name), [
    "get_account_totp_factor_material",
    "record_account_totp_failure",
  ]);
});

test("successful TOTP rotates the website session and returns a separate opaque grant", async () => {
  const result = await grantTeamAreaAccess({ session, code: "123456", requestHeaders });
  assert.equal(result.token, "A".repeat(43));
  assert.notEqual(result.sessionId, session.session_id);
  assert.deepEqual(state.calls.map((call) => call.name), [
    "get_account_totp_factor_material",
    "grant_account_team_access",
  ]);
  const grant = state.calls[1].parameters;
  assert.equal(grant.p_session_id, session.session_id);
  assert.equal(grant.p_new_session_id, result.sessionId);
  assert.equal(grant.p_accepted_step, 12345);
  assert.equal(grant.p_token_digest, "t".repeat(64));
  assert.equal(grant.p_context_digest, "c".repeat(64));
});
