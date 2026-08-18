import "server-only";

import { AuthError } from "@/lib/auth/AuthError";
import { supabaseAdmin } from "@/lib/db/admin";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

async function rpc(functionName: string, parameters: object) {
  const { data, error } = await supabaseAdmin.rpc(functionName, parameters);
  if (error) {
    console.error("[NOTIFICATIONS] settings RPC failed", { functionName, code: error.code });
    throw new AuthError(503, "Notification settings unavailable", "NOTIFICATION_SETTINGS_UNAVAILABLE");
  }
  return record(data);
}

export function loadNotificationSettings(sessionId: string) {
  return rpc("get_own_notification_settings", { p_session_id: sessionId });
}

export function setNotificationPreference(
  sessionId: string,
  categoryKey: string,
  inProductEnabled: boolean
) {
  if (!/^[a-z][a-z0-9_]{2,63}$/u.test(categoryKey)) {
    throw new AuthError(400, "Invalid notification category", "NOTIFICATION_CATEGORY_INVALID");
  }
  return rpc("set_own_notification_preference", {
    p_session_id: sessionId,
    p_category_key: categoryKey,
    p_in_product_enabled: inProductEnabled,
  });
}
