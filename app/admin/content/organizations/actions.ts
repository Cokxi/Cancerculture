"use server";

import { DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { revalidatePath, updateTag } from "next/cache";
import { redirect } from "next/navigation";
import { requireDynamicTeamCapability } from "@/lib/auth/teamAuthorization";
import { processStaticImage } from "@/lib/media/processStaticImage";
import { ORGANIZATION_LOGO_MEDIA_PROFILE } from "@/lib/media/profiles";
import {
  DONATION_ORGANIZATION_CACHE_TAG,
} from "@/lib/organizations/data.server";
import {
  manageDonationOrganization,
  manageSubmissionOrganizationReference,
} from "@/lib/organizations/manage.server";
import type {
  DonationOrganizationDraftPayload,
  DonationOrganizationProviderStatus,
} from "@/lib/organizations/types";
import {
  normalizeOrganizationName,
  normalizeSafePublicHttpsUrl,
} from "@/lib/organizations/urlValidation";
import { r2 } from "@/lib/r2";

const ADMIN_PATH = "/admin/content/organizations";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function requiredText(formData: FormData, key: string, maximum: number) {
  const value = formData.get(key)?.toString().trim() ?? "";
  if (!value || value.length > maximum) throw new Error(`Invalid ${key}`);
  return value;
}

function safeInteger(formData: FormData, key: string, minimum: number) {
  const value = Number(formData.get(key));
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`Invalid ${key}`);
  }
  return value;
}

function requestId(formData: FormData) {
  const value = requiredText(formData, "request_id", 36);
  if (!UUID_PATTERN.test(value)) throw new Error("Invalid request ID");
  return value;
}

function publicKey(formData: FormData) {
  const value = requiredText(formData, "public_key", 80).toLowerCase();
  if (!KEY_PATTERN.test(value)) throw new Error("Invalid public key");
  return value;
}

function invalidateCatalog() {
  updateTag(DONATION_ORGANIZATION_CACHE_TAG);
  revalidatePath("/upload");
  revalidatePath(ADMIN_PATH);
}

function actionErrorTarget(error: unknown) {
  const status = error && typeof error === "object" && "status" in error
    ? Number(error.status)
    : null;
  return status === 403
    ? "permission"
    : status === 409
      ? "conflict"
      : status === 400 || error instanceof Error
        ? "invalid"
        : "unavailable";
}

async function saveDraft(formData: FormData) {
  const authorization = await requireDynamicTeamCapability(
    "donation_organizations.manage"
  );
  const key = publicKey(formData);
  const logoEntry = formData.get("logo");
  let logoR2Key: string | null = null;
  let uploaded = false;

  try {
    if (logoEntry instanceof File && logoEntry.size > 0) {
      const processed = await processStaticImage({
        input: Buffer.from(await logoEntry.arrayBuffer()),
        claimedMimeType: logoEntry.type,
        profile: ORGANIZATION_LOGO_MEDIA_PROFILE,
      });
      logoR2Key = `donation-organizations/logos/${crypto.randomUUID()}.webp`;
      await r2.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME!,
        Key: logoR2Key,
        Body: processed.buffer,
        ContentType: "image/webp",
        CacheControl: "public, max-age=31536000, immutable",
      }));
      uploaded = true;
    }

    const providerStatus = requiredText(formData, "provider_status", 20);
    if (!(["available", "unavailable", "unverified"] as string[]).includes(providerStatus)) {
      throw new Error("Invalid provider status");
    }
    const description = requiredText(formData, "description", 1200);
    if (description.length < 20) throw new Error("Description is too short");
    const payload: DonationOrganizationDraftPayload & { reuseDraftLogo?: boolean } = {
      selectorName: normalizeOrganizationName(formData.get("selector_name")),
      displayName: normalizeOrganizationName(formData.get("display_name"), { maximum: 160 }),
      description,
      displayOrder: safeInteger(formData, "display_order", 1),
      officialWebsiteUrl: normalizeSafePublicHttpsUrl(formData.get("official_website_url")),
      givingBlockUrl: normalizeSafePublicHttpsUrl(formData.get("giving_block_url"), { optional: true }),
      officialSocialUrl: normalizeSafePublicHttpsUrl(formData.get("official_social_url"), { optional: true }),
      providerStatus: providerStatus as DonationOrganizationProviderStatus,
      selectable: formData.get("selectable") === "on",
      legacyLogoUrl: null,
      logoR2Key,
      reuseDraftLogo: logoR2Key === null,
    };
    await manageDonationOrganization({
      actorDiscordUserId: authorization.discord_user_id,
      operation: "save_draft",
      requestId: requestId(formData),
      publicKey: key,
      expectedStateVersion: safeInteger(formData, "expected_state_version", 0),
      payload,
    });
    invalidateCatalog();
  } catch (error) {
    if (uploaded && logoR2Key && process.env.R2_BUCKET_NAME) {
      await r2.send(new DeleteObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: logoR2Key,
      })).catch(() => undefined);
    }
    throw error;
  }
}

export async function saveOrganizationDraftAction(formData: FormData) {
  try {
    await saveDraft(formData);
  } catch (error) {
    console.error("[DONATION_ORGANIZATIONS][save action]", {
      type: actionErrorTarget(error),
    });
    redirect(`${ADMIN_PATH}?error=${actionErrorTarget(error)}`);
  }
  redirect(`${ADMIN_PATH}?notice=draft-saved`);
}

export async function transitionOrganizationAction(formData: FormData) {
  try {
    const authorization = await requireDynamicTeamCapability(
      "donation_organizations.manage"
    );
    const operation = requiredText(formData, "operation", 20);
    if (operation !== "publish" && operation !== "archive") {
      throw new Error("Invalid operation");
    }
    await manageDonationOrganization({
      actorDiscordUserId: authorization.discord_user_id,
      operation,
      requestId: requestId(formData),
      publicKey: publicKey(formData),
      expectedStateVersion: safeInteger(formData, "expected_state_version", 1),
      reason: operation === "archive" ? requiredText(formData, "reason", 500) : null,
    });
    invalidateCatalog();
  } catch (error) {
    redirect(`${ADMIN_PATH}?error=${actionErrorTarget(error)}`);
  }
  redirect(`${ADMIN_PATH}?notice=organization-updated`);
}

export async function reviewOtherOrganizationAction(formData: FormData) {
  try {
    const authorization = await requireDynamicTeamCapability(
      "donation_organizations.manage"
    );
    const operation = requiredText(formData, "operation", 30);
    if (!(["verify", "correct", "quarantine", "create_candidate"] as string[]).includes(operation)) {
      throw new Error("Invalid operation");
    }
    const needsReference = operation !== "quarantine";
    await manageSubmissionOrganizationReference({
      actorDiscordUserId: authorization.discord_user_id,
      requestId: requestId(formData),
      submissionId: safeInteger(formData, "submission_id", 1),
      expectedVersion: safeInteger(formData, "expected_version", 1),
      operation: operation as "verify" | "correct" | "quarantine" | "create_candidate",
      name: needsReference ? normalizeOrganizationName(formData.get("name")) : null,
      websiteUrl: needsReference
        ? normalizeSafePublicHttpsUrl(formData.get("website_url"))
        : null,
      reason: requiredText(formData, "reason", 500),
    });
    invalidateCatalog();
  } catch (error) {
    redirect(`${ADMIN_PATH}?error=${actionErrorTarget(error)}`);
  }
  redirect(`${ADMIN_PATH}?notice=reference-reviewed`);
}
