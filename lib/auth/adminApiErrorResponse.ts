import "server-only";

import { getAuthErrorStatus } from "@/lib/auth/AuthError";
import { NextResponse } from "next/server";

export function getAdminApiErrorResponse(
  error: unknown,
  context: string
) {
  const authStatus = getAuthErrorStatus(error);
  const status = authStatus ?? 500;
  const message =
    error instanceof Error
      ? error.message
      : status === 500
        ? "Internal server error"
        : "Admin authorization failed";

  if (status >= 500) {
    console.error(`[ADMIN_AUTH] ${context}`, error);
  }

  return NextResponse.json({ error: message }, { status });
}
