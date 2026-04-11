import { NextResponse } from "next/server";

function sanitizeState(state: string | null): string {
  if (!state) return "/upload";
  if (!state.startsWith("/")) return "/upload";
  return state;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);

  
  const state = sanitizeState(
    searchParams.get("state")
  );

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
  discordAuthUrl.searchParams.set("state", state);

  return NextResponse.redirect(discordAuthUrl.toString());
}
