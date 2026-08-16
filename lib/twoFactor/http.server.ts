import "server-only";

import { NextResponse } from "next/server";
import { AuthError } from "@/lib/auth/AuthError";
import { TwoFactorError } from "@/lib/twoFactor/service.server";

export const TWO_FACTOR_RESPONSE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
};

export function twoFactorJson(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: TWO_FACTOR_RESPONSE_HEADERS,
  });
}
export function assertTwoFactorMutationRequest(request: Request) {
  const origin = request.headers.get("origin");
  const requestOrigin = new URL(request.url).origin;
  const contentType = request.headers.get("content-type")?.split(";", 1)[0];
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (!origin || origin !== requestOrigin) {
    throw new TwoFactorError(403, "REQUEST_ORIGIN_INVALID", "Invalid request origin");
  }
  if (contentType !== "application/json") {
    throw new TwoFactorError(415, "JSON_REQUIRED", "JSON request required");
  }
  if (Number.isFinite(contentLength) && contentLength > 16_384) {
    throw new TwoFactorError(413, "REQUEST_TOO_LARGE", "Request too large");
  }
}

export async function readTwoFactorJson(request: Request) {
  assertTwoFactorMutationRequest(request);
  return request.json().catch(() => {
    throw new TwoFactorError(400, "JSON_INVALID", "Invalid JSON request");
  });
}

export function twoFactorErrorResponse(error: unknown) {
  if (error instanceof TwoFactorError) {
    return twoFactorJson(
      {
        error: error.code,
        ...(error.retryAt ? { retryAt: error.retryAt } : {}),
      },
      error.status
    );
  }
  if (error instanceof AuthError) {
    return twoFactorJson({ error: error.code }, error.status);
  }
  console.error("[2FA] request failed", { code: "UNEXPECTED_ERROR" });
  return twoFactorJson({ error: "TWO_FACTOR_UNAVAILABLE" }, 503);
}
