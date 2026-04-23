export const runtime = "nodejs";

import { PutObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/guards";
import { r2 } from "@/lib/r2";
import {
  getSponsoredCycleDraft,
  saveSponsoredCycleDraft,
} from "@/lib/cycles/sponsoredCycle";

const MAX_BANNER_SIZE = 4 * 1024 * 1024;
const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp"];

function getErrorResponse(error: unknown) {
  const message =
    error instanceof Error ? error.message : "Forbidden";
  const status =
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
      ? error.status
      : 403;

  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: Request) {
  try {
    await requireAdmin();

    const formData = await req.formData();
    const enabled = formData.get("enabled") === "true";
    const companyName =
      formData.get("companyName")?.toString().trim() ?? "";
    const sponsorLink =
      formData.get("sponsorLink")?.toString().trim() ?? "";
    const currentBannerR2Key =
      formData.get("currentBannerR2Key")?.toString().trim() ?? "";
    const bannerEntry = formData.get("banner");

    if (enabled && companyName.length === 0) {
      return NextResponse.json(
        { error: "Company name is required" },
        { status: 400 }
      );
    }

    if (sponsorLink.length > 0) {
      try {
        new URL(sponsorLink);
      } catch {
        return NextResponse.json(
          { error: "Sponsor link must be a valid URL" },
          { status: 400 }
        );
      }
    }

    if (enabled && sponsorLink.length === 0) {
      return NextResponse.json(
        { error: "Sponsor link is required" },
        { status: 400 }
      );
    }

    let bannerR2Key = currentBannerR2Key;

    if (bannerEntry instanceof File && bannerEntry.size > 0) {
      if (bannerEntry.size > MAX_BANNER_SIZE) {
        return NextResponse.json(
          { error: "Banner file too large" },
          { status: 400 }
        );
      }

      if (!ALLOWED_TYPES.includes(bannerEntry.type)) {
        return NextResponse.json(
          { error: "Invalid banner file type" },
          { status: 400 }
        );
      }

      const inputBuffer = Buffer.from(
        await bannerEntry.arrayBuffer()
      );
      const webpBuffer = await sharp(inputBuffer)
        .rotate()
        .resize(1200, 600, {
          fit: "cover",
          position: "center",
        })
        .webp({ quality: 82 })
        .toBuffer();

      bannerR2Key = `sponsored-cycles/drafts/${crypto.randomUUID()}.webp`;

      await r2.send(
        new PutObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME!,
          Key: bannerR2Key,
          Body: webpBuffer,
          ContentType: "image/webp",
        })
      );
    }

    const existingDraft = await getSponsoredCycleDraft();
    await saveSponsoredCycleDraft({
      enabled,
      companyName,
      sponsorLink,
      bannerR2Key:
        bannerR2Key || existingDraft.bannerR2Key || "",
    });

    const draft = await getSponsoredCycleDraft();

    return NextResponse.json({
      success: true,
      draft,
    });
  } catch (error) {
    return getErrorResponse(error);
  }
}
