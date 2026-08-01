import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("flag case detail presents overview, lifecycle, and append-order history", async () => {
  const detail = await source("app/admin/flags/[caseId]/page.tsx");

  for (const marker of [
    "data-flag-case-overview",
    "data-flag-status-badge",
    "data-flag-lifecycle",
    "data-flag-history-event",
  ]) {
    assert.match(detail, new RegExp(marker, "u"));
  }
  for (const label of ["User", "Status", "Category", "Reason", "Comment", "Version"]) {
    assert.match(detail, new RegExp(`label="${label}"`, "u"));
  }
  assert.match(detail, /label="Created"/u);
  assert.match(detail, /label="Escalated"/u);
  assert.match(detail, /label="Final Decision"/u);
  assert.match(detail, /flagCase\.events\.map\(\(event\)/u);
  assert.doesNotMatch(detail, /flagCase\.events\.(?:sort|reverse)\(/u);
  assert.match(detail, /Actor snapshot details/u);
  assert.match(detail, /event\.actorAccountId/u);
  assert.match(detail, /event\.actorDiscordUserId/u);
  assert.match(detail, /event\.actorUsername/u);
  assert.match(detail, /event\.actorDisplayName/u);
  assert.match(detail, /event\.recordedAt/u);
  assert.match(detail, /event\.caseVersion/u);
  assert.match(detail, /event\.comment/u);
});

test("flag case detail retains capability gates and review action conditions", async () => {
  const detail = await source("app/admin/flags/[caseId]/page.tsx");

  assert.match(detail, /"users\.flag\.view"/u);
  assert.match(detail, /"users\.flag\.review"/u);
  assert.match(detail, /if \(!canView && !canReview\) redirect\("\/403"\)/u);
  assert.match(detail, /\{canView \? \(/u);
  assert.match(detail, /canReview && flagCase\.status === "open"/u);
  assert.match(detail, /isAdmin && flagCase\.status === "escalated"/u);
});

test("review input and outcomes expose clear accessible interaction states", async () => {
  const actions = await source(
    "app/admin/flags/[caseId]/FlagCaseReviewActions.tsx"
  );

  assert.match(actions, /data-flag-review-actions/u);
  assert.match(actions, /htmlFor="flag-review-reason"/u);
  assert.match(actions, /id="flag-review-reason"/u);
  assert.match(actions, /rows=\{5\}/u);
  assert.match(actions, /minLength=\{3\}/u);
  assert.match(actions, /required/u);
  assert.match(actions, /border-2 border-white\/25/u);
  assert.match(actions, /px-3 py-3/u);
  assert.match(actions, /focus-visible:ring-2/u);
  assert.match(actions, /disabled:cursor-not-allowed/u);
  assert.match(actions, /className="mt-5 flex flex-wrap gap-3/u);
  assert.match(actions, /role="group"/u);
  assert.match(actions, /aria-label="Flag case review actions"/u);

  for (const action of [
    "resolved",
    "dismissed",
    "escalated",
    "banned_resolved",
  ]) {
    assert.match(actions, new RegExp(`data-review-action="${action}"`, "u"));
  }
  for (const style of ["resolve", "dismiss", "escalate", "ban"]) {
    assert.match(actions, new RegExp(`className=\\{${style}ButtonClassName\\}`, "u"));
  }
  assert.match(actions, /cursor-pointer/u);
  assert.match(actions, /disabled:opacity-45/u);
  assert.doesNotMatch(actions, /style=\{\{ color: "#ff6b6b" \}\}/u);
});

test("user log flag history is an independent accessible table control", async () => {
  const [page, disclosure] = await Promise.all([
    source("app/admin/users/page.tsx"),
    source("app/admin/users/UserFlagHistoryDisclosure.tsx"),
  ]);

  assert.match(page, /<th align="left">Flag cases<\/th>/u);
  assert.match(page, /<UserFlagHistoryDisclosure/u);
  assert.match(page, /flagCasesByUser\.get\(user\.discord_user_id\) \?\? \[\]/u);
  assert.match(disclosure, /<details data-user-flag-history/u);
  assert.match(disclosure, /<summary/u);
  assert.match(disclosure, /aria-label=\{`Show flag case history for/u);
  assert.match(disclosure, /href=\{`\/admin\/flags\/\$\{flagCase\.caseId\}`\}/u);
  assert.doesNotMatch(disclosure, /onClick=/u);
});

test("non-interactive flag statuses do not advertise pointer interaction", async () => {
  const [actions, form] = await Promise.all([
    source("app/admin/users/UserModerationActions.tsx"),
    source("app/admin/users/UserFlagCaseCreateForm.tsx"),
  ]);

  for (const ui of [actions, form]) {
    assert.match(ui, /role="status"/u);
    assert.match(ui, /cursor: "default"/u);
  }
});
