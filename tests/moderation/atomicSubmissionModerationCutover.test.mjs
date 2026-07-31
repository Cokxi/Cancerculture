import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("both mutation APIs use only the atomic RPC wrapper", async () => {
  for (const path of [
    "app/api/admin/disqualify/route.ts",
    "app/api/admin/reinstate/route.ts",
  ]) {
    const route = await source(path);
    assert.match(route, /getTeamAuthorizationContext\(\)/u);
    assert.match(route, /requireSubmissionModerationAction\(/u);
    assert.match(route, /moderateSubmission\(/u);
    assert.doesNotMatch(route, /supabaseAdmin|logModerationAction/u);
  }
});

test("the unused legacy GET route and direct DML module are gone", async () => {
  await assert.rejects(
    access(new URL("app/api/admin/submissions/route.ts", root))
  );
  await assert.rejects(
    access(
      new URL(
        "lib/moderation/setSubmissionDisqualification.ts",
        root
      )
    )
  );
});

test("the strict read model exposes only submission and voting open", async () => {
  const readModel = await source(
    "lib/moderation/submissionModerationReadModel.ts"
  );
  assert.match(
    readModel,
    /\.in\("status", \["submission_open", "voting_open"\]\)/u
  );
  assert.doesNotMatch(readModel, /"active"|"paused"/u);
  assert.match(readModel, /MODERATION_CYCLE_READ_UNAVAILABLE/u);
});

test("pages and buttons carry phase, expected state and idempotency", async () => {
  const [livePage, disqualifiedPage, grid, reinstate] =
    await Promise.all([
      source("app/admin/moderation/submissions/page.tsx"),
      source("app/admin/moderation/disqualified/page.tsx"),
      source("app/admin/moderation/submissions/ModerationGrid.tsx"),
      source(
        "app/admin/moderation/disqualified/reinstate-button.tsx"
      ),
    ]);
  assert.match(livePage, /requireLiveModerationPage/u);
  assert.match(disqualifiedPage, /requireDisqualifiedSubmissionsPage/u);
  assert.match(livePage, /canDisqualify=\{canDisqualify\}/u);
  assert.match(livePage, /canReinstate=\{canReinstate\}/u);
  for (const client of [grid, reinstate]) {
    assert.match(client, /expectedPhase/u);
    assert.match(client, /expectedIsDisqualified/u);
    assert.match(client, /crypto\.randomUUID\(\)/u);
    assert.match(client, /res\.status === 409/u);
  }
});

test("no production authorization path uses the deprecated key", async () => {
  for (const path of [
    "lib/auth/guards.ts",
    "lib/auth/guards.ui.ts",
    "lib/auth/pageAccess.ts",
    "lib/auth/teamAuthorizationShadow.ts",
    "lib/admin/teamAreaNavigation.ts",
  ]) {
    assert.doesNotMatch(
      await source(path),
      /submissions\.submission_phase\.moderate/u,
      path
    );
  }
});
