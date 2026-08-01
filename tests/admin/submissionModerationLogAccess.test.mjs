import assert from "node:assert/strict";
import test from "node:test";
import { getDelegatedSubmissionModerationReason } from "../../lib/admin/submissionModerationLogAccess.ts";

test("delegated submission moderation reasons expose only broad categories", () => {
  const cases = new Map([
    ["spam", "rules_violation"],
    ["nudity", "rules_violation"],
    ["policy_violation", "rules_violation"],
    ["child_abuse", "illegal_content"],
    ["copyright_violation", "illegal_content"],
    ["copyright_claim", "legal_or_rights_review"],
    ["dmca_notice", "legal_or_rights_review"],
    ["manual_review", "manual_review"],
    ["sensitive_internal_detail", "moderation_reason_redacted"],
  ]);

  for (const [reason, expected] of cases) {
    assert.equal(getDelegatedSubmissionModerationReason(reason), expected);
  }
});

test("missing and mixed-case moderation reasons fail closed", () => {
  assert.equal(
    getDelegatedSubmissionModerationReason(null),
    "moderation_reason_redacted"
  );
  assert.equal(
    getDelegatedSubmissionModerationReason(" LEGAL_REVIEW "),
    "legal_or_rights_review"
  );
});
