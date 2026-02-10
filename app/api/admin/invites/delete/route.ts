import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/db/admin";
import { requireAdmin } from "@/lib/auth/guards";

export async function POST(req: Request) {
  try {
    /* 🔐 Admin-only */
    await requireAdmin();

    const formData = await req.formData();
    const inviteId = formData.get("invite_id");

    if (typeof inviteId !== "string" || !inviteId) {
      return NextResponse.json(
        { error: "Missing invite id" },
        { status: 400 }
      );
    }

    /* 🧹 Logs löschen (optional, empfohlen) */
    await supabaseAdmin
      .from("invite_auth_logs")
      .delete()
      .eq("invite_id", inviteId);

    /* 🗑️ Invite löschen */
    await supabaseAdmin
      .from("admin_invites")
      .delete()
      .eq("id", inviteId);

    return NextResponse.redirect(
      new URL("/admin/invites", req.url)
    );
  } catch (error) {
    // 🔑 Auth-Fehler sauber durchreichen
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
