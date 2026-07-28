import "server-only";
import {
  decodePublicPaginationCursor,
  encodePublicPaginationCursor,
  PUBLIC_PAGINATION_CURSOR_SECRET_MIN_LENGTH,
} from "./publicPaginationCursor";
import type {
  PublicPaginationCursorPayload,
  PublicPaginationScope,
} from "./publicPagination";

export class PublicPaginationConfigurationError extends Error {
  constructor(
    code:
      | "PUBLIC_PAGINATION_CURSOR_SECRET_MISSING"
      | "PUBLIC_PAGINATION_CURSOR_SECRET_TOO_SHORT"
  ) {
    super(code);
    this.name = "PublicPaginationConfigurationError";
  }
}

export function resolvePublicPaginationCursorSecret(
  environment: Readonly<
    Record<string, string | undefined>
  >
) {
  const secret =
    environment.PUBLIC_PAGINATION_CURSOR_SECRET;

  if (!secret) {
    throw new PublicPaginationConfigurationError(
      "PUBLIC_PAGINATION_CURSOR_SECRET_MISSING"
    );
  }

  if (
    secret.length <
    PUBLIC_PAGINATION_CURSOR_SECRET_MIN_LENGTH
  ) {
    throw new PublicPaginationConfigurationError(
      "PUBLIC_PAGINATION_CURSOR_SECRET_TOO_SHORT"
    );
  }

  return secret;
}

function getCursorSecret() {
  return resolvePublicPaginationCursorSecret(process.env);
}

export function encodeServerPublicPaginationCursor(
  payload: PublicPaginationCursorPayload
) {
  return encodePublicPaginationCursor(
    payload,
    getCursorSecret()
  );
}

export function decodeServerPublicPaginationCursor(
  cursor: string,
  expectedScope: PublicPaginationScope,
  expectedContext: PublicPaginationCursorPayload["context"]
) {
  return decodePublicPaginationCursor(
    cursor,
    expectedScope,
    expectedContext,
    getCursorSecret()
  );
}
