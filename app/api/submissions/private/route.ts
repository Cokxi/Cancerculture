export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/db/admin";
import { requireSession } from "@/lib/auth/requireSession";

export async function GET(req: Request) {
  try {
    const { discord_user_id } = await requireSession();

    const { searchParams } = new URL(req.url);
    const submissionIdRaw = searchParams.get("id");

    if (!submissionIdRaw) {
      return NextResponse.json(
        { error: "Missing id" },
        { status: 400 }
      );
    }

    const submissionId = Number(submissionIdRaw);

    if (!Number.isInteger(submissionId)) {
      return NextResponse.json(
        { error: "Invalid id" },
        { status: 400 }
      );
    }

    // submission laden
    const { data: submission } = await supabaseAdmin
      .from("submissions")
      .select("id, discord_user_id")
      .eq("id", submissionId)
      .single();

    if (!submission) {
      return NextResponse.json(
        { error: "Not found" },
        { status: 404 }
      );
    }

    // 🔐 Owner Check
    if (submission.discord_user_id !== discord_user_id) {
      return NextResponse.json(
        { error: "Forbidden" },
        { status: 403 }
      );
    }

    const { data: privateData } = await supabaseAdmin
      .from("submission_private_data")
      .select(
        "x_username, wallet_address, payout_choice, split_percent, charity"
      )
      .eq("submission_id", submissionId)
      .single();

    return NextResponse.json(privateData);
  } catch (err) {
    if (err instanceof Response) throw err;

    return NextResponse.json(
      { error: "Failed" },
      { status: 500 }
    );
  }
}