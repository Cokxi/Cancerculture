import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { supabaseAdmin } from "@/lib/db/admin";
import { touchUserLog } from "@/lib/logging/touchUserLog";

export async function GET(req: Request) {
  console.log("DISCORD CALLBACK HIT");

  const { searchParams } = new URL(req.url);
  const code = searchParams.get("code");

  const redirectPath = searchParams.get("state") || "/upload";
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL!;

  if (!code) {
    return NextResponse.redirect(
      new URL(`${redirectPath}?error=discord`, baseUrl)
    );
  }

  // 1️⃣ Code → Access Token
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

    return NextResponse.redirect(
      new URL(`${redirectPath}?error=discord_token`, baseUrl)
    );
  }

  const tokenData = await tokenRes.json();

  if (!tokenData.access_token) {
    return NextResponse.redirect(
      new URL(`${redirectPath}?error=discord`, baseUrl)
    );
  }

  // 2️⃣ Discord User holen
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
    return NextResponse.redirect(
      new URL(`${redirectPath}?error=discord`, baseUrl)
    );
  }

  await touchUserLog({
  discordUserId: user.id,
  discordUsername: user.username,
});


  // 🚫 BAN CHECK (user_logs)
const { data: userLog } = await supabaseAdmin
  .from("user_logs")
  .select("is_banned")
  .eq("discord_user_id", user.id)
  .single();

if (userLog?.is_banned) {
  return NextResponse.redirect(
    new URL(`/banned`, baseUrl)
  );
}


  // 🧠 INVITE-FLOW (bleibt unverändert)
  if (redirectPath.startsWith("/invite/")) {
    const inviteSlug = redirectPath.split("/invite/")[1];

    if (inviteSlug) {
      const { data: invite } = await supabaseAdmin
        .from("admin_invites")
        .select("id, invite_slug, is_active")
        .eq("invite_slug", inviteSlug)
        .single();

      if (invite && invite.is_active) {
        await supabaseAdmin
          .from("invite_auth_logs")
          .insert({
            invite_id: invite.id,
            invite_slug: invite.invite_slug,
            invited_discord_user_id: user.id,
            discord_username: user.username,
            discord_discriminator: user.discriminator,
            discord_avatar: user.avatar,
          });

        await supabaseAdmin
          .from("team_members")
          .upsert({
            discord_user_id: user.id,
            discord_username: user.username,
            role: "mod",
          });
            // ✅ HIER – Invite EINMALIG deaktivieren
      await supabaseAdmin
        .from("admin_invites")
        .update({ is_active: false })
        .eq("id", invite.id);
      }
    }
  }

  // 🆕 SESSION ANLEGEN
  const sessionId = randomUUID();

  await supabaseAdmin
    .from("sessions")
    .insert({
      id: sessionId,
      discord_user_id: user.id,
      created_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
    });

  // 🔁 Redirect + Cookie setzen
  const finalRedirect =
  redirectPath.startsWith("/invite/")
    ? "/"
    : redirectPath;

const response = NextResponse.redirect(
  new URL(finalRedirect, baseUrl)
);


  const isProd = process.env.NODE_ENV === "production";

  // ❗ EINZIGER COOKIE
  response.cookies.set("session_id", sessionId, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 Tage
  });

  // 🧹 ALTEN COOKIE AKTIV LÖSCHEN (falls vorhanden)
  response.cookies.delete("discord_user_id");

  return response;
}
