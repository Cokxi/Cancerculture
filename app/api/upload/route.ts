export const runtime = "nodejs";


import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";
import { supabaseAdmin } from "@/lib/db/admin";
import { r2 } from "@/lib/r2";
import { logUpload } from "@/lib/logging/logUpload";
import { touchUserLog } from "@/lib/logging/touchUserLog";
import { logUploadFailAndCheckLimit } from "@/lib/logging/logUploadFailAndCheckLimit";

const MAX_UPLOAD_SIZE = 4 * 1024 * 1024; 
const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp"];



export async function POST(req: Request) {
  try {
    
    const { discord_user_id: discordUserId } = await requireSession();

    
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

      return new Response(JSON.stringify({ error: "BANNED" }), {
        status: 403,
      });
    }


const { data: userRules } = await supabaseAdmin
  .from("user_logs")
  .select("accepted_rules_version")
  .eq("discord_user_id", discordUserId)
  .single();

const { data: currentRules } = await supabaseAdmin
  .from("rules_meta")
  .select("current_version")
  .eq("id", 1)
  .single();

if (
  !userRules ||
  userRules.accepted_rules_version !== currentRules?.current_version
) {
  return NextResponse.json(
    { error: "RULES_NOT_ACCEPTED" },
    { status: 403 }
  );
}    

    
    const rateLimitBlocked = await logUploadFailAndCheckLimit({
      discordUserId,
      mode: "check",
    });

    if (rateLimitBlocked) {
      return new Response(
        JSON.stringify({ error: "TOO_MANY_FAILED_UPLOADS" }),
        { status: 429 }
      );
    }

    
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

 
    const { data: existing } = await supabaseAdmin
      .from("submissions")
      .select("id")
      .eq("cycle_id", cycle.id)
      .eq("discord_user_id", discordUserId)
      .maybeSingle();

    if (existing) {

  await logUploadFailAndCheckLimit({
    discordUserId,
    mode: "fail",
  });

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


await touchUserLog({
      discordUserId,
    });

    
    
    const formData = await req.formData();
    const fileEntry = formData.get("file");

    if (!(fileEntry instanceof File)) {

      await logUploadFailAndCheckLimit({
  discordUserId,
  mode: "fail",
});
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

    const file = fileEntry;

    
    if (file.size > MAX_UPLOAD_SIZE) {
      await logUploadFailAndCheckLimit({
  discordUserId,
  mode: "fail",
});

      await logUpload({
        cycleId: null,
        discordUserId,
        status: "failed",
        reason: "file_size",
      });

      return NextResponse.json(
        { error: "File too large" },
        { status: 400 }
      );
    }

    
    const xUsername = formData.get("xUsername")?.toString() ?? "";
    const walletAddress = formData.get("walletAddress")?.toString() ?? "";
    const payoutChoice = formData.get("payoutChoice")?.toString() ?? null;
    const splitPercentRaw = formData.get("splitPercent")?.toString();
    const charity = formData.get("charity")?.toString() ?? null;

    const splitPercent = splitPercentRaw
      ? parseInt(splitPercentRaw, 10)
      : null;

    if (!xUsername || !walletAddress || !payoutChoice) {
      await logUploadFailAndCheckLimit({
  discordUserId,
  mode: "fail",
});

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
      await logUploadFailAndCheckLimit({
  discordUserId,
  mode: "fail",
});

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
      await logUploadFailAndCheckLimit({
  discordUserId,
  mode: "fail",
});

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

    
    if (!ALLOWED_TYPES.includes(file.type)) {
      await logUploadFailAndCheckLimit({
        discordUserId,
        mode: "fail",
             });

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

   

    
    const inputBuffer = Buffer.from(await file.arrayBuffer());

    const webpBuffer = await sharp(inputBuffer)
      .rotate()
      .webp({ quality: 75 })
      .toBuffer();

    const r2_key = `${cycle.id}/${crypto.randomUUID()}.webp`;

    await r2.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME!,
        Key: r2_key,
        Body: webpBuffer,
        ContentType: "image/webp",
      })
    );


    
    const { data: submission, error: insertError } =
      await supabaseAdmin
        .from("submissions")
        .insert({
          cycle_id: cycle.id,
          discord_user_id: discordUserId,
          r2_key: r2_key,
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

    
    const { error: privateError } = await supabaseAdmin
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

    
    await logUpload({
      cycleId: cycle.id,
      discordUserId,
      submissionId: submission.id,
      status: "success",
    });

    return NextResponse.json({
      success: true,
          });
  } catch (error) {
    console.error("UPLOAD ERROR", error);

    if (error instanceof Response) {
      throw error;
    }

    return NextResponse.json(
      { error: "Upload failed" },
      { status: 500 }
    );
  }
}