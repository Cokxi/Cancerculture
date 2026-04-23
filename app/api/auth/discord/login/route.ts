import { NextResponse } from "next/server";
import { randomUUID } from "crypto";

function sanitizeState(state: string | null): string {
  if (!state) return "/upload";
  if (!state.startsWith("/")) return "/upload";
  return state;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const redirectPath = sanitizeState(
    searchParams.get("state")
  );
  const oauthState = randomUUID();

  const discordAuthUrl = new URL(
    "https://discord.com/api/oauth2/authorize"
  );

  discordAuthUrl.searchParams.set(
    "client_id",
    process.env.DISCORD_CLIENT_ID!
  );
  discordAuthUrl.searchParams.set("response_type", "code");
  discordAuthUrl.searchParams.set(
    "redirect_uri",
    process.env.DISCORD_REDIRECT_URI!
  );
  discordAuthUrl.searchParams.set("scope", "identify");
  discordAuthUrl.searchParams.set("prompt", "consent");
  discordAuthUrl.searchParams.set("state", oauthState);

  const response = NextResponse.redirect(
    discordAuthUrl.toString()
  );

  const isProd = process.env.NODE_ENV === "production";

  response.cookies.set("oauth_state", oauthState, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 10,
  });

  response.cookies.set("oauth_redirect_path", redirectPath, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 10,
  });

  return response;
}
