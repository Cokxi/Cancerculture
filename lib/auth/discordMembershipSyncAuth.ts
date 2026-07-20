import "server-only";

import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";

export const DISCORD_MEMBERSHIP_SYNC_PATH =
  "/api/internal/discord/membership-sync";
export const DISCORD_HEARTBEAT_PATH =
  "/api/internal/discord/heartbeat";
export const DISCORD_MEMBERSHIP_SYNC_MAX_BODY_BYTES = 256 * 1024;
export const DISCORD_MEMBERSHIP_SYNC_MAX_SKEW_SECONDS = 5 * 60;

const EVENT_ID_PATTERN = /^[A-Za-z0-9:_-]{8,128}$/;
const SIGNATURE_PATTERN = /^(?:sha256=)?([0-9a-f]{64})$/i;
const DISCORD_INTERNAL_PATHS = new Set([
  DISCORD_MEMBERSHIP_SYNC_PATH,
  DISCORD_HEARTBEAT_PATH,
]);

export class DiscordMembershipSyncAuthError extends Error {
  status: 401 | 503;
  code:
    | "SYNC_NOT_CONFIGURED"
    | "INVALID_SYNC_SIGNATURE"
    | "EXPIRED_SYNC_REQUEST"
    | "INVALID_SYNC_REQUEST";

  constructor(
    status: 401 | 503,
    code:
      | "SYNC_NOT_CONFIGURED"
      | "INVALID_SYNC_SIGNATURE"
      | "EXPIRED_SYNC_REQUEST"
      | "INVALID_SYNC_REQUEST"
  ) {
    super(code);
    this.name = "DiscordMembershipSyncAuthError";
    this.status = status;
    this.code = code;
  }
}

export function getDiscordMembershipSyncConfiguration() {
  const secret = process.env.DISCORD_MEMBERSHIP_SYNC_SECRET?.trim() ?? "";
  const guildId = process.env.DISCORD_GUILD_ID?.trim() ?? "";

  if (secret.length < 32 || !/^\d{5,32}$/.test(guildId)) {
    throw new DiscordMembershipSyncAuthError(
      503,
      "SYNC_NOT_CONFIGURED"
    );
  }

  return { guildId, secret };
}

export function createDiscordMembershipSyncBodyHash(body: string) {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export function createDiscordMembershipSyncSignature({
  secret,
  method,
  path,
  timestamp,
  eventId,
  body,
}: {
  secret: string;
  method: string;
  path: string;
  timestamp: string;
  eventId: string;
  body: string;
}) {
  const bodyHash = createDiscordMembershipSyncBodyHash(body);
  const canonical = [
    method.toUpperCase(),
    path,
    timestamp,
    eventId,
    bodyHash,
  ].join("\n");

  return createHmac("sha256", secret)
    .update(canonical, "utf8")
    .digest("hex");
}

export function verifyDiscordMembershipSyncRequest({
  method,
  path,
  timestamp,
  eventId,
  signature,
  body,
  nowMs = Date.now(),
}: {
  method: string;
  path: string;
  timestamp: string | null;
  eventId: string | null;
  signature: string | null;
  body: string;
  nowMs?: number;
}) {
  const { guildId, secret } = getDiscordMembershipSyncConfiguration();

  if (
    method.toUpperCase() !== "POST" ||
    !DISCORD_INTERNAL_PATHS.has(path) ||
    !timestamp ||
    !eventId ||
    !EVENT_ID_PATTERN.test(eventId) ||
    !signature
  ) {
    throw new DiscordMembershipSyncAuthError(
      401,
      "INVALID_SYNC_REQUEST"
    );
  }

  const timestampSeconds = Number(timestamp);
  if (
    !Number.isSafeInteger(timestampSeconds) ||
    Math.abs(Math.floor(nowMs / 1000) - timestampSeconds) >
      DISCORD_MEMBERSHIP_SYNC_MAX_SKEW_SECONDS
  ) {
    throw new DiscordMembershipSyncAuthError(
      401,
      "EXPIRED_SYNC_REQUEST"
    );
  }

  const signatureMatch = signature.match(SIGNATURE_PATTERN);
  if (!signatureMatch) {
    throw new DiscordMembershipSyncAuthError(
      401,
      "INVALID_SYNC_SIGNATURE"
    );
  }

  const expected = Buffer.from(
    createDiscordMembershipSyncSignature({
      secret,
      method,
      path,
      timestamp,
      eventId,
      body,
    }),
    "hex"
  );
  const received = Buffer.from(signatureMatch[1], "hex");

  if (
    expected.length !== received.length ||
    !timingSafeEqual(expected, received)
  ) {
    throw new DiscordMembershipSyncAuthError(
      401,
      "INVALID_SYNC_SIGNATURE"
    );
  }

  return {
    eventId,
    guildId,
    payloadSha256: createDiscordMembershipSyncBodyHash(body),
  };
}
