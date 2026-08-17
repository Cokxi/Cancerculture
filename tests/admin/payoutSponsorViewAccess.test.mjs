import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("Winner Payouts exposes only the hardened Claim projection", async () => {
  const [page, service, correctionRoute, copyButton] = await Promise.all([
    source("app/admin/logs/winners/page.tsx"),
    source("lib/winnerClaims/service.server.ts"),
    source("app/api/admin/winner-recipient-corrections/route.ts"),
    source("app/admin/logs/winners/CopyWalletButton.tsx"),
  ]);

  assert.match(
    page,
    /requireTeamCapabilityPage\(\s*"winners\.payouts\.view"/
  );
  assert.match(page, /getTeamWinnerClaims/);
  assert.doesNotMatch(page, /\.from\("winner_public_profiles"\)/);
  assert.match(service, /rpc\("get_team_winner_claims"/);
  assert.match(page, /winner\.status === "confirmed"[\s\S]*winner\.walletAddress/);
  assert.match(page, /Wallet pending winner confirmation/);
  assert.match(page, /Donation — no claim required/);
  assert.match(correctionRoute, /requireDynamicTeamCapability\("winners\.payouts\.view"\)/);
  assert.match(correctionRoute, /"winners\.recipient_corrections\.manage"/);
  assert.ok(correctionRoute.indexOf('"winners.payouts.view"') < correctionRoute.indexOf('"winners.recipient_corrections.manage"'));
  assert.match(copyButton, /navigator\.clipboard\.writeText\(walletAddress\)/);
  assert.match(copyButton, /aria-label="Copy payout wallet address"/);
  assert.match(copyButton, /Copied/);
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
