"use server";

import {
  overruleTeamUserWarning,
  UserWarningCorrectionConflict,
} from "@/lib/warnings/userWarningVisibility.server";

export async function overruleUserWarning(params: {
  targetDiscordUserId: string;
  publicWarningId: string;
  expectedRowVersion: number;
  reason: string;
  requestId: string;
}) {
  try {
    const result = await overruleTeamUserWarning(params);
    return {
      success: true as const,
      state: result.state,
      rowVersion: result.rowVersion,
      replayed: result.replayed,
    };
  } catch (error) {
    if (error instanceof UserWarningCorrectionConflict) {
      return {
        success: false as const,
        stale: true as const,
        message: error.reason === "target_mismatch"
          ? "This Warning no longer belongs to the selected user. No correction was made."
          : "This Warning was already updated. Refresh the history before trying again.",
      };
    }
    throw error;
  }
}
