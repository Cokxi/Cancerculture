export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import {
  getValidatedApplicationOrigin,
  sanitizeInternalReturnPath,
} from "@/lib/auth/oauth/safeReturnPath";
import {
  createOAuthState,
  OAUTH_STATE_MAX_AGE_SECONDS,
} from "@/lib/auth/oauth/state";
import { enforceRouteMutationGate } from "@/lib/writeGate.server";

export async function GET(req: Request) {
  const gateResponse = enforceRouteMutationGate();
  if (gateResponse) return gateResponse;

  try {
    const clientId = process.env.DISCORD_CLIENT_ID?.trim();
    const redirectUri = process.env.DISCORD_REDIRECT_URI?.trim();

    if (!clientId || !redirectUri) {
      throw new Error("Discord OAuth configuration is incomplete");
    }

    const applicationOrigin = getValidatedApplicationOrigin(
      process.env.NEXT_PUBLIC_BASE_URL
    );
    const { searchParams } = new URL(req.url);
    const redirectPath = sanitizeInternalReturnPath(
      searchParams.get("state"),
      applicationOrigin
    );
    const oauthState = createOAuthState();
    const discordAuthUrl = new URL(
      "https://discord.com/api/oauth2/authorize"
    );

    discordAuthUrl.searchParams.set("client_id", clientId);
    discordAuthUrl.searchParams.set("response_type", "code");
    discordAuthUrl.searchParams.set("redirect_uri", redirectUri);
    discordAuthUrl.searchParams.set("scope", "identify");
    discordAuthUrl.searchParams.set("prompt", "consent");
    discordAuthUrl.searchParams.set("state", oauthState);

    const response = NextResponse.redirect(discordAuthUrl);
    response.headers.set("Cache-Control", "no-store");
    const cookieOptions = {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax" as const,
      path: "/",
      maxAge: OAUTH_STATE_MAX_AGE_SECONDS,
    };

    response.cookies.set("oauth_state", oauthState, cookieOptions);
    response.cookies.set(
      "oauth_redirect_path",
      redirectPath,
      cookieOptions
    );

    return response;
  } catch (error) {
    console.error("[AUTH_OAUTH] login_configuration", error);
    return NextResponse.json(
      { error: "Authentication is temporarily unavailable" },
      { status: 500 }
    );
  }
}
