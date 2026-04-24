export const runtime = "nodejs";

import { NextResponse } from "next/server";
import {
  getSponsorViewerHash,
  isSponsorEventType,
  isSponsorTrackingSurface,
  recordSponsorEvent,
  SPONSOR_TRACKING_COOKIE,
} from "@/lib/sponsors/tracking";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const sponsorshipId = Number(body?.sponsorshipId);

  if (
    !Number.isInteger(sponsorshipId) ||
    sponsorshipId <= 0 ||
    !isSponsorEventType(body?.eventType) ||
    !isSponsorTrackingSurface(body?.surface)
  ) {
    return NextResponse.json(
      { error: "Invalid sponsor tracking event" },
      { status: 400 }
    );
  }

  const { anonymousViewerId, viewerHash } =
    await getSponsorViewerHash();

  const response = NextResponse.json({ ok: true });

  if (anonymousViewerId) {
    response.cookies.set(
      SPONSOR_TRACKING_COOKIE,
      anonymousViewerId,
      {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: 60 * 60 * 24 * 180,
      }
    );
  }

  if (!viewerHash) {
    return response;
  }

  await recordSponsorEvent({
    eventType: body.eventType,
    sponsorshipId,
    surface: body.surface,
    viewerHash,
  });

  return response;
}
