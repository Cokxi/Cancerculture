import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  decryptPushSubscription,
  encryptPushSubscription,
  fingerprintPushEndpoint,
  isPushSubscriptionCryptoConfigured,
} from "../../lib/notifications/pushCrypto.server.ts";

test("Push subscription credentials are encrypted and endpoint fingerprints are keyed", () => {
  const previous = {
    key: process.env.PUSH_SUBSCRIPTION_ENCRYPTION_KEY,
    version: process.env.PUSH_SUBSCRIPTION_ENCRYPTION_KEY_VERSION,
    hmac: process.env.PUSH_ENDPOINT_HMAC_SECRET,
  };
  process.env.PUSH_SUBSCRIPTION_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.PUSH_SUBSCRIPTION_ENCRYPTION_KEY_VERSION = "7";
  process.env.PUSH_ENDPOINT_HMAC_SECRET = randomBytes(32).toString("base64url");
  try {
    assert.equal(isPushSubscriptionCryptoConfigured(), true);
    const plaintext = JSON.stringify({
      endpoint: "https://push.example.invalid/private-token",
      expirationTime: null,
      keys: { p256dh: "private-p256dh", auth: "private-auth" },
    });
    const encrypted = encryptPushSubscription(plaintext);
    assert.equal(encrypted.keyVersion, 7);
    assert.doesNotMatch(JSON.stringify(encrypted), /private-token|private-p256dh|private-auth/u);
    assert.equal(decryptPushSubscription(encrypted), plaintext);
    const first = fingerprintPushEndpoint("https://push.example.invalid/a");
    assert.match(first, /^[a-f0-9]{64}$/u);
    assert.equal(first, fingerprintPushEndpoint("https://push.example.invalid/a"));
    assert.notEqual(first, fingerprintPushEndpoint("https://push.example.invalid/b"));
  } finally {
    if (previous.key === undefined) delete process.env.PUSH_SUBSCRIPTION_ENCRYPTION_KEY;
    else process.env.PUSH_SUBSCRIPTION_ENCRYPTION_KEY = previous.key;
    if (previous.version === undefined) delete process.env.PUSH_SUBSCRIPTION_ENCRYPTION_KEY_VERSION;
    else process.env.PUSH_SUBSCRIPTION_ENCRYPTION_KEY_VERSION = previous.version;
    if (previous.hmac === undefined) delete process.env.PUSH_ENDPOINT_HMAC_SECRET;
    else process.env.PUSH_ENDPOINT_HMAC_SECRET = previous.hmac;
  }
});

test("Push crypto fails closed when independent configuration is absent", () => {
  const previousKey = process.env.PUSH_SUBSCRIPTION_ENCRYPTION_KEY;
  const previousHmac = process.env.PUSH_ENDPOINT_HMAC_SECRET;
  delete process.env.PUSH_SUBSCRIPTION_ENCRYPTION_KEY;
  delete process.env.PUSH_ENDPOINT_HMAC_SECRET;
  try {
    assert.equal(isPushSubscriptionCryptoConfigured(), false);
    assert.throws(() => encryptPushSubscription("{}"), /PUSH_CRYPTO_UNAVAILABLE/u);
    assert.throws(() => fingerprintPushEndpoint("https://push.example.invalid"), /PUSH_CRYPTO_UNAVAILABLE/u);
  } finally {
    if (previousKey !== undefined) process.env.PUSH_SUBSCRIPTION_ENCRYPTION_KEY = previousKey;
    if (previousHmac !== undefined) process.env.PUSH_ENDPOINT_HMAC_SECRET = previousHmac;
  }
});
