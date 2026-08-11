import "server-only";

import { getCurrentSubmissionCycle } from "@/lib/cycles/currentCycle";
import { supabaseAdmin } from "@/lib/db/admin";
import {
  getDiscordMembershipEligibility,
  type DiscordMembershipEligibility,
} from "@/lib/eligibility/discordMembership";

type UploadEligibilityOptions = {
  discordUserId: string;
  includeDiscordMembership?: boolean;
};

export type DiscordMembershipStatus = DiscordMembershipEligibility;

export type SubmissionUploadQuota = {
  used: number;
  limit: number;
  remaining: number;
  cooldownSeconds: number;
  cooldownRemainingSeconds: number;
  nextUploadAllowedAt: string | null;
};

export type UploadEligibility = {
  isBanned: boolean;
  banReason: string | null;
  activeCycleId: number | null;
  quota: SubmissionUploadQuota | null;
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
  let quota: SubmissionUploadQuota | null = null;
  let isUploadBlocked = false;

  if (activeCycle?.id) {
    const [quotaResult, abuseResult] = await Promise.all([
      supabaseAdmin.rpc("get_submission_upload_quota", {
        p_cycle_id: activeCycle.id,
        p_discord_user_id: discordUserId,
      }),
      supabaseAdmin
        .from("submission_upload_abuse_states")
        .select("blocked_at")
        .eq("cycle_id", activeCycle.id)
        .eq("discord_user_id", discordUserId)
        .maybeSingle(),
    ]);

    if (quotaResult.error || abuseResult.error) {
      console.error("[upload eligibility][quota]", {
        abuseCode: abuseResult.error?.code ?? null,
        quotaCode: quotaResult.error?.code ?? null,
      });
      throw new UploadEligibilityDependencyError();
    }

    const quotaData = quotaResult.data as Record<string, unknown> | null;
    if (
      !quotaData ||
      quotaData.outcome !== "status" ||
      typeof quotaData.used !== "number" ||
      typeof quotaData.limit !== "number" ||
      typeof quotaData.remaining !== "number" ||
      typeof quotaData.cooldownSeconds !== "number" ||
      typeof quotaData.cooldownRemainingSeconds !== "number" ||
      !(
        typeof quotaData.nextUploadAllowedAt === "string" ||
        quotaData.nextUploadAllowedAt === null
      )
    ) {
      console.error("[upload eligibility][quota response]", {
        outcome:
          typeof quotaData?.outcome === "string"
            ? quotaData.outcome
            : "INVALID",
      });
      throw new UploadEligibilityDependencyError();
    }

    quota = {
      used: quotaData.used,
      limit: quotaData.limit,
      remaining: quotaData.remaining,
      cooldownSeconds: quotaData.cooldownSeconds,
      cooldownRemainingSeconds: quotaData.cooldownRemainingSeconds,
      nextUploadAllowedAt: quotaData.nextUploadAllowedAt,
    };
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

    membership = discordMembership;
  }

  return {
    isBanned: userLog?.is_banned === true,
    banReason: userLog?.ban_reason ?? null,
    activeCycleId: activeCycle?.id ?? null,
    quota,
    isUploadBlocked,
    hasAcceptedRules:
      userLog?.accepted_rules_version === currentRules?.current_version,
    membership,
  };
}
