import assert from "node:assert/strict";
import test from "node:test";
import {
  getTeamCapabilityPermissionTab,
  TEAM_CAPABILITY_PERMISSION_TABS,
} from "../../lib/auth/teamCapabilityPresentation.ts";
import { ACTIVE_TEAM_CAPABILITY_KEYS } from "../../lib/auth/teamCapabilityRegistry.ts";

const expectedViewKeys = [
  "submissions.reports.live.view",
  "submissions.reports.finalized.view",
  "users.flag.view",
  "users.warnings.view",
  "users.directory.basic.view",
  "users.directory.full.view",
  "users.disqualified_submissions.view",
  "users.upload_blocks.view",
  "users.website_bans.view",
  "logs.website_bans.view",
  "logs.uploads.view",
  "logs.avatar_uploads.view",
  "logs.votes.view",
  "logs.vote_refunds.view",
  "logs.submission_moderation.view",
  "logs.submission_reporters.view",
  "logs.submission_report_moderation.view",
  "logs.team_authorization.view",
  "cycles.logs.view",
  "community.comment_reports.view",
  "community.comment_spam.view",
  "logs.community_comment_moderation.view",
  "sponsorships.reports.view",
  "winners.payouts.view",
  "winners.payout_logs.view",
];

const expectedActionKeys = [
  "submissions.submission_phase.disqualify",
  "submissions.submission_phase.reinstate",
  "submissions.voting_phase.disqualify",
  "submissions.voting_phase.reinstate",
  "submissions.reports.review",
  "users.flag.create",
  "users.flag.review",
  "users.warnings.issue",
  "users.warnings.overrule",
  "users.website_bans.create",
  "users.website_bans.revoke",
  "cycles.manage",
  "votes.refund_disqualified",
  "rules.manage",
  "faq.manage",
  "homepage_content.manage",
  "community.polls.manage",
  "community.comment_reports.review",
  "community.comments.moderate",
  "community.comment_spam.review",
  "donation_organizations.manage",
  "winners.manage_payouts",
  "winners.recipient_corrections.manage",
];

test("the permission presentation exposes exactly View and Actions tabs", () => {
  assert.deepEqual([...TEAM_CAPABILITY_PERMISSION_TABS], [
    "view",
    "actions",
  ]);
});

test("every active capability is assigned once to its semantic tab", () => {
  const viewKeys = ACTIVE_TEAM_CAPABILITY_KEYS.filter(
    (key) => getTeamCapabilityPermissionTab(key) === "view"
  );
  const actionKeys = ACTIVE_TEAM_CAPABILITY_KEYS.filter(
    (key) => getTeamCapabilityPermissionTab(key) === "actions"
  );

  assert.deepEqual(viewKeys, expectedViewKeys);
  assert.deepEqual(actionKeys, expectedActionKeys);
  assert.equal(viewKeys.length, 25);
  assert.equal(actionKeys.length, 23);
  assert.equal(viewKeys.length + actionKeys.length, ACTIVE_TEAM_CAPABILITY_KEYS.length);
  assert.equal(new Set([...viewKeys, ...actionKeys]).size, ACTIVE_TEAM_CAPABILITY_KEYS.length);
  assert.equal(
    ACTIVE_TEAM_CAPABILITY_KEYS.includes("coin_launches.manage"),
    false
  );
});
