export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  getValidatedApplicationOrigin,
  sanitizeInternalReturnPath,
} from "@/lib/auth/oauth/safeReturnPath";
import { runAuthQueryWithTimeout } from "@/lib/auth/authQuery";
import { supabaseAdmin } from "@/lib/db/admin";
import { enforceRouteMutationGate } from "@/lib/writeGate.server";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function expireCookie(response: NextResponse, name: string) {
  response.cookies.set(name, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

export async function POST(req: Request) {
  const gateResponse = enforceRouteMutationGate();
  if (gateResponse) return gateResponse;

  let applicationOrigin: URL;

  try {
    applicationOrigin = getValidatedApplicationOrigin(
      process.env.NEXT_PUBLIC_BASE_URL
    );
  } catch {
    return NextResponse.json(
      { error: "AUTHENTICATION_UNAVAILABLE" },
      { status: 503 }
    );
  }

  const requestOrigin = req.headers.get("origin");
  if (requestOrigin && requestOrigin !== applicationOrigin.origin) {
    return NextResponse.json({ error: "INVALID_ORIGIN" }, { status: 403 });
  }

  const requestUrl = new URL(req.url);
  const returnPath = sanitizeInternalReturnPath(
    requestUrl.searchParams.get("returnTo"),
    applicationOrigin
  );
  const cookieStore = await cookies();
  const sessionId = cookieStore.get("session_id")?.value;

  if (sessionId && UUID_PATTERN.test(sessionId)) {
    const { error } = await runAuthQueryWithTimeout(
      "logout session revocation",
      supabaseAdmin
        .from("sessions")
        .update({ revoked_at: new Date().toISOString() })
        .eq("id", sessionId)
        .is("revoked_at", null)
    );

    if (error) {
      console.error("[AUTH] logout session revocation failed", {
        code: error.code,
      });
      return NextResponse.json(
        { error: "AUTHENTICATION_UNAVAILABLE" },
        { status: 503 }
      );
    }
  }

  const response = NextResponse.redirect(
    new URL(returnPath, applicationOrigin),
    303
  );
  response.headers.set("Cache-Control", "no-store");
  expireCookie(response, "session_id");
  expireCookie(response, "team_access");
  expireCookie(response, "discord_user_id");
  expireCookie(response, "oauth_state");
  expireCookie(response, "oauth_redirect_path");
  return response;
}
