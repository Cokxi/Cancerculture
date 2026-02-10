export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/db/admin";
import { requireSession } from "@/lib/auth/requireSession";
import { logVote } from "@/lib/logging/logVote";
import { touchUserLog } from "@/lib/logging/touchUserLog";

export async function POST(req: Request) {
  try {
    /* 1️⃣ Auth via Session → Discord-ID */
    const { discord_user_id: discordUserId } = await requireSession();

    /* 🚫 BAN CHECK (user_logs) */
const { data: userLog } = await supabaseAdmin
  .from("user_logs")
  .select("is_banned")
  .eq("discord_user_id", discordUserId)
  .single();

if (userLog?.is_banned) {
  await logVote({
    cycleId: null,
    discordUserId,
    status: "rejected",
    reason: "banned",
  });

  return NextResponse.json(
    { error: "BANNED" },
    { status: 403 }
  );
}

await touchUserLog({
  discordUserId,
  // optional: discordUsername
});

    /* 2️⃣ Input (HTML Form) */
    const formData = await req.formData();
    const submissionIdRaw = formData.get("submissionId");

    if (typeof submissionIdRaw !== "string") {
      return NextResponse.json(
        { error: "Invalid submissionId" },
        { status: 400 }
      );
    }

    const submissionId = Number(submissionIdRaw);

    if (!Number.isInteger(submissionId)) {
      return NextResponse.json(
        { error: "Invalid submissionId" },
        { status: 400 }
      );
    }

    /* 3️⃣ Aktiven Cycle holen */
    const { data: cycle } = await supabaseAdmin
      .from("voting_cycles")
      .select("id")
      .eq("status", "active")
      .single();

    if (!cycle) {
      return NextResponse.json(
        { error: "No active voting cycle" },
        { status: 400 }
      );
    }

    /* 4️⃣ Submission laden (Self-Vote-Check) */
    const { data: submission } = await supabaseAdmin
      .from("submissions")
      .select("id, discord_user_id")
      .eq("id", submissionId)
      .eq("cycle_id", cycle.id)
      .single();

    if (!submission) {
      return NextResponse.json(
        { error: "Submission not found" },
        { status: 404 }
      );
    }

    /* 🚫 Self-Vote verhindern */
    if (submission.discord_user_id === discordUserId) {
      await logVote({
        cycleId: cycle.id,
        submissionId,
        discordUserId,
        status: "rejected",
        reason: "self_vote",
      });

      return NextResponse.json(
        { error: "You can’t vote for your own submission" },
        { status: 403 }
      );
    }

    /* 🛑 Schon gevotet? (1 Vote pro Discord-ID pro Cycle) */
    const { data: existingVote } = await supabaseAdmin
      .from("votes")
      .select("id")
      .eq("cycle_id", cycle.id)
      .eq("discord_user_id", discordUserId)
      .maybeSingle();

    if (existingVote) {
      await logVote({
        cycleId: cycle.id,
        submissionId,
        discordUserId,
        status: "rejected",
        reason: "already_voted",
      });

      return NextResponse.json(
        { error: "You already voted in this cycle" },
        { status: 400 }
      );
    }

    /* 🗳️ Vote speichern */
    const { error: insertError } = await supabaseAdmin
      .from("votes")
      .insert({
        cycle_id: cycle.id,
        submission_id: submissionId,
        discord_user_id: discordUserId,
      });

    if (insertError) {
      throw insertError;
    }

    /* 🧾 Log */
    await logVote({
      cycleId: cycle.id,
      submissionId,
      discordUserId,
      status: "accepted",
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("VOTE ERROR", error);

    // requireSession wirft Response → direkt weiterreichen
    if (error instanceof Response) {
      throw error;
    }

    return NextResponse.json(
      { error: "Voting failed" },
      { status: 500 }
    );
  }
}
