import { supabaseAdmin } from "@/lib/db/admin";
import { getPublicImageUrl } from "@/lib/r2/getPublicImageUrl";

export type SponsoredCycleDraft = {
  enabled: boolean;
  companyName: string;
  sponsorLink: string;
  bannerR2Key: string;
  bannerUrl: string | null;
};

export type SponsoredCycleMeta = {
  enabled: boolean;
  companyName: string;
  sponsorLink: string;
  bannerR2Key: string;
  bannerUrl: string | null;
};

const DRAFT_KEYS = {
  enabled: "next_cycle_sponsored_enabled",
  companyName: "next_cycle_sponsor_name",
  sponsorLink: "next_cycle_sponsor_link",
  bannerR2Key: "next_cycle_sponsor_banner_r2_key",
} as const;

function normalizeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeBooleanString(value: unknown) {
  return value === "true";
}

function toDraftFromConfig(config: Record<string, unknown>) {
  const bannerR2Key = normalizeString(
    config[DRAFT_KEYS.bannerR2Key]
  );

  return {
    enabled: normalizeBooleanString(config[DRAFT_KEYS.enabled]),
    companyName: normalizeString(config[DRAFT_KEYS.companyName]),
    sponsorLink: normalizeString(config[DRAFT_KEYS.sponsorLink]),
    bannerR2Key,
    bannerUrl: getPublicImageUrl(bannerR2Key) ?? null,
  };
}

export async function getSponsoredCycleDraft(): Promise<SponsoredCycleDraft> {
  const { data } = await supabaseAdmin
    .from("app_config")
    .select("key, value")
    .in("key", Object.values(DRAFT_KEYS));

  const config = Object.fromEntries(
    (data ?? []).map((row) => [row.key, row.value])
  );

  return toDraftFromConfig(config);
}

export async function saveSponsoredCycleDraft(
  draft: Omit<SponsoredCycleDraft, "bannerUrl">
) {
  const rows = [
    {
      key: DRAFT_KEYS.enabled,
      value: draft.enabled ? "true" : "false",
    },
    {
      key: DRAFT_KEYS.companyName,
      value: draft.companyName || null,
    },
    {
      key: DRAFT_KEYS.sponsorLink,
      value: draft.sponsorLink || null,
    },
    {
      key: DRAFT_KEYS.bannerR2Key,
      value: draft.bannerR2Key || null,
    },
  ];

  const { error } = await supabaseAdmin
    .from("app_config")
    .upsert(rows, { onConflict: "key" });

  if (error) {
    throw new Error(error.message);
  }
}

export async function clearSponsoredCycleDraft() {
  await saveSponsoredCycleDraft({
    enabled: false,
    companyName: "",
    sponsorLink: "",
    bannerR2Key: "",
  });
}

export function getCycleSponsoredMetaKey(cycleId: number) {
  return `cycle_sponsor_meta_${cycleId}`;
}

export async function saveCycleSponsoredMeta(
  cycleId: number,
  meta: Omit<SponsoredCycleMeta, "bannerUrl">
) {
  const { error } = await supabaseAdmin
    .from("app_config")
    .upsert(
      {
        key: getCycleSponsoredMetaKey(cycleId),
        value: JSON.stringify(meta),
      },
      { onConflict: "key" }
    );

  if (error) {
    throw new Error(error.message);
  }
}

export async function getCycleSponsoredMeta(
  cycleId: number
): Promise<SponsoredCycleMeta | null> {
  const { data } = await supabaseAdmin
    .from("app_config")
    .select("value")
    .eq("key", getCycleSponsoredMetaKey(cycleId))
    .maybeSingle();

  if (typeof data?.value !== "string" || data.value.length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(data.value) as {
      enabled?: boolean;
      companyName?: string;
      sponsorLink?: string;
      bannerR2Key?: string;
    };
    const bannerR2Key = normalizeString(parsed.bannerR2Key);

    return {
      enabled: parsed.enabled === true,
      companyName: normalizeString(parsed.companyName),
      sponsorLink: normalizeString(parsed.sponsorLink),
      bannerR2Key,
      bannerUrl: getPublicImageUrl(bannerR2Key) ?? null,
    };
  } catch {
    return null;
  }
}
