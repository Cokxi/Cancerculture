import "server-only";
import { createHmac, randomUUID } from "crypto";
import { cookies } from "next/headers";
import { supabaseAdmin } from "@/lib/db/admin";

export const SPONSOR_TRACKING_SURFACES = [
  "home_hud",
  "vote_modal",
  "history_modal",
  "fame_modal",
  "shame_modal",
  "spread",
] as const;

export const SPONSOR_EVENT_TYPES = [
  "impression",
  "click",
] as const;

export type SponsorTrackingSurface =
  (typeof SPONSOR_TRACKING_SURFACES)[number];

export type SponsorEventType =
  (typeof SPONSOR_EVENT_TYPES)[number];

export const SPONSOR_TRACKING_COOKIE = "sponsor_viewer_id";
export const SPONSOR_TRACKING_CONSENT_COOKIE =
  "sponsor_analytics_consent";
export const SPONSOR_TRACKING_COOKIE_MAX_AGE_SECONDS =
  30 * 24 * 60 * 60;

export function isSponsorTrackingSurface(
  value: unknown
): value is SponsorTrackingSurface {
  return (
    typeof value === "string" &&
    SPONSOR_TRACKING_SURFACES.includes(
      value as SponsorTrackingSurface
    )
  );
}

export function isSponsorEventType(
  value: unknown
): value is SponsorEventType {
  return (
    typeof value === "string" &&
    SPONSOR_EVENT_TYPES.includes(value as SponsorEventType)
  );
}

function getTrackingSalt() {
  return process.env.SPONSOR_MEASUREMENT_HMAC_SECRET ?? "";
}

function hashViewerId(rawViewerId: string) {
  const salt = getTrackingSalt();

  if (!salt) {
    return null;
  }

  return createHmac("sha256", salt)
    .update(rawViewerId)
    .digest("hex");
}

export async function getSponsorMeasurementConsent() {
  const cookieStore = await cookies();
  const value = cookieStore.get(SPONSOR_TRACKING_CONSENT_COOKIE)?.value;
  return value === "granted" || value === "denied" ? value : "unknown";
}

export async function hasSponsorMeasurementConsent() {
  return (await getSponsorMeasurementConsent()) === "granted";
}

export async function getSponsorViewerHash() {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get("session_id")?.value ?? null;

  if (sessionId) {
    const { data: session } = await supabaseAdmin
      .from("sessions")
      .select("discord_user_id, revoked_at")
      .eq("id", sessionId)
      .maybeSingle();

    if (session?.discord_user_id && !session.revoked_at) {
      return {
        viewerHash: hashViewerId(
          `discord:${session.discord_user_id}`
        ),
        anonymousViewerId: null,
      };
    }
  }

  const existingAnonymousId =
    cookieStore.get(SPONSOR_TRACKING_COOKIE)?.value ?? null;
  const anonymousViewerId = existingAnonymousId ?? randomUUID();

  return {
    viewerHash: hashViewerId(`anon:${anonymousViewerId}`),
    anonymousViewerId: existingAnonymousId
      ? null
      : anonymousViewerId,
  };
}

export async function recordSponsorEvent({
  eventType,
  feedKind = null,
  sponsorshipId,
  surface,
  viewerHash,
}: {
  eventType: SponsorEventType;
  feedKind?: "live" | "top10" | "all" | "trash" | null;
  sponsorshipId: number;
  surface: SponsorTrackingSurface;
  viewerHash: string;
}) {
  if (
    (surface === "spread" && !feedKind) ||
    (surface !== "spread" && feedKind !== null)
  ) {
    return { status: "skipped" as const };
  }

  const result = await supabaseAdmin.rpc("record_sponsor_event_v2", {
    p_event_type: eventType,
    p_feed_kind: feedKind,
    p_sponsorship_id: sponsorshipId,
    p_surface: surface,
    p_viewer_hash: viewerHash,
  });

  if (result.error) {
    console.warn(
      "[sponsor tracking][rpc]",
      { code: result.error.code }
    );
    return { status: "skipped" as const };
  }

  const outcome =
    result.data &&
    typeof result.data === "object" &&
    "outcome" in result.data
      ? String(result.data.outcome)
      : "";

  return outcome === "tracked"
    ? { status: "tracked" as const }
    : outcome === "deduped"
      ? { status: "deduped" as const }
      : { status: "skipped" as const };
}
