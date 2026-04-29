import { getActiveCycle } from "@/lib/cycles/getActiveCycle";
import { supabaseAdmin } from "@/lib/db/admin";
import { getDiscordMembershipEligibility } from "@/lib/eligibility/discordMembership";

type UploadEligibilityOptions = {
  discordUserId: string;
  includeDiscordMembership?: boolean;
};

type DiscordMembershipStatus = {
  isMember: boolean;
  joinedAt: string | null;
  joinedTooRecently: boolean;
};

export type UploadEligibility = {
  isBanned: boolean;
  banReason: string | null;
  activeCycleId: number | null;
  alreadyUploaded: boolean;
  uploadLimitBypassed: boolean;
  hasAcceptedRules: boolean;
  isRateLimited: boolean;
  membership: DiscordMembershipStatus | null;
};

function isUploadLimitBypassedForUser(discordUserId: string) {
  const allowList =
    process.env.UPLOAD_LIMIT_BYPASS_DISCORD_IDS ?? "";

  if (!allowList.trim()) {
    return false;
  }

  return allowList
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .includes(discordUserId);
}

export async function getUploadEligibility({
  discordUserId,
  includeDiscordMembership = false,
}: UploadEligibilityOptions): Promise<UploadEligibility> {
  const { data: userLog } = await supabaseAdmin
    .from("user_logs")
    .select("is_banned, ban_reason, accepted_rules_version, upload_fail_count")
    .eq("discord_user_id", discordUserId)
    .maybeSingle();

  const { data: currentRules } = await supabaseAdmin
    .from("rules_meta")
    .select("current_version")
    .eq("id", 1)
    .single();

  const activeCycle = await getActiveCycle();
  const uploadLimitBypassed =
    isUploadLimitBypassedForUser(discordUserId);

  let alreadyUploaded = false;

  if (activeCycle?.id && !uploadLimitBypassed) {
    const { data: existingSubmission } = await supabaseAdmin
      .from("submissions")
      .select("id")
      .eq("cycle_id", activeCycle.id)
      .eq("discord_user_id", discordUserId)
      .maybeSingle();

    alreadyUploaded = Boolean(existingSubmission);
  }

  let membership: DiscordMembershipStatus | null = null;

  if (includeDiscordMembership) {
    const discordMembership =
      await getDiscordMembershipEligibility(discordUserId);

    membership = {
      isMember: discordMembership.isInDiscord,
      joinedAt: discordMembership.joinedAt,
      joinedTooRecently: discordMembership.joinedTooRecently,
    };
  }

  return {
    isBanned: userLog?.is_banned === true,
    banReason: userLog?.ban_reason ?? null,
    activeCycleId: activeCycle?.id ?? null,
    alreadyUploaded,
    uploadLimitBypassed,
    hasAcceptedRules:
      userLog?.accepted_rules_version === currentRules?.current_version,
    isRateLimited: (userLog?.upload_fail_count ?? 0) >= 5,
    membership,
  };
}
