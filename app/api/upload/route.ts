export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import { PutObjectCommand } from "@aws-sdk/client-s3";

import { supabaseAdmin } from "@/lib/db/admin";
import { r2 } from "@/lib/r2";
import { logUpload } from "@/lib/logging/logUpload";
import { touchUserLog } from "@/lib/logging/touchUserLog";


/* ================= ENTRY ================= */

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
  await logUpload({
    cycleId: null,
    discordUserId,
    status: "failed",
    reason: "banned",
  });

  return new Response(
    JSON.stringify({ error: "BANNED" }),
    { status: 403 }
  );
}
await touchUserLog({
  discordUserId,
  // optional: falls du den Namen aus Session / OAuth hast
  // discordUsername,
});

    /* 2️⃣ FormData + File */
    const formData = await req.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      await logUpload({
        cycleId: null,
        discordUserId,
        status: "failed",
        reason: "no_file",
      });

      return NextResponse.json(
        { error: "No file provided" },
        { status: 400 }
      );
    }

    /* 3️⃣ Metadaten */
    const xUsername = formData.get("xUsername")?.toString() ?? "";
    const walletAddress = formData.get("walletAddress")?.toString() ?? "";
    const payoutChoice = formData.get("payoutChoice")?.toString() ?? null;
    const splitPercentRaw = formData.get("splitPercent")?.toString();
    const charity = formData.get("charity")?.toString() ?? null;

    const splitPercent = splitPercentRaw
      ? parseInt(splitPercentRaw, 10)
      : null;

    if (!xUsername || !walletAddress || !payoutChoice) {
      await logUpload({
        cycleId: null,
        discordUserId,
        status: "failed",
        reason: "validation_failed",
      });

      return NextResponse.json(
        { error: "Missing submission metadata" },
        { status: 400 }
      );
    }

    if (
      payoutChoice === "split" &&
      (!splitPercent || splitPercent <= 0 || splitPercent >= 100)
    ) {
      await logUpload({
        cycleId: null,
        discordUserId,
        status: "failed",
        reason: "validation_failed",
      });

      return NextResponse.json(
        { error: "Invalid split percentage" },
        { status: 400 }
      );
    }

    if (
      (payoutChoice === "donate" || payoutChoice === "split") &&
      !charity
    ) {
      await logUpload({
        cycleId: null,
        discordUserId,
        status: "failed",
        reason: "validation_failed",
      });

      return NextResponse.json(
        { error: "Charity required" },
        { status: 400 }
      );
    }

    /* 4️⃣ File-Type prüfen */
    if (!file.type.startsWith("image/")) {
      await logUpload({
        cycleId: null,
        discordUserId,
        status: "failed",
        reason: "invalid_file_type",
      });

      return NextResponse.json(
        { error: "Invalid file type" },
        { status: 400 }
      );
    }

    /* 5️⃣ Aktiven Cycle holen */
    const { data: cycle } = await supabaseAdmin
      .from("voting_cycles")
      .select("id")
      .eq("status", "active")
      .single();

    if (!cycle) {
      await logUpload({
        cycleId: null,
        discordUserId,
        status: "failed",
        reason: "no_active_cycle",
      });

      return NextResponse.json(
        { error: "No active voting cycle" },
        { status: 400 }
      );
    }

    /* 6️⃣ Duplicate Check (Discord-only) */
    const { data: existing } = await supabaseAdmin
      .from("submissions")
      .select("id")
      .eq("cycle_id", cycle.id)
      .eq("discord_user_id", discordUserId)
      .maybeSingle();

    if (existing) {
      await logUpload({
        cycleId: cycle.id,
        discordUserId,
        status: "failed",
        reason: "duplicate_submission",
      });

      return NextResponse.json(
        { error: "You already uploaded for this cycle" },
        { status: 400 }
      );
    }

    /* 7️⃣ Upload zu R2 */
    const buffer = Buffer.from(await file.arrayBuffer());
    const ext = file.name.split(".").pop() || "jpg";
    const key = `cycle-${cycle.id}/${crypto.randomUUID()}.${ext}`;

    await r2.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME!,
        Key: key,
        Body: buffer,
        ContentType: file.type,
      })
    );

    const imageUrl = `${process.env.R2_PUBLIC_BASE_URL}/${key}`;

    /* 8️⃣ Submission speichern */
    const { data: submission, error: insertError } =
      await supabaseAdmin
        .from("submissions")
        .insert({
          cycle_id: cycle.id,
          discord_user_id: discordUserId,
          image_url: imageUrl,
        })
        .select()
        .single();

    if (insertError || !submission) {
      await logUpload({
        cycleId: cycle.id,
        discordUserId,
        status: "failed",
        reason: "db_error",
      });

      throw insertError;
    }

    /* 9️⃣ Private Submission-Daten */
    const { error: privateError } =
      await supabaseAdmin
        .from("submission_private_data")
        .insert({
          submission_id: submission.id,
          x_username: xUsername,
          wallet_address: walletAddress,
          payout_choice: payoutChoice,
          split_percent: splitPercent,
          charity,
        });

    if (privateError) {
      await logUpload({
        cycleId: cycle.id,
        discordUserId,
        submissionId: submission.id,
        status: "failed",
        reason: "db_error",
      });

      throw privateError;
    }

    /* ✅ Erfolg */
    await logUpload({
      cycleId: cycle.id,
      discordUserId,
      submissionId: submission.id,
      status: "success",
    });

    return NextResponse.json({
      success: true,
      imageUrl,
    });
  } catch (error) {
    console.error("UPLOAD ERROR", error);

    // 🔑 Auth-Responses sauber durchreichen
    if (error instanceof Response) {
      throw error;
    }

    return NextResponse.json(
      { error: "Upload failed" },
      { status: 500 }
    );
  }
}
