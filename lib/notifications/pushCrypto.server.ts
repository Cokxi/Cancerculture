import "server-only";

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

export type EncryptedPushSubscription = Readonly<{
  ciphertext: string;
  nonce: string;
  tag: string;
  keyVersion: number;
}>;

function decodeKey(value: string | undefined) {
  if (!value) return null;
  try {
    const key = Buffer.from(value, "base64");
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

function currentConfig() {
  const encryptionKey = decodeKey(process.env.PUSH_SUBSCRIPTION_ENCRYPTION_KEY);
  const hmacSecret = process.env.PUSH_ENDPOINT_HMAC_SECRET?.trim();
  const keyVersion = Number.parseInt(
    process.env.PUSH_SUBSCRIPTION_ENCRYPTION_KEY_VERSION ?? "1",
    10
  );
  if (
    !encryptionKey ||
    !hmacSecret ||
    hmacSecret.length < 32 ||
    !Number.isSafeInteger(keyVersion) ||
    keyVersion < 1
  ) {
    return null;
  }
  return { encryptionKey, hmacSecret, keyVersion };
}

function aad(keyVersion: number) {
  return Buffer.from(`cancerculture:push-subscription:v1:${keyVersion}`, "utf8");
}

export function isPushSubscriptionCryptoConfigured() {
  return currentConfig() !== null;
}

export function fingerprintPushEndpoint(endpoint: string) {
  const config = currentConfig();
  if (!config) throw new Error("PUSH_CRYPTO_UNAVAILABLE");
  return createHmac("sha256", config.hmacSecret)
    .update(`push-endpoint:v1\0${endpoint}`, "utf8")
    .digest("hex");
}

export function encryptPushSubscription(plaintext: string): EncryptedPushSubscription {
  const config = currentConfig();
  if (!config) throw new Error("PUSH_CRYPTO_UNAVAILABLE");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", config.encryptionKey, nonce);
  cipher.setAAD(aad(config.keyVersion));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64url"),
    nonce: nonce.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    keyVersion: config.keyVersion,
  };
}

export function decryptPushSubscription(encrypted: EncryptedPushSubscription) {
  const config = currentConfig();
  if (!config) throw new Error("PUSH_CRYPTO_UNAVAILABLE");
  const key = encrypted.keyVersion === config.keyVersion
    ? config.encryptionKey
    : decodeKey(process.env[`PUSH_SUBSCRIPTION_ENCRYPTION_KEY_V${encrypted.keyVersion}`]);
  if (!key) throw new Error("PUSH_CRYPTO_UNAVAILABLE");
  try {
    const nonce = Buffer.from(encrypted.nonce, "base64url");
    const tag = Buffer.from(encrypted.tag, "base64url");
    if (nonce.length !== 12 || tag.length !== 16) throw new Error("invalid");
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(aad(encrypted.keyVersion));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("PUSH_SUBSCRIPTION_DECRYPTION_FAILED");
  }
}
