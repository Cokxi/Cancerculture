import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repoRoot = new URL("../../", import.meta.url);
const source = (path) => readFile(new URL(path, repoRoot), "utf8");

test("refund execution and history use separate exact server-side capabilities", async () => {
  const [route, refundRead, historyRead, navigation, teamRoles] =
    await Promise.all([
      source("app/api/admin/vote-refunds/route.ts"),
      source("lib/voteRefund/readModel.server.ts"),
      source("lib/voteRefund/historyReadModel.server.ts"),
      source("lib/admin/teamAreaNavigation.ts"),
      source("lib/auth/teamRoles.ts"),
    ]);

  assert.match(route, /requireDynamicTeamCapability\(\s*"votes\.refund_disqualified"/u);
  assert.match(refundRead, /requireDynamicTeamCapability\("votes\.refund_disqualified"\)/u);
  assert.match(historyRead, /requireDynamicTeamCapability\(\s*"logs\.vote_refunds\.view"/u);
  assert.doesNotMatch(route, /logs\.vote_refunds\.view/u);
  assert.doesNotMatch(historyRead, /votes\.refund_disqualified/u);
  assert.match(navigation, /"votes\.refund_disqualified"/u);
  assert.match(navigation, /"logs\.vote_refunds\.view"/u);
  assert.doesNotMatch(teamRoles, /canRefundDisqualifiedVotes/u);
});

test("the UI requires explicit selection and warns that reinstatement cannot restore refunded votes", async () => {
  const panel = await source(
    "app/admin/moderation/vote-refunds/VoteRefundPanel.tsx"
  );

  assert.match(panel, /Select all on this page/u);
  assert.match(panel, /Every other disqualified[\s\S]*submission keeps all of its votes/u);
  assert.match(panel, /later reinstatement will not restore these[\s\S]*votes/u);
  assert.match(panel, /REFUND/u);
  assert.match(panel, /crypto\.randomUUID\(\)/u);
  assert.match(panel, /expectedDisqualifiedAt/u);
  assert.match(panel, /expectedVoteCount/u);
  assert.doesNotMatch(panel, /refund all disqualified/iu);
});

test("delegated history does not read or expose individual refund items", async () => {
  const [historyRead, historyPage] = await Promise.all([
    source("lib/voteRefund/historyReadModel.server.ts"),
    source("app/admin/logs/vote-refunds/page.tsx"),
  ]);

  assert.match(historyRead, /authorization\.isAdmin \? \["reason_text", "request_hash"\] : \[\]/u);
  assert.doesNotMatch(historyRead, /\.from\("vote_refund_items"\)/u);
  assert.doesNotMatch(historyRead, /voter_discord_user_id|original_vote_id/u);
  assert.match(historyPage, /Individual voter[\s\S]*records are not exposed/u);
});
