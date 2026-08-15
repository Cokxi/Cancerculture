export const runtime = "nodejs";

import { PutObjectCommand } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { getAdminApiErrorResponse } from "@/lib/auth/adminApiErrorResponse";
import { requireDynamicTeamCapability } from "@/lib/auth/teamAuthorization";
import {
  getSponsoredCycleDraft,
  getSponsoredCycleDraftInternal,
} from "@/lib/cycles/sponsoredCycle";
import { supabaseAdmin } from "@/lib/db/admin";
import { r2 } from "@/lib/r2";
import {
  getSponsorBannerStorageKey,
  normalizeSponsorBanner,
} from "@/lib/sponsors/bannerMedia.server";

type NormalizedUpload = Awaited<ReturnType<typeof normalizeSponsorBanner>>;

function validIdempotencyKey(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value
  );
}

function safeSponsorTarget(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function rpcErrorStatus(message: string) {
  if (
    message.includes("SPONSOR_DRAFT_STALE") ||
    message.includes("SPONSOR_UPLOAD_NOT_COMMITTABLE") ||
    message.includes("SPONSOR_UPLOAD_IDEMPOTENCY_MISMATCH")
  ) {
    return 409;
  }
  if (
    message.includes("INVALID_SPONSOR") ||
    message.includes("INCOMPLETE_SPONSOR_SETTINGS")
  ) {
    return 400;
  }
  return 503;
}

export async function POST(req: Request) {
  let reserved:
    | {
        actorDiscordUserId: string;
        idempotencyKey: string;
        requestFingerprint: string;
      }
    | undefined;

  try {
    const authorization =
      await requireDynamicTeamCapability("cycles.manage");
    const formData = await req.formData();
    const idempotencyKey =
      formData.get("idempotencyKey")?.toString().trim() ?? "";
    const expectedRevision = Number(formData.get("revision"));
    const enabled = formData.get("enabled") === "true";
    const companyName =
      formData.get("companyName")?.toString().trim() ?? "";
    const sponsorLinkInput =
      formData.get("sponsorLink")?.toString().trim() ?? "";
    const replaceSponsorLink = sponsorLinkInput.length > 0;
    const sponsorLink = replaceSponsorLink
      ? safeSponsorTarget(sponsorLinkInput)
      : null;
    const detailEntry = formData.get("detailBanner");
    const feedEntry = formData.get("feedBanner");
    const existingDraft = await getSponsoredCycleDraftInternal();

    if (
      !validIdempotencyKey(idempotencyKey) ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      expectedRevision !== existingDraft.revision ||
      companyName.length > 120
    ) {
      return NextResponse.json(
        { error: "Sponsored cycle draft changed or request is invalid" },
        { status: 409 }
      );
    }
    if (replaceSponsorLink && !sponsorLink) {
      return NextResponse.json(
        { error: "Sponsor link must be a valid HTTPS URL" },
        { status: 400 }
      );
    }

    let detailUpload: NormalizedUpload | null = null;
    let feedUpload: NormalizedUpload | null = null;
    try {
      [detailUpload, feedUpload] = await Promise.all([
        detailEntry instanceof File && detailEntry.size > 0
          ? normalizeSponsorBanner({ file: detailEntry, role: "detail" })
          : Promise.resolve(null),
        feedEntry instanceof File && feedEntry.size > 0
          ? normalizeSponsorBanner({ file: feedEntry, role: "feed" })
          : Promise.resolve(null),
      ]);
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      const message =
        code === "SPONSOR_DETAIL_BANNER_DIMENSIONS_INVALID"
          ? "Detail banner must be exactly 2:1 and at least 1200 × 600"
          : code === "SPONSOR_FEED_BANNER_DIMENSIONS_INVALID"
            ? "Feed banner must be exactly 6:1 and at least 1800 × 300"
            : code === "SPONSOR_BANNER_FILE_SIZE_INVALID"
              ? "Each banner must be 4 MiB or smaller"
              : code === "SPONSOR_BANNER_OUTPUT_SIZE_INVALID"
                ? "Normalized banner exceeds the 4 MB delivery limit"
              : "Banner must be a valid PNG, JPEG, or WebP image";
      return NextResponse.json({ error: message }, { status: 400 });
    }

    const detailCandidateKey = detailUpload
      ? getSponsorBannerStorageKey("detail", idempotencyKey)
      : null;
    const feedCandidateKey = feedUpload
      ? getSponsorBannerStorageKey("feed", idempotencyKey)
      : null;
    const requestFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          companyName,
          detailSha256: detailUpload?.sha256 ?? null,
          enabled,
          expectedRevision,
          feedSha256: feedUpload?.sha256 ?? null,
          replaceSponsorLink,
          sponsorLink,
        })
      )
      .digest("hex");

    const { data: reservation, error: reservationError } =
      await supabaseAdmin.rpc("reserve_sponsor_media_upload", {
        p_actor_discord_user_id: authorization.discord_user_id,
        p_idempotency_key: idempotencyKey,
        p_request_fingerprint: requestFingerprint,
        p_expected_draft_revision: expectedRevision,
        p_detail_candidate_r2_key: detailCandidateKey,
        p_feed_candidate_r2_key: feedCandidateKey,
      });
    if (reservationError) {
      return NextResponse.json(
        { error: "Sponsored cycle draft could not be reserved" },
        { status: rpcErrorStatus(reservationError.message) }
      );
    }
    if (reservation?.state === "committed") {
      return NextResponse.json({
        success: true,
        replayed: true,
        draft: await getSponsoredCycleDraft(),
      });
    }
    if (reservation?.state !== "reserved") {
      return NextResponse.json(
        { error: "Sponsored cycle upload is no longer active" },
        { status: 409 }
      );
    }

    reserved = {
      actorDiscordUserId: authorization.discord_user_id,
      idempotencyKey,
      requestFingerprint,
    };

    await Promise.all(
      [
        detailUpload && detailCandidateKey
          ? { upload: detailUpload, key: detailCandidateKey }
          : null,
        feedUpload && feedCandidateKey
          ? { upload: feedUpload, key: feedCandidateKey }
          : null,
      ]
        .filter(
          (
            item
          ): item is { upload: NormalizedUpload; key: string } => item !== null
        )
        .map(({ upload, key }) =>
          r2.send(
            new PutObjectCommand({
              Bucket: process.env.R2_BUCKET_NAME!,
              Key: key,
              Body: upload.bytes,
              ContentType: "image/webp",
            })
          )
        )
    );

    const { error: commitError } = await supabaseAdmin.rpc(
      "commit_sponsor_media_upload",
      {
        p_actor_discord_user_id: authorization.discord_user_id,
        p_idempotency_key: idempotencyKey,
        p_request_fingerprint: requestFingerprint,
        p_enabled: enabled,
        p_company_name: companyName,
        p_replace_sponsor_link: replaceSponsorLink,
        p_sponsor_link: sponsorLink,
      }
    );
    if (commitError) {
      throw Object.assign(new Error(commitError.message), {
        status: rpcErrorStatus(commitError.message),
      });
    }

    reserved = undefined;
    return NextResponse.json({
      success: true,
      replayed: false,
      draft: await getSponsoredCycleDraft(),
    });
  } catch (error) {
    if (reserved) {
      try {
        await supabaseAdmin.rpc("abort_sponsor_media_upload", {
          p_actor_discord_user_id: reserved.actorDiscordUserId,
          p_idempotency_key: reserved.idempotencyKey,
          p_request_fingerprint: reserved.requestFingerprint,
        });
      } catch {
        // The persisted reservation remains recoverable by the cleanup worker.
      }
    }
    const status =
      error &&
      typeof error === "object" &&
      "status" in error &&
      typeof error.status === "number" &&
      error.status >= 400 &&
      error.status <= 599
        ? error.status
        : null;
    if (status !== null) {
      return NextResponse.json(
        {
          error:
            status === 409
              ? "Sponsored cycle draft changed; reload and try again"
              : "Sponsored cycle draft could not be saved",
        },
        { status }
      );
    }
    return getAdminApiErrorResponse(
      error,
      "POST /api/admin/cycles/sponsored-draft"
    );
  }
}
