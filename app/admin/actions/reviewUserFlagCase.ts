"use server";

import {
  reviewUserFlagCase as reviewCase,
  UserFlagDatabaseError,
} from "@/lib/admin/userFlagCases";

export async function reviewUserFlagCase(params: {
  caseId: string;
  expectedRowVersion: number;
  status: "resolved" | "dismissed";
  reviewReason: string;
  idempotencyKey: string;
}) {
  try {
    const result = await reviewCase(params);
    return {
      success: true as const,
      status: result.status,
      rowVersion: result.rowVersion,
    };
  } catch (error) {
    if (
      error instanceof UserFlagDatabaseError &&
      error.databaseCode === "PT409"
    ) {
      return {
        success: false as const,
        stale: true as const,
        message:
          "This flag case was already updated. The view will now be refreshed.",
      };
    }

    throw error;
  }
}
