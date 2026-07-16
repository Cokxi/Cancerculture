import assert from "node:assert/strict";
import test from "node:test";
import {
  getValidatedApplicationOrigin,
  sanitizeInternalReturnPath,
} from "../../lib/auth/oauth/safeReturnPath.ts";
import {
  createOAuthState,
  OAUTH_STATE_MAX_AGE_SECONDS,
  validateOAuthState,
} from "../../lib/auth/oauth/state.ts";

const applicationOrigin = getValidatedApplicationOrigin(
  "https://cancerculture.example/app-path"
);

const allowedPaths = [
  "/",
  "/submissions",
  "/profile",
  "/profile?tab=socials",
  "/cycle-history?cycle=12#submission-55",
];

const rejectedPaths = [
  "",
  "   ",
  "//evil.example",
  "///evil.example",
  "https://evil.example",
  "http://evil.example",
  "javascript:alert(1)",
  "data:text/html,test",
  "ftp://evil.example",
  "\\\\evil.example",
  "/\\evil.example",
  "/path\\segment",
  "/path\r\ninjected",
  "/path\0injected",
  "/%2f%2fevil.example",
  "/%5cevil.example",
  "/%252f%252fevil.example",
  "/%0d%0ainjected",
  "/malformed%encoding",
];

for (const path of allowedPaths) {
  test(`allows internal return path: ${path}`, () => {
    assert.equal(
      sanitizeInternalReturnPath(path, applicationOrigin),
      path
    );
  });
}

for (const path of rejectedPaths) {
  test(`rejects unsafe return path: ${JSON.stringify(path)}`, () => {
    assert.equal(
      sanitizeInternalReturnPath(path, applicationOrigin),
      "/"
    );
  });
}

test("OAuth state is random, matched, and time bounded", () => {
  const now = Date.now();
  const first = createOAuthState(now);
  const second = createOAuthState(now);

  assert.notEqual(first, second);
  assert.equal(validateOAuthState(first, first, now), true);
  assert.equal(validateOAuthState(null, first, now), false);
  assert.equal(validateOAuthState(first, null, now), false);
  assert.equal(validateOAuthState(second, first, now), false);
  assert.equal(
    validateOAuthState(
      first,
      first,
      now + OAUTH_STATE_MAX_AGE_SECONDS * 1000 + 1
    ),
    false
  );
});
