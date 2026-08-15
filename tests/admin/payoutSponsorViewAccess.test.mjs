import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("Winner Payouts exposes the exact finalized payout projection", async () => {
  const [page, copyButton] = await Promise.all([
    source("app/admin/logs/winners/page.tsx"),
    source("app/admin/logs/winners/CopyWalletButton.tsx"),
  ]);

  assert.match(
    page,
    /requireTeamCapabilityPage\(\s*"winners\.payouts\.view"/
  );
  assert.match(page, /\.from\("winner_public_profiles"\)/);
  assert.match(
    page,
    /cycle_id, submission_id, vote_count, win_share, wallet_address, payout_choice, split_percent, charity/
  );
  assert.doesNotMatch(page, /private_data|submission_private|seed_phrase|secret/iu);
  assert.match(
    page,
    /winner\.wallet_address \? \([\s\S]*CopyWalletButton[\s\S]*walletAddress=\{winner\.wallet_address\}/
  );
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
  assert.match(page, /getSponsorReportStats/);
  assert.match(page, /Unique Views/);
  assert.match(page, /Unique Clicks/);
  assert.match(page, /CTR/);

  assert.match(
    exportRoute,
    /requireDynamicTeamCapability\(\s*"sponsorships\.reports\.view"/
  );
  assert.doesNotMatch(exportRoute, /banner_r2_key|feed_banner_r2_key/);
  assert.doesNotMatch(
    exportRoute,
    /sponsorship:\s*\{[\s\S]*?\b(?:id|cycle_id):/u
  );
  assert.match(exportRoute, /cycle_number: cycleNumber/u);
  assert.match(exportRoute, /Raw viewer hashes are intentionally not included/);
  assert.doesNotMatch(exportRoute, /exportPayload[\s\S]*events:/);
  assert.match(exportRoute, /"Cache-Control": "no-store"/);
});
