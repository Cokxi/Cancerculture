import assert from "node:assert/strict";
import test from "node:test";
import { getDelegatedVoteLogReason } from "../../lib/admin/voteLogAccess.ts";

test("accepted votes expose no rejection reason", () => {
  assert.equal(
    getDelegatedVoteLogReason("database_internal_detail", "accepted"),
    null
  );
});

test("delegated vote reasons preserve only bounded product categories", () => {
  const cases = new Map([
    ["banned", "access_denied"],
    ["discord_banned", "access_denied"],
    ["website_banned", "access_denied"],
    ["participation_unavailable", "access_denied"],
    ["not_in_discord", "access_denied"],
    ["joined_too_recently", "access_denied"],
    ["self_vote", "self_vote"],
    ["already_voted", "duplicate_vote"],
    ["duplicate_submission_vote", "duplicate_vote"],
    ["vote_limit_reached", "vote_limit_reached"],
    ["voting_closed", "cycle_unavailable"],
    ["submission_not_found", "submission_unavailable"],
    ["submission_ineligible", "submission_unavailable"],
    ["sensitive_internal_detail", "vote_rejected"],
  ]);

  for (const [reason, expected] of cases) {
    assert.equal(getDelegatedVoteLogReason(reason, "rejected"), expected);
  }
});

test("missing and mixed-case vote reasons fail closed", () => {
  assert.equal(
    getDelegatedVoteLogReason(null, "rejected"),
    "vote_rejected"
  );
  assert.equal(
    getDelegatedVoteLogReason(" WEBSITE_BANNED ", "REJECTED"),
    "access_denied"
  );
});
