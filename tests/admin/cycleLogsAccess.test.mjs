import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("Cycle Logs page and data source share the exact capability guard", async () => {
  const [layout, page, readModel] = await Promise.all([
    source("app/admin/logs/cycles/layout.tsx"),
    source("app/admin/logs/cycles/page.tsx"),
    source("lib/admin/cycleLogsReadModel.ts"),
  ]);

  assert.match(
    layout,
    /requireTeamCapabilityPage\("cycles\.logs\.view", "\/admin\/logs\/cycles"\)/u
  );
  assert.match(
    readModel,
    /requireDynamicTeamCapability\("cycles\.logs\.view"\)/u
  );
  assert.match(page, /loadCycleLogsReadModel\(\{ page \}\)/u);
  assert.doesNotMatch(page, /fetch\(|useEffect|"use client"/u);
});

test("Cycle Logs read model filters, allowlists, and paginates on the server", async () => {
  const readModel = await source("lib/admin/cycleLogsReadModel.ts");

  assert.match(readModel, /\.from\("admin_action_logs"\)/u);
  assert.match(readModel, /\.eq\("target_type", "cycle"\)/u);
  assert.match(readModel, /\.in\("action", \[\.\.\.CYCLE_LOG_ACTIONS\]\)/u);
  assert.match(readModel, /\.order\("created_at", \{ ascending: false \}\)/u);
  assert.match(readModel, /\.order\("id", \{ ascending: false \}\)/u);
  assert.match(readModel, /\.range\(offset, offset \+ CYCLE_LOG_PAGE_SIZE - 1\)/u);
  assert.doesNotMatch(readModel, /\.select\("\*"\)/u);
  assert.match(
    readModel,
    /authorization\.isAdmin \? \["actor_type", "target_type", "meta"\] : \[\]/u
  );
  assert.match(
    readModel,
    /authorization\.isAdmin[\s\S]*current_discord_handle[\s\S]*: "discord_user_id, current_discord_username"/u
  );
});

test("generic Admin logs remain owner-only while Cycle themes use cycles.manage", async () => {
  const [logsApi, themesApi] = await Promise.all([
    source("app/api/admin/logs/route.ts"),
    source("app/api/admin/cycles/themes/route.ts"),
  ]);

  assert.match(logsApi, /requireAdmin\(\)/u);
  assert.match(
    themesApi,
    /requireDynamicTeamCapability\("cycles\.manage"\)/u
  );
  assert.doesNotMatch(themesApi, /requireAdmin\(\)/u);
  assert.doesNotMatch(`${logsApi}\n${themesApi}`, /cycles\.logs\.view/u);
});

test("delegated Cycle Logs UI excludes raw context while Admin retains disclosure", async () => {
  const page = await source("app/admin/logs/cycles/page.tsx");

  assert.match(page, /Delegated audit · Read-only/u);
  assert.match(page, /This\s+surface cannot change cycle state/u);
  assert.match(page, /isAdmin && entry\.adminAudit/u);
  assert.match(page, /Owner-only raw audit context/u);
  assert.match(page, /entry\.actorLabel \? \(/u);
  assert.match(page, /entry\.actorDiscordUserId/u);
});
