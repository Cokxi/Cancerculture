const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function encodeTeamInboxCursor(value: { at: string; id: string }) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function parseTeamInboxCursor(value: string | null | undefined) {
  if (!value || value.length < 4 || value.length > 512) return null;
  try {
    const candidate = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      typeof candidate.at !== "string" ||
      !Number.isFinite(Date.parse(candidate.at)) ||
      typeof candidate.id !== "string" ||
      !UUID_PATTERN.test(candidate.id)
    ) return null;
    return { at: candidate.at, id: candidate.id };
  } catch {
    return null;
  }
}
