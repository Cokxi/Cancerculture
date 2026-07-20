import assert from "node:assert/strict";
import test from "node:test";
import { AuthError } from "../../lib/auth/AuthError.ts";
import { getTeamPageAccessRedirect } from "../../lib/auth/pageAccessDecision.ts";

test("authentication and authorization denials map to the Forbidden page", () => {
  assert.equal(
    getTeamPageAccessRedirect(new AuthError(401, "Not authenticated")),
    "/403"
  );
  assert.equal(
    getTeamPageAccessRedirect(new AuthError(403, "Membership pending")),
    "/403"
  );
});

test("dependency failures are not disguised as a Forbidden response", () => {
  assert.equal(
    getTeamPageAccessRedirect(new AuthError(503, "Dependency unavailable")),
    null
  );
  assert.equal(getTeamPageAccessRedirect(new Error("Unexpected")), null);
});
