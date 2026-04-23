import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { cookies } from "next/headers";
import { supabaseAdmin } from "@/lib/db/admin";
import { touchUserLog } from "@/lib/logging/touchUserLog";

function sanitizeRedirectPath(path: string | undefined) {
  if (!path) return "/upload";
  if (!path.startsWith("/")) return "/upload";
  return path;
}

export async function GET(req: Request) {
  console.log("DISCORD CALLBACK HIT");

  const { searchParams } = new URL(req.url);
  const code = searchParams.get("code");
  const returnedState = searchParams.get("state");
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL!;
  const cookieStore = await cookies();
  const expectedState =
    cookieStore.get("oauth_state")?.value ?? null;
  const redirectPath = sanitizeRedirectPath(
    cookieStore.get("oauth_redirect_path")?.value
  );

  const invalidStateResponse = NextResponse.redirect(
    new URL(`/upload?error=oauth_state`, baseUrl)
  );
  invalidStateResponse.cookies.delete("oauth_state");
  invalidStateResponse.cookies.delete(
    "oauth_redirect_path"
  );

  if (
    !returnedState ||
    !expectedState ||
    returnedState !== expectedState
  ) {
    return invalidStateResponse;
  }

  if (!code) {
    const response = NextResponse.redirect(
      new URL(`${redirectPath}?error=discord`, baseUrl)
    );
    response.cookies.delete("oauth_state");
    response.cookies.delete("oauth_redirect_path");
    return response;
  }

  
  const tokenRes = await fetch(
    "https://discord.com/api/oauth2/token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID!,
        client_secret: process.env.DISCORD_CLIENT_SECRET!,
        grant_type: "authorization_code",
        code,
        redirect_uri: process.env.DISCORD_REDIRECT_URI!,
      }),
    }
  );

  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    console.error("DISCORD TOKEN ERROR:", text);

    const response = NextResponse.redirect(
      new URL(`${redirectPath}?error=discord_token`, baseUrl)
    );
    response.cookies.delete("oauth_state");
    response.cookies.delete("oauth_redirect_path");
    return response;
  }

  const tokenData = await tokenRes.json();

  if (!tokenData.access_token) {
    const response = NextResponse.redirect(
      new URL(`${redirectPath}?error=discord`, baseUrl)
    );
    response.cookies.delete("oauth_state");
    response.cookies.delete("oauth_redirect_path");
    return response;
  }

  
  const userRes = await fetch(
    "https://discord.com/api/users/@me",
    {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
      },
    }
  );

  const user = await userRes.json();

  if (!user?.id) {
    const response = NextResponse.redirect(
      new URL(`${redirectPath}?error=discord`, baseUrl)
    );
    response.cookies.delete("oauth_state");
    response.cookies.delete("oauth_redirect_path");
    return response;
  }

  await touchUserLog({
  discordUserId: user.id,
  discordUsername: user.username,
  discordAvatar: user.avatar,
});


  
const { data: userLog } = await supabaseAdmin
  .from("user_logs")
  .select("is_banned")
  .eq("discord_user_id", user.id)
  .single();

if (userLog?.is_banned) {
  const response = NextResponse.redirect(
    new URL(`/banned`, baseUrl)
  );
  response.cookies.delete("oauth_state");
  response.cookies.delete("oauth_redirect_path");
  return response;
}

  
  const sessionId = randomUUID();

  await supabaseAdmin
    .from("sessions")
    .insert({
      id: sessionId,
      discord_user_id: user.id,
      created_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
    });

  
const response = NextResponse.redirect(
  new URL(redirectPath, baseUrl)
);


  const isProd = process.env.NODE_ENV === "production";

  
  response.cookies.set("session_id", sessionId, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30, 
  });

  
  response.cookies.delete("discord_user_id");
  response.cookies.delete("oauth_state");
  response.cookies.delete("oauth_redirect_path");

  return response;
}
