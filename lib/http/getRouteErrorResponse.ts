import { NextResponse } from "next/server";
import {
  getAuthErrorCode,
  getAuthErrorStatus,
} from "@/lib/auth/AuthError";

export function getRouteErrorResponse(error: unknown) {
  const authStatus = getAuthErrorStatus(error);
  const status = authStatus ?? 500;
  const authCode = getAuthErrorCode(error);
  const message = authCode
    ? authCode.split(":")[0]
    : status >= 500
      ? "INTERNAL_ERROR"
      : error instanceof Error
        ? error.message
        : "Forbidden";

  return NextResponse.json({ error: message }, { status });
}
