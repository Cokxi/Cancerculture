import { createHash, timingSafeEqual } from "node:crypto";

export type InternalTriggerAuthResult =
  | "authorized"
  | "unauthorized"
  | "misconfigured";

const MINIMUM_TRIGGER_SECRET_LENGTH = 32;

function getBearerToken(authorizationHeader: string | null) {
  if (!authorizationHeader) {
    return null;
  }

  const match = /^Bearer ([^\s]+)$/.exec(authorizationHeader);
  return match?.[1] ?? null;
}

function digestSecret(value: string) {
  return createHash("sha256").update(value, "utf8").digest();
}

export function authorizeInternalTrigger({
  authorizationHeader,
  configuredSecret,
}: {
  authorizationHeader: string | null;
  configuredSecret: string | undefined;
}): InternalTriggerAuthResult {
  if (
    !configuredSecret ||
    configuredSecret.length < MINIMUM_TRIGGER_SECRET_LENGTH
  ) {
    return "misconfigured";
  }

  const providedSecret = getBearerToken(authorizationHeader);

  if (!providedSecret) {
    return "unauthorized";
  }

  return timingSafeEqual(
    digestSecret(configuredSecret),
    digestSecret(providedSecret)
  )
    ? "authorized"
    : "unauthorized";
}
