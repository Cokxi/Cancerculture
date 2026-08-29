import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const [actions, client, comments, reports] = await Promise.all([
  readFile(new URL("app/spread/CommunityFeedCardActions.tsx", root), "utf8"),
  readFile(new URL("app/spread/CommunityFeedClient.tsx", root), "utf8"),
  readFile(
    new URL("app/components/comments/CommunityCommentThread.tsx", root),
    "utf8",
  ),
  readFile(new URL("app/components/SubmissionReportPanel.tsx", root), "utf8"),
]);

test("The Spread groups equal Share, Copy, Save, Comments, and Report actions", () => {
  assert.match(actions, /grid-cols-4 sm:grid-cols-\[repeat\(5,max-content\)\]/u);
  assert.match(actions, /sm:grid-cols-\[repeat\(5,max-content\)\]/u);
  assert.match(actions, /grid-cols-3 sm:grid-cols-\[repeat\(4,max-content\)\]/u);
  assert.match(actions, /justify-center gap-2/u);
  assert.match(actions, /commentAction/u);
  assert.match(actions, /<SubmissionReportPanel/u);
  assert.match(actions, /presentation="feed_action"/u);
  assert.match(actions, /feed === "live" \? "active" : "history"/u);
  assert.match(actions, /getCommunityFeedHref\(feed, submissionId\)/u);
  assert.equal(actions.match(/h-11 w-full min-w-0/gu)?.length, 2);
  assert.equal(actions.match(/rounded-full/gu)?.length, 5);
  assert.match(actions, /hidden h-11[\s\S]*sm:inline-flex/u);
  assert.match(comments, /h-11 w-full min-w-0[\s\S]*rounded-full[\s\S]*<span>Comments<\/span>/u);
  assert.match(reports, /h-11 w-full min-w-0[\s\S]*rounded-full[\s\S]*\? "Report"/u);
  assert.doesNotMatch(actions, /sm:grid-cols-5|min-h-11 w-full/u);
  assert.match(actions, /window\.matchMedia\("\(max-width: 639px\)"\)/u);
  assert.match(actions, /community-feed-share-options/u);
  assert.match(actions, /Share…[\s\S]*Copy Link/u);
});

test("the shared Comment disclosure stays below the complete Feed action bar", () => {
  assert.match(client, /renderActionBar=\{\(commentAction\) => \(/u);
  assert.ok(
    comments.indexOf("{actionBar}") < comments.indexOf("<details open={open}"),
  );
  assert.match(comments, /aria-controls=\{disclosurePanelId\}/u);
  assert.match(comments, /aria-expanded=\{open\}/u);
  assert.match(comments, /suppressDisclosureScrollAnchoring\(\)/u);
  assert.match(comments, /<summary hidden>Comments<\/summary>/u);
});

test("Feed Report reuses the canonical authenticated report panel", () => {
  assert.match(actions, /accountState === "authenticated"/u);
  assert.match(reports, /presentation\?: "default" \| "feed_action"/u);
  assert.match(reports, /aria-controls=\{reportPanelId\}/u);
  assert.match(reports, /Log in with Discord to report this submission/u);
  assert.match(reports, /loadEligibility/u);
  assert.match(reports, /submitSubmissionReportFromClient/u);
  assert.doesNotMatch(actions, /api\/submission-reports|\.rpc\(|supabase/iu);
});
