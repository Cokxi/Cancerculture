export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { requireModOrAdmin } from "@/lib/auth/guards";
import { supabaseAdmin } from "@/lib/db/admin";
import { logSocialVerificationAction } from "@/lib/logging/logSocialVerificationAction";

function parseSocialId(value: string) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

export async function POST(
  req: Request,
  context: { params: Promise<{ socialId: string }> }
) {
  try {
    const actor = await requireModOrAdmin();
    const { socialId: socialIdParam } = await context.params;
    const socialId = parseSocialId(socialIdParam);
    const { note } = await req
      .json()
      .catch(() => ({ note: null }));

    if (!socialId) {
      return NextResponse.json(
        { error: "Invalid social id." },
        { status: 400 }
      );
    }

    const { data: social, error: loadError } =
      await supabaseAdmin
        .from("user_social_links")
        .select(
          "id, discord_user_id, platform, handle, profile_url"
        )
        .eq("id", socialId)
        .maybeSingle();

    if (loadError) {
      console.error(
        "[admin/socials/:id/unverify][load]",
        loadError
      );
      return NextResponse.json(
        { error: "Failed to load social link." },
        { status: 500 }
      );
    }

    if (!social) {
      return NextResponse.json(
        { error: "Social link not found." },
        { status: 404 }
      );
    }

    const { error } = await supabaseAdmin
      .from("user_social_links")
      .update({
        is_verified: false,
        verified_at: null,
        verified_by_discord_user_id: null,
        verification_note: null,
      })
      .eq("id", socialId);

    if (error) {
      console.error("[admin/socials/:id/unverify]", error);
      return NextResponse.json(
        { error: "Failed to unverify social link." },
        { status: 500 }
      );
    }

    await logSocialVerificationAction({
      action: "unverify_social",
      actorDiscordUserId: actor.discord_user_id,
      actorRole: actor.role,
      targetDiscordUserId: social.discord_user_id,
      userSocialLinkId: social.id,
      platform: social.platform,
      profileUrl: social.profile_url,
      handle: social.handle,
      note:
        typeof note === "string" && note.trim().length > 0
          ? note.trim()
          : null,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Response) {
      throw error;
    }

    return NextResponse.json(
      { error: "Failed to unverify social link." },
      { status: 500 }
    );
  }
}
