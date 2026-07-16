export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getAvatarUploadEligibility } from "@/lib/avatar/uploadProtection";
import { requireSession } from "@/lib/auth/requireSession";
import { getRouteErrorResponse } from "@/lib/http/getRouteErrorResponse";
import { logAvatarUpload } from "@/lib/logging/logAvatarUpload";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { supabaseAdmin } from "@/lib/db/admin";
import { r2 } from "@/lib/r2";
import { AVATAR_MEDIA_PROFILE } from "@/lib/media/profiles";
import {
  MediaValidationError,
  processStaticImage,
} from "@/lib/media/processStaticImage";

export async function POST(req: Request) {
  try {
    const session = await requireSession();
    const discord_user_id = session.discord_user_id;
    const eligibility = await getAvatarUploadEligibility(
      discord_user_id
    );

    if (!eligibility.canUpload) {
      await logAvatarUpload({
        discordUserId: discord_user_id,
        status: "failed",
        reason: "cooldown",
        cooldownUntil: eligibility.nextAllowedAt,
      });

      return NextResponse.json(
        {
          error: `Please wait ${eligibility.cooldownMinutes} minutes before changing your avatar again.`,
          nextAllowedAt: eligibility.nextAllowedAt,
          retryAfterSeconds: eligibility.retryAfterSeconds,
        },
        { status: 429 }
      );
    }

    const formData = await req.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      await logAvatarUpload({
        discordUserId: discord_user_id,
        status: "failed",
        reason: "missing_file",
      });

      return NextResponse.json({ error: "No file" }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const processedImage = await processStaticImage({
      input: buffer,
      claimedMimeType: file.type,
      profile: AVATAR_MEDIA_PROFILE,
    });

    const key = `avatars/${discord_user_id}.webp`;
    const avatarUpdatedAt = new Date().toISOString();

    await r2.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME!,
        Key: key,
        Body: processedImage.buffer,
        ContentType: "image/webp",
        CacheControl: "public, max-age=300",
      })
    );

    const { error: updateError } = await supabaseAdmin
      .from("user_logs")
      .update({
        avatar_key: key,
        avatar_updated_at: avatarUpdatedAt,
      })
      .eq("discord_user_id", discord_user_id);

    if (updateError) {
      console.error("[avatar upload][database]", {
        code: updateError.code,
      });
      throw new Error("AVATAR_UPLOAD_DEPENDENCY_UNAVAILABLE");
    }

    await logAvatarUpload({
      discordUserId: discord_user_id,
      status: "success",
      avatarKey: key,
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    if (err instanceof MediaValidationError) {
      return NextResponse.json(
        { error: err.code },
        { status: err.status }
      );
    }

    console.error("[UPLOAD AVATAR]", {
      errorName: err instanceof Error ? err.name : "UnknownError",
    });
    if (
      typeof err === "object" &&
      err !== null &&
      "status" in err &&
      typeof err.status === "number"
    ) {
      return getRouteErrorResponse(err);
    }

    return NextResponse.json(
      { error: "Upload failed" },
      { status: 500 }
    );
  }
}
