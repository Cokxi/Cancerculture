import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  requirePositiveVersion,
  requireUuid,
  validateCommunityPollDraft,
} from "../../lib/communityPolls/validation.ts";

const repoRoot = new URL("../../", import.meta.url);
const source = (path) => readFile(new URL(path, repoRoot), "utf8");

test("draft validation keeps durations and options bounded", () => {
  const draft = validateCommunityPollDraft({
    question: "Where should this locked donation go?",
    context: "The original organization cannot receive SOL.",
    durationHours: "24",
    options: "Roll into a later Cycle\nReturn to the winner",
  });
  assert.equal(draft.durationHours, 24);
  assert.deepEqual(draft.options, [
    "Roll into a later Cycle",
    "Return to the winner",
  ]);
  assert.throws(() => validateCommunityPollDraft({
    question: "Too short",
    durationHours: 12,
    options: ["One", "Two"],
  }));
  assert.throws(() => validateCommunityPollDraft({
    question: "A sufficiently long duplicate question?",
    durationHours: 24,
    options: ["Same", "same"],
  }));
});

test("public identifiers and optimistic versions are validated", () => {
  assert.equal(
    requireUuid("123e4567-e89b-42d3-a456-426614174000", "Poll"),
    "123e4567-e89b-42d3-a456-426614174000"
  );
  assert.equal(requirePositiveVersion("3"), 3);
  assert.throws(() => requireUuid("7", "Poll"));
  assert.throws(() => requirePositiveVersion(0));
});

test("public pages expose stable active and history surfaces without private IDs", async () => {
  const [index, detail, card] = await Promise.all([
    source("app/community-votes/page.tsx"),
    source("app/community-votes/[pollId]/page.tsx"),
    source("app/components/communityVotes/CommunityPollCard.tsx"),
  ]);
  assert.match(index, /Active polls/u);
  assert.match(index, /Poll history/u);
  assert.match(index, /temporarily unavailable/u);
  assert.match(index, /role="alert"/u);
  assert.match(detail, /params: Promise<\{ pollId: string \}>/u);
  assert.match(card, /Open stable poll page/u);
  assert.match(card, /resultsVisible/u);
  assert.match(card, /30_000/u);
  assert.match(card, /Discord server membership is not required/u);
  assert.match(card, /cannot be changed or withdrawn/u);
  assert.doesNotMatch(card, /discord_user_id|participant_digest|participation_secret/u);
  assert.doesNotMatch(`${index}${detail}`, /participant_digest|participation_secret/u);
  assert.doesNotMatch(`${index}${detail}`, /initialPoll=\{[^}]*discord_user_id/u);
});

test("vote API uses Website session auth, no-store, and no participation guard", async () => {
  const route = await source("app/api/community-votes/[pollId]/route.ts");
  assert.match(route, /requireSession\(\)/u);
  assert.match(route, /castCommunityPollVote/u);
  assert.match(route, /Cache-Control", "no-store"/u);
  assert.match(route, /params: Promise<\{ pollId: string \}>/u);
  assert.doesNotMatch(route, /requireParticipation|getParticipationAccess|DiscordMembership/iu);
  assert.doesNotMatch(route, /console\.(log|error).*option/iu);
});

test("management page and every action recheck the exact capability", async () => {
  const [page, actions, navigation, button, data] = await Promise.all([
    source("app/admin/community-votes/page.tsx"),
    source("app/admin/community-votes/actions.ts"),
    source("lib/admin/teamAreaNavigation.ts"),
    source("app/admin/community-votes/CommunityPollActionButton.tsx"),
    source("lib/communityPolls/data.server.ts"),
  ]);
  assert.match(page, /requireTeamCapabilityPage\(\s*"community\.polls\.manage"/u);
  assert.equal(
    actions.match(/requireDynamicTeamCapability\(\s*"community\.polls\.manage"/gu)?.length,
    5
  );
  assert.match(navigation, /href: "\/admin\/community-votes"/u);
  assert.match(page, /without publishing a Homepage Info Box/u);
  assert.match(button, /useFormStatus/u);
  assert.match(button, /window\.confirm/u);
  assert.match(data, /requireManagementOutcome/u);
  assert.match(data, /This poll changed\. Refresh the page/u);
  assert.doesNotMatch(actions, /homepage_info_blocks|push|VAPID/iu);
});
