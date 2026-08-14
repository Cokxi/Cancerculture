import {
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import {
  PUBLIC_PAGINATION_CURSOR_VERSION,
  PUBLIC_PAGINATION_SCOPES,
  type PaginationView,
  type PublicPaginationCursorPayload,
  type PublicPaginationCursorPayloadForScope,
  type PublicPaginationScope,
} from "./publicPagination";

const MAX_CURSOR_LENGTH = 2048;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
export const PUBLIC_PAGINATION_CURSOR_SECRET_MIN_LENGTH = 32;

export class PublicPaginationCursorError extends Error {
  constructor() {
    super("INVALID_CURSOR");
    this.name = "PublicPaginationCursorError";
  }
}

function fail(): never {
  throw new PublicPaginationCursorError();
}

function isRecord(
  value: unknown
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: string[]
) {
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...keys].sort();

  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every(
      (key, index) => key === expectedKeys[index]
    )
  );
}

function isId(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function isView(value: unknown): value is PaginationView {
  return value === "public" || value === "admin";
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }

  const parsed = new Date(value);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString() === value
  );
}

function isPreciseUtcTimestamp(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/u.test(
      value
    )
  ) {
    return false;
  }

  const parsed = new Date(value);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 19) === value.slice(0, 19)
  );
}

function validatePayload(
  value: unknown
): PublicPaginationCursorPayload {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "version",
      "scope",
      "context",
      "values",
    ]) ||
    value.version !== PUBLIC_PAGINATION_CURSOR_VERSION ||
    typeof value.scope !== "string" ||
    !isRecord(value.context) ||
    !isRecord(value.values)
  ) {
    return fail();
  }

  if (value.scope === PUBLIC_PAGINATION_SCOPES.submissions) {
    if (
      !hasExactKeys(value.context, ["cycleId"]) ||
      !hasExactKeys(value.values, ["id"]) ||
      !isId(value.context.cycleId) ||
      !isId(value.values.id)
    ) {
      return fail();
    }

    return value as PublicPaginationCursorPayload;
  }

  if (
    value.scope === PUBLIC_PAGINATION_SCOPES.fame ||
    value.scope === PUBLIC_PAGINATION_SCOPES.shame
  ) {
    if (
      !hasExactKeys(value.context, ["wall"]) ||
      !hasExactKeys(value.values, ["createdAt", "id"]) ||
      value.context.wall !== value.scope ||
      !isId(value.values.id) ||
      !(
        value.values.createdAt === null ||
        isCanonicalTimestamp(value.values.createdAt)
      )
    ) {
      return fail();
    }

    return value as PublicPaginationCursorPayload;
  }

  if (
    value.scope === PUBLIC_PAGINATION_SCOPES.historyCycles
  ) {
    if (
      !hasExactKeys(value.context, ["view"]) ||
      !hasExactKeys(value.values, ["id"]) ||
      !isView(value.context.view) ||
      !isId(value.values.id)
    ) {
      return fail();
    }

    return value as PublicPaginationCursorPayload;
  }

  if (
    value.scope ===
    PUBLIC_PAGINATION_SCOPES.historySubmissions
  ) {
    if (
      !hasExactKeys(value.context, ["cycleId", "view"]) ||
      !hasExactKeys(value.values, ["id"]) ||
      !isId(value.context.cycleId) ||
      !isView(value.context.view) ||
      !isId(value.values.id)
    ) {
      return fail();
    }

    return value as PublicPaginationCursorPayload;
  }

  if (value.scope === PUBLIC_PAGINATION_SCOPES.feedLive) {
    if (
      !hasExactKeys(value.context, [
        "cycleId",
        "feed",
        "resetCount",
      ]) ||
      !hasExactKeys(value.values, [
        "createdAt",
        "submissionId",
      ]) ||
      value.context.feed !== "live" ||
      !isId(value.context.cycleId) ||
      !isNonNegativeInteger(value.context.resetCount) ||
      !isPreciseUtcTimestamp(value.values.createdAt) ||
      !isId(value.values.submissionId)
    ) {
      return fail();
    }

    return value as PublicPaginationCursorPayload;
  }

  const finalizedFeedByScope = {
    [PUBLIC_PAGINATION_SCOPES.feedTop10]: "top10",
    [PUBLIC_PAGINATION_SCOPES.feedAll]: "all",
    [PUBLIC_PAGINATION_SCOPES.feedTrash]: "trash",
  } as const;
  const finalizedFeed =
    finalizedFeedByScope[
      value.scope as keyof typeof finalizedFeedByScope
    ];

  if (finalizedFeed) {
    if (
      !hasExactKeys(value.context, [
        "classificationVersion",
        "feed",
      ]) ||
      !hasExactKeys(value.values, [
        "cycleId",
        "finalizedAt",
        "rankInCycle",
        "submissionId",
      ]) ||
      value.context.feed !== finalizedFeed ||
      !isId(value.context.classificationVersion) ||
      !isPreciseUtcTimestamp(value.values.finalizedAt) ||
      !isId(value.values.cycleId) ||
      !isId(value.values.rankInCycle) ||
      !isId(value.values.submissionId)
    ) {
      return fail();
    }

    return value as PublicPaginationCursorPayload;
  }

  return fail();
}

function getSignature(body: string, secret: string) {
  if (
    secret.length <
    PUBLIC_PAGINATION_CURSOR_SECRET_MIN_LENGTH
  ) {
    throw new Error("PUBLIC_PAGINATION_CURSOR_SECRET_INVALID");
  }

  return createHmac("sha256", secret)
    .update(body)
    .digest("base64url");
}

function contextsMatch(
  actual: PublicPaginationCursorPayload["context"],
  expected: PublicPaginationCursorPayload["context"]
) {
  const actualEntries = Object.entries(actual).sort();
  const expectedEntries = Object.entries(expected).sort();

  return (
    actualEntries.length === expectedEntries.length &&
    actualEntries.every(
      ([key, value], index) =>
        key === expectedEntries[index]?.[0] &&
        value === expectedEntries[index]?.[1]
    )
  );
}

export function encodePublicPaginationCursor(
  payload: PublicPaginationCursorPayload,
  secret: string
) {
  const validatedPayload = validatePayload(payload);
  const body = Buffer.from(
    JSON.stringify(validatedPayload),
    "utf8"
  ).toString("base64url");
  const signature = getSignature(body, secret);

  return `${body}.${signature}`;
}

export function decodePublicPaginationCursorForScope<
  Scope extends PublicPaginationScope,
>(
  cursor: string,
  expectedScope: Scope,
  secret: string
): PublicPaginationCursorPayloadForScope<Scope> {
  if (
    typeof cursor !== "string" ||
    cursor.length === 0 ||
    cursor.length > MAX_CURSOR_LENGTH
  ) {
    return fail();
  }

  const parts = cursor.split(".");

  if (
    parts.length !== 2 ||
    !parts[0] ||
    !parts[1] ||
    !BASE64URL_PATTERN.test(parts[0]) ||
    !BASE64URL_PATTERN.test(parts[1])
  ) {
    return fail();
  }

  const [body, providedSignature] = parts;
  const expectedSignature = getSignature(body, secret);
  const providedBuffer = Buffer.from(
    providedSignature,
    "base64url"
  );
  const expectedBuffer = Buffer.from(
    expectedSignature,
    "base64url"
  );

  if (
    providedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    return fail();
  }

  let decoded: unknown;

  try {
    const bodyBuffer = Buffer.from(body, "base64url");

    if (bodyBuffer.toString("base64url") !== body) {
      return fail();
    }

    decoded = JSON.parse(bodyBuffer.toString("utf8"));
  } catch {
    return fail();
  }

  const payload = validatePayload(decoded);

  if (payload.scope !== expectedScope) {
    return fail();
  }

  return payload as PublicPaginationCursorPayloadForScope<Scope>;
}

export function decodePublicPaginationCursor<
  Scope extends PublicPaginationScope,
>(
  cursor: string,
  expectedScope: Scope,
  expectedContext: PublicPaginationCursorPayload["context"],
  secret: string
): PublicPaginationCursorPayloadForScope<Scope> {
  const payload = decodePublicPaginationCursorForScope(
    cursor,
    expectedScope,
    secret
  );

  if (!contextsMatch(payload.context, expectedContext)) {
    return fail();
  }

  return payload;
}
