import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import type { SponsorTrackingSurface } from "@/lib/sponsors/tracking";

const TOKEN_VERSION = 1;
const PRESENTATION_LIFETIME_SECONDS = 6 * 60 * 60;
const PRESENTATION_SURFACES = [
  "home_hud",
  "vote_modal",
  "history_modal",
  "fame_modal",
  "shame_modal",
  "spread_detail",
] as const;

function isPresentationSurface(
  value: unknown
): value is Exclude<SponsorTrackingSurface, "spread"> {
  return (
    typeof value === "string" &&
    PRESENTATION_SURFACES.includes(
      value as (typeof PRESENTATION_SURFACES)[number]
    )
  );
}

type SponsorPresentationPayload = {
  exp: number;
  sponsorshipId: number;
  surface: SponsorTrackingSurface;
  purpose: "sponsor-presentation";
  v: number;
};

function getSecret() {
  const secret = process.env.SPONSOR_MEASUREMENT_HMAC_SECRET ?? "";
  return secret.length >= 32 ? secret : null;
}

function getEncryptionKey(secret: string) {
  return createHash("sha256")
    .update(`sponsor-presentation:${secret}`)
    .digest();
}

function encryptPayload(payload: SponsorPresentationPayload, secret: string) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getEncryptionKey(secret), nonce);
  cipher.setAAD(Buffer.from("sponsor-presentation:v1"));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    nonce.toString("base64url"),
    ciphertext.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
  ].join(".");
}

export function createSponsorPresentationGrant({
  sponsorshipId,
  surface,
  nowMs = Date.now(),
}: {
  sponsorshipId: number;
  surface: Exclude<SponsorTrackingSurface, "spread">;
  nowMs?: number;
}) {
  const secret = getSecret();
  if (!secret || !Number.isSafeInteger(sponsorshipId) || sponsorshipId <= 0) {
    return null;
  }

  const expiresAtSeconds =
    Math.floor(nowMs / 1000) + PRESENTATION_LIFETIME_SECONDS;
  const payload: SponsorPresentationPayload = {
    exp: expiresAtSeconds,
    sponsorshipId,
    surface,
    purpose: "sponsor-presentation",
    v: TOKEN_VERSION,
  };
  return {
    token: encryptPayload(payload, secret),
    expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
  };
}

export function verifySponsorPresentationGrant({
  token,
  surface,
  nowMs = Date.now(),
}: {
  token: string;
  surface: unknown;
  nowMs?: number;
}): SponsorPresentationPayload | null {
  const secret = getSecret();
  if (token.length === 0 || token.length > 2048) return null;
  const [version, nonceValue, ciphertextValue, tagValue, extra] =
    token.split(".");
  if (
    !secret ||
    version !== "v1" ||
    !nonceValue ||
    !ciphertextValue ||
    !tagValue ||
    extra ||
    !isPresentationSurface(surface)
  ) {
    return null;
  }

  try {
    const nonce = Buffer.from(nonceValue, "base64url");
    const tag = Buffer.from(tagValue, "base64url");
    if (nonce.length !== 12 || tag.length !== 16) return null;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      getEncryptionKey(secret),
      nonce
    );
    decipher.setAAD(Buffer.from("sponsor-presentation:v1"));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    const payload = JSON.parse(plaintext) as Partial<SponsorPresentationPayload>;
    if (
      payload.v !== TOKEN_VERSION ||
      payload.purpose !== "sponsor-presentation" ||
      payload.surface !== surface ||
      !Number.isSafeInteger(payload.sponsorshipId) ||
      Number(payload.sponsorshipId) <= 0 ||
      !Number.isSafeInteger(payload.exp) ||
      Number(payload.exp) <= Math.floor(nowMs / 1000)
    ) {
      return null;
    }
    return payload as SponsorPresentationPayload;
  } catch {
    return null;
  }
}
