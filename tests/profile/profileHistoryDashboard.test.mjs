import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("the Feed exposes native Share and Copy Link without app-specific targets", async () => {
  const actions = await source("app/spread/CommunityFeedCardActions.tsx");
  assert.match(actions, /onClick=\{shareNative\}/u);
  assert.match(actions, />\s*Copy Link\s*</u);
  assert.doesNotMatch(
    actions,
    /facebook|whatsapp|telegram|signal|More apps|t\.me|wa\.me/iu,
  );
});

test("My Profile uses Permanent Marker headings and five-item history previews", async () => {
  const [page, sections, reports] = await Promise.all([
    source("app/my-profile/page.tsx"),
    source("app/my-profile/ProfileSections.tsx"),
    source("lib/reports/submissionReportOwn.server.ts"),
  ]);

  assert.match(sections, /const PROFILE_PREVIEW_LIMIT = 5/u);
  assert.match(sections, /font-\['Permanent_Marker'\]/u);
  assert.match(sections, /submissions\.slice\(0, PROFILE_PREVIEW_LIMIT\)/u);
  assert.match(sections, /votes\.slice\(0, PROFILE_PREVIEW_LIMIT\)/u);
  assert.match(sections, /completedWins\.slice\(0, PROFILE_PREVIEW_LIMIT\)/u);
  assert.match(page, /getOwnSavedMemes[\s\S]*limit: PROFILE_PREVIEW_LIMIT/u);
  assert.match(page, /loadOwnSubmissionReports/u);
  assert.match(page, /loadOwnDisqualificationHistory/u);
  assert.match(reports, /limit = PAGE_SIZE/u);
  assert.match(reports, /limit < 1 \|\| limit > PAGE_SIZE/u);
  assert.match(reports, /p_limit: limit/u);
});

test("every private history category links from its preview to a full overview", async () => {
  const sections = await source("app/my-profile/ProfileSections.tsx");

  for (const [href, label] of [
    ["/my-profile/submissions", "Open My Submissions to see all submissions"],
    ["/my-profile/winnings", "Open My Wins to see all wins"],
    ["/my-profile/saved-memes", "Open My Saved Memes to see all saved memes"],
    ["/my-reports", "Open My Reports to see all reports"],
    ["/my-profile/disqualifications", "Open My Moderation History to see all history"],
    ["/my-profile/votes", "Open My Votes to see all votes"],
  ]) {
    assert.ok(sections.includes(`href="${href}"`));
    assert.ok(sections.includes(label));
  }
});

test("full Submissions, Wins and Votes overviews preserve session checks and use Home", async () => {
  const pages = await Promise.all([
    source("app/my-profile/submissions/page.tsx"),
    source("app/my-profile/winnings/page.tsx"),
    source("app/my-profile/votes/page.tsx"),
  ]);

  for (const page of pages) {
    assert.match(page, /getSessionState\(\)/u);
    assert.match(page, /<BackButton href="\/" label="Home" \/>/u);
    assert.match(page, /font-\['Permanent_Marker'\]/u);
  }
});

test("Saved Memes and Winner Claim use the canonical Home control and clean headings", async () => {
  const [saved, claim] = await Promise.all([
    source("app/my-profile/saved-memes/page.tsx"),
    source("app/my-profile/winnings/[claimId]/page.tsx"),
  ]);

  assert.match(saved, /<BackButton href="\/" label="Home" \/>/u);
  assert.match(saved, /font-\['Permanent_Marker'\]/u);
  assert.doesNotMatch(saved, /private links to the original memes|separate copy/iu);
  assert.match(claim, /<BackButton href="\/" label="Home" \/>/u);
});

test("My Votes reuse the public submission destination and expose a history action", async () => {
  const [profileData, lists] = await Promise.all([
    source("lib/profile/getUserProfileData.ts"),
    source("app/my-profile/ProfileHistoryLists.tsx"),
  ]);

  assert.match(profileData, /destination_href: string \| null/u);
  assert.match(profileData, /getSubmissionDestinationHref/u);
  assert.match(profileData, /destination_href: voteSubmission\?\.destinationHref \?\? null/u);
  assert.match(lists, /vote\.destination_href/u);
  assert.match(lists, /View in Cycle History/u);
});

test("My Wins show the matching public meme and link it back to Cycle History", async () => {
  const [page, fullPage, sections, lists] = await Promise.all([
    source("app/my-profile/page.tsx"),
    source("app/my-profile/winnings/page.tsx"),
    source("app/my-profile/ProfileSections.tsx"),
    source("app/my-profile/ProfileHistoryLists.tsx"),
  ]);

  assert.match(page, /enrichOwnWinnerClaims\([\s\S]*?winnings\?\.items \?\? null,[\s\S]*?submissions,[\s\S]*?\)/u);
  assert.match(fullPage, /getUserProfileData/u);
  assert.match(fullPage, /enrichOwnWinnerClaims\([\s\S]*?result\?\.items \?\? null,[\s\S]*?profile\?\.submissions \?\? \[\],[\s\S]*?\)/u);
  assert.match(sections, /ProfileWinSummary/u);
  assert.match(lists, /claim\.imageUrl/u);
  assert.match(lists, /claim\.destinationHref/u);
  assert.match(lists, /getSubmissionThumbnailUrl\(claim\.imageUrl\)/u);
  assert.match(lists, /View in Cycle History/u);
});
