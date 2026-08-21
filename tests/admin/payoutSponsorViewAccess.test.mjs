import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("Payouts uses the simple Cycle-grouped server projection and atomic publish flow", async () => {
  const [page, manager, payoutService, publishRoute, correctionRoute] = await Promise.all([
    source("app/admin/payouts/page.tsx"),
    source("app/admin/payouts/PayoutManager.tsx"),
    source("lib/payouts/service.server.ts"),
    source("app/api/admin/payouts/[allocationId]/publish/route.ts"),
    source("app/api/admin/winner-recipient-corrections/route.ts"),
  ]);

  assert.match(
    page,
    /requireTeamCapabilityPage\(\s*"winners\.payouts\.view"/
  );
  assert.match(page, /getSimpleTeamPayouts/);
  assert.doesNotMatch(page, /\.from\("winner_public_profiles"\)/);
  assert.match(manager, /Cycle #\{cycleNumber\}/u);
  assert.match(manager, /Save & publish/u);
  assert.match(manager, /Donation operation wallet/u);
  assert.doesNotMatch(manager, />Prepare payout<|>lock<|>abort<|>replace</iu);
  assert.match(payoutService, /rpc\("get_simple_team_payouts_v2"/u);
  assert.match(payoutService, /rpc\("complete_and_publish_payout_v2"/u);
  assert.match(publishRoute, /inspectMainnetPayoutTransaction/u);
  assert.match(publishRoute, /completeAndPublishPayout/u);
  assert.match(correctionRoute, /requireDynamicTeamCapability\("winners\.payouts\.view"\)/);
  assert.match(correctionRoute, /"winners\.recipient_corrections\.manage"/);
  assert.ok(correctionRoute.indexOf('"winners.payouts.view"') < correctionRoute.indexOf('"winners.recipient_corrections.manage"'));
});

test("Sponsor Reports delegates receive aggregates and a redacted export", async () => {
  const [page, exportRoute] = await Promise.all([
    source("app/admin/logs/sponsors/page.tsx"),
    source("app/api/admin/sponsors/cycle/[cycleNumber]/export/route.ts"),
  ]);

  assert.match(
    page,
    /requireTeamCapabilityPage\(\s*"sponsorships\.reports\.view"/
  );
  assert.doesNotMatch(page, /banner_r2_key/);
  assert.doesNotMatch(page, /sponsor_link/);
  assert.match(page, /getSponsorReportStats/);
  assert.match(page, /Unique Views/);
  assert.match(page, /Unique Clicks/);
  assert.match(page, /CTR/);

  assert.match(
    exportRoute,
    /requireDynamicTeamCapability\(\s*"sponsorships\.reports\.view"/
  );
  assert.ok(
    exportRoute.indexOf(
      'requireDynamicTeamCapability("sponsorships.reports.view")'
    ) < exportRoute.indexOf('new URL(request.url)')
  );
  assert.ok(
    exportRoute.indexOf('new URL(request.url)') <
      exportRoute.indexOf('.from("voting_cycles")')
  );
  assert.doesNotMatch(
    exportRoute,
    /banner_r2_key|feed_banner_r2_key|sponsor_link/
  );
  assert.doesNotMatch(
    exportRoute,
    /sponsorship:\s*\{[\s\S]*?\b(?:id|cycle_id):/u
  );
  assert.match(exportRoute, /cycle_number: cycleNumber/u);
  assert.match(exportRoute, /buildSponsorReportPayload/u);
  assert.match(exportRoute, /\.gte\("created_at", rollingUniqueWindowStart\)/u);
  assert.match(
    exportRoute,
    /event_day, event_type, surface, feed_kind, event_count/u
  );
  assert.match(exportRoute, /format === "pdf"/u);
  assert.match(exportRoute, /createSponsorReportPdf\(exportPayload\)/u);
  assert.match(exportRoute, /"Content-Type": "application\/pdf"/u);
  assert.doesNotMatch(exportRoute, /exportPayload[\s\S]*events:/u);
  assert.match(exportRoute, /"Cache-Control": "no-store"/);
  assert.match(exportRoute, /"X-Content-Type-Options": "nosniff"/);
});
