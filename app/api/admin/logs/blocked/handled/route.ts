export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/guards";
import { supabaseAdmin } from "@/lib/db/admin";

export async function POST(req: Request) {
  try {
    await requireAdmin();

    const body = await req.json();
    const { discord_user_id } = body;

    if (!discord_user_id) {
      return NextResponse.json(
        { error: "Missing discord_user_id" },
        { status: 400 }
      );
    }

    
    const { error } = await supabaseAdmin
      .from("blocked_user_meta")
      .upsert({
        discord_user_id,
        admin_handled: true,
        updated_at: new Date().toISOString(),
      });

    if (error) {
      return NextResponse.json(
        { error: "Failed to update handled state" },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message ?? "Forbidden" },
      { status: err.status ?? 403 }
    );
  }
}