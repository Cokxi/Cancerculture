import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repoRoot = new URL("../../", import.meta.url);
const [route, logger] = await Promise.all([
  readFile(new URL("app/api/vote/route.ts", repoRoot), "utf8"),
  readFile(new URL("lib/logging/logVote.ts", repoRoot), "utf8"),
]);

test("vote rejection logs preserve exact bounded domain reasons", () => {
  for (const reason of [
    "self_vote",
    "duplicate_submission_vote",
    "vote_limit_reached",
    "voting_closed",
    "submission_not_found",
    "submission_ineligible",
    "discord_banned",
    "website_banned",
    "participation_unavailable",
    "not_in_discord",
    "joined_too_recently",
  ]) {
    assert.match(route, new RegExp(`reason: [\\s\\S]*?"${reason}"`, "u"));
  }
});

test("cycleless banned attempts remain loggable without exposing errors", () => {
  assert.match(
    route,
    /if \(voteEligibility\.isBanned\)[\s\S]*?cycleId: voteEligibility\.activeCycleId/
  );
  assert.match(logger, /console\.error\("\[VOTE LOG\]", \{/);
  assert.match(logger, /errorName:/);
  assert.doesNotMatch(logger, /console\.error\("\[VOTE LOG\]", error\)/);
});
