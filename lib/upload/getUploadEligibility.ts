import "server-only";

import { getCurrentSubmissionCycle } from "@/lib/cycles/currentCycle";
import { supabaseAdmin } from "@/lib/db/admin";
import { getDiscordMembershipEligibility } from "@/lib/eligibility/discordMembership";

type UploadEligibilityOptions = {
  discordUserId: string;
  includeDiscordMembership?: boolean;
};

export type DiscordMembershipStatus = {
  isMember: boolean;
  joinedAt: string | null;
  joinedTooRecently: boolean;
};

export type UploadEligibility = {
  isBanned: boolean;
  banReason: string | null;
  activeCycleId: number | null;
  alreadyUploaded: boolean;
  isUploadBlocked: boolean;
  hasAcceptedRules: boolean;
  membership: DiscordMembershipStatus | null;
};

export class UploadEligibilityDependencyError extends Error {
  constructor() {
    super("Upload eligibility dependency unavailable");
    this.name = "UploadEligibilityDependencyError";
  }
}

export async function getUploadEligibility({
  discordUserId,
  includeDiscordMembership = false,
}: UploadEligibilityOptions): Promise<UploadEligibility> {
  const { data: userLog, error: userLogError } = await supabaseAdmin
    .from("user_logs")
    .select("is_banned, ban_reason, accepted_rules_version")
    .eq("discord_user_id", discordUserId)
    .maybeSingle();

  const { data: currentRules, error: rulesError } = await supabaseAdmin
    .from("rules_meta")
    .select("current_version")
    .eq("id", 1)
    .single();

  if (userLogError || rulesError || !currentRules) {
    console.error("[upload eligibility][dependency]", {
      rules: rulesError?.code ?? (!currentRules ? "MISSING" : null),
      user: userLogError?.code ?? null,
    });
    throw new UploadEligibilityDependencyError();
  }

  let activeCycle;

  try {
    activeCycle = await getCurrentSubmissionCycle({
      throwOnError: true,
    });
  } catch {
    throw new UploadEligibilityDependencyError();
  }
  let alreadyUploaded = false;
  let isUploadBlocked = false;

  if (activeCycle?.id) {
    const [existingResult, abuseResult] = await Promise.all([
      supabaseAdmin
        .from("submissions")
        .select("id")
        .eq("cycle_id", activeCycle.id)
        .eq("discord_user_id", discordUserId)
        .maybeSingle(),
      supabaseAdmin
        .from("submission_upload_abuse_states")
        .select("blocked_at")
        .eq("cycle_id", activeCycle.id)
        .eq("discord_user_id", discordUserId)
        .maybeSingle(),
    ]);

    if (existingResult.error || abuseResult.error) {
      console.error("[upload eligibility][existing submission]", {
        abuseCode: abuseResult.error?.code ?? null,
        submissionCode: existingResult.error?.code ?? null,
      });
      throw new UploadEligibilityDependencyError();
    }

    alreadyUploaded = Boolean(existingResult.data);
    isUploadBlocked = Boolean(abuseResult.data?.blocked_at);
  }

  let membership: DiscordMembershipStatus | null = null;

  if (includeDiscordMembership) {
    let discordMembership;

    try {
      discordMembership =
        await getDiscordMembershipEligibility(discordUserId);
    } catch {
      throw new UploadEligibilityDependencyError();
    }

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
    isUploadBlocked,
    hasAcceptedRules:
      userLog?.accepted_rules_version === currentRules?.current_version,
    membership,
  };
}
