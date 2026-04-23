export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import { supabaseAdmin } from "@/lib/db/admin";
import { touchUserLog } from "@/lib/logging/touchUserLog";

export async function PATCH(req: Request) {
  try {
    const { discord_user_id: discordUserId } =
      await requireSession();
    const { scope, value } = await req.json();

    if (
      (scope !== "profile" && scope !== "submissions") ||
      typeof value !== "boolean"
    ) {
      return NextResponse.json(
        { error: "Invalid visibility value." },
        { status: 400 }
      );
    }

    await touchUserLog({ discordUserId });

    const { error } = await supabaseAdmin
      .from("user_logs")
      .update(
        scope === "profile"
          ? { show_socials: value }
          : { show_socials_on_submissions: value }
      )
      .eq("discord_user_id", discordUserId);

    if (error) {
      console.error("[profile/social-visibility]", error);
      return NextResponse.json(
        { error: "Failed to update visibility." },
        { status: 500 }
      );
    }

    return NextResponse.json({ scope, value });
  } catch (error) {
    if (error instanceof Response) {
      throw error;
    }

    return NextResponse.json(
      { error: "Failed to update visibility." },
      { status: 500 }
    );
  }
}
