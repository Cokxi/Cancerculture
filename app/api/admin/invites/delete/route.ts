import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/db/admin";
import { requireAdmin } from "@/lib/auth/guards";

export async function POST(req: Request) {
  try {
    
    await requireAdmin();

    const formData = await req.formData();
    const inviteId = formData.get("invite_id");

    if (typeof inviteId !== "string" || !inviteId) {
      return NextResponse.json(
        { error: "Missing invite id" },
        { status: 400 }
      );
    }

    
    await supabaseAdmin
      .from("invite_auth_logs")
      .delete()
      .eq("invite_id", inviteId);

    
    await supabaseAdmin
      .from("admin_invites")
      .delete()
      .eq("id", inviteId);

    return NextResponse.redirect(
      new URL("/admin/invites", req.url)
    );
  } catch (error) {
    
    if (error instanceof Error && (error as any).status) {
      return NextResponse.json(
        { error: error.message },
        { status: (error as any).status }
      );
    }

    console.error("DELETE INVITE ERROR", error);

    return NextResponse.json(
      { error: "Failed to delete invite" },
      { status: 500 }
    );
  }
}
