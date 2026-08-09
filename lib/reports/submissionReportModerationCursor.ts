import type { SubmissionReportModerationCursor } from "@/lib/reports/submissionReportTeam.server";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function encodeSubmissionReportModerationCursor(
  cursor: SubmissionReportModerationCursor
) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function parseSubmissionReportModerationCursor(
  value: string | null | undefined
): SubmissionReportModerationCursor | null {
  if (!value || value.length > 500) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8")
    ) as Record<string, unknown>;
    if (
      Object.keys(parsed).length !== 2 ||
      typeof parsed.occurredAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.occurredAt)) ||
      typeof parsed.eventId !== "string" ||
      !UUID_PATTERN.test(parsed.eventId)
    ) {
      return null;
    }
    return Object.freeze({
      occurredAt: parsed.occurredAt,
      eventId: parsed.eventId.toLowerCase(),
    });
  } catch {
    return null;
  }
}
