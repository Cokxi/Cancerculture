"use server";

import { requireDynamicTeamCapability } from "@/lib/auth/teamAuthorization";
import { supabaseAdmin } from "@/lib/db/admin";

export async function unbanUser(params: {
  targetDiscordUserId: string;
  expectedBanVersion: number;
  reason: string;
  idempotencyKey: string;
}) {
  const { targetDiscordUserId, expectedBanVersion, reason, idempotencyKey } =
    params;

  if (!reason?.trim()) {
    throw new Error("Unban reason is required");
  }

  if (!Number.isSafeInteger(expectedBanVersion) || expectedBanVersion < 0) {
    throw new Error("Invalid website ban version");
  }

  const authorization = await requireDynamicTeamCapability(
    "users.website_bans.revoke"
  );
  const { data, error } = await supabaseAdmin.rpc("revoke_website_ban", {
    p_actor_discord_user_id: authorization.discord_user_id,
    p_target_discord_user_id: targetDiscordUserId,
    p_expected_ban_version: expectedBanVersion,
    p_reason: reason.trim(),
    p_idempotency_key: idempotencyKey,
  });

  if (error) throw error;

  return data;
}
