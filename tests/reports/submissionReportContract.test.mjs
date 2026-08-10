import assert from "node:assert/strict";
import test from "node:test";
import {
  SUBMISSION_REPORT_REASONS,
  SUBMISSION_REPORT_REASONS_BY_SURFACE,
  SUBMISSION_REPORT_REASON_LABELS,
  SUBMISSION_REPORT_TAXONOMY_VERSION,
  parseSubmissionReportCreateInput,
} from "../../lib/reports/submissionReportContract.ts";

const valid = (overrides = {}) => ({
  submissionId: 42,
  reason: "privacy_or_personal_information",
  subcategory: "doxxing",
  comment: "This exposes private location information.",
  idempotencyKey: "3d4f7a8e-4b35-4a0f-8f89-a36f12d4d5f1",
  ...overrides,
});

test("Submission Report V2 exposes the phase-specific public reason contract", () => {
  assert.equal(SUBMISSION_REPORT_TAXONOMY_VERSION, 2);
  assert.equal(SUBMISSION_REPORT_REASONS.length, 7);
  assert.equal(SUBMISSION_REPORT_REASON_LABELS.other_rules_concern, "Other");
  assert.equal(SUBMISSION_REPORT_REASONS.includes("spam_or_platform_abuse"), false);
  assert.equal(
    SUBMISSION_REPORT_REASONS_BY_SURFACE.active.includes("fair_play_manipulation"),
    true
  );
  assert.equal(
    SUBMISSION_REPORT_REASONS_BY_SURFACE.active.includes("rights_or_ownership"),
    false
  );
  assert.equal(
    SUBMISSION_REPORT_REASONS_BY_SURFACE.history.includes("rights_or_ownership"),
    true
  );
  assert.equal(
    SUBMISSION_REPORT_REASONS_BY_SURFACE.history.includes("fair_play_manipulation"),
    false
  );
});

test("creation requires a valid specific or Other subcategory", () => {
  assert.deepEqual(parseSubmissionReportCreateInput(valid()), valid());
  assert.equal(parseSubmissionReportCreateInput(valid({ subcategory: "" })), null);
  assert.equal(
    parseSubmissionReportCreateInput(
      valid({ reason: "privacy_or_personal_information", subcategory: "spam" })
    ),
    null
  );
  assert.equal(parseSubmissionReportCreateInput(valid({ reason: "unknown" })), null);
  assert.equal(parseSubmissionReportCreateInput(valid({ submissionId: 0 })), null);
});

test("Other, Fair Play, Rights, and general concerns require 20 characters", () => {
  for (const report of [
    valid({ subcategory: "other" }),
    valid({
      reason: "fair_play_manipulation",
      subcategory: "vote_influence_or_promotion",
    }),
    valid({
      reason: "rights_or_ownership",
      subcategory: "copyright_or_unlicensed_use",
    }),
    valid({ reason: "other_rules_concern", subcategory: "other" }),
  ]) {
    assert.equal(
      parseSubmissionReportCreateInput({ ...report, comment: "x".repeat(19) }),
      null
    );
    assert.ok(
      parseSubmissionReportCreateInput({ ...report, comment: "x".repeat(20) })
    );
  }
});

test("optional reporter context remains trimmed and bounded", () => {
  assert.deepEqual(
    parseSubmissionReportCreateInput(valid({ comment: "" })),
    valid({ comment: null })
  );
  assert.equal(parseSubmissionReportCreateInput(valid({ comment: "short" })), null);
  assert.equal(
    parseSubmissionReportCreateInput(valid({ comment: "x".repeat(501) })),
    null
  );
});
