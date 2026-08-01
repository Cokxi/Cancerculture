"use server";

import { requireDynamicTeamCapability } from "@/lib/auth/teamAuthorization";
import { supabaseAdmin } from "@/lib/db/admin";

export async function banUser(params: {
  targetDiscordUserId: string;
  expectedBanVersion: number;
  reason: string;
  source?: "illegal_submission" | "admin_manual";
  idempotencyKey: string;
}) {
  const {
    targetDiscordUserId,
    expectedBanVersion,
    reason,
    source,
    idempotencyKey,
  } = params;

  if (!reason?.trim()) {
    throw new Error("Ban reason is required");
  }

  if (!Number.isSafeInteger(expectedBanVersion) || expectedBanVersion < 0) {
    throw new Error("Invalid website ban version");
  }

  const authorization = await requireDynamicTeamCapability(
    "users.website_bans.create"
  );
  const { data, error } = await supabaseAdmin.rpc("ban_website_user_v2", {
    p_actor_discord_user_id: authorization.discord_user_id,
    p_target_discord_user_id: targetDiscordUserId,
    p_expected_ban_version: expectedBanVersion,
    p_reason: reason.trim(),
    p_source: source ?? "admin_manual",
    p_idempotency_key: idempotencyKey,
  });

  if (error) throw error;

  return data;
}
