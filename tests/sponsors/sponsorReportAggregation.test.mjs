import assert from "node:assert/strict";
import test from "node:test";
import { getSponsorReportStats } from "../../lib/sponsors/report.ts";

test("Sponsor reports use retained totals and only current raw rows for 30-day uniques", () => {
  const events = [
    { event_type: "impression", surface: "spread", feed_kind: "live", viewer_hash: "a" },
    { event_type: "impression", surface: "spread", feed_kind: "live", viewer_hash: "a" },
    { event_type: "click", surface: "spread", feed_kind: "live", viewer_hash: "a" },
    { event_type: "impression", surface: "home_hud", feed_kind: null, viewer_hash: "b" },
  ];
  const aggregates = [
    { event_type: "impression", surface: "spread", feed_kind: "live", event_count: 8 },
    { event_type: "click", surface: "spread", feed_kind: "live", event_count: 2 },
    { event_type: "impression", surface: "home_hud", feed_kind: null, event_count: 3 },
  ];
  const stats = getSponsorReportStats(events, aggregates);

  assert.equal(stats.impressions, 11);
  assert.equal(stats.clicks, 2);
  assert.equal(stats.uniqueViews, 2);
  assert.equal(stats.uniqueClicks, 1);
  assert.equal(stats.surfaceStats.get("spread:live").impressions, 8);
  assert.equal(stats.surfaceStats.get("spread:live").uniqueViews, 1);
  assert.equal(stats.surfaceStats.get("home_hud").impressions, 3);
});
