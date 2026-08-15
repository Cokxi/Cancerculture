import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import {
  buildSponsorReportPayload,
  getSponsorReportStats,
} from "../../lib/sponsors/report.ts";
import { createSponsorReportPdf } from "../../lib/sponsors/reportPdf.ts";

function buildReport(dayCount = 12) {
  const aggregates = [];
  for (let index = 0; index < dayCount; index += 1) {
    const date = new Date(Date.UTC(2026, 7, index + 1))
      .toISOString()
      .slice(0, 10);
    aggregates.push(
      {
        event_day: date,
        event_type: "impression",
        surface: index % 2 === 0 ? "spread" : "spread_detail",
        feed_kind: index % 2 === 0 ? "top10" : null,
        event_count: 20 + index * 3,
      },
      {
        event_day: date,
        event_type: "click",
        surface: index % 2 === 0 ? "spread" : "spread_detail",
        feed_kind: index % 2 === 0 ? "top10" : null,
        event_count: index % 4,
      }
    );
  }
  const stats = getSponsorReportStats(
    [
      {
        event_type: "impression",
        surface: "spread",
        feed_kind: "top10",
        viewer_hash: "raw-viewer-hash-must-not-escape",
      },
      {
        event_type: "click",
        surface: "spread_detail",
        viewer_hash: "raw-click-hash-must-not-escape",
      },
    ],
    aggregates
  );
  return buildSponsorReportPayload({
    exportedAt: "2026-08-15T12:30:00.000Z",
    sponsorship: {
      cycle_number: 3,
      sponsor_name: "Fantasy Care Collective",
      is_active: false,
      starts_at: "2026-08-01T00:00:00.000Z",
      ends_at: "2026-08-15T00:00:00.000Z",
      created_at: "2026-07-30T12:00:00.000Z",
      updated_at: "2026-08-15T00:00:00.000Z",
    },
    stats,
  });
}

test("the presentation PDF is valid, paginated, deterministic in metadata, and aggregate-only", async () => {
  const report = buildReport();
  const bytes = await createSponsorReportPdf(report);
  const source = Buffer.from(bytes);
  const document = await PDFDocument.load(bytes);

  assert.equal(source.subarray(0, 5).toString("ascii"), "%PDF-");
  assert.equal(document.getPageCount(), 4);
  assert.equal(
    document.getTitle(),
    "Sponsor Report - Cycle 3 - Fantasy Care Collective"
  );
  assert.match(document.getSubject() ?? "", /Aggregate-only/u);
  assert.equal(document.getCreationDate()?.toISOString(), report.exported_at);
  assert.equal(report.daily.length, 12);
  assert.ok(report.surfaces.length >= 2);
  assert.doesNotMatch(
    source.toString("latin1"),
    /raw-viewer-hash|raw-click-hash|sponsor_link|cycle_id|banner_r2_key/u
  );
});

test("the PDF keeps an explicit empty-state chart and table without failing", async () => {
  const report = buildSponsorReportPayload({
    exportedAt: "2026-08-15T12:30:00.000Z",
    sponsorship: {
      cycle_number: 4,
      sponsor_name: "Test Sponsor",
      is_active: false,
      starts_at: null,
      ends_at: null,
      created_at: "2026-08-15T12:00:00.000Z",
      updated_at: "2026-08-15T12:00:00.000Z",
    },
    stats: getSponsorReportStats([], []),
  });
  const bytes = await createSponsorReportPdf(report);
  const document = await PDFDocument.load(bytes);

  assert.equal(document.getPageCount(), 3);
  assert.equal(report.totals.impressions, 0);
  assert.deepEqual(report.daily, []);
  assert.deepEqual(report.surfaces, []);
});
