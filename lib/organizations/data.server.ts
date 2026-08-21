import "server-only";

import { unstable_cache } from "next/cache";
import { supabaseAdmin } from "@/lib/db/admin";
import type {
  DonationOrganizationProviderStatus,
  PublicDonationOrganization,
} from "./types";
import { normalizeSafePublicHttpsUrl } from "./urlValidation";

export const DONATION_ORGANIZATION_CACHE_TAG =
  "public-content:donation-organizations";

const PUBLIC_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function isProviderStatus(
  value: unknown
): value is DonationOrganizationProviderStatus {
  return value === "available" || value === "unavailable" || value === "unverified";
}

function requiredString(value: unknown, minimum: number, maximum: number) {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
    throw new Error("Invalid donation organization catalog response");
  }
  return value;
}

function validateCatalog(value: unknown): readonly PublicDonationOrganization[] {
  if (!Array.isArray(value)) throw new Error("Invalid donation organization catalog response");
  const keys = new Set<string>();
  const organizations = value.map((entry) => {
    if (!entry || typeof entry !== "object") {
      throw new Error("Invalid donation organization catalog response");
    }
    const row = entry as Record<string, unknown>;
    const publicKey = requiredString(row.publicKey, 1, 80);
    if (!PUBLIC_KEY_PATTERN.test(publicKey) || keys.has(publicKey)) {
      throw new Error("Invalid donation organization catalog response");
    }
    keys.add(publicKey);
    if (
      !Number.isSafeInteger(row.displayOrder) ||
      Number(row.displayOrder) < 1 ||
      !Number.isSafeInteger(row.revisionNumber) ||
      Number(row.revisionNumber) < 1 ||
      !isProviderStatus(row.providerStatus) ||
      typeof row.selectable !== "boolean" ||
      (row.selectable && row.providerStatus !== "available") ||
      typeof row.hasManagedLogo !== "boolean"
    ) {
      throw new Error("Invalid donation organization catalog response");
    }
    const legacyLogoUrl = row.logoUrl === null
      ? null
      : normalizeSafePublicHttpsUrl(row.logoUrl);
    if (!legacyLogoUrl && row.hasManagedLogo !== true) {
      throw new Error("Invalid donation organization catalog response");
    }
    return Object.freeze({
      publicKey,
      selectorName: requiredString(row.selectorName, 2, 120),
      displayName: requiredString(row.displayName, 2, 160),
      description: requiredString(row.description, 20, 1200),
      displayOrder: Number(row.displayOrder),
      officialWebsiteUrl: normalizeSafePublicHttpsUrl(row.officialWebsiteUrl),
      givingBlockUrl: normalizeSafePublicHttpsUrl(row.givingBlockUrl, { optional: true }),
      officialSocialUrl: normalizeSafePublicHttpsUrl(row.officialSocialUrl, { optional: true }),
      providerStatus: row.providerStatus,
      selectable: row.selectable,
      logoUrl: legacyLogoUrl ?? `/api/donation-organizations/${publicKey}/logo`,
      revisionNumber: Number(row.revisionNumber),
    });
  });
  return Object.freeze(organizations);
}

async function loadDonationOrganizationCatalog() {
  const { data, error } = await supabaseAdmin.rpc(
    "get_donation_organization_catalog"
  );
  if (error) {
    console.error("[DONATION_ORGANIZATIONS][catalog]", { code: error.code });
    throw new Error("Donation organization catalog is unavailable");
  }
  return validateCatalog(data);
}

export const getDonationOrganizationCatalog = unstable_cache(
  loadDonationOrganizationCatalog,
  ["donation-organization-catalog-v1"],
  { tags: [DONATION_ORGANIZATION_CACHE_TAG], revalidate: 86_400 }
);

export async function getDonationOrganizationManagement(
  actorDiscordUserId: string
) {
  const { data, error } = await supabaseAdmin.rpc(
    "get_donation_organization_management",
    { p_actor_discord_user_id: actorDiscordUserId }
  );
  if (error) {
    console.error("[DONATION_ORGANIZATIONS][management]", { code: error.code });
    throw new Error("Donation organization management is unavailable");
  }
  return data as {
    organizations: unknown[];
    otherReferences: unknown[];
  };
}
