import assert from "node:assert/strict";
import test from "node:test";
import { resolveVoteBlockedReason } from "../../lib/vote/voteEligibilityState.ts";

test("an eligible route response overrides the initial pending state", () => {
  assert.equal(resolveVoteBlockedReason(null, "membership_pending"), null);
});

test("the initial state is used only before a local response exists", () => {
  assert.equal(
    resolveVoteBlockedReason(undefined, "membership_pending"),
    "membership_pending"
  );
});

test("local blocked responses override the initial state", () => {
  assert.equal(
    resolveVoteBlockedReason("join_wait", "membership_pending"),
    "join_wait"
  );
  assert.equal(
    resolveVoteBlockedReason("dependency_unavailable", null),
    "dependency_unavailable"
  );
});
