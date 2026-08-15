import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage,
  type RGB,
} from "pdf-lib";
import type { SponsorReportPayload } from "@/lib/sponsors/report";

const PAGE_WIDTH = 841.89;
const PAGE_HEIGHT = 595.28;
const MARGIN = 40;

const COLOR = {
  background: rgb(0.035, 0.047, 0.075),
  panel: rgb(0.075, 0.095, 0.14),
  panelStrong: rgb(0.1, 0.125, 0.18),
  border: rgb(0.2, 0.235, 0.31),
  text: rgb(0.96, 0.97, 0.985),
  muted: rgb(0.68, 0.72, 0.79),
  orange: rgb(0.98, 0.45, 0.12),
  orangeSoft: rgb(0.42, 0.17, 0.08),
  teal: rgb(0.12, 0.78, 0.72),
  grid: rgb(0.17, 0.2, 0.27),
  test: rgb(0.82, 0.22, 0.18),
  white: rgb(1, 1, 1),
} as const;

type Fonts = {
  regular: PDFFont;
  bold: PDFFont;
};

function safePdfText(value: unknown) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[\u2010-\u2015]/gu, "-")
    .replace(/[\u2018\u2019]/gu, "'")
    .replace(/[\u201c\u201d]/gu, '"')
    .replace(/[^\x20-\x7E]/gu, "?");
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(Number.isFinite(value) ? value : 0);
}

function formatPercent(value: number) {
  return `${Number.isFinite(value) ? value.toFixed(2) : "0.00"}%`;
}

function formatDate(value: string | null, includeTime = false) {
  if (!value) return "Not set";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return safePdfText(value);
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    ...(includeTime
      ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" as const }
      : {}),
    timeZone: "UTC",
  }).format(date);
}

function truncateText(
  value: string,
  font: PDFFont,
  size: number,
  maxWidth: number
) {
  const text = safePdfText(value);
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let candidate = text;
  while (
    candidate.length > 1 &&
    font.widthOfTextAtSize(`${candidate}...`, size) > maxWidth
  ) {
    candidate = candidate.slice(0, -1);
  }
  return `${candidate.trimEnd()}...`;
}

function wrapText(
  value: string,
  font: PDFFont,
  size: number,
  maxWidth: number
) {
  const words = safePdfText(value).split(/\s+/u).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate;
    } else {
      if (line) lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length > 0 ? lines : [""];
}

function drawWrappedText({
  color = COLOR.text,
  font,
  lineHeight,
  maxWidth,
  page,
  size,
  text,
  x,
  y,
}: {
  color?: RGB;
  font: PDFFont;
  lineHeight: number;
  maxWidth: number;
  page: PDFPage;
  size: number;
  text: string;
  x: number;
  y: number;
}) {
  const lines = wrapText(text, font, size, maxWidth);
  lines.forEach((line, index) => {
    page.drawText(line, {
      color,
      font,
      size,
      x,
      y: y - index * lineHeight,
    });
  });
  return y - lines.length * lineHeight;
}

function addPage(document: PDFDocument, fonts: Fonts, section: string) {
  const page = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  page.drawRectangle({
    color: COLOR.background,
    height: PAGE_HEIGHT,
    width: PAGE_WIDTH,
    x: 0,
    y: 0,
  });
  page.drawText("CANCERCULTURE", {
    color: COLOR.orange,
    font: fonts.bold,
    size: 10,
    x: MARGIN,
    y: PAGE_HEIGHT - 28,
  });
  page.drawText(safePdfText(section).toUpperCase(), {
    color: COLOR.muted,
    font: fonts.bold,
    size: 8,
    x: PAGE_WIDTH - MARGIN - fonts.bold.widthOfTextAtSize(
      safePdfText(section).toUpperCase(),
      8
    ),
    y: PAGE_HEIGHT - 27,
  });
  page.drawLine({
    color: COLOR.border,
    end: { x: PAGE_WIDTH - MARGIN, y: PAGE_HEIGHT - 38 },
    start: { x: MARGIN, y: PAGE_HEIGHT - 38 },
    thickness: 0.8,
  });
  return page;
}

function drawKpiCard({
  label,
  value,
  page,
  fonts,
  x,
  y,
  width,
}: {
  label: string;
  value: string;
  page: PDFPage;
  fonts: Fonts;
  x: number;
  y: number;
  width: number;
}) {
  page.drawRectangle({
    borderColor: COLOR.border,
    borderWidth: 0.8,
    color: COLOR.panel,
    height: 66,
    width,
    x,
    y,
  });
  page.drawRectangle({
    color: COLOR.orange,
    height: 3,
    width,
    x,
    y: y + 63,
  });
  page.drawText(truncateText(label, fonts.bold, 8, width - 20), {
    color: COLOR.muted,
    font: fonts.bold,
    size: 8,
    x: x + 10,
    y: y + 44,
  });
  page.drawText(truncateText(value, fonts.bold, 19, width - 20), {
    color: COLOR.text,
    font: fonts.bold,
    size: 19,
    x: x + 10,
    y: y + 16,
  });
}

function drawLineChart({
  color,
  data,
  fonts,
  page,
  title,
  x,
  y,
  width,
  height,
}: {
  color: RGB;
  data: Array<{ date: string; value: number }>;
  fonts: Fonts;
  page: PDFPage;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
}) {
  page.drawRectangle({
    borderColor: COLOR.border,
    borderWidth: 0.8,
    color: COLOR.panel,
    height,
    width,
    x,
    y,
  });
  page.drawText(title, {
    color: COLOR.text,
    font: fonts.bold,
    size: 11,
    x: x + 14,
    y: y + height - 22,
  });
  const plot = {
    x: x + 45,
    y: y + 36,
    width: width - 62,
    height: height - 72,
  };
  if (data.length === 0) {
    page.drawText("No aggregate measurements for this period.", {
      color: COLOR.muted,
      font: fonts.regular,
      size: 9,
      x: plot.x,
      y: plot.y + plot.height / 2,
    });
    return;
  }

  const maxValue = Math.max(1, ...data.map((point) => point.value));
  for (let step = 0; step <= 4; step += 1) {
    const gridY = plot.y + (plot.height * step) / 4;
    page.drawLine({
      color: COLOR.grid,
      end: { x: plot.x + plot.width, y: gridY },
      start: { x: plot.x, y: gridY },
      thickness: 0.6,
    });
    const tick = formatNumber((maxValue * step) / 4);
    page.drawText(tick, {
      color: COLOR.muted,
      font: fonts.regular,
      size: 7,
      x: plot.x - fonts.regular.widthOfTextAtSize(tick, 7) - 6,
      y: gridY - 2,
    });
  }

  const points = data.map((point, index) => ({
    x:
      data.length === 1
        ? plot.x + plot.width / 2
        : plot.x + (plot.width * index) / (data.length - 1),
    y: plot.y + (plot.height * point.value) / maxValue,
  }));
  for (let index = 1; index < points.length; index += 1) {
    page.drawLine({
      color,
      end: points[index],
      start: points[index - 1],
      thickness: 2.2,
    });
  }
  if (points.length === 1) {
    page.drawLine({
      color,
      end: { x: points[0].x + 1, y: points[0].y },
      start: { x: points[0].x - 1, y: points[0].y },
      thickness: 2.2,
    });
  }
  if (points.length <= 40) {
    points.forEach((point) => {
      page.drawCircle({
        borderColor: COLOR.white,
        borderWidth: 0.7,
        color,
        size: 2.8,
        x: point.x,
        y: point.y,
      });
    });
  }

  const labelIndexes = Array.from(
    new Set([0, Math.floor((data.length - 1) / 2), data.length - 1])
  );
  labelIndexes.forEach((index) => {
    const label = safePdfText(data[index].date);
    const labelWidth = fonts.regular.widthOfTextAtSize(label, 6.7);
    page.drawText(label, {
      color: COLOR.muted,
      font: fonts.regular,
      size: 6.7,
      x: Math.max(
        plot.x,
        Math.min(
          points[index].x - labelWidth / 2,
          plot.x + plot.width - labelWidth
        )
      ),
      y: plot.y - 16,
    });
  });

  const finalValue = formatNumber(data.at(-1)?.value ?? 0);
  page.drawText(`Latest: ${finalValue}`, {
    color,
    font: fonts.bold,
    size: 8,
    x: x + width - 14 - fonts.bold.widthOfTextAtSize(`Latest: ${finalValue}`, 8),
    y: y + height - 22,
  });
}

function drawSurfacePages(
  document: PDFDocument,
  fonts: Fonts,
  report: SponsorReportPayload
) {
  const rowsPerPage = 7;
  const surfaces = report.surfaces.length > 0 ? report.surfaces : [];
  const chunks = surfaces.length > 0
    ? Array.from(
        { length: Math.ceil(surfaces.length / rowsPerPage) },
        (_, index) => surfaces.slice(index * rowsPerPage, (index + 1) * rowsPerPage)
      )
    : [[]];
  const maxImpressions = Math.max(
    1,
    ...surfaces.map((surface) => surface.impressions)
  );
  const maxClicks = Math.max(1, ...surfaces.map((surface) => surface.clicks));

  chunks.forEach((chunk, pageIndex) => {
    const page = addPage(
      document,
      fonts,
      pageIndex === 0 ? "Surface comparison" : "Surface comparison continued"
    );
    page.drawText("Performance by Sponsor surface", {
      color: COLOR.text,
      font: fonts.bold,
      size: 21,
      x: MARGIN,
      y: PAGE_HEIGHT - 76,
    });
    page.drawText(
      "Totals come from retained aggregates. Unique values cover the rolling 30-day window.",
      {
        color: COLOR.muted,
        font: fonts.regular,
        size: 9,
        x: MARGIN,
        y: PAGE_HEIGHT - 96,
      }
    );

    const top = PAGE_HEIGHT - 128;
    page.drawRectangle({
      color: COLOR.panelStrong,
      height: 28,
      width: PAGE_WIDTH - MARGIN * 2,
      x: MARGIN,
      y: top - 28,
    });
    const headers = [
      ["Surface", 50],
      ["Impressions", 260],
      ["Clicks", 350],
      ["CTR", 420],
      ["Unique views", 488],
      ["Unique clicks", 585],
      ["Relative reach", 690],
    ] as const;
    headers.forEach(([label, x]) => {
      page.drawText(label, {
        color: COLOR.muted,
        font: fonts.bold,
        size: 7.5,
        x,
        y: top - 18,
      });
    });

    if (chunk.length === 0) {
      page.drawText("No measured Sponsor surfaces.", {
        color: COLOR.muted,
        font: fonts.regular,
        size: 10,
        x: MARGIN + 10,
        y: top - 62,
      });
      return;
    }

    chunk.forEach((surface, index) => {
      const rowTop = top - 28 - index * 48;
      const rowBottom = rowTop - 48;
      if (index % 2 === 0) {
        page.drawRectangle({
          color: COLOR.panel,
          height: 48,
          width: PAGE_WIDTH - MARGIN * 2,
          x: MARGIN,
          y: rowBottom,
        });
      }
      page.drawText(truncateText(surface.label, fonts.bold, 8.5, 195), {
        color: COLOR.text,
        font: fonts.bold,
        size: 8.5,
        x: 50,
        y: rowBottom + 20,
      });
      const values = [
        [formatNumber(surface.impressions), 260],
        [formatNumber(surface.clicks), 350],
        [formatPercent(surface.ctr_percent), 420],
        [formatNumber(surface.unique_views), 488],
        [formatNumber(surface.unique_clicks), 585],
      ] as const;
      values.forEach(([value, x]) => {
        page.drawText(value, {
          color: COLOR.text,
          font: fonts.regular,
          size: 8.5,
          x,
          y: rowBottom + 20,
        });
      });

      const barX = 704;
      const barWidth = 82;
      page.drawText("I", {
        color: COLOR.muted,
        font: fonts.bold,
        size: 6.5,
        x: 692,
        y: rowBottom + 28,
      });
      page.drawText("C", {
        color: COLOR.muted,
        font: fonts.bold,
        size: 6.5,
        x: 692,
        y: rowBottom + 13,
      });
      page.drawRectangle({
        color: COLOR.grid,
        height: 7,
        width: barWidth,
        x: barX,
        y: rowBottom + 27,
      });
      page.drawRectangle({
        color: COLOR.orange,
        height: 7,
        width: (barWidth * surface.impressions) / maxImpressions,
        x: barX,
        y: rowBottom + 27,
      });
      page.drawRectangle({
        color: COLOR.grid,
        height: 7,
        width: barWidth,
        x: barX,
        y: rowBottom + 12,
      });
      page.drawRectangle({
        color: COLOR.teal,
        height: 7,
        width: (barWidth * surface.clicks) / maxClicks,
        x: barX,
        y: rowBottom + 12,
      });
    });

    page.drawText(
      "I = Impressions (orange) | C = Clicks (teal). Numeric columns remain the canonical values.",
      {
        color: COLOR.muted,
        font: fonts.regular,
        size: 7.5,
        x: MARGIN,
        y: 55,
      }
    );
  });
}

function drawMethodologyAndDailyPages(
  document: PDFDocument,
  fonts: Fonts,
  report: SponsorReportPayload
) {
  const page = addPage(document, fonts, "Methodology and daily data");
  page.drawText("How these measurements work", {
    color: COLOR.text,
    font: fonts.bold,
    size: 21,
    x: MARGIN,
    y: PAGE_HEIGHT - 76,
  });

  const items = [
    ["A", "Consent", report.methodology.analytics_consent],
    ["B", "Qualified impression", report.methodology.qualified_impression],
    ["C", "Deduplication", report.methodology.deduplication],
    ["D", "Rolling uniques", report.methodology.rolling_uniques],
    ["E", "Aggregate retention", report.methodology.aggregate_retention],
  ] as const;
  let itemY = PAGE_HEIGHT - 111;
  items.forEach(([marker, heading, body]) => {
    page.drawCircle({
      color: COLOR.orangeSoft,
      size: 10,
      x: MARGIN + 10,
      y: itemY + 1,
    });
    page.drawText(marker, {
      color: COLOR.orange,
      font: fonts.bold,
      size: 8,
      x: MARGIN + 7.2,
      y: itemY - 2,
    });
    page.drawText(heading, {
      color: COLOR.text,
      font: fonts.bold,
      size: 9.5,
      x: MARGIN + 30,
      y: itemY + 4,
    });
    drawWrappedText({
      color: COLOR.muted,
      font: fonts.regular,
      lineHeight: 11,
      maxWidth: PAGE_WIDTH - MARGIN * 2 - 30,
      page,
      size: 8.2,
      text: body,
      x: MARGIN + 30,
      y: itemY - 8,
    });
    itemY -= 48;
  });

  page.drawText("Daily aggregate data", {
    color: COLOR.text,
    font: fonts.bold,
    size: 14,
    x: MARGIN,
    y: itemY - 3,
  });
  const firstPageRows = report.daily.slice(0, 8);
  drawDailyTable(page, fonts, firstPageRows, itemY - 22);

  const remaining = report.daily.slice(8);
  const rowsPerPage = 22;
  for (let offset = 0; offset < remaining.length; offset += rowsPerPage) {
    const continuation = addPage(document, fonts, "Daily data continued");
    continuation.drawText("Daily aggregate data - continued", {
      color: COLOR.text,
      font: fonts.bold,
      size: 21,
      x: MARGIN,
      y: PAGE_HEIGHT - 76,
    });
    drawDailyTable(
      continuation,
      fonts,
      remaining.slice(offset, offset + rowsPerPage),
      PAGE_HEIGHT - 104
    );
  }
}

function drawDailyTable(
  page: PDFPage,
  fonts: Fonts,
  rows: SponsorReportPayload["daily"],
  top: number
) {
  const width = PAGE_WIDTH - MARGIN * 2;
  page.drawRectangle({
    color: COLOR.panelStrong,
    height: 24,
    width,
    x: MARGIN,
    y: top - 24,
  });
  const headers = [
    ["Date (UTC)", MARGIN + 10],
    ["Impressions", MARGIN + 245],
    ["Clicks", MARGIN + 400],
    ["CTR", MARGIN + 545],
  ] as const;
  headers.forEach(([label, x]) => {
    page.drawText(label, {
      color: COLOR.muted,
      font: fonts.bold,
      size: 8,
      x,
      y: top - 16,
    });
  });
  if (rows.length === 0) {
    page.drawText("No retained daily aggregate measurements.", {
      color: COLOR.muted,
      font: fonts.regular,
      size: 9,
      x: MARGIN + 10,
      y: top - 47,
    });
    return;
  }
  rows.forEach((row, index) => {
    const rowY = top - 24 - (index + 1) * 19;
    if (index % 2 === 0) {
      page.drawRectangle({
        color: COLOR.panel,
        height: 19,
        width,
        x: MARGIN,
        y: rowY,
      });
    }
    const values = [
      [safePdfText(row.date), MARGIN + 10],
      [formatNumber(row.impressions), MARGIN + 245],
      [formatNumber(row.clicks), MARGIN + 400],
      [formatPercent(row.ctr_percent), MARGIN + 545],
    ] as const;
    values.forEach(([value, x]) => {
      page.drawText(value, {
        color: COLOR.text,
        font: fonts.regular,
        size: 8,
        x,
        y: rowY + 6,
      });
    });
  });
}

export async function createSponsorReportPdf(report: SponsorReportPayload) {
  const document = await PDFDocument.create();
  const fonts = {
    regular: await document.embedFont(StandardFonts.Helvetica),
    bold: await document.embedFont(StandardFonts.HelveticaBold),
  } satisfies Fonts;
  const generatedAt = new Date(report.exported_at);
  const validGeneratedAt = Number.isNaN(generatedAt.getTime())
    ? new Date(0)
    : generatedAt;

  document.setTitle(
    `Sponsor Report - Cycle ${report.sponsorship.cycle_number} - ${safePdfText(report.sponsorship.sponsor_name)}`
  );
  document.setSubject(
    "Aggregate-only Sponsor performance report - pre-launch test data"
  );
  document.setAuthor("CancerCulture");
  document.setCreator("CancerCulture protected Sponsor Reports");
  document.setProducer("CancerCulture protected Sponsor Reports");
  document.setKeywords([
    "Sponsor report",
    "aggregate analytics",
    "pre-launch test data",
  ]);
  document.setCreationDate(validGeneratedAt);
  document.setModificationDate(validGeneratedAt);

  const overview = addPage(document, fonts, "Sponsor performance report");
  overview.drawText("Sponsor performance report", {
    color: COLOR.text,
    font: fonts.bold,
    size: 25,
    x: MARGIN,
    y: PAGE_HEIGHT - 78,
  });
  const badge = report.report_status.label;
  const badgeWidth = fonts.bold.widthOfTextAtSize(badge, 8) + 20;
  overview.drawRectangle({
    color: COLOR.test,
    height: 24,
    width: badgeWidth,
    x: PAGE_WIDTH - MARGIN - badgeWidth,
    y: PAGE_HEIGHT - 84,
  });
  overview.drawText(badge, {
    color: COLOR.white,
    font: fonts.bold,
    size: 8,
    x: PAGE_WIDTH - MARGIN - badgeWidth + 10,
    y: PAGE_HEIGHT - 76,
  });
  overview.drawText(
    truncateText(report.sponsorship.sponsor_name, fonts.bold, 15, 470),
    {
      color: COLOR.orange,
      font: fonts.bold,
      size: 15,
      x: MARGIN,
      y: PAGE_HEIGHT - 108,
    }
  );
  overview.drawText(`Public Cycle #${report.sponsorship.cycle_number}`, {
    color: COLOR.muted,
    font: fonts.regular,
    size: 9,
    x: MARGIN,
    y: PAGE_HEIGHT - 126,
  });
  const campaignLine = `Campaign: ${formatDate(report.sponsorship.starts_at)} to ${formatDate(report.sponsorship.ends_at)} | Generated ${formatDate(report.exported_at, true)} UTC`;
  overview.drawText(
    truncateText(campaignLine, fonts.regular, 8, PAGE_WIDTH - MARGIN * 2),
    {
      color: COLOR.muted,
      font: fonts.regular,
      size: 8,
      x: MARGIN,
      y: PAGE_HEIGHT - 143,
    }
  );

  const kpis = [
    ["Impressions", formatNumber(report.totals.impressions)],
    ["Unique views (30d)", formatNumber(report.totals.unique_views)],
    ["Clicks", formatNumber(report.totals.clicks)],
    ["Unique clicks (30d)", formatNumber(report.totals.unique_clicks)],
    ["CTR", formatPercent(report.totals.ctr_percent)],
  ] as const;
  const gap = 8;
  const cardWidth = (PAGE_WIDTH - MARGIN * 2 - gap * 4) / 5;
  kpis.forEach(([label, value], index) => {
    drawKpiCard({
      fonts,
      label,
      page: overview,
      value,
      width: cardWidth,
      x: MARGIN + index * (cardWidth + gap),
      y: PAGE_HEIGHT - 226,
    });
  });

  const chartGap = 14;
  const chartWidth = (PAGE_WIDTH - MARGIN * 2 - chartGap) / 2;
  drawLineChart({
    color: COLOR.orange,
    data: report.daily.map((day) => ({
      date: day.date,
      value: day.impressions,
    })),
    fonts,
    height: 215,
    page: overview,
    title: "Daily impressions",
    width: chartWidth,
    x: MARGIN,
    y: 104,
  });
  drawLineChart({
    color: COLOR.teal,
    data: report.daily.map((day) => ({
      date: day.date,
      value: day.clicks,
    })),
    fonts,
    height: 215,
    page: overview,
    title: "Daily clicks",
    width: chartWidth,
    x: MARGIN + chartWidth + chartGap,
    y: 104,
  });
  drawWrappedText({
    color: COLOR.muted,
    font: fonts.regular,
    lineHeight: 10,
    maxWidth: PAGE_WIDTH - MARGIN * 2,
    page: overview,
    size: 7.5,
    text: report.report_status.notice,
    x: MARGIN,
    y: 86,
  });

  drawSurfacePages(document, fonts, report);
  drawMethodologyAndDailyPages(document, fonts, report);

  const pages = document.getPages();
  pages.forEach((page, index) => {
    const footer = `AGGREGATE-ONLY | ${report.report_status.label} | Page ${index + 1} of ${pages.length}`;
    page.drawLine({
      color: COLOR.border,
      end: { x: PAGE_WIDTH - MARGIN, y: 34 },
      start: { x: MARGIN, y: 34 },
      thickness: 0.7,
    });
    page.drawText(footer, {
      color: COLOR.muted,
      font: fonts.bold,
      size: 6.8,
      x: MARGIN,
      y: 20,
    });
  });

  return document.save({
    addDefaultPage: false,
    useObjectStreams: false,
  });
}
