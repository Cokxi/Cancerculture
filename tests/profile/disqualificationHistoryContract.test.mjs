import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repoRoot = new URL("../../", import.meta.url);
const source = (path) => readFile(new URL(path, repoRoot), "utf8");

test("the self read model derives the subject only from the authenticated session", async () => {
  const loader = await source(
    "lib/profile/disqualificationHistoryReadModel.server.ts"
  );
  const selfBlock = loader.slice(
    loader.indexOf("export async function loadOwnDisqualificationHistory"),
    loader.indexOf("export async function loadTeamDisqualificationHistory")
  );

  assert.match(selfBlock, /const session = await requireSession\(\)/u);
  assert.match(selfBlock, /session\.discord_user_id/u);
  assert.doesNotMatch(selfBlock, /discordUserId\s*:/u);
  assert.doesNotMatch(loader, /export async function readHistoryPage/u);
});

test("delegated loaders resolve authorization internally and require one exact capability", async () => {
  const loader = await source(
    "lib/profile/disqualificationHistoryReadModel.server.ts"
  );
  const detailBlock = loader.slice(
    loader.indexOf("export async function loadTeamDisqualificationHistory"),
    loader.indexOf("export async function loadDisqualificationProfiles")
  );
  const listBlock = loader.slice(
    loader.indexOf("export async function loadDisqualificationProfiles")
  );

  for (const block of [detailBlock, listBlock]) {
    assert.match(block, /await getTeamAuthorizationContext\(\)/u);
    assert.match(block, /requireHistoryCapability\(authorization\)/u);
    assert.doesNotMatch(block, /authorization\s*:/u);
  }
  assert.match(loader, /"users\.disqualified_submissions\.view"/u);
  assert.doesNotMatch(loader, /users\.directory\.full\.view/u);
  assert.doesNotMatch(loader, /logs\.submission_moderation\.view/u);
});

test("self sees the exact DQ reason while delegates remain redacted", async () => {
  const loader = await source(
    "lib/profile/disqualificationHistoryReadModel.server.ts"
  );

  assert.match(loader, /const canViewExactReason =/u);
  assert.match(
    loader,
    /viewerMode === "self" &&[\s\S]*event\.transition === "disqualified"/u
  );
  assert.match(loader, /reasonCode: canViewExactReason \? event\.reasonCode : null/u);
  assert.match(loader, /reasonText: canViewExactReason \? event\.reasonText : null/u);
  assert.match(
    loader,
    /viewerMode === "owner"[\s\S]*ownerActorLabel\(event\)[\s\S]*: null/u
  );
  assert.match(loader, /getDelegatedSubmissionModerationReason/u);
  assert.doesNotMatch(loader, /evidence|r2_key.*reasonText|request_payload/iu);
});

test("expanded moderation events render newest first without rewriting history", async () => {
  const [loader, list] = await Promise.all([
    source("lib/profile/disqualificationHistoryReadModel.server.ts"),
    source("app/components/profile/DisqualificationHistoryList.tsx"),
  ]);

  assert.match(loader, /const chronologicalEvents = parseEvents\(row\.events\)\.sort/u);
  assert.match(loader, /const latestEvent = chronologicalEvents\.at\(-1\)/u);
  assert.match(loader, /chronologicalEvents\.slice\(\)\.reverse\(\)\.map/u);
  assert.doesNotMatch(list, /item\.events\.(?:sort|reverse)\(/u);
});

test("public profiles omit current DQs and serialize no DQ state or reason", async () => {
  const [publicLoader, publicPage] = await Promise.all([
    source("lib/profile/getPublicUserProfileData.ts"),
    source("app/profile/[publicProfileId]/page.tsx"),
  ]);

  assert.match(publicLoader, /if \(submission\.is_disqualified\) \{\s+return null;/u);
  assert.match(publicLoader, /\| "is_disqualified"/u);
  assert.match(publicLoader, /\| "disqualification_reason_code"/u);
  assert.match(publicLoader, /\| "disqualification_reason_text"/u);
  assert.doesNotMatch(publicPage, /submission\.is_disqualified/u);
  assert.doesNotMatch(publicPage, /Disqualified/u);
});

test("the private current-profile projection shows the DQ reason but no actor", async () => {
  const [profileLoader, profilePage, sections] = await Promise.all([
    source("lib/profile/getUserProfileData.ts"),
    source("app/my-profile/page.tsx"),
    source("app/my-profile/ProfileSections.tsx"),
  ]);

  assert.match(profileLoader, /disqualification_reason_category/u);
  assert.match(profileLoader, /getDelegatedSubmissionModerationReason/u);
  assert.match(profileLoader, /\| "disqualified_by_discord_username"/u);
  assert.match(profilePage, /disqualification_reason_text/u);
  assert.doesNotMatch(profilePage, /disqualified_by_discord_username/u);
  assert.match(sections, /disqualification_reason_text/u);
  assert.doesNotMatch(sections, /disqualified_by_discord_username/u);
});

test("the user directory links directly to the complete moderation history", async () => {
  const page = await source("app/admin/users/page.tsx");

  assert.match(page, /View User Moderation History/u);
  assert.match(page, /publicProfileIdByDiscordUserId\.get\(user\.discord_user_id\)/u);
  assert.doesNotMatch(
    page,
    /canViewDisqualificationHistory\s*&&\s*user\.public_profile_id/u
  );
});
