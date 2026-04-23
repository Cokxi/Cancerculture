export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import { supabaseAdmin } from "@/lib/db/admin";
import {
  normalizeSocialInput,
  parseSocialPlatform,
} from "@/lib/socials/normalize";

function parseSocialId(value: string) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

export async function PATCH(
  req: Request,
  context: { params: Promise<{ socialId: string }> }
) {
  try {
    const { discord_user_id: discordUserId } =
      await requireSession();
    const { socialId: socialIdParam } = await context.params;
    const socialId = parseSocialId(socialIdParam);

    if (!socialId) {
      return NextResponse.json(
        { error: "Invalid social id." },
        { status: 400 }
      );
    }

    const { platform: rawPlatform, value } =
      await req.json();
    const platform = parseSocialPlatform(
      String(rawPlatform ?? "")
    );

    if (!platform) {
      return NextResponse.json(
        { error: "Invalid platform." },
        { status: 400 }
      );
    }

    const { data: existing, error: loadError } =
      await supabaseAdmin
        .from("user_social_links")
        .select("id, discord_user_id")
        .eq("id", socialId)
        .maybeSingle();

    if (loadError) {
      console.error(
        "[profile/socials/:id][PATCH][load]",
        loadError
      );
      return NextResponse.json(
        { error: "Failed to load social link." },
        { status: 500 }
      );
    }

    if (!existing || existing.discord_user_id !== discordUserId) {
      return NextResponse.json(
        { error: "Not found." },
        { status: 404 }
      );
    }

    const normalized = normalizeSocialInput({
      platform,
      rawValue: String(value ?? ""),
    });

    const { data, error } = await supabaseAdmin
      .from("user_social_links")
      .update({
        platform,
        handle: normalized.handle,
        profile_url: normalized.profileUrl,
      })
      .eq("id", socialId)
      .eq("discord_user_id", discordUserId)
      .select(
        "id, discord_user_id, platform, handle, profile_url, is_verified, verified_at, verified_by_discord_user_id, verification_note, created_at, updated_at"
      )
      .single();

    if (error) {
      if (error.code === "23505") {
        return NextResponse.json(
          { error: "That social link is already saved." },
          { status: 409 }
        );
      }

      console.error("[profile/socials/:id][PATCH]", error);
      return NextResponse.json(
        { error: "Failed to update social link." },
        { status: 500 }
      );
    }

    return NextResponse.json({ social: data });
  } catch (error) {
    if (error instanceof Response) {
      throw error;
    }

    if (error instanceof Error) {
      return NextResponse.json(
        { error: error.message },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: "Failed to update social link." },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _req: Request,
  context: { params: Promise<{ socialId: string }> }
) {
  try {
    const { discord_user_id: discordUserId } =
      await requireSession();
    const { socialId: socialIdParam } = await context.params;
    const socialId = parseSocialId(socialIdParam);

    if (!socialId) {
      return NextResponse.json(
        { error: "Invalid social id." },
        { status: 400 }
      );
    }

    const { error } = await supabaseAdmin
      .from("user_social_links")
      .delete()
      .eq("id", socialId)
      .eq("discord_user_id", discordUserId);

    if (error) {
      console.error("[profile/socials/:id][DELETE]", error);
      return NextResponse.json(
        { error: "Failed to delete social link." },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Response) {
      throw error;
    }

    return NextResponse.json(
      { error: "Failed to delete social link." },
      { status: 500 }
    );
  }
}
