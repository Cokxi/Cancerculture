import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (relativePath) =>
  readFile(new URL(`../../${relativePath}`, import.meta.url), "utf8");

const migrationPath =
  "supabase/migrations/20260812000100_gapless_public_cycle_numbers.sql";

function referenceBackfill(rows) {
  return new Map(
    rows
      .filter(
        (row) =>
          row.status !== "draft" ||
          row.resetCount > 0 ||
          row.hasStartsAt ||
          row.hasSubmissionStart
      )
      .sort((left, right) => left.id - right.id)
      .map((row, index) => [row.id, index + 1])
  );
}

test("the one-time backfill closes internal ID gaps without counting unused drafts", () => {
  const numbers = referenceBackfill([
    {
      id: 1,
      status: "finished",
      resetCount: 0,
      hasStartsAt: true,
      hasSubmissionStart: true,
    },
    {
      id: 2,
      status: "draft",
      resetCount: 0,
      hasStartsAt: false,
      hasSubmissionStart: false,
    },
    {
      id: 7,
      status: "finished",
      resetCount: 0,
      hasStartsAt: true,
      hasSubmissionStart: true,
    },
    {
      id: 8,
      status: "draft",
      resetCount: 2,
      hasStartsAt: false,
      hasSubmissionStart: false,
    },
    {
      id: 14,
      status: "cancelled",
      resetCount: 0,
      hasStartsAt: true,
      hasSubmissionStart: true,
    },
  ]);

  assert.deepEqual([...numbers], [
    [1, 1],
    [7, 2],
    [8, 3],
    [14, 4],
  ]);
});

test("the database owns immutable transactional public-number allocation", async () => {
  const migration = await source(migrationPath);

  assert.match(migration, /add column public_number bigint/u);
  assert.match(migration, /row_number\(\) over \(order by cycle\.id\)/u);
  assert.match(migration, /cycle\.status <> 'draft'/u);
  assert.match(migration, /cycle\.reset_count > 0/u);
  assert.match(migration, /create unique index voting_cycles_public_number_uidx/u);
  assert.match(migration, /status = 'draft' or public_number is not null/u);
  assert.match(migration, /pg_advisory_xact_lock/u);
  assert.match(migration, /coalesce\(max\(cycle\.public_number\), 0\) \+ 1/u);
  assert.match(migration, /PUBLIC_CYCLE_NUMBER_IMMUTABLE/u);
  assert.match(migration, /if new\.status <> 'draft'/u);
  assert.doesNotMatch(migration, /create\s+sequence/iu);
  assert.doesNotMatch(migration, /set\s+id\s*=/iu);
  assert.doesNotMatch(migration, /alter\s+column\s+id/iu);
});

test("managed start and reset return the public number while retaining internal cycleId", async () => {
  const [migration, startServer, resetServer] = await Promise.all([
    source(migrationPath),
    source("lib/cycles/startCycle.ts"),
    source("lib/cycles/resetCycle.ts"),
  ]);

  assert.match(
    migration,
    /where cycle\.id = \(v_result ->> ''cycleId''\)::bigint/u
  );
  assert.match(migration, /''cycleNumber'', \(/u);
  assert.match(startServer, /cycleId: number;/u);
  assert.match(startServer, /cycleNumber: number;/u);
  assert.match(resetServer, /cycleId: number;/u);
  assert.match(resetServer, /cycleNumber: number;/u);
});

test("public DTOs display cycle numbers while only legacy non-Feed links and cursors keep internal IDs", async () => {
  const [
    historyTypes,
    historyQuery,
    historyClient,
    profileQuery,
    publicProfile,
    wallTypes,
    wallQuery,
    submissionsPage,
    submissionsClient,
    destination,
    pagination,
  ] = await Promise.all([
    source("lib/cycles/cycleHistoryTypes.ts"),
    source("lib/cycles/getCycleHistoryData.ts"),
    source("app/cycle-history/CycleHistoryClient.tsx"),
    source("lib/queries/getUserSubmissions.ts"),
    source("app/profile/[publicProfileId]/page.tsx"),
    source("lib/walls/publicWallTypes.ts"),
    source("lib/walls/getPublicWallPage.ts"),
    source("app/submissions/page.tsx"),
    source("app/submissions/SubmissionsClient.tsx"),
    source("lib/submissions/getSubmissionDestinationHref.ts"),
    source("lib/pagination/publicPagination.ts"),
  ]);

  assert.match(historyTypes, /cycleId: number;\s+cycleNumber: number;/u);
  assert.match(historyQuery, /public_number/u);
  assert.match(historyClient, /Cycle #\{cycle\.cycleNumber\}/u);
  assert.match(profileQuery, /cycle_number:/u);
  assert.match(publicProfile, /Cycle: \{submission\.cycle_number\}/u);
  assert.match(wallTypes, /cycle_id: number;\s+cycle_number: number;/u);
  assert.match(wallQuery, /cycle_number:/u);
  assert.match(submissionsPage, /cycleId=\{currentCycle\.id\}/u);
  assert.match(
    submissionsPage,
    /cycleNumber=\{requirePublicCycleNumber\(currentCycle\.public_number\)\}/u
  );
  assert.match(submissionsClient, /CYCLE #\$\{cycleNumber\}/u);
  assert.match(
    destination,
    /\/cycle-history\?cycle=\$\{cycleId\}#submission-\$\{submissionId\}/u
  );
  assert.match(pagination, /context: \{ cycleId: number \}/u);
  assert.match(
    pagination,
    /scope: typeof PUBLIC_PAGINATION_SCOPES\.feedLive;[\s\S]*cycleNumber: number;/u,
  );
  assert.match(pagination, /feedCycleCatalog: "feed-cycle-catalog"/u);
});

test("admin, audit, bot, and scheduler contracts remain internal-ID based", async () => {
  const [adminControls, cycleLogs, schedulerRoute, phaseAutomation] =
    await Promise.all([
      source("app/admin/cycles/CycleControls.tsx"),
      source("app/admin/logs/cycles/page.tsx"),
      source("app/api/internal/cycles/process-due/route.ts"),
      source("lib/cycles/phaseAutomation.ts"),
    ]);

  assert.match(adminControls, /internal ID/u);
  assert.match(cycleLogs, /Cycle internal ID/u);
  assert.match(schedulerRoute, /cycleId: result\.cycleId/u);
  assert.doesNotMatch(schedulerRoute, /cycleNumber|publicNumber/u);
  assert.match(phaseAutomation, /cycleId: data\.cycleId/u);
  assert.doesNotMatch(phaseAutomation, /cycleNumber|publicNumber/u);
});
