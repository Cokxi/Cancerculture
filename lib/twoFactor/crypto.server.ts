import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;
const RECOVERY_CODE_COUNT = 10;

export type EncryptedValue = {
  ciphertext: string;
  nonce: string;
  tag: string;
  keyVersion: number;
};

type TwoFactorCryptoConfig = {
  encryptionKey: Buffer;
  pepper: Buffer;
  keyVersion: number;
};

function decodeSecret(value: string | undefined) {
  if (!value) return null;
  try {
    const decoded = Buffer.from(value, "base64");
    return decoded.length === 32 ? decoded : null;
  } catch {
    return null;
  }
}

export function getTwoFactorCryptoConfig(): TwoFactorCryptoConfig | null {
  const encryptionKey = decodeSecret(process.env.TOTP_ENCRYPTION_KEY);
  const pepper = decodeSecret(process.env.TOTP_HMAC_PEPPER);
  const keyVersion = Number.parseInt(
    process.env.TOTP_ENCRYPTION_KEY_VERSION ?? "1",
    10
  );
  if (
    !encryptionKey ||
    !pepper ||
    !Number.isSafeInteger(keyVersion) ||
    keyVersion <= 0
  ) {
    return null;
  }
  return { encryptionKey, pepper, keyVersion };
}

function aad(purpose: string, discordUserId: string) {
  return Buffer.from(`cancerculture:${purpose}:v1:${discordUserId}`, "utf8");
}

export function encryptTwoFactorValue(
  plaintext: string,
  purpose: "totp-secret" | "recovery-email",
  discordUserId: string
): EncryptedValue {
  const config = getTwoFactorCryptoConfig();
  if (!config) throw new Error("TWO_FACTOR_CRYPTO_UNAVAILABLE");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", config.encryptionKey, nonce);
  cipher.setAAD(aad(purpose, discordUserId));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return {
    ciphertext: ciphertext.toString("base64url"),
    nonce: nonce.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    keyVersion: config.keyVersion,
  };
}

export function decryptTwoFactorValue(
  encrypted: EncryptedValue,
  purpose: "totp-secret" | "recovery-email",
  discordUserId: string
) {
  const config = getTwoFactorCryptoConfig();
  if (!config) {
    throw new Error("TWO_FACTOR_CRYPTO_UNAVAILABLE");
  }
  const encryptionKey =
    encrypted.keyVersion === config.keyVersion
      ? config.encryptionKey
      : decodeSecret(
          process.env[`TOTP_ENCRYPTION_KEY_V${encrypted.keyVersion}`]
        );
  if (!encryptionKey) throw new Error("TWO_FACTOR_CRYPTO_UNAVAILABLE");
  try {
    const nonce = Buffer.from(encrypted.nonce, "base64url");
    const tag = Buffer.from(encrypted.tag, "base64url");
    if (nonce.length !== 12 || tag.length !== 16) throw new Error("invalid");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey,
      nonce
    );
    decipher.setAAD(aad(purpose, discordUserId));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("TWO_FACTOR_DECRYPTION_FAILED");
  }
}

export function encodeBase32(input: Buffer) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function decodeBase32(value: string) {
  const normalized = value.toUpperCase().replace(/=+$/u, "");
  let bits = 0;
  let buffer = 0;
  const output: number[] = [];
  for (const character of normalized) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) throw new Error("INVALID_BASE32");
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

export function generateTotpSecret() {
  return encodeBase32(randomBytes(20));
}

function hotp(secret: string, counter: bigint) {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(counter);
  const digest = createHmac("sha1", decodeBase32(secret))
    .update(counterBuffer)
    .digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

function normalizeTotpCode(value: string) {
  return value.replace(/[\s-]/gu, "");
}

export function findMatchingTotpStep({
  secret,
  code,
  nowMs = Date.now(),
}: {
  secret: string;
  code: string;
  nowMs?: number;
}) {
  const normalized = normalizeTotpCode(code);
  if (!/^\d{6}$/u.test(normalized)) return null;
  const supplied = Buffer.from(normalized, "ascii");
  const currentStep = Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
  for (const offset of [-1, 0, 1]) {
    const step = currentStep + offset;
    if (step < 0) continue;
    const expected = Buffer.from(hotp(secret, BigInt(step)), "ascii");
    if (timingSafeEqual(supplied, expected)) return step;
  }
  return null;
}

export function buildOtpAuthUri({
  secret,
  accountLabel,
}: {
  secret: string;
  accountLabel: string;
}) {
  const issuer = "CancerCulture";
  const label = `${issuer}:${accountLabel.trim().slice(0, 80) || "Account"}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

export function generateRecoveryCodes() {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const body = encodeBase32(randomBytes(10));
    return `CC-${body.match(/.{1,4}/gu)?.join("-") ?? body}`;
  });
}

function keyedDigest(namespace: string, value: string) {
  const config = getTwoFactorCryptoConfig();
  if (!config) throw new Error("TWO_FACTOR_CRYPTO_UNAVAILABLE");
  return createHmac("sha256", config.pepper)
    .update(`${namespace}:v1\0${value}`, "utf8")
    .digest("hex");
}

export function digestRecoveryCode(value: string) {
  const normalized = value.toUpperCase().replace(/[^A-Z2-7]/gu, "");
  return keyedDigest("recovery-code", normalized);
}

export function generateEmailToken() {
  return randomBytes(32).toString("base64url");
}

export function generateTeamAccessToken() {
  return randomBytes(32).toString("base64url");
}

export function digestTeamAccessToken(value: string) {
  return keyedDigest("team-access-token", value);
}

export function digestTeamAccessContext(value: string) {
  return keyedDigest("team-access-context", value);
}

export function digestEmailToken(value: string) {
  return keyedDigest("email-token", value.replace(/\s/gu, ""));
}

export function generateEmailVerificationCode() {
  return String(randomInt(0, 100_000_000)).padStart(8, "0");
}

export function normalizeEmailVerificationCode(value: string) {
  const normalized = value.replace(/[\s-]/gu, "");
  return /^\d{8}$/u.test(normalized) ? normalized : null;
}

export function digestEmailVerificationCode(value: string) {
  const normalized = normalizeEmailVerificationCode(value);
  if (!normalized) throw new Error("EMAIL_VERIFICATION_CODE_INVALID");
  return keyedDigest("email-token", normalized);
}

export function normalizeRecoveryEmail(value: string) {
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length < 3 ||
    normalized.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized)
  ) {
    throw new Error("RECOVERY_EMAIL_INVALID");
  }
  return normalized;
}

export function fingerprintRecoveryEmail(value: string) {
  return keyedDigest("recovery-email", normalizeRecoveryEmail(value));
}

export function maskRecoveryEmail(value: string) {
  const [local, domain] = normalizeRecoveryEmail(value).split("@");
  const visibleLocal = local.slice(0, Math.min(2, local.length));
  const [domainName, ...suffixParts] = domain.split(".");
  const suffix = suffixParts.join(".");
  return `${visibleLocal}${"*".repeat(Math.max(3, local.length - visibleLocal.length))}@${domainName.slice(0, 1)}***${suffix ? `.${suffix}` : ""}`;
}
