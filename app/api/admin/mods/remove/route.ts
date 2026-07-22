import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/db/admin";
import { AuthError } from "@/lib/auth/AuthError";
import { requireAdmin } from "@/lib/auth/guards";

export async function POST(req: Request) {
  try {
    
    const admin = await requireAdmin();
    const actorId = admin.discord_user_id;

    
    const formData = await req.formData();
    const targetId = formData.get("discord_user_id");

    if (typeof targetId !== "string" || !targetId) {
      return NextResponse.json(
        { error: "Missing user id" },
        { status: 400 }
      );
    }

    
    if (targetId === actorId) {
      return NextResponse.json(
        { error: "Cannot remove yourself" },
        { status: 400 }
      );
    }

    
    await supabaseAdmin
      .from("team_members")
      .delete()
      .eq("discord_user_id", targetId)
      .eq("role", "mod");

    
    return NextResponse.redirect(
      new URL("/admin/mods", req.url)
    );
  } catch (error) {
    
    if (
      error instanceof AuthError &&
      (error.status === 401 || error.status === 403)
    ) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }

    console.error("REMOVE MOD ERROR", error);

    return NextResponse.json(
      { error: "Failed to remove mod" },
      { status: 500 }
    );
  }
}
