export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { readTeamAuthorizationContextForDiscordUserId } from "@/lib/auth/teamAuthorization";
import {
  grantTeamAreaAccess,
  TEAM_ACCESS_COOKIE,
  TEAM_ACCESS_MAX_AGE_SECONDS,
  TeamAccessError,
} from "@/lib/auth/teamAccess.server";
import { requireSession } from "@/lib/auth/requireSession";
import { AuthError } from "@/lib/auth/AuthError";
import { enforceRouteMutationGate } from "@/lib/writeGate.server";

const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const RESPONSE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
};

function errorResponse(error: unknown) {
  if (error instanceof TeamAccessError) {
    return NextResponse.json(
      {
        error: error.code,
        ...(error.retryAt ? { retryAt: error.retryAt } : {}),
      },
      { status: error.status, headers: RESPONSE_HEADERS }
    );
  }
  if (error instanceof AuthError) {
    return NextResponse.json(
      { error: error.code },
      { status: error.status, headers: RESPONSE_HEADERS }
    );
  }
  console.error("[TEAM_ACCESS] request failed", { code: "UNEXPECTED_ERROR" });
  return NextResponse.json(
    { error: "TEAM_ACCESS_UNAVAILABLE" },
    { status: 503, headers: RESPONSE_HEADERS }
  );
}

export async function POST(request: Request) {
  const gate = enforceRouteMutationGate();
  if (gate) return gate;

  try {
    const origin = request.headers.get("origin");
    if (!origin || origin !== new URL(request.url).origin) {
      throw new TeamAccessError(403, "REQUEST_ORIGIN_INVALID", "Invalid origin");
    }
    if (request.headers.get("content-type")?.split(";", 1)[0] !== "application/json") {
      throw new TeamAccessError(415, "JSON_REQUIRED", "JSON request required");
    }
    const body = await request.json().catch(() => null);
    if (
      !body ||
      typeof body !== "object" ||
      typeof body.code !== "string" ||
      !/^\d{6}$/u.test(body.code.replace(/[\s-]/gu, ""))
    ) {
      throw new TeamAccessError(400, "TWO_FACTOR_CODE_INVALID", "Invalid code");
    }

    const session = await requireSession();
    await readTeamAuthorizationContextForDiscordUserId(session.discord_user_id);
    const grant = await grantTeamAreaAccess({
      session,
      code: body.code,
      requestHeaders: request.headers,
    });
    const response = NextResponse.json(
      { granted: true, expiresAt: grant.expiresAt },
      { headers: RESPONSE_HEADERS }
    );
    response.cookies.set("session_id", grant.sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_MAX_AGE_SECONDS,
    });
    response.cookies.set(TEAM_ACCESS_COOKIE, grant.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: TEAM_ACCESS_MAX_AGE_SECONDS,
    });
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
