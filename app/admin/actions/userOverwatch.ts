"use server";

import {
  addUserToOverwatch,
  prepareUserOverwatchTarget,
  removeUserFromOverwatch,
  UserOverwatchConflict,
} from "@/lib/overwatch/userOverwatch.server";

function conflictMessage(error: UserOverwatchConflict) {
  return error.reason === "target_mismatch"
    ? "The selected user or Overwatch generation is no longer available."
    : error.reason === "idempotency_conflict"
      ? "This request UUID was already used for different Overwatch data. No change was made."
      : "Overwatch changed before this request completed. Refresh and try again.";
}

export async function prepareAddToOverwatch(targetDiscordUserId: string) {
  try {
    return {
      success: true as const,
      target: await prepareUserOverwatchTarget(targetDiscordUserId),
    };
  } catch (error) {
    if (error instanceof UserOverwatchConflict) {
      return {
        success: false as const,
        stale: true as const,
        message: conflictMessage(error),
      };
    }
    throw error;
  }
}

export async function addToOverwatch(params: {
  targetDiscordUserId: string;
  expectedState: "absent" | "removed";
  expectedRowVersion: number;
  reason: string;
  requestId: string;
}) {
  try {
    const receipt = await addUserToOverwatch(params);
    return { success: true as const, receipt };
  } catch (error) {
    if (error instanceof UserOverwatchConflict) {
      return {
        success: false as const,
        stale: true as const,
        message: conflictMessage(error),
      };
    }
    throw error;
  }
}

export async function removeFromOverwatch(params: {
  targetDiscordUserId: string;
  entryId: string;
  expectedRowVersion: number;
  reason: string;
  requestId: string;
}) {
  try {
    const receipt = await removeUserFromOverwatch(params);
    return { success: true as const, receipt };
  } catch (error) {
    if (error instanceof UserOverwatchConflict) {
      return {
        success: false as const,
        stale: true as const,
        message: conflictMessage(error),
      };
    }
    throw error;
  }
}
