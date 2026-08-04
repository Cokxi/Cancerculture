import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getSubmissionDestinationHref } from "../../lib/submissions/getSubmissionDestinationHref.ts";

const destination = (overrides = {}) =>
  getSubmissionDestinationHref({
    cycleId: 7,
    cycleStatus: "submission_open",
    isDisqualified: false,
    publicVisibilityStatus: "visible",
    submissionId: 42,
    ...overrides,
  });

test("current public cycle links use the canonical submissions view", () => {
  for (const cycleStatus of [
    "active",
    "submission_open",
    "voting_open",
    "paused",
  ]) {
    assert.equal(
      destination({ cycleStatus }),
      "/submissions?submission=42"
    );
  }
});

test("finished cycle links use the canonical history view", () => {
  for (const publicVisibilityStatus of [
    null,
    "visible",
    "legal_review",
  ]) {
    assert.equal(
      destination({
        cycleStatus: "finished",
        publicVisibilityStatus,
      }),
      "/cycle-history?cycle=7#submission-42"
    );
  }
});

test("unavailable or non-public submissions fail closed", () => {
  for (const overrides of [
    { isDisqualified: true },
    { publicVisibilityStatus: "removed" },
    { publicVisibilityStatus: "legal_review" },
    { publicVisibilityStatus: null },
    { cycleStatus: "voting_closed" },
    { cycleStatus: "finished", publicVisibilityStatus: "removed" },
    { cycleId: 0 },
    { submissionId: 0 },
  ]) {
    assert.equal(destination(overrides), null);
  }
});

test("existing submission links reuse the canonical resolver without changing the legacy view contract", async () => {
  const [profileQuery, adminDropdown] = await Promise.all([
    readFile(
      new URL("../../lib/queries/getUserSubmissions.ts", import.meta.url),
      "utf8"
    ),
    readFile(
      new URL(
        "../../app/admin/users/UserSubmissionsDropdown.tsx",
        import.meta.url
      ),
      "utf8"
    ),
  ]);

  assert.match(profileQuery, /getSubmissionDestinationHref/u);
  assert.match(adminDropdown, /getSubmissionDestinationHref/u);
  assert.match(
    profileQuery,
    /\.from\("submissions"\)[\s\S]*?\.select\("id, cycle_id, public_visibility_status"\)/u
  );
  assert.doesNotMatch(
    profileQuery,
    /\.from\("submissions_with_votes"\)[\s\S]*?public_visibility_status[\s\S]*?\.eq\("discord_user_id"/u
  );
});
