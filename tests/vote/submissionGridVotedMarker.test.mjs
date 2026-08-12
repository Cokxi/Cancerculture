import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const client = await readFile(
  new URL("app/submissions/SubmissionsClient.tsx", root),
  "utf8",
);

test("the grid shows an accessible green marker only from safe viewer vote state", () => {
  assert.match(
    client,
    /isAuthenticated &&\s*voteStateAvailable &&\s*!s\.isOwnSubmission &&\s*votedSubmissionIdSet\.has\(s\.id\)/u,
  );
  assert.match(client, /bg-emerald-600/u);
  assert.match(client, /<span aria-hidden="true">✓<\/span>/u);
  assert.match(client, /<span className="sr-only">Already voted<\/span>/u);
  assert.match(client, /s\.isOwnSubmission && \([\s\S]*\(you\)/u);
  assert.doesNotMatch(client, /discord_user_id|discordUserId/u);
});

test("successful votes update the shared marker state immediately", () => {
  assert.match(
    client,
    /setVoteStateAvailable\(true\);[\s\S]*setVotedSubmissionIdSet\(\(current\) => \{[\s\S]*next\.add\(submissionId\)/u,
  );
  assert.match(client, /items: submissions/u);
  assert.match(client, /submissions\.map\(\(s\) =>/u);
  assert.match(client, /votedSubmissionIdSet\.has\(s\.id\)/u);
});
