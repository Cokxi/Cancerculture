import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSponsorReportPayload,
  getSponsorReportStats,
} from "../../lib/sponsors/report.ts";

test("Sponsor reports use retained totals and only current raw rows for 30-day uniques", () => {
  const events = [
    { event_type: "impression", surface: "spread", feed_kind: "live", viewer_hash: "a" },
    { event_type: "impression", surface: "spread", feed_kind: "live", viewer_hash: "a" },
    { event_type: "click", surface: "spread", feed_kind: "live", viewer_hash: "a" },
    { event_type: "impression", surface: "home_hud", feed_kind: null, viewer_hash: "b" },
  ];
  const aggregates = [
    { event_day: "2026-08-14", event_type: "impression", surface: "spread", feed_kind: "live", event_count: 8 },
    { event_day: "2026-08-14", event_type: "click", surface: "spread", feed_kind: "live", event_count: 2 },
    { event_day: "2026-08-15", event_type: "impression", surface: "home_hud", feed_kind: null, event_count: 3 },
  ];
  const stats = getSponsorReportStats(events, aggregates);

  assert.equal(stats.impressions, 11);
  assert.equal(stats.clicks, 2);
  assert.equal(stats.uniqueViews, 2);
  assert.equal(stats.uniqueClicks, 1);
  assert.equal(stats.surfaceStats.get("spread:live").impressions, 8);
  assert.equal(stats.surfaceStats.get("spread:live").uniqueViews, 1);
  assert.equal(stats.surfaceStats.get("home_hud").impressions, 3);
  assert.deepEqual(stats.dailyStats, [
    {
      clicks: 2,
      ctrPercent: 25,
      date: "2026-08-14",
      impressions: 8,
    },
    {
      clicks: 0,
      ctrPercent: 0,
      date: "2026-08-15",
      impressions: 3,
    },
  ]);
});

test("the external payload is a stable allowlist with daily trends and no raw report data", () => {
  const stats = getSponsorReportStats(
    [
      {
        event_type: "impression",
        surface: "spread_detail",
        viewer_hash: "viewer-secret",
      },
    ],
    [
      {
        event_day: "2026-08-15",
        event_type: "impression",
        surface: "spread_detail",
        feed_kind: null,
        event_count: 12,
      },
      {
        event_day: "2026-08-15",
        event_type: "click",
        surface: "spread_detail",
        feed_kind: null,
        event_count: 3,
      },
    ]
  );
  const payload = buildSponsorReportPayload({
    exportedAt: "2026-08-15T12:00:00.000Z",
    sponsorship: {
      cycle_number: 3,
      sponsor_name: "Fantasy Sponsor",
      is_active: false,
      starts_at: "2026-08-14T10:00:00.000Z",
      ends_at: "2026-08-15T10:00:00.000Z",
      created_at: "2026-08-14T09:00:00.000Z",
      updated_at: "2026-08-15T10:00:00.000Z",
      sponsor_link: "https://secret-target.invalid/path",
      id: 77,
      cycle_id: 91,
      banner_r2_key: "internal/storage/key.webp",
    },
    stats,
  });
  const serialized = JSON.stringify(payload);

  assert.equal(payload.report_status.code, "pre_launch_test");
  assert.match(payload.methodology.analytics_consent, /only after/u);
  assert.match(payload.methodology.qualified_impression, /50%[\s\S]*1,000 ms/u);
  assert.match(payload.methodology.deduplication, /30-minute/u);
  assert.match(payload.methodology.rolling_uniques, /rolling 30-day/u);
  assert.match(payload.methodology.aggregate_retention, /25 months/u);
  assert.deepEqual(payload.daily, [
    {
      date: "2026-08-15",
      impressions: 12,
      clicks: 3,
      ctr_percent: 25,
    },
  ]);
  assert.equal(payload.surfaces[0].label, "The Spread - meme detail");
  assert.doesNotMatch(
    serialized,
    /viewer-secret|secret-target|cycle_id|banner_r2_key|storage\/key|"id"/u
  );
});
