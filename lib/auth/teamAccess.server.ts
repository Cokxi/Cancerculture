import "server-only";

import { randomUUID } from "node:crypto";
import { cookies, headers } from "next/headers";
import { AuthError } from "@/lib/auth/AuthError";
import { runAuthQueryWithTimeout } from "@/lib/auth/authQuery";
import { buildCoarseTeamSecurityContext } from "@/lib/auth/teamAccessContext.server";
import { supabaseAdmin } from "@/lib/db/admin";
import {
  decryptTwoFactorValue,
  digestTeamAccessContext,
  digestTeamAccessToken,
  findMatchingTotpStep,
  generateTeamAccessToken,
} from "@/lib/twoFactor/crypto.server";

export const TEAM_ACCESS_COOKIE = "team_access";
export const TEAM_ACCESS_MAX_AGE_SECONDS = 60 * 60 * 12;
const TEAM_ACCESS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

type TeamSession = Readonly<{
  discord_user_id: string;
  session_id: string;
}>;

type RpcObject = Record<string, unknown>;

export class TeamAccessError extends AuthError {
  retryAt?: string;

  constructor(status: number, code: string, message: string, retryAt?: string) {
    super(status, message, code);
    this.name = "TeamAccessError";
    this.retryAt = retryAt;
  }
}

function asObject(value: unknown): RpcObject {
  return value && typeof value === "object" ? (value as RpcObject) : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

async function teamAccessRpc(name: string, parameters: Record<string, unknown>) {
  const { data, error } = await runAuthQueryWithTimeout(
    `team access ${name}`,
    supabaseAdmin.rpc(name, parameters)
  );
  if (error) {
    console.error("[TEAM_ACCESS] database request failed", {
      operation: name,
      code: error.code,
    });
    throw new TeamAccessError(
      503,
      "TEAM_ACCESS_UNAVAILABLE",
      "Team access is temporarily unavailable"
    );
  }
  return asObject(data);
}

function contextDigest(requestHeaders: Pick<Headers, "get">) {
  try {
    return digestTeamAccessContext(
      buildCoarseTeamSecurityContext(requestHeaders)
    );
  } catch {
    throw new TeamAccessError(
      503,
      "TEAM_SECURITY_CONTEXT_UNAVAILABLE",
      "Team security context is unavailable"
    );
  }
}

export async function verifyTeamAreaAccess({
  session,
  token,
  requestHeaders,
}: {
  session: TeamSession;
  token: string | null;
  requestHeaders: Pick<Headers, "get">;
}) {
  if (!token || !TEAM_ACCESS_TOKEN_PATTERN.test(token)) {
    throw new TeamAccessError(
      403,
      "TEAM_TOTP_REQUIRED",
      "Team verification required"
    );
  }
  const result = await teamAccessRpc("verify_account_team_access", {
    p_session_id: session.session_id,
    p_token_digest: digestTeamAccessToken(token),
    p_context_digest: contextDigest(requestHeaders),
  });
  const outcome = stringValue(result.outcome);
  if (outcome === "allowed") {
    return { expiresAt: stringValue(result.expiresAt) };
  }
  if (outcome === "context_changed") {
    throw new TeamAccessError(
      403,
      "TEAM_SECURITY_CONTEXT_CHANGED",
      "Team verification required after a security context change"
    );
  }
  if (outcome === "missing" || outcome === "totp_required") {
    throw new TeamAccessError(
      403,
      "TEAM_TOTP_REQUIRED",
      "Team verification required"
    );
  }
  if (outcome === "not_team_member") {
    throw new TeamAccessError(403, "TEAM_ACCESS_DENIED", "Forbidden");
  }
  throw new TeamAccessError(
    503,
    "TEAM_ACCESS_UNAVAILABLE",
    "Team access is temporarily unavailable"
  );
}

export async function requireTeamAreaAccess(session: TeamSession) {
  const [cookieStore, requestHeaders] = await Promise.all([cookies(), headers()]);
  return verifyTeamAreaAccess({
    session,
    token: cookieStore.get(TEAM_ACCESS_COOKIE)?.value ?? null,
    requestHeaders,
  });
}

async function recordInvalidTotp(session: TeamSession): Promise<never> {
  const result = await teamAccessRpc("record_account_totp_failure", {
    p_session_id: session.session_id,
    p_scope: "totp",
  });
  const retryAt = stringValue(result.retryAt) ?? undefined;
  throw new TeamAccessError(
    retryAt ? 429 : 401,
    retryAt ? "TWO_FACTOR_RATE_LIMITED" : "TWO_FACTOR_CODE_INVALID",
    retryAt ? "Too many attempts" : "Invalid authenticator code",
    retryAt
  );
}

export async function grantTeamAreaAccess({
  session,
  code,
  requestHeaders,
}: {
  session: TeamSession;
  code: string;
  requestHeaders: Pick<Headers, "get">;
}) {
  const material = await teamAccessRpc("get_account_totp_factor_material", {
    p_session_id: session.session_id,
  });
  const outcome = stringValue(material.outcome);
  if (outcome === "rate_limited") {
    throw new TeamAccessError(
      429,
      "TWO_FACTOR_RATE_LIMITED",
      "Too many attempts",
      stringValue(material.retryAt) ?? undefined
    );
  }
  if (outcome === "not_enrolled") {
    throw new TeamAccessError(
      409,
      "TEAM_TOTP_NOT_ACTIVE",
      "Active two-factor authentication is required"
    );
  }
  const factorId = stringValue(material.factorId);
  const ciphertext = stringValue(material.ciphertext);
  const nonce = stringValue(material.nonce);
  const tag = stringValue(material.tag);
  const keyVersion = numberValue(material.keyVersion);
  if (outcome !== "ok" || !factorId || !ciphertext || !nonce || !tag || !keyVersion) {
    throw new TeamAccessError(
      503,
      "TEAM_ACCESS_UNAVAILABLE",
      "Team access is temporarily unavailable"
    );
  }
  const secret = decryptTwoFactorValue(
    { ciphertext, nonce, tag, keyVersion },
    "totp-secret",
    session.discord_user_id
  );
  const acceptedStep = findMatchingTotpStep({ secret, code });
  if (acceptedStep === null) {
    return recordInvalidTotp(session);
  }

  const token = generateTeamAccessToken();
  const newSessionId = randomUUID();
  const result = await teamAccessRpc("grant_account_team_access", {
    p_session_id: session.session_id,
    p_new_session_id: newSessionId,
    p_factor_id: factorId,
    p_token_digest: digestTeamAccessToken(token),
    p_context_digest: contextDigest(requestHeaders),
    p_accepted_step: acceptedStep,
  });
  const grantOutcome = stringValue(result.outcome);
  if (grantOutcome === "granted" && result.sessionId === newSessionId) {
    return {
      token,
      sessionId: newSessionId,
      expiresAt: stringValue(result.expiresAt),
    };
  }
  if (grantOutcome === "rate_limited") {
    throw new TeamAccessError(
      429,
      "TWO_FACTOR_RATE_LIMITED",
      "Too many attempts",
      stringValue(result.retryAt) ?? undefined
    );
  }
  if (grantOutcome === "replayed") {
    throw new TeamAccessError(
      409,
      "TOTP_STEP_REPLAYED",
      "Authenticator code already used"
    );
  }
  if (grantOutcome === "not_enrolled") {
    throw new TeamAccessError(
      409,
      "TEAM_TOTP_NOT_ACTIVE",
      "Active two-factor authentication is required"
    );
  }
  if (grantOutcome === "not_team_member") {
    throw new TeamAccessError(403, "TEAM_ACCESS_DENIED", "Forbidden");
  }
  throw new TeamAccessError(
    409,
    "TEAM_ACCESS_STATE_CHANGED",
    "Team access state changed"
  );
}
