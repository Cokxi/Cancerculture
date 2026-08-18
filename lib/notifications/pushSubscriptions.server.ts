import "server-only";

import { AuthError } from "@/lib/auth/AuthError";
import { supabaseAdmin } from "@/lib/db/admin";
import {
  encryptPushSubscription,
  fingerprintPushEndpoint,
  isPushSubscriptionCryptoConfigured,
} from "@/lib/notifications/pushCrypto.server";

export const PUSH_DEVICE_COOKIE = "push_device_id";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CATEGORY_PATTERN = /^[a-z][a-z0-9_]{2,63}$/u;

type BrowserSubscription = Readonly<{
  endpoint: string;
  expirationTime: number | null;
  keys: Readonly<{ p256dh: string; auth: string }>;
}>;

function valueRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function parseBrowserSubscription(value: unknown): BrowserSubscription {
  const candidate = valueRecord(value);
  const keys = valueRecord(candidate.keys);
  if (
    typeof candidate.endpoint !== "string" ||
    candidate.endpoint.length > 2048 ||
    !/^https:\/\//u.test(candidate.endpoint) ||
    (candidate.expirationTime !== null && typeof candidate.expirationTime !== "number") ||
    typeof keys.p256dh !== "string" ||
    !/^[A-Za-z0-9_-]{20,512}$/u.test(keys.p256dh) ||
    typeof keys.auth !== "string" ||
    !/^[A-Za-z0-9_-]{8,256}$/u.test(keys.auth)
  ) {
    throw new AuthError(400, "Invalid push subscription", "PUSH_SUBSCRIPTION_INVALID");
  }
  return Object.freeze({
    endpoint: candidate.endpoint,
    expirationTime: candidate.expirationTime as number | null,
    keys: Object.freeze({ p256dh: keys.p256dh, auth: keys.auth }),
  });
}

async function rpc(functionName: string, parameters: object) {
  const { data, error } = await supabaseAdmin.rpc(functionName, parameters);
  if (error) {
    console.error("[PUSH] subscription RPC failed", { functionName, code: error.code });
    throw new AuthError(503, "Push settings unavailable", "PUSH_SETTINGS_UNAVAILABLE");
  }
  return valueRecord(data);
}

export function isPushDeviceId(value: string | null | undefined): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function getVapidPublicConfiguration() {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim() ?? "";
  const available = isPushSubscriptionCryptoConfigured()
    && /^[A-Za-z0-9_-]{40,256}$/u.test(publicKey);
  return { available, publicKey: available ? publicKey : null } as const;
}

export async function registerPushSubscription({
  sessionId,
  deviceId,
  subscription,
}: {
  sessionId: string;
  deviceId: string;
  subscription: unknown;
}) {
  if (!isPushDeviceId(deviceId)) throw new AuthError(400, "Invalid device", "PUSH_DEVICE_INVALID");
  const parsed = parseBrowserSubscription(subscription);
  let encrypted;
  let fingerprint;
  try {
    encrypted = encryptPushSubscription(JSON.stringify(parsed));
    fingerprint = fingerprintPushEndpoint(parsed.endpoint);
  } catch {
    throw new AuthError(503, "Push settings unavailable", "PUSH_CONFIGURATION_UNAVAILABLE");
  }
  return rpc("upsert_own_push_subscription", {
    p_session_id: sessionId,
    p_device_id: deviceId,
    p_endpoint_fingerprint: fingerprint,
    p_subscription_ciphertext: encrypted.ciphertext,
    p_subscription_nonce: encrypted.nonce,
    p_subscription_tag: encrypted.tag,
    p_key_version: encrypted.keyVersion,
  });
}

export async function loadPushSubscriptionSettings(sessionId: string, deviceId: string) {
  if (!isPushDeviceId(deviceId)) return { active: false, categories: [] };
  return rpc("get_own_push_subscription_settings", {
    p_session_id: sessionId,
    p_device_id: deviceId,
  });
}

export async function setPushSubscriptionPreference({
  sessionId,
  deviceId,
  categoryKey,
  enabled,
}: {
  sessionId: string;
  deviceId: string;
  categoryKey: string;
  enabled: boolean;
}) {
  if (!isPushDeviceId(deviceId) || !CATEGORY_PATTERN.test(categoryKey)) {
    throw new AuthError(400, "Invalid push preference", "PUSH_PREFERENCE_INVALID");
  }
  return rpc("set_own_push_subscription_preference", {
    p_session_id: sessionId,
    p_device_id: deviceId,
    p_category_key: categoryKey,
    p_enabled: enabled,
  });
}

export async function deactivatePushSubscription(
  sessionId: string,
  deviceId: string
) {
  if (!isPushDeviceId(deviceId)) return { outcome: "deactivated", count: 0 };
  return rpc("deactivate_own_push_subscription", {
    p_session_id: sessionId,
    p_device_id: deviceId,
  });
}
