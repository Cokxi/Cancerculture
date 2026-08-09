const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type SubmissionReportCursor = Readonly<{
  createdAt: string;
  reportId: string;
}>;

export function encodeSubmissionReportCursor(
  cursor: SubmissionReportCursor
) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function parseSubmissionReportCursor(
  value: string | null | undefined
): SubmissionReportCursor | null {
  if (!value || value.length > 500) return null;

  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8")
    ) as Record<string, unknown>;
    if (
      Object.keys(parsed).length !== 2 ||
      typeof parsed.createdAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.createdAt)) ||
      typeof parsed.reportId !== "string" ||
      !UUID_PATTERN.test(parsed.reportId)
    ) {
      return null;
    }
    return Object.freeze({
      createdAt: parsed.createdAt,
      reportId: parsed.reportId.toLowerCase(),
    });
  } catch {
    return null;
  }
}
