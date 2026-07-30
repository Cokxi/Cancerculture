import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { AuthError } from "../../lib/auth/AuthError.ts";

const authenticatedSession = {
  discord_user_id: "profile-user",
  session_id: "00000000-0000-4000-8000-000000000001",
};
const state = {
  error: null,
};

mock.module(
  new URL("../../lib/auth/requireSession.ts", import.meta.url),
  {
    namedExports: {
      async requireSession() {
        if (state.error) {
          throw state.error;
        }

        return authenticatedSession;
      },
    },
  }
);

const { getSessionState } = await import(
  "../../lib/auth/sessionState.ts"
);

test.beforeEach(() => {
  state.error = null;
});

test("valid sessions remain authenticated", async () => {
  assert.deepEqual(await getSessionState(), {
    status: "authenticated",
    session: authenticatedSession,
  });
});

for (const scenario of [
  "missing session cookie",
  "invalid session",
  "revoked session",
]) {
  test(`${scenario} becomes anonymous`, async () => {
    state.error = new AuthError(
      401,
      "Not authenticated",
      "NOT_AUTHENTICATED"
    );

    assert.deepEqual(await getSessionState(), {
      status: "anonymous",
    });
  });
}

test("known account restrictions retain their reason", async () => {
  state.error = new AuthError(
    403,
    "Account restricted",
    "DISCORD_BANNED"
  );
  assert.deepEqual(await getSessionState(), {
    status: "restricted",
    reason: "discord_banned",
  });

  state.error = new AuthError(
    403,
    "Account restricted",
    "WEBSITE_BANNED"
  );
  assert.deepEqual(await getSessionState(), {
    status: "restricted",
    reason: "website_banned",
  });
});

test("expected auth dependency failures become controlled state", async () => {
  for (const error of [
    new AuthError(
      503,
      "Authentication service temporarily unavailable",
      "AUTHENTICATION_UNAVAILABLE"
    ),
    new AuthError(403, "Unexpected auth restriction"),
  ]) {
    state.error = error;
    assert.deepEqual(await getSessionState(), {
      status: "dependency_unavailable",
    });
  }
});

test("unexpected programming errors still surface", async () => {
  state.error = new Error("unexpected");

  await assert.rejects(getSessionState(), /unexpected/);
});
