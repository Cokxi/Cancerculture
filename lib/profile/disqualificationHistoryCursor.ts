const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type HistoryCursor = Readonly<{
  at: string;
  eventId: string;
}>;

type ProfileCursor = Readonly<{
  at: string;
  publicProfileId: string;
}>;

function encode(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8").toString(
    "base64url"
  );
}

function decode(value: string): unknown {
  if (value.length < 4 || value.length > 512) {
    return null;
  }

  try {
    return JSON.parse(
      Buffer.from(value, "base64url").toString("utf8")
    );
  } catch {
    return null;
  }
}

function validTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 20 &&
    value.length <= 64 &&
    Number.isFinite(Date.parse(value))
  );
}

export function encodeDisqualificationHistoryCursor(
  cursor: HistoryCursor
) {
  return encode(cursor);
}

export function parseDisqualificationHistoryCursor(
  value: string | null | undefined
): HistoryCursor | null {
  if (!value) return null;

  const decoded = decode(value);
  if (!decoded || typeof decoded !== "object") return null;

  const candidate = decoded as Record<string, unknown>;
  if (
    !validTimestamp(candidate.at) ||
    typeof candidate.eventId !== "string" ||
    !UUID_PATTERN.test(candidate.eventId)
  ) {
    return null;
  }

  return Object.freeze({
    at: candidate.at,
    eventId: candidate.eventId,
  });
}

export function encodeDisqualificationProfileCursor(
  cursor: ProfileCursor
) {
  return encode(cursor);
}

export function isDisqualificationPublicProfileId(
  value: unknown
): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function parseDisqualificationProfileCursor(
  value: string | null | undefined
): ProfileCursor | null {
  if (!value) return null;

  const decoded = decode(value);
  if (!decoded || typeof decoded !== "object") return null;

  const candidate = decoded as Record<string, unknown>;
  if (
    !validTimestamp(candidate.at) ||
    !isDisqualificationPublicProfileId(candidate.publicProfileId)
  ) {
    return null;
  }

  return Object.freeze({
    at: candidate.at,
    publicProfileId: candidate.publicProfileId,
  });
}
