import "server-only";

import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/lib/db/admin";
import {
  buildOtpAuthUri,
  decryptTwoFactorValue,
  digestEmailVerificationCode,
  digestEmailToken,
  digestRecoveryCode,
  encryptTwoFactorValue,
  fingerprintRecoveryEmail,
  findMatchingTotpStep,
  generateEmailToken,
  generateEmailVerificationCode,
  generateRecoveryCodes,
  generateTotpSecret,
  maskRecoveryEmail,
  normalizeRecoveryEmail,
  type EncryptedValue,
} from "@/lib/twoFactor/crypto.server";
import { sendTwoFactorSecurityMail } from "@/lib/twoFactor/mail.server";
import { createAuthenticatorQrCode } from "@/lib/twoFactor/qr.server";

export type TwoFactorSession = {
  discord_user_id: string;
  session_id: string;
};

export type StepUpPurpose =
  | "factor_change"
  | "factor_deactivation"
  | "recovery_codes_replace"
  | "backup_email_change"
  | "sol_wallet_change";

export class TwoFactorError extends Error {
  status: number;
  code: string;
  retryAt?: string;

  constructor(status: number, code: string, message: string, retryAt?: string) {
    super(message);
    this.name = "TwoFactorError";
    this.status = status;
    this.code = code;
    this.retryAt = retryAt;
  }
}

type RpcObject = Record<string, unknown>;

function asObject(value: unknown): RpcObject {
  return value && typeof value === "object" ? (value as RpcObject) : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function encryptedValue(value: unknown): EncryptedValue | null {
  const object = asObject(value);
  const ciphertext = stringValue(object.ciphertext);
  const nonce = stringValue(object.nonce);
  const tag = stringValue(object.tag);
  const keyVersion = numberValue(object.keyVersion);
  return ciphertext && nonce && tag && keyVersion
    ? { ciphertext, nonce, tag, keyVersion }
    : null;
}

async function rpc(name: string, parameters: Record<string, unknown>) {
  const { data, error } = await supabaseAdmin.rpc(name, parameters);
  if (error) {
    const code =
      error.message.match(/[A-Z][A-Z0-9_]{4,}/u)?.[0] ??
      "TWO_FACTOR_SERVICE_UNAVAILABLE";
    const status =
      code === "FRESH_STEP_UP_REQUIRED" ? 403 :
      code.endsWith("_COOLDOWN") ? 429 :
      code.includes("INPUT_INVALID") || code.includes("TOKEN_INVALID") ? 400 :
      code.includes("STATE_CHANGED") || code.includes("NOT_PENDING") ? 409 : 503;
    throw new TwoFactorError(status, code, "Two-factor request failed");
  }
  return asObject(data);
}

function requireOutcome(result: RpcObject, expected: string) {
  const outcome = stringValue(result.outcome);
  if (outcome === expected) return result;
  if (outcome === "rate_limited") {
    throw new TwoFactorError(
      429,
      "TWO_FACTOR_RATE_LIMITED",
      "Too many attempts",
      stringValue(result.retryAt) ?? undefined
    );
  }
  if (outcome === "replayed") {
    throw new TwoFactorError(409, "TOTP_STEP_REPLAYED", "Code already used");
  }
  if (outcome === "rejected") {
    throw new TwoFactorError(401, "TWO_FACTOR_CODE_INVALID", "Invalid code");
  }
  if (outcome === "not_enrolled") {
    throw new TwoFactorError(409, "TWO_FACTOR_NOT_ACTIVE", "Two-factor is not active");
  }
  throw new TwoFactorError(409, "TWO_FACTOR_STATE_CHANGED", "Two-factor state changed");
}

async function recordInvalidCode(session: TwoFactorSession, scope: "totp" | "recovery_code") {
  const result = await rpc("record_account_totp_failure", {
    p_session_id: session.session_id,
    p_scope: scope,
  });
  const retryAt = stringValue(result.retryAt);
  throw new TwoFactorError(
    retryAt ? 429 : 401,
    retryAt ? "TWO_FACTOR_RATE_LIMITED" : "TWO_FACTOR_CODE_INVALID",
    retryAt ? "Too many attempts" : "Invalid code",
    retryAt ?? undefined
  );
}

export async function getTwoFactorStatus(session: TwoFactorSession) {
  const result = requireOutcome(
    await rpc("get_account_two_factor_status", {
      p_session_id: session.session_id,
    }),
    "ok"
  );
  const contact = encryptedValue(result.recoveryContact);
  let maskedRecoveryEmail: string | null = null;
  if (contact) {
    const email = decryptTwoFactorValue(
      contact,
      "recovery-email",
      session.discord_user_id
    );
    maskedRecoveryEmail = maskRecoveryEmail(email);
  }
  const pending = asObject(result.pendingEnrollment);
  return {
    active: result.active === true,
    activatedAt: stringValue(result.activatedAt),
    recoveryCodesRemaining: numberValue(result.recoveryCodesRemaining) ?? 0,
    recoveryEmail: maskedRecoveryEmail
      ? {
          masked: maskedRecoveryEmail,
          verifiedAt: stringValue(asObject(result.recoveryContact).verifiedAt),
        }
      : null,
    pendingEnrollment: stringValue(pending.id)
      ? {
          id: stringValue(pending.id)!,
          intent: stringValue(pending.intent),
          expiresAt: stringValue(pending.expiresAt),
        }
      : null,
  };
}

export async function beginTotpEnrollment({
  session,
  intent,
  recoveryToken,
  acknowledgeRecoveryResponsibility,
  accountLabel,
}: {
  session: TwoFactorSession;
  intent: "initial" | "replacement" | "email_recovery";
  recoveryToken?: string;
  acknowledgeRecoveryResponsibility: boolean;
  accountLabel: string;
}) {
  if (
    intent !== "replacement" &&
    !acknowledgeRecoveryResponsibility
  ) {
    throw new TwoFactorError(
      400,
      "RECOVERY_RESPONSIBILITY_ACK_REQUIRED",
      "Recovery responsibility acknowledgement required"
    );
  }
  const secret = generateTotpSecret();
  const encrypted = encryptTwoFactorValue(
    secret,
    "totp-secret",
    session.discord_user_id
  );
  const enrollmentId = randomUUID();
  const result = requireOutcome(
    await rpc("begin_account_totp_enrollment", {
      p_session_id: session.session_id,
      p_enrollment_id: enrollmentId,
      p_intent: intent,
      p_secret_ciphertext: encrypted.ciphertext,
      p_secret_nonce: encrypted.nonce,
      p_secret_tag: encrypted.tag,
      p_key_version: encrypted.keyVersion,
      p_no_backup_acknowledged: acknowledgeRecoveryResponsibility,
      p_recovery_token_digest:
        intent === "email_recovery" && recoveryToken
          ? digestEmailToken(recoveryToken)
          : null,
    }),
    "pending"
  );
  const otpAuthUri = buildOtpAuthUri({ secret, accountLabel });
  return {
    enrollmentId,
    expiresAt: stringValue(result.expiresAt),
    qrCodeDataUrl: await createAuthenticatorQrCode(otpAuthUri),
    manualKey: secret,
  };
}

export async function activateTotpEnrollment({
  session,
  enrollmentId,
  code,
}: {
  session: TwoFactorSession;
  enrollmentId: string;
  code: string;
}) {
  const material = requireOutcome(
    await rpc("get_account_totp_enrollment_material", {
      p_session_id: session.session_id,
      p_enrollment_id: enrollmentId,
    }),
    "ok"
  );
  const encrypted = encryptedValue(material);
  if (!encrypted) {
    throw new TwoFactorError(503, "TWO_FACTOR_MATERIAL_INVALID", "Two-factor unavailable");
  }
  const secret = decryptTwoFactorValue(
    encrypted,
    "totp-secret",
    session.discord_user_id
  );
  const matchingStep = findMatchingTotpStep({ secret, code });
  if (matchingStep === null) await recordInvalidCode(session, "totp");

  const recoveryCodes = generateRecoveryCodes();
  const result = requireOutcome(
    await rpc("activate_account_totp_enrollment", {
      p_session_id: session.session_id,
      p_enrollment_id: enrollmentId,
      p_accepted_step: matchingStep,
      p_recovery_code_digests: recoveryCodes.map(digestRecoveryCode),
    }),
    "activated"
  );

  let recoveryNotificationSent: boolean | null = null;
  if (stringValue(result.intent) === "email_recovery") {
    try {
      const status = await getTwoFactorStatus(session);
      if (status.recoveryEmail) {
        const contactResult = await rpc("get_account_two_factor_status", {
          p_session_id: session.session_id,
        });
        const contact = encryptedValue(contactResult.recoveryContact);
        if (contact) {
          const recipient = decryptTwoFactorValue(
            contact,
            "recovery-email",
            session.discord_user_id
          );
          recoveryNotificationSent =
            (await sendTwoFactorSecurityMail({ kind: "factor_changed", recipient }))
              .status === "sent";
        }
      }
    } catch {
      recoveryNotificationSent = false;
    }
  }

  return {
    active: true,
    activatedAt: stringValue(result.activatedAt),
    recoveryCodes,
    recoveryNotificationSent,
  };
}

export async function verifyStepUp({
  session,
  code,
  purpose,
}: {
  session: TwoFactorSession;
  code: string;
  purpose: StepUpPurpose;
}) {
  const looksLikeRecoveryCode = code.trim().toUpperCase().startsWith("CC-");
  if (looksLikeRecoveryCode) {
    if (purpose === "backup_email_change") {
      throw new TwoFactorError(
        400,
        "TOTP_REQUIRED_FOR_RECOVERY_EMAIL",
        "A current authenticator code is required"
      );
    }
    return requireOutcome(
      await rpc("accept_account_recovery_code_step_up", {
        p_session_id: session.session_id,
        p_code_digest: digestRecoveryCode(code),
        p_purpose: purpose,
      }),
      "accepted"
    );
  }

  const material = await rpc("get_account_totp_factor_material", {
    p_session_id: session.session_id,
  });
  requireOutcome(material, "ok");
  const encrypted = encryptedValue(material);
  const factorId = stringValue(material.factorId);
  if (!encrypted || !factorId) {
    throw new TwoFactorError(503, "TWO_FACTOR_MATERIAL_INVALID", "Two-factor unavailable");
  }
  const secret = decryptTwoFactorValue(
    encrypted,
    "totp-secret",
    session.discord_user_id
  );
  const matchingStep = findMatchingTotpStep({ secret, code });
  if (matchingStep === null) await recordInvalidCode(session, "totp");
  return requireOutcome(
    await rpc("accept_account_totp_step_up", {
      p_session_id: session.session_id,
      p_factor_id: factorId,
      p_accepted_step: matchingStep,
      p_purpose: purpose,
    }),
    "accepted"
  );
}

export async function replaceRecoveryCodes(session: TwoFactorSession) {
  const recoveryCodes = generateRecoveryCodes();
  requireOutcome(
    await rpc("replace_account_totp_recovery_codes", {
      p_session_id: session.session_id,
      p_request_id: randomUUID(),
      p_recovery_code_digests: recoveryCodes.map(digestRecoveryCode),
    }),
    "replaced"
  );
  return recoveryCodes;
}

export async function deactivateTotp(session: TwoFactorSession) {
  requireOutcome(
    await rpc("deactivate_account_totp_factor", {
      p_session_id: session.session_id,
      p_request_id: randomUUID(),
    }),
    "deactivated"
  );
}

async function markDelivery(
  session: TwoFactorSession,
  challengeId: string,
  status: "sent" | "failed"
) {
  await rpc("mark_account_email_challenge_delivery", {
    p_session_id: session.session_id,
    p_challenge_id: challengeId,
    p_delivery_status: status,
  });
}

export async function requestRecoveryEmailVerification({
  session,
  email,
}: {
  session: TwoFactorSession;
  email: string;
}) {
  const normalized = normalizeRecoveryEmail(email);
  const encrypted = encryptTwoFactorValue(
    normalized,
    "recovery-email",
    session.discord_user_id
  );
  const token = generateEmailVerificationCode();
  const result = requireOutcome(
    await rpc("begin_account_recovery_email_change", {
      p_session_id: session.session_id,
      p_request_id: randomUUID(),
      p_token_digest: digestEmailVerificationCode(token),
      p_email_ciphertext: encrypted.ciphertext,
      p_email_nonce: encrypted.nonce,
      p_email_tag: encrypted.tag,
      p_email_fingerprint: fingerprintRecoveryEmail(normalized),
      p_key_version: encrypted.keyVersion,
    }),
    "pending_delivery"
  );
  const challengeId = stringValue(result.challengeId);
  if (!challengeId) throw new TwoFactorError(503, "EMAIL_CHALLENGE_INVALID", "Email unavailable");
  const delivery = await sendTwoFactorSecurityMail({
    kind: "verify_backup_email",
    recipient: normalized,
    token,
  });
  await markDelivery(session, challengeId, delivery.status === "sent" ? "sent" : "failed");
  if (delivery.status !== "sent") {
    throw new TwoFactorError(503, "SECURITY_EMAIL_UNAVAILABLE", "Security email unavailable");
  }
  return { masked: maskRecoveryEmail(normalized), expiresAt: stringValue(result.expiresAt) };
}

export async function confirmRecoveryEmail(session: TwoFactorSession, token: string) {
  let tokenDigest: string;
  try {
    tokenDigest = digestEmailVerificationCode(token);
  } catch {
    throw new TwoFactorError(400, "RECOVERY_TOKEN_INVALID", "Invalid recovery token");
  }
  return requireOutcome(
    await rpc("confirm_account_recovery_email", {
      p_session_id: session.session_id,
      p_token_digest: tokenDigest,
    }),
    "verified"
  );
}

export async function removeRecoveryEmail(session: TwoFactorSession) {
  requireOutcome(
    await rpc("remove_account_recovery_email", {
      p_session_id: session.session_id,
      p_request_id: randomUUID(),
    }),
    "removed"
  );
}

export async function requestFactorRecoveryEmail(session: TwoFactorSession) {
  const token = generateEmailToken();
  const result = await rpc("reserve_account_factor_recovery_email", {
    p_session_id: session.session_id,
    p_token_digest: digestEmailToken(token),
  });
  const outcome = stringValue(result.outcome);
  if (outcome === "rate_limited") {
    throw new TwoFactorError(429, "RECOVERY_EMAIL_RATE_LIMITED", "Recovery email rate limited");
  }
  if (outcome !== "pending_delivery") {
    throw new TwoFactorError(409, "RECOVERY_EMAIL_UNAVAILABLE", "Recovery email unavailable");
  }
  const challengeId = stringValue(result.challengeId);
  const contact = encryptedValue(result.contact);
  if (!challengeId || !contact) {
    throw new TwoFactorError(503, "RECOVERY_EMAIL_UNAVAILABLE", "Recovery email unavailable");
  }
  const recipient = decryptTwoFactorValue(
    contact,
    "recovery-email",
    session.discord_user_id
  );
  const delivery = await sendTwoFactorSecurityMail({
    kind: "factor_recovery",
    recipient,
    token,
  });
  await markDelivery(session, challengeId, delivery.status === "sent" ? "sent" : "failed");
  if (delivery.status !== "sent") {
    throw new TwoFactorError(503, "SECURITY_EMAIL_UNAVAILABLE", "Security email unavailable");
  }
  return { requested: true, expiresAt: stringValue(result.expiresAt) };
}
