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

export async function POST(request: Request) {
  const gateResponse = enforceRouteMutationGate();
  if (gateResponse) return gateResponse;

  const url = new URL(request.url);
  const body = await request.json().catch(() => null);
  const token = typeof body?.token === "string" ? body.token : "";
  const grant = verifySponsorPresentationGrant({
    token,
    surface: url.searchParams.get("surface"),
  });
  if (!grant || url.searchParams.get("token") !== token) {
    return new NextResponse(null, {
      status: 204,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const source = await getCycleSponsorshipSourceById(grant.sponsorshipId);
  if (!source || !(await hasSponsorMeasurementConsent())) {
    return new NextResponse(null, {
      status: 204,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const { anonymousViewerId, viewerHash } = await getSponsorViewerHash();
  if (viewerHash) {
    await recordSponsorEvent({
      eventType: "impression",
      sponsorshipId: source.sponsorshipId,
      surface: grant.surface,
      viewerHash,
    });
  }
  const response = new NextResponse(null, {
    status: 204,
    headers: { "Cache-Control": "no-store" },
  });
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
