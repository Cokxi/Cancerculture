export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getAdminApiErrorResponse } from "@/lib/auth/adminApiErrorResponse";
import { requireDynamicTeamCapability } from "@/lib/auth/teamAuthorization";
import { startCycleTransactional } from "@/lib/cycles/startCycle";
import { getSponsoredCycleDraftInternal } from "@/lib/cycles/sponsoredCycle";
import { supabaseAdmin } from "@/lib/db/admin";
import {
  DEFAULT_SUBMISSIONS_PER_USER,
  DEFAULT_UPLOAD_SUCCESS_COOLDOWN_SECONDS,
  isValidSubmissionsPerUser,
  isValidUploadSuccessCooldownSeconds,
} from "@/lib/cycles/submissionSettings";

export async function POST(req: Request) {
  try {
    const authorization =
      await requireDynamicTeamCapability("cycles.manage");
    const body = await req.json().catch(() => null);
    const theme = body?.theme;
    const submissionsPerUser =
      body?.submissionsPerUser === undefined
        ? DEFAULT_SUBMISSIONS_PER_USER
        : Number(body.submissionsPerUser);
    const uploadSuccessCooldownSeconds =
      body?.uploadSuccessCooldownSeconds === undefined
        ? DEFAULT_UPLOAD_SUCCESS_COOLDOWN_SECONDS
        : Number(body.uploadSuccessCooldownSeconds);
    const requestedCycleId =
      body?.cycleId === null || body?.cycleId === undefined
        ? null
        : Number(body.cycleId);

    if (
      requestedCycleId !== null &&
      (!Number.isSafeInteger(requestedCycleId) || requestedCycleId <= 0)
    ) {
      return NextResponse.json(
        { error: "Invalid cycle id" },
        { status: 400 }
      );
    }

    if (!isValidSubmissionsPerUser(submissionsPerUser)) {
      return NextResponse.json(
        { error: "Submissions per user must be between 1 and 20" },
        { status: 400 }
      );
    }

    if (
      !isValidUploadSuccessCooldownSeconds(
        uploadSuccessCooldownSeconds
      )
    ) {
      return NextResponse.json(
        { error: "Upload cooldown must be between 30 and 300 seconds" },
        { status: 400 }
      );
    }

    const manualTheme =
      typeof theme === "string" && theme.trim().length > 0
        ? theme.trim()
        : null;

    const { data: nextCycleConfig, error: nextCycleConfigError } =
      await supabaseAdmin
        .from("app_config")
        .select("key, value")
        .in("key", [
          "next_cycle_theme",
          "next_cycle_reward_description",
        ]);

    if (nextCycleConfigError) {
      console.error("[cycle start][next config]", {
        code: nextCycleConfigError.code,
      });
      throw new Error("Failed to load next cycle configuration");
    }

    const nextCycleConfigByKey = Object.fromEntries(
      (nextCycleConfig ?? []).map((row) => [row.key, row.value])
    );
    const storedNextTheme =
      typeof nextCycleConfigByKey.next_cycle_theme === "string" &&
      nextCycleConfigByKey.next_cycle_theme.trim().length > 0
        ? nextCycleConfigByKey.next_cycle_theme.trim()
        : null;
    const rewardDescription =
      typeof nextCycleConfigByKey.next_cycle_reward_description ===
        "string" &&
      nextCycleConfigByKey.next_cycle_reward_description.trim().length >
        0
        ? nextCycleConfigByKey.next_cycle_reward_description.trim()
        : null;
    const sponsoredDraft = await getSponsoredCycleDraftInternal();
    const resolvedTheme = manualTheme ?? storedNextTheme;

    if (
      sponsoredDraft.enabled &&
      (sponsoredDraft.companyName.length === 0 ||
        sponsoredDraft.sponsorLink.length === 0 ||
        sponsoredDraft.detailBannerR2Key.length === 0 ||
        sponsoredDraft.feedBannerR2Key.length === 0)
    ) {
      return NextResponse.json(
        {
          error:
            "Sponsored cycle needs company name, sponsor link, a 2:1 detail banner, and a 6:1 Feed banner before start",
        },
        { status: 400 }
      );
    }

    const result = await startCycleTransactional({
      actorDiscordUserId: authorization.discord_user_id,
      cycleId: requestedCycleId,
      settings: {
        submissionsPerUser,
        uploadSuccessCooldownSeconds,
        theme: resolvedTheme,
        themeSource: manualTheme
          ? "manual"
          : storedNextTheme
            ? "next_cycle_theme"
            : "none",
        rewardDescription,
        sponsored: {
          enabled: sponsoredDraft.enabled,
          companyName: sponsoredDraft.companyName,
          sponsorLink: sponsoredDraft.sponsorLink,
          bannerR2Key: sponsoredDraft.detailBannerR2Key,
          feedBannerR2Key: sponsoredDraft.feedBannerR2Key,
          bannerUrl: null,
        },
      },
    });

    return NextResponse.json({
      success: true,
      cycle: {
        id: result.cycleId,
        publicNumber: result.cycleNumber,
        status: result.status,
        submission_starts_at: result.startedAt,
        reset_count: result.resetCount,
        submissions_per_user: result.submissionsPerUser,
        upload_success_cooldown_seconds:
          result.uploadSuccessCooldownSeconds,
      },
      alreadyStarted: result.alreadyStarted,
      createdCycle: result.createdCycle,
      reusedDraft: result.reusedDraft,
      reusedResetCycle: result.reusedResetDraft,
    });
  } catch (error) {
    return getAdminApiErrorResponse(error, "POST /api/admin/cycles/start");
  }
}
