export const runtime = "nodejs";

import {
  DeleteObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { NextResponse } from "next/server";
import sharp from "sharp";
import { requireSession } from "@/lib/auth/requireSession";
import { supabaseAdmin } from "@/lib/db/admin";
import { isUniqueViolation } from "@/lib/db/isUniqueViolation";
import { logUpload } from "@/lib/logging/logUpload";
import { logUploadFailAndCheckLimit } from "@/lib/logging/logUploadFailAndCheckLimit";
import { touchUserLog } from "@/lib/logging/touchUserLog";
import { r2 } from "@/lib/r2";
import { getSocialDisplayLabel } from "@/lib/socials/normalize";
import { getUploadEligibility } from "@/lib/upload/getUploadEligibility";

const MAX_UPLOAD_SIZE = 4 * 1024 * 1024;
const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp"];

async function failUpload({
  discordUserId,
  cycleId = null,
  reason,
  error,
  status,
  countFailure = true,
}: {
  discordUserId: string;
  cycleId?: number | null;
  reason: string;
  error: string;
  status: number;
  countFailure?: boolean;
}) {
  if (countFailure) {
    await logUploadFailAndCheckLimit({
      discordUserId,
      mode: "fail",
    });
  }

  await logUpload({
    cycleId,
    discordUserId,
    status: "failed",
    reason,
  });

  return NextResponse.json({ error }, { status });
}

async function cleanupUploadedObject(r2Key: string | null) {
  if (!r2Key) {
    return;
  }

  try {
    await r2.send(
      new DeleteObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME!,
        Key: r2Key,
      })
    );
  } catch (cleanupError) {
    console.error("[UPLOAD CLEANUP ERROR]", cleanupError);
  }
}

export async function POST(req: Request) {
  let uploadedR2Key: string | null = null;

  try {
    const { discord_user_id: discordUserId } = await requireSession();
    const uploadEligibility = await getUploadEligibility({
      discordUserId,
      includeDiscordMembership: true,
    });

    if (uploadEligibility.isBanned) {
      await logUpload({
        cycleId: null,
        discordUserId,
        status: "failed",
        reason: "banned",
      });

      return NextResponse.json({ error: "BANNED" }, { status: 403 });
    }

    if (!uploadEligibility.membership?.isMember) {
      await logUpload({
        cycleId: null,
        discordUserId,
        status: "failed",
        reason: "not_in_discord",
      });

      return NextResponse.json(
        { error: "NOT_IN_DISCORD" },
        { status: 403 }
      );
    }

    if (uploadEligibility.membership.joinedTooRecently) {
      await logUpload({
        cycleId: null,
        discordUserId,
        status: "failed",
        reason: "joined_too_recently",
      });

      return NextResponse.json(
        {
          error: "JOINED_TOO_RECENTLY",
          joinedAt: uploadEligibility.membership.joinedAt,
        },
        { status: 403 }
      );
    }

    if (!uploadEligibility.hasAcceptedRules) {
      return NextResponse.json(
        { error: "RULES_NOT_ACCEPTED" },
        { status: 403 }
      );
    }

    if (uploadEligibility.isRateLimited) {
      return NextResponse.json(
        { error: "TOO_MANY_FAILED_UPLOADS" },
        { status: 429 }
      );
    }

    if (!uploadEligibility.activeCycleId) {
      return NextResponse.json(
        { error: "No active voting cycle" },
        { status: 400 }
      );
    }

    if (
      uploadEligibility.alreadyUploaded &&
      !uploadEligibility.uploadLimitBypassed
    ) {
      return failUpload({
        discordUserId,
        cycleId: uploadEligibility.activeCycleId,
        reason: "duplicate_submission",
        error: "You already uploaded for this cycle",
        status: 400,
      });
    }

    await touchUserLog({ discordUserId });

    const formData = await req.formData();
    const fileEntry = formData.get("file");

    if (!(fileEntry instanceof File)) {
      return failUpload({
        discordUserId,
        reason: "no_file",
        error: "No file provided",
        status: 400,
      });
    }

    const file = fileEntry;

    if (file.size > MAX_UPLOAD_SIZE) {
      return failUpload({
        discordUserId,
        reason: "file_size",
        error: "File too large",
        status: 400,
      });
    }

    const walletAddress =
      formData.get("walletAddress")?.toString().trim() ?? "";
    const payoutChoice = formData.get("payoutChoice")?.toString() ?? null;
    const splitPercentRaw = formData.get("splitPercent")?.toString();
    const charityRaw = formData.get("charity")?.toString().trim() ?? "";
    const splitPercent = splitPercentRaw
      ? parseInt(splitPercentRaw, 10)
      : null;
    const normalizedCharity =
      charityRaw.length > 0 ? charityRaw : null;

    if (!payoutChoice) {
      return failUpload({
        discordUserId,
        reason: "validation_failed",
        error: "Missing submission metadata",
        status: 400,
      });
    }

    if (
      (payoutChoice === "keep" || payoutChoice === "split") &&
      !walletAddress
    ) {
      return failUpload({
        discordUserId,
        reason: "validation_failed",
        error: "Wallet address required",
        status: 400,
      });
    }

    if (
      payoutChoice === "split" &&
      (!splitPercent || splitPercent <= 0 || splitPercent >= 100)
    ) {
      return failUpload({
        discordUserId,
        reason: "validation_failed",
        error: "Invalid split percentage",
        status: 400,
      });
    }

    if (
      (payoutChoice === "donate" || payoutChoice === "split") &&
      !normalizedCharity
    ) {
      return failUpload({
        discordUserId,
        reason: "validation_failed",
        error: "Charity required",
        status: 400,
      });
    }

    if (!ALLOWED_TYPES.includes(file.type)) {
      return failUpload({
        discordUserId,
        reason: "invalid_file_type",
        error: "Invalid file type",
        status: 400,
      });
    }

    const submissionSplitPercent =
      payoutChoice === "split" ? splitPercent : null;
    const submissionCharity =
      payoutChoice === "donate" || payoutChoice === "split"
        ? normalizedCharity
        : null;
    const normalizedWalletAddress =
      payoutChoice === "donate" ? "" : walletAddress;

    const inputBuffer = Buffer.from(await file.arrayBuffer());
    const webpBuffer = await sharp(inputBuffer)
      .rotate()
      .webp({ quality: 75 })
      .toBuffer();

    const r2Key = `${uploadEligibility.activeCycleId}/${crypto.randomUUID()}.webp`;
    uploadedR2Key = r2Key;

    await r2.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME!,
        Key: r2Key,
        Body: webpBuffer,
        ContentType: "image/webp",
      })
    );

    const { data: userLog } = await supabaseAdmin
      .from("user_logs")
      .select(
        "current_discord_username, show_socials_on_submissions"
      )
      .eq("discord_user_id", discordUserId)
      .maybeSingle();

    const discordUsernameAtUpload =
      userLog?.current_discord_username ?? "unknown";

    const { data: submission, error: insertError } = await supabaseAdmin
      .from("submissions")
      .insert({
        cycle_id: uploadEligibility.activeCycleId,
        discord_user_id: discordUserId,
        r2_key: r2Key,
        discord_username_at_upload: discordUsernameAtUpload,
      })
      .select()
      .single();

    if (insertError || !submission) {
      if (isUniqueViolation(insertError)) {
        await cleanupUploadedObject(uploadedR2Key);
        uploadedR2Key = null;

        return failUpload({
          discordUserId,
          cycleId: uploadEligibility.activeCycleId,
          reason: "duplicate_submission",
          error: "You already uploaded for this cycle",
          status: 400,
        });
      }

      await logUpload({
        cycleId: uploadEligibility.activeCycleId,
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
        x_username: null,
        wallet_address: normalizedWalletAddress,
        payout_choice: payoutChoice,
        split_percent: submissionSplitPercent,
        charity: submissionCharity,
      });

    if (privateError) {
      await logUpload({
        cycleId: uploadEligibility.activeCycleId,
        discordUserId,
        submissionId: submission.id,
        status: "failed",
        reason: "db_error",
      });

      throw privateError;
    }

    if (userLog?.show_socials_on_submissions) {
      const { data: socialLinks, error: socialLinksError } =
        await supabaseAdmin
          .from("user_social_links")
          .select(
            "id, platform, handle, profile_url, is_verified"
          )
          .eq("discord_user_id", discordUserId)
          .eq("is_verified", true)
          .order("created_at", { ascending: true });

      if (socialLinksError) {
        await logUpload({
          cycleId: uploadEligibility.activeCycleId,
          discordUserId,
          submissionId: submission.id,
          status: "failed",
          reason: "db_error",
        });

        throw socialLinksError;
      }

      const snapshotRows = (socialLinks ?? []).map(
        (socialLink) => ({
          submission_id: submission.id,
          discord_user_id: discordUserId,
          platform: socialLink.platform,
          display_label: getSocialDisplayLabel({
            platform: socialLink.platform,
            handle: socialLink.handle,
            profile_url: socialLink.profile_url,
          }),
          profile_url: socialLink.profile_url,
          is_verified_snapshot: socialLink.is_verified,
          source_user_social_link_id: socialLink.id,
        })
      );

      if (snapshotRows.length > 0) {
        const { error: snapshotError } = await supabaseAdmin
          .from("submission_social_links")
          .insert(snapshotRows);

        if (snapshotError) {
          await logUpload({
            cycleId: uploadEligibility.activeCycleId,
            discordUserId,
            submissionId: submission.id,
            status: "failed",
            reason: "db_error",
          });

          throw snapshotError;
        }
      }
    }

    await logUpload({
      cycleId: uploadEligibility.activeCycleId,
      discordUserId,
      submissionId: submission.id,
      status: "success",
    });

    uploadedR2Key = null;

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("UPLOAD ERROR", error);

    await cleanupUploadedObject(uploadedR2Key);

    if (error instanceof Response) {
      throw error;
    }

    return NextResponse.json(
      { error: "Upload failed" },
      { status: 500 }
    );
  }
}
