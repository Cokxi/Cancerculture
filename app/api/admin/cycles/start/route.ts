export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getAdminApiErrorResponse } from "@/lib/auth/adminApiErrorResponse";
import { requireDynamicTeamCapability } from "@/lib/auth/teamAuthorization";
import { startCycleTransactional } from "@/lib/cycles/startCycle";
import { getSponsoredCycleDraft } from "@/lib/cycles/sponsoredCycle";
import { supabaseAdmin } from "@/lib/db/admin";

export async function POST(req: Request) {
  try {
    const authorization =
      await requireDynamicTeamCapability("cycles.manage");
    const body = await req.json().catch(() => null);
    const theme = body?.theme;
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
    const sponsoredDraft = await getSponsoredCycleDraft();
    const resolvedTheme = manualTheme ?? storedNextTheme;

    if (
      sponsoredDraft.enabled &&
      (sponsoredDraft.companyName.length === 0 ||
        sponsoredDraft.sponsorLink.length === 0 ||
        sponsoredDraft.bannerR2Key.length === 0)
    ) {
      return NextResponse.json(
        {
          error:
            "Sponsored cycle needs company name, sponsor link, and banner before start",
        },
        { status: 400 }
      );
    }

    const result = await startCycleTransactional({
      actorDiscordUserId: authorization.discord_user_id,
      cycleId: requestedCycleId,
      settings: {
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
          bannerR2Key: sponsoredDraft.bannerR2Key,
          bannerUrl: sponsoredDraft.bannerUrl,
        },
      },
    });

    return NextResponse.json({
      success: true,
      cycle: {
        id: result.cycleId,
        status: result.status,
        submission_starts_at: result.startedAt,
        reset_count: result.resetCount,
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
