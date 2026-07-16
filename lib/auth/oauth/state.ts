import { randomBytes, timingSafeEqual } from "node:crypto";

export const OAUTH_STATE_MAX_AGE_SECONDS = 10 * 60;
const OAUTH_STATE_MAX_AGE_MS =
  OAUTH_STATE_MAX_AGE_SECONDS * 1000;
const MAX_CLOCK_SKEW_MS = 30 * 1000;
const STATE_NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function createOAuthState(now = Date.now()): string {
  const nonce = randomBytes(32).toString("base64url");
  return `${now}.${nonce}`;
}

export function validateOAuthState(
  returnedState: string | null | undefined,
  storedState: string | null | undefined,
  now = Date.now()
): boolean {
  if (!returnedState || !storedState) {
    return false;
  }

  const parts = storedState.split(".");

  if (parts.length !== 2 || !STATE_NONCE_PATTERN.test(parts[1])) {
    return false;
  }

  const issuedAt = Number(parts[0]);

  if (
    !Number.isSafeInteger(issuedAt) ||
    issuedAt > now + MAX_CLOCK_SKEW_MS ||
    now - issuedAt > OAUTH_STATE_MAX_AGE_MS
  ) {
    return false;
  }

  const returnedBuffer = Buffer.from(returnedState);
  const storedBuffer = Buffer.from(storedState);

  return (
    returnedBuffer.length === storedBuffer.length &&
    timingSafeEqual(returnedBuffer, storedBuffer)
  );
}
