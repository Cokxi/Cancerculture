import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repoRoot = new URL("../../", import.meta.url);
const source = (path) => readFile(new URL(path, repoRoot), "utf8");

test("the calibration page is owner-only before loading observations", async () => {
  const page = await source("app/admin/cycles/observations/page.tsx");
  const guard = 'requireAdminPage("/admin/cycles/observations")';

  assert.match(page, /export const dynamic = "force-dynamic"/u);
  assert.match(page, new RegExp(guard.replace(/[()/]/g, "\\$&"), "u"));
  assert.ok(page.indexOf(guard) < page.indexOf("loadCycleVoteObservationReadModel()"));
  assert.match(page, /Owner-only calibration/u);
  assert.match(page, /creates no fraud label/u);
  assert.match(page, /historical test\s+cycles are intentionally not backfilled/u);
});

test("the read model uses only aggregate storage and bounded snapshot work", async () => {
  const readModel = await source("lib/cycles/voteObservationReadModel.ts");

  assert.match(readModel, /const SNAPSHOT_LIMIT = 24/u);
  assert.match(readModel, /const CALCULATION_LIMIT = 8/u);
  assert.match(readModel, /cycle_vote_observation_snapshots/u);
  assert.match(readModel, /cycle_vote_submission_observations/u);
  assert.match(readModel, /calculate_cycle_vote_observation_snapshot/u);
  assert.match(readModel, /p_reset_count/u);
  assert.doesNotMatch(readModel, /\.from\("votes"\)/u);
  assert.doesNotMatch(readModel, /discord_user_id/u);
  assert.doesNotMatch(readModel, /vote_logs/u);
});

test("the navigation exposes observations to Admin only", async () => {
  const navigation = await source("lib/admin/teamAreaNavigation.ts");
  assert.match(
    navigation,
    /id: "cycle-vote-observations"[\s\S]*href: "\/admin\/cycles\/observations"[\s\S]*requirement: adminOnly/u
  );
});
