import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import type { CommunityFeedKind } from "@/lib/feed/communityFeed";

const TOKEN_VERSION = 1;
const MEASUREMENT_WINDOW_SECONDS = 30 * 60;

type TokenPayload = {
  exp: number;
  feed: CommunityFeedKind;
  submissionId: number;
  v: number;
};

function getSecret() {
  const value = process.env.SPONSOR_MEASUREMENT_HMAC_SECRET ?? "";
  return value.length >= 32 ? value : null;
}

function sign(encodedPayload: string, secret: string) {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

export function createSponsorMeasurementGrant({
  feed,
  submissionId,
  nowMs = Date.now(),
}: {
  feed: CommunityFeedKind;
  submissionId: number;
  nowMs?: number;
}) {
  const secret = getSecret();
  if (!secret || !Number.isSafeInteger(submissionId) || submissionId <= 0) {
    return null;
  }

  const nowSeconds = Math.floor(nowMs / 1000);
  const expiresAtSeconds =
    (Math.floor(nowSeconds / MEASUREMENT_WINDOW_SECONDS) + 1) *
    MEASUREMENT_WINDOW_SECONDS;
  const payload: TokenPayload = {
    exp: expiresAtSeconds,
    feed,
    submissionId,
    v: TOKEN_VERSION,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return {
    token: `${encodedPayload}.${sign(encodedPayload, secret)}`,
    expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
  };
}

export function verifySponsorMeasurementToken({
  token,
  feed,
  submissionId,
  nowMs = Date.now(),
}: {
  token: string;
  feed: CommunityFeedKind;
  submissionId: number;
  nowMs?: number;
}) {
  const secret = getSecret();
  const [encodedPayload, signature, extra] = token.split(".");
  if (!secret || !encodedPayload || !signature || extra) return false;

  const expected = Buffer.from(sign(encodedPayload, secret));
  const actual = Buffer.from(signature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return false;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8")
    ) as Partial<TokenPayload>;
    return (
      payload.v === TOKEN_VERSION &&
      payload.feed === feed &&
      payload.submissionId === submissionId &&
      Number.isSafeInteger(payload.exp) &&
      Number(payload.exp) > Math.floor(nowMs / 1000)
    );
  } catch {
    return false;
  }
}
