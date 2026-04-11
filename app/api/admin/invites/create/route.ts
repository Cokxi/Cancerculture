export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/guards";
import { supabaseAdmin } from "@/lib/db/admin";


export async function POST(req: Request) {
  try {
   
    const admin = await requireAdmin();

    const body = await req.json().catch(() => ({}));
    const note: string | null = body?.note ?? null;

    
    const inviteSlug = crypto.randomUUID().slice(0, 8);

    const { data: invite, error } = await supabaseAdmin
      .from("admin_invites")
      .insert({
        invite_slug: inviteSlug,
        invited_by_discord_id: admin.discord_user_id,
        note,
      })
      .select()
      .single();

    if (error || !invite) {
      return NextResponse.json(
        { error: "Failed to create invite" },
        { status: 500 }
      );
    }

    const inviteUrl = `${process.env.NEXT_PUBLIC_BASE_URL}/invite/${invite.invite_slug}`;

    return NextResponse.json({
      success: true,
      invite: {
        id: invite.id,
        invite_slug: invite.invite_slug,
        invite_url: inviteUrl,
        note: invite.note,
        created_at: invite.created_at,
      },
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message ?? "Forbidden" },
      { status: err.status ?? 403 }
    );
  }
}
