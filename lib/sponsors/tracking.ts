import "server-only";
import { createHash, randomUUID } from "crypto";
import { cookies } from "next/headers";
import { supabaseAdmin } from "@/lib/db/admin";

export const SPONSOR_TRACKING_SURFACES = [
  "home_hud",
  "vote_modal",
  "history_modal",
  "fame_modal",
  "shame_modal",
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
export const SPONSOR_TRACKING_COOLDOWN_HOURS = 24;

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
  return (
    process.env.SPONSOR_TRACKING_SALT ??
    process.env.OWNER_HASH_SECRET ??
    ""
  );
}

function hashViewerId(rawViewerId: string) {
  const salt = getTrackingSalt();

  if (!salt) {
    return null;
  }

  return createHash("sha256")
    .update(`${salt}:${rawViewerId}`)
    .digest("hex");
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
  sponsorshipId,
  surface,
  viewerHash,
}: {
  eventType: SponsorEventType;
  sponsorshipId: number;
  surface: SponsorTrackingSurface;
  viewerHash: string;
}) {
  const cutoff = new Date(
    Date.now() -
      SPONSOR_TRACKING_COOLDOWN_HOURS * 60 * 60 * 1000
  ).toISOString();

  const existingResult = await supabaseAdmin
    .from("sponsor_tracking_events")
    .select("id")
    .eq("sponsorship_id", sponsorshipId)
    .eq("event_type", eventType)
    .eq("surface", surface)
    .eq("viewer_hash", viewerHash)
    .gte("created_at", cutoff)
    .limit(1)
    .maybeSingle();

  if (existingResult.error) {
    console.warn(
      "[sponsor tracking][dedupe]",
      existingResult.error.message
    );
    return { status: "skipped" as const };
  }

  if (existingResult.data) {
    return { status: "deduped" as const };
  }

  const insertResult = await supabaseAdmin
    .from("sponsor_tracking_events")
    .insert({
      sponsorship_id: sponsorshipId,
      event_type: eventType,
      surface,
      viewer_hash: viewerHash,
    });

  if (insertResult.error) {
    console.warn(
      "[sponsor tracking][insert]",
      insertResult.error.message
    );
    return { status: "skipped" as const };
  }

  return { status: "tracked" as const };
}
