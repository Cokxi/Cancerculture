export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import {
  getSponsorMeasurementConsent,
  SPONSOR_TRACKING_CONSENT_COOKIE,
  SPONSOR_TRACKING_COOKIE,
  SPONSOR_TRACKING_COOKIE_MAX_AGE_SECONDS,
} from "@/lib/sponsors/tracking";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

export async function GET() {
  return NextResponse.json(
    { status: await getSponsorMeasurementConsent() },
    { headers: NO_STORE_HEADERS }
  );
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const status = body?.status;
  if (status !== "granted" && status !== "denied") {
    return NextResponse.json(
      { error: "Invalid sponsor analytics preference" },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }

  const response = NextResponse.json({ status }, { headers: NO_STORE_HEADERS });
  response.cookies.set(SPONSOR_TRACKING_CONSENT_COOKIE, status, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    maxAge: SPONSOR_TRACKING_COOKIE_MAX_AGE_SECONDS,
  });
  if (status === "denied") {
    response.cookies.set(SPONSOR_TRACKING_COOKIE, "", {
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      path: "/",
      maxAge: 0,
    });
  }
  return response;
}
