export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getCycleSponsorshipSourceById } from "@/lib/cycles/sponsoredCycle";
import { verifySponsorPresentationGrant } from "@/lib/sponsors/presentationToken.server";
import {
  getSponsorViewerHash,
  hasSponsorMeasurementConsent,
  recordSponsorEvent,
  SPONSOR_TRACKING_COOKIE,
  SPONSOR_TRACKING_COOKIE_MAX_AGE_SECONDS,
} from "@/lib/sponsors/tracking";
import { enforceRouteMutationGate } from "@/lib/writeGate.server";

export async function GET(request: Request) {
  const gateResponse = enforceRouteMutationGate();
  if (gateResponse) return gateResponse;

  const url = new URL(request.url);
  const grant = verifySponsorPresentationGrant({
    token: url.searchParams.get("token") ?? "",
    surface: url.searchParams.get("surface"),
  });
  if (!grant) return NextResponse.redirect(new URL("/", request.url));

  const source = await getCycleSponsorshipSourceById(grant.sponsorshipId);
  if (!source) return NextResponse.redirect(new URL("/", request.url));

  let anonymousViewerId: string | null = null;
  if (await hasSponsorMeasurementConsent()) {
    const viewer = await getSponsorViewerHash();
    anonymousViewerId = viewer.anonymousViewerId;
    if (viewer.viewerHash) {
      await recordSponsorEvent({
        eventType: "click",
        sponsorshipId: source.sponsorshipId,
        surface: grant.surface,
        viewerHash: viewer.viewerHash,
      });
    }
  }

  const response = NextResponse.redirect(source.sponsorLink);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  if (anonymousViewerId) {
    response.cookies.set(SPONSOR_TRACKING_COOKIE, anonymousViewerId, {
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      path: "/",
      maxAge: SPONSOR_TRACKING_COOKIE_MAX_AGE_SECONDS,
    });
  }
  return response;
}
