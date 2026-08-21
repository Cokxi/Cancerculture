import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("Cycle Management owns the prize-pool editor and requires exact confirmation", async () => {
  const [page, controls, route, service] = await Promise.all([
    source("app/admin/cycles/page.tsx"),
    source("app/admin/cycles/CycleControls.tsx"),
    source("app/api/admin/cycles/prize-pool/route.ts"),
    source("lib/cycles/prizePool.server.ts"),
  ]);

  assert.match(
    page,
    /requireTeamCapabilityPage\([\s\S]*"cycles\.manage"/u
  );
  assert.match(page, /getCyclePrizePoolManagementContext/u);
  assert.match(controls, /Prize Pool/u);
  assert.match(controls, /Confirm exact amount \(SOL\)/u);
  assert.match(
    controls,
    /prizePoolAmount\.trim\(\) !== prizePoolConfirmation\.trim\(\)/u
  );
  assert.match(
    route,
    /requireDynamicTeamCapability\("cycles\.manage"\)/u
  );
  assert.match(route, /amount !== confirmation/u);
  assert.match(service, /manage_current_cycle_prize_pool/u);
  assert.match(service, /assertServerMutationAllowed\(\)/u);
});

test("Payouts no longer offers technical or retroactive pool controls", async () => {
  const [page, actions, service] = await Promise.all([
    source("app/admin/payouts/page.tsx"),
    source("app/admin/payouts/actions.ts"),
    source("lib/payouts/service.server.ts"),
  ]);

  assert.doesNotMatch(page, /managePrizePoolAction/u);
  assert.doesNotMatch(page, /Cycle prize pools/u);
  assert.doesNotMatch(page, /add_component|replace_component/u);
  assert.doesNotMatch(actions, /managePrizePool/u);
  assert.doesNotMatch(service, /manage_cycle_prize_pool/u);
  assert.match(page, /prize pool itself is set in Cycle Management/u);
});
