import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  DISCORD_MEMBERSHIP_FRESHNESS_MINUTES,
  getDiscordMembershipCooldown,
  isDiscordMembershipObservationFresh,
} from "../../lib/eligibility/discordMembershipFreshness.ts";

const readRepoFile = (path) =>
  readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("a known Discord member remains eligible through the 90-minute observation window", () => {
  const now = Date.parse("2026-07-17T12:00:00.000Z");
  const freshRejoin = new Date(now - 10 * 60 * 1000).toISOString();
  const boundary = new Date(
    now - DISCORD_MEMBERSHIP_FRESHNESS_MINUTES * 60 * 1000
  ).toISOString();

  assert.equal(DISCORD_MEMBERSHIP_FRESHNESS_MINUTES, 90);
  assert.equal(isDiscordMembershipObservationFresh(freshRejoin, now), true);
  assert.equal(isDiscordMembershipObservationFresh(boundary, now), true);
  assert.equal(
    isDiscordMembershipObservationFresh(
      new Date(now + 5 * 60 * 1000).toISOString(),
      now
    ),
    true
  );
});

test("stale, missing, and malformed membership observations fail closed", () => {
  const now = Date.parse("2026-07-17T12:00:00.000Z");
  const stale = new Date(now - 90 * 60 * 1000 - 1).toISOString();

  assert.equal(isDiscordMembershipObservationFresh(stale, now), false);
  assert.equal(
    isDiscordMembershipObservationFresh(
      new Date(now + 5 * 60 * 1000 + 1).toISOString(),
      now
    ),
    false
  );
  assert.equal(isDiscordMembershipObservationFresh(null, now), false);
  assert.equal(isDiscordMembershipObservationFresh("not-a-date", now), false);
});

test("the join cooldown changes eligibility exactly at ten minutes", () => {
  const now = Date.parse("2026-07-17T12:00:00.000Z");

  assert.deepEqual(
    getDiscordMembershipCooldown(
      new Date(now - (10 * 60 * 1000 - 1000)).toISOString(),
      now
    ),
    { joinedTooRecently: true, retryAfterMs: 1000 }
  );
  assert.deepEqual(
    getDiscordMembershipCooldown(
      new Date(now - 10 * 60 * 1000).toISOString(),
      now
    ),
    { joinedTooRecently: false, retryAfterMs: 0 }
  );
  assert.deepEqual(
    getDiscordMembershipCooldown(
      new Date(now - (10 * 60 * 1000 + 1000)).toISOString(),
      now
    ),
    { joinedTooRecently: false, retryAfterMs: 0 }
  );
  assert.equal(getDiscordMembershipCooldown(null, now), null);
  assert.equal(getDiscordMembershipCooldown("not-a-date", now), null);
});

test("an offline join observed after four minutes retains six minutes of cooldown", () => {
  const now = Date.parse("2026-07-17T12:00:00.000Z");

  assert.deepEqual(
    getDiscordMembershipCooldown(
      new Date(now - 4 * 60 * 1000).toISOString(),
      now
    ),
    { joinedTooRecently: true, retryAfterMs: 6 * 60 * 1000 }
  );
});

test("eligibility checks Freshness before applying the join cooldown and refreshes when it ends", async () => {
  const [membership, submissionsClient] = await Promise.all([
    readRepoFile("lib/eligibility/discordMembership.ts"),
    readRepoFile("app/submissions/SubmissionsClient.tsx"),
  ]);

  assert.match(membership, /isDiscordMembershipObservationFresh/);
  assert.ok(
    membership.indexOf("isDiscordMembershipObservationFresh") <
      membership.indexOf("const joinedAt"),
    "freshness must be checked before the cooldown calculation"
  );
  assert.match(submissionsClient, /cache: "no-store"/);
  assert.match(submissionsClient, /onComplete=\{\(\) => \{[\s\S]*loadVoteEligibility\(\)/);
});
