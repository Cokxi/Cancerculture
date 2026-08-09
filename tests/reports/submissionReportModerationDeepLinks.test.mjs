import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const [reportServer, reportQueue, livePage, cycleEndPage, moderationGrid] =
  await Promise.all([
    read("lib/reports/submissionReportTeam.server.ts"),
    read("app/admin/reports/SubmissionReportQueueClient.tsx"),
    read("app/admin/moderation/submissions/page.tsx"),
    read("app/admin/cycles/end-moderation/page.tsx"),
    read("app/admin/moderation/submissions/ModerationGrid.tsx"),
  ]);

test("Report Cases expose only capability-safe canonical Submission actions", () => {
  assert.match(reportServer, /canModerateSubmission/u);
  assert.match(
    reportServer,
    /\/admin\/moderation\/submissions\?submission=\$\{submissionId\}/u
  );
  assert.match(
    reportServer,
    /\/admin\/cycles\/end-moderation\?submission=\$\{submissionId\}/u
  );
  assert.match(reportServer, /cycleStatus === "finished" && historyHref/u);
  assert.match(reportServer, /label: "Open Live Moderation"/u);
  assert.match(reportServer, /label: "Open Cycle End Moderation"/u);
  assert.match(reportServer, /label: "Open Cycle History"/u);
  assert.match(reportServer, /submissionActionHref/u);
  assert.match(reportServer, /submissionActionLabel/u);
});

test("the Report queue links out and does not duplicate moderation mutations", () => {
  assert.match(reportQueue, /row\.submissionActionHref/u);
  assert.match(reportQueue, /row\.submissionActionLabel/u);
  assert.match(reportQueue, /prefetch=\{false\}/u);
  assert.match(reportQueue, /target="_blank"/u);
  assert.match(reportQueue, /rel="noopener noreferrer"/u);
  assert.doesNotMatch(reportQueue, /\/api\/admin\/disqualify/u);
  assert.doesNotMatch(reportQueue, /\/api\/admin\/reinstate/u);
});

test("both moderation pages validate and forward the focused Submission", () => {
  for (const page of [livePage, cycleEndPage]) {
    assert.match(page, /searchParams/u);
    assert.match(page, /Number\.isSafeInteger\(requestedSubmissionId\)/u);
    assert.match(page, /focusedSubmissionId/u);
  }
  assert.match(livePage, /getLiveModerationSubmissions\([\s\S]*focusedSubmissionId/u);
  assert.match(cycleEndPage, /loadCycleEndModerationReadModel\([\s\S]*focusedSubmissionId/u);
  assert.match(livePage, /View all current submissions/u);
  assert.match(cycleEndPage, /View all Cycle End submissions/u);
});

test("the shared moderation grid visibly focuses and scrolls to the target", () => {
  assert.match(moderationGrid, /moderation-submission-\$\{focusedSubmissionId\}/u);
  assert.match(moderationGrid, /scrollIntoView/u);
  assert.match(moderationGrid, /submission\.id === focusedSubmissionId/u);
  assert.match(moderationGrid, /2px solid #ff6a00/u);
});
