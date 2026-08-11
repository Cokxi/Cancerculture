import "server-only";

import { supabaseAdmin } from "@/lib/db/admin";

export type StartCycleSettings = {
  submissionsPerUser: number;
  uploadSuccessCooldownSeconds: number;
  theme: string | null;
  themeSource: "manual" | "next_cycle_theme" | "none";
  rewardDescription: string | null;
  sponsored: {
    enabled: boolean;
    companyName: string;
    sponsorLink: string;
    bannerR2Key: string;
    bannerUrl: string | null;
  };
};

export type StartCycleResult = {
  cycleId: number;
  cycleNumber: number;
  status: "submission_open" | "active";
  startedAt: string | null;
  alreadyStarted: boolean;
  createdCycle: boolean;
  reusedDraft: boolean;
  reusedResetDraft: boolean;
  resetCount: number;
  submissionsPerUser: number;
  uploadSuccessCooldownSeconds: number;
};

const BAD_REQUEST_MESSAGES = new Set([
  "CYCLE_DRAFT_NOT_CLEAN",
  "CYCLE_NOT_STARTABLE",
  "INCOMPLETE_SPONSOR_SETTINGS",
  "INVALID_CYCLE_ID",
  "INVALID_SPONSOR_SETTINGS",
  "INVALID_START_ACTOR",
  "INVALID_START_SETTINGS",
  "INVALID_THEME_SOURCE",
]);

function isStartCycleResult(value: unknown): value is StartCycleResult {
  if (!value || typeof value !== "object") {
    return false;
  }

  const result = value as Record<string, unknown>;

  return (
    typeof result.cycleId === "number" &&
    typeof result.cycleNumber === "number" &&
    (result.status === "submission_open" || result.status === "active") &&
    (typeof result.startedAt === "string" || result.startedAt === null) &&
    typeof result.alreadyStarted === "boolean" &&
    typeof result.createdCycle === "boolean" &&
    typeof result.reusedDraft === "boolean" &&
    typeof result.reusedResetDraft === "boolean" &&
    typeof result.resetCount === "number" &&
    typeof result.submissionsPerUser === "number" &&
    typeof result.uploadSuccessCooldownSeconds === "number"
  );
}

export async function startCycleTransactional({
  actorDiscordUserId,
  cycleId,
  settings,
}: {
  actorDiscordUserId: string;
  cycleId: number | null;
  settings: StartCycleSettings;
}): Promise<StartCycleResult> {
  const { data, error } = await supabaseAdmin.rpc("start_cycle_managed", {
    p_actor_discord_user_id: actorDiscordUserId,
    p_cycle_id: cycleId,
    p_settings: settings,
  });

  if (error) {
    const badRequest = Array.from(BAD_REQUEST_MESSAGES).find(
      (message) => error.message.includes(message)
    );

    if (badRequest) {
      throw Object.assign(new Error(badRequest), { status: 400 });
    }

    if (error.message.includes("CYCLE_NOT_FOUND")) {
      throw Object.assign(new Error("Cycle not found"), {
        status: 404,
      });
    }

    if (error.message.includes("CURRENT_CYCLE_EXISTS")) {
      throw Object.assign(
        new Error("There is already an unfinished cycle"),
        { status: 409 }
      );
    }

    console.error("[cycle start][rpc]", { code: error.code });
    throw Object.assign(new Error("Cycle start failed"), {
      status: 503,
    });
  }

  if (!isStartCycleResult(data)) {
    console.error("[cycle start][invalid response]");
    throw new Error("Cycle start returned an invalid response");
  }

  return data;
}
