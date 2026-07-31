import assert from "node:assert/strict";
import test from "node:test";
import {
  canModerateSubmission,
  getSubmissionModerationCapability,
  requireDisqualifiedSubmissionsPage,
  requireLiveModerationPage,
  requireSubmissionModerationAction,
} from "../../lib/moderation/submissionModerationAuthorization.ts";

const context = (capabilities = [], isAdmin = false) => ({
  isAdmin,
  resolvedCapabilities: capabilities,
});

test("the four operations map to exactly four granular keys", () => {
  assert.equal(
    getSubmissionModerationCapability(
      "submission_open",
      "disqualify"
    ),
    "submissions.submission_phase.disqualify"
  );
  assert.equal(
    getSubmissionModerationCapability(
      "submission_open",
      "reinstate"
    ),
    "submissions.submission_phase.reinstate"
  );
  assert.equal(
    getSubmissionModerationCapability("voting_open", "disqualify"),
    "submissions.voting_phase.disqualify"
  );
  assert.equal(
    getSubmissionModerationCapability("voting_open", "reinstate"),
    "submissions.voting_phase.reinstate"
  );
});

test("action rights are fully separated and phase-specific", () => {
  const submissionDisqualifier = context([
    "submissions.submission_phase.disqualify",
  ]);
  assert.equal(
    canModerateSubmission(
      submissionDisqualifier,
      "submission_open",
      "disqualify"
    ),
    true
  );
  assert.equal(
    canModerateSubmission(
      submissionDisqualifier,
      "submission_open",
      "reinstate"
    ),
    false
  );
  assert.equal(
    canModerateSubmission(
      submissionDisqualifier,
      "voting_open",
      "disqualify"
    ),
    false
  );
  assert.throws(
    () =>
      requireSubmissionModerationAction(
        submissionDisqualifier,
        "voting_open",
        "disqualify"
      ),
    { status: 403 }
  );
});

test("live page accepts one current-phase right", () => {
  assert.doesNotThrow(() =>
    requireLiveModerationPage(
      context(["submissions.voting_phase.reinstate"]),
      "voting_open"
    )
  );
  assert.throws(
    () =>
      requireLiveModerationPage(
        context(["submissions.submission_phase.reinstate"]),
        "voting_open"
      ),
    { status: 403 }
  );
});

test("disqualified page requires current-phase reinstate", () => {
  assert.doesNotThrow(() =>
    requireDisqualifiedSubmissionsPage(
      context(["submissions.submission_phase.reinstate"]),
      "submission_open"
    )
  );
  assert.throws(
    () =>
      requireDisqualifiedSubmissionsPage(
        context(["submissions.submission_phase.disqualify"]),
        "submission_open"
      ),
    { status: 403 }
  );
});

test("admin remains hard owner without grants", () => {
  for (const phase of ["submission_open", "voting_open"]) {
    for (const operation of ["disqualify", "reinstate"]) {
      assert.doesNotThrow(() =>
        requireSubmissionModerationAction(
          context([], true),
          phase,
          operation
        )
      );
    }
  }
});
