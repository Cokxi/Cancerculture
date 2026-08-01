"use server";

import {
  createUserFlagCase,
  getUserFlagActiveStatus,
  UserFlagDatabaseError,
} from "@/lib/admin/userFlagCases";

export async function flagUser(params: {
  targetDiscordUserId: string;
  category: "trolling_low_effort" | "suspicious_behavior" | "other";
  reason: string;
  comment?: string;
  idempotencyKey: string;
}) {
  try {
    const result = await createUserFlagCase(params);
    return {
      success: true as const,
      caseId: result.caseId,
      status: result.status,
    };
  } catch (error) {
    if (
      error instanceof UserFlagDatabaseError &&
      error.databaseCode === "PT409"
    ) {
      return {
        success: false as const,
        conflict: true as const,
        message:
          "This user already has an active flag case. No case details were disclosed.",
      };
    }

    throw error;
  }
}

export async function checkUserFlagStatus(targetDiscordUserId: string) {
  return getUserFlagActiveStatus(targetDiscordUserId);
}
