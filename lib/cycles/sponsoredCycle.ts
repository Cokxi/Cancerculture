import "server-only";

import { supabaseAdmin } from "@/lib/db/admin";
import {
  isSponsorDetailBannerKey,
  isSponsorFeedBannerKey,
} from "@/lib/sponsors/bannerMedia.server";
import { createSponsorPresentationGrant } from "@/lib/sponsors/presentationToken.server";
import type { SponsorTrackingSurface } from "@/lib/sponsors/tracking";

export type SponsoredCycleDraft = {
  enabled: boolean;
  companyName: string;
  hasSponsorLink: boolean;
  revision: number;
  detailBanner: { ready: boolean; url: string | null };
  feedBanner: { ready: boolean; url: string | null };
};

export type SponsoredCycleDraftInternal = {
  enabled: boolean;
  companyName: string;
  sponsorLink: string;
  revision: number;
  detailBannerR2Key: string;
  feedBannerR2Key: string;
};

export type SponsoredCycleMeta = {
  enabled: true;
  companyName: string;
  bannerUrl: string;
  clickUrl: string;
  impressionUrl: string;
  measurementToken: string;
  measurementTokenExpiresAt: string;
};

export type CycleSponsorshipSource = {
  sponsorshipId: number;
  cycleId: number;
  enabled: boolean;
  companyName: string;
  sponsorLink: string;
  detailBannerR2Key: string;
  feedBannerR2Key: string | null;
};

const DRAFT_KEYS = {
  enabled: "next_cycle_sponsored_enabled",
  companyName: "next_cycle_sponsor_name",
  sponsorLink: "next_cycle_sponsor_link",
  detailBannerR2Key: "next_cycle_sponsor_banner_r2_key",
  feedBannerR2Key: "next_cycle_sponsor_feed_banner_r2_key",
  revision: "next_cycle_sponsor_draft_revision",
} as const;

function normalizeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeRevision(value: unknown) {
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
}

function safeSponsorTarget(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export async function getSponsoredCycleDraftInternal(): Promise<SponsoredCycleDraftInternal> {
  const { data, error } = await supabaseAdmin
    .from("app_config")
    .select("key, value")
    .in("key", Object.values(DRAFT_KEYS));
  if (error) throw new Error("SPONSOR_DRAFT_READ_FAILED");

  const config = Object.fromEntries(
    (data ?? []).map((row) => [row.key, row.value])
  );
  return {
    enabled: config[DRAFT_KEYS.enabled] === "true",
    companyName: normalizeString(config[DRAFT_KEYS.companyName]),
    sponsorLink: normalizeString(config[DRAFT_KEYS.sponsorLink]),
    revision: normalizeRevision(config[DRAFT_KEYS.revision]),
    detailBannerR2Key: normalizeString(config[DRAFT_KEYS.detailBannerR2Key]),
    feedBannerR2Key: normalizeString(config[DRAFT_KEYS.feedBannerR2Key]),
  };
}

export function toSponsoredCycleDraft(
  draft: SponsoredCycleDraftInternal
): SponsoredCycleDraft {
  const detailReady = isSponsorDetailBannerKey(draft.detailBannerR2Key);
  const feedReady = isSponsorFeedBannerKey(draft.feedBannerR2Key);
  return {
    enabled: draft.enabled,
    companyName: draft.companyName,
    hasSponsorLink: Boolean(safeSponsorTarget(draft.sponsorLink)),
    revision: draft.revision,
    detailBanner: {
      ready: detailReady,
      url: detailReady
        ? `/api/admin/cycles/sponsored-draft/media?role=detail&revision=${draft.revision}`
        : null,
    },
    feedBanner: {
      ready: feedReady,
      url: feedReady
        ? `/api/admin/cycles/sponsored-draft/media?role=feed&revision=${draft.revision}`
        : null,
    },
  };
}

export async function getSponsoredCycleDraft(): Promise<SponsoredCycleDraft> {
  return toSponsoredCycleDraft(await getSponsoredCycleDraftInternal());
}

function mapSponsorshipSource(data: Record<string, unknown>) {
  const sponsorshipId = Number(data.id);
  const cycleId = Number(data.cycle_id);
  const companyName = normalizeString(data.sponsor_name);
  const sponsorLink = safeSponsorTarget(data.sponsor_link);
  const detailBannerR2Key = normalizeString(data.banner_r2_key);
  const feedBannerR2Key = normalizeString(data.feed_banner_r2_key);
  if (
    !Number.isSafeInteger(sponsorshipId) ||
    sponsorshipId <= 0 ||
    !Number.isSafeInteger(cycleId) ||
    cycleId <= 0 ||
    companyName.length === 0 ||
    companyName.length > 120 ||
    !sponsorLink ||
    !isSponsorDetailBannerKey(detailBannerR2Key)
  ) {
    return null;
  }

  return {
    sponsorshipId,
    cycleId,
    enabled: data.is_active === true,
    companyName,
    sponsorLink,
    detailBannerR2Key,
    feedBannerR2Key: isSponsorFeedBannerKey(feedBannerR2Key)
      ? feedBannerR2Key
      : null,
  } satisfies CycleSponsorshipSource;
}

export async function getCycleSponsorshipSource(
  cycleId: number
): Promise<CycleSponsorshipSource | null> {
  const { data, error } = await supabaseAdmin
    .from("cycle_sponsorships")
    .select(
      "id, cycle_id, sponsor_name, sponsor_link, banner_r2_key, feed_banner_r2_key, is_active"
    )
    .eq("cycle_id", cycleId)
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return mapSponsorshipSource(data as Record<string, unknown>);
}

export async function getCycleSponsorshipSourceById(
  sponsorshipId: number
): Promise<CycleSponsorshipSource | null> {
  const { data, error } = await supabaseAdmin
    .from("cycle_sponsorships")
    .select(
      "id, cycle_id, sponsor_name, sponsor_link, banner_r2_key, feed_banner_r2_key, is_active"
    )
    .eq("id", sponsorshipId)
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return mapSponsorshipSource(data as Record<string, unknown>);
}

export async function getCycleSponsoredMeta(
  cycleId: number,
  surface: Exclude<SponsorTrackingSurface, "spread">
): Promise<SponsoredCycleMeta | null> {
  const source = await getCycleSponsorshipSource(cycleId);
  if (!source || (!source.enabled && surface !== "spread_detail")) return null;
  if (surface === "spread_detail" && !source.feedBannerR2Key) return null;
  const grant = createSponsorPresentationGrant({
    sponsorshipId: source.sponsorshipId,
    surface,
  });
  if (!grant) return null;

  const query = new URLSearchParams({ surface, token: grant.token }).toString();
  return {
    enabled: true,
    companyName: source.companyName,
    bannerUrl: `/api/sponsor/banner?${query}`,
    clickUrl: `/api/sponsor/click?${query}`,
    impressionUrl: `/api/sponsor/impression?${query}`,
    measurementToken: grant.token,
    measurementTokenExpiresAt: grant.expiresAt,
  };
}
