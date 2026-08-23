import "server-only";

import { createHmac } from "node:crypto";

const MIN_SECRET_LENGTH = 32;

export class CommunityCommentAbuseConfigurationError extends Error {
  constructor() {
    super("COMMENT_ABUSE_HMAC_SECRET_UNAVAILABLE");
    this.name = "CommunityCommentAbuseConfigurationError";
  }
}

export function resolveCommunityCommentAbuseSecret(
  environment: Readonly<Record<string, string | undefined>>
) {
  const secret = environment.COMMENT_ABUSE_HMAC_SECRET?.trim();
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new CommunityCommentAbuseConfigurationError();
  }
  return secret;
}

export function getCommunityCommentContentDigest(body: string) {
  return createHmac(
    "sha256",
    resolveCommunityCommentAbuseSecret(process.env)
  )
    .update(body, "utf8")
    .digest("hex");
}
