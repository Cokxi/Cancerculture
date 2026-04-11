export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { supabaseAdmin } from "@/lib/db/admin";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug: inviteSlug } = await params;


  
  const { data: invite } = await supabaseAdmin
    .from("admin_invites")
    .select("id, invite_slug, is_active")
    .eq("invite_slug", inviteSlug)
    .eq("is_active", true)
    .single();

  if (!invite) {
    return NextResponse.json(
      { error: "Invalid or expired invite" },
      { status: 404 }
    );
  }

  
  (await cookies()).delete("session_id");

  
  return NextResponse.redirect(
    `${process.env.NEXT_PUBLIC_BASE_URL}/api/auth/discord/login?state=/invite/${inviteSlug}`
  );
}
