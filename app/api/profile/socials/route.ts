export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import { supabaseAdmin } from "@/lib/db/admin";
import { touchUserLog } from "@/lib/logging/touchUserLog";
import {
  normalizeSocialInput,
  parseSocialPlatform,
} from "@/lib/socials/normalize";

export async function POST(req: Request) {
  try {
    const { discord_user_id: discordUserId } =
      await requireSession();
    await touchUserLog({ discordUserId });

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

    const normalized = normalizeSocialInput({
      platform,
      rawValue: String(value ?? ""),
    });

    const { data, error } = await supabaseAdmin
      .from("user_social_links")
      .insert({
        discord_user_id: discordUserId,
        platform,
        handle: normalized.handle,
        profile_url: normalized.profileUrl,
      })
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

      console.error("[profile/socials][POST]", error);
      return NextResponse.json(
        { error: "Failed to save social link." },
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
      { error: "Failed to save social link." },
      { status: 500 }
    );
  }
}
