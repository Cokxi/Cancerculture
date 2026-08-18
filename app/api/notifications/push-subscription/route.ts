export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getAuthErrorStatus } from "@/lib/auth/AuthError";
import { getValidatedApplicationOrigin } from "@/lib/auth/oauth/safeReturnPath";
import { requireSession } from "@/lib/auth/requireSession";
import {
  PUSH_DEVICE_COOKIE,
  deactivatePushSubscription,
  getVapidPublicConfiguration,
  isPushDeviceId,
  loadPushSubscriptionSettings,
  registerPushSubscription,
  setPushSubscriptionPreference,
} from "@/lib/notifications/pushSubscriptions.server";
import { enforceRouteMutationGate } from "@/lib/writeGate.server";

const responseHeaders = { "Cache-Control": "no-store" };

function setDeviceCookie(response: NextResponse, deviceId: string) {
  response.cookies.set(PUSH_DEVICE_COOKIE, deviceId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}

function validOrigin(request: Request) {
  try {
    const applicationOrigin = getValidatedApplicationOrigin(process.env.NEXT_PUBLIC_BASE_URL);
    const origin = request.headers.get("origin");
    return !origin || origin === applicationOrigin.origin;
  } catch {
    return false;
  }
}

function errorResponse(error: unknown) {
  const status = getAuthErrorStatus(error) ?? 503;
  return NextResponse.json(
    { error: status === 401 ? "NOT_AUTHENTICATED" : status === 400 ? "INVALID_INPUT" : "PUSH_UNAVAILABLE" },
    { status, headers: responseHeaders }
  );
}

export async function GET() {
  try {
    const session = await requireSession();
    const cookieStore = await cookies();
    const current = cookieStore.get(PUSH_DEVICE_COOKIE)?.value;
    const deviceId = isPushDeviceId(current) ? current : randomUUID();
    const settings = await loadPushSubscriptionSettings(session.session_id, deviceId);
    const configuration = getVapidPublicConfiguration();
    const response = NextResponse.json({
      configurationAvailable: configuration.available,
      vapidPublicKey: configuration.publicKey,
      active: settings.active === true,
      categories: Array.isArray(settings.categories) ? settings.categories : [],
    }, { headers: responseHeaders });
    setDeviceCookie(response, deviceId);
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  const gate = enforceRouteMutationGate();
  if (gate) return gate;
  if (!validOrigin(request)) return NextResponse.json({ error: "INVALID_ORIGIN" }, { status: 403 });
  try {
    const session = await requireSession();
    const cookieStore = await cookies();
    const current = cookieStore.get(PUSH_DEVICE_COOKIE)?.value;
    const deviceId = isPushDeviceId(current) ? current : randomUUID();
    const body = await request.json() as Record<string, unknown>;
    const result = await registerPushSubscription({
      sessionId: session.session_id,
      deviceId,
      subscription: body.subscription,
    });
    const response = NextResponse.json(result, { headers: responseHeaders });
    setDeviceCookie(response, deviceId);
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request) {
  const gate = enforceRouteMutationGate();
  if (gate) return gate;
  if (!validOrigin(request)) return NextResponse.json({ error: "INVALID_ORIGIN" }, { status: 403 });
  try {
    const session = await requireSession();
    const deviceId = (await cookies()).get(PUSH_DEVICE_COOKIE)?.value;
    const body = await request.json() as Record<string, unknown>;
    if (!isPushDeviceId(deviceId) || typeof body.categoryKey !== "string" || typeof body.enabled !== "boolean") {
      return NextResponse.json({ error: "INVALID_INPUT" }, { status: 400, headers: responseHeaders });
    }
    return NextResponse.json(await setPushSubscriptionPreference({
      sessionId: session.session_id,
      deviceId,
      categoryKey: body.categoryKey,
      enabled: body.enabled,
    }), { headers: responseHeaders });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  const gate = enforceRouteMutationGate();
  if (gate) return gate;
  if (!validOrigin(request)) return NextResponse.json({ error: "INVALID_ORIGIN" }, { status: 403 });
  try {
    const session = await requireSession();
    const deviceId = (await cookies()).get(PUSH_DEVICE_COOKIE)?.value;
    if (isPushDeviceId(deviceId)) {
      await deactivatePushSubscription(session.session_id, deviceId);
    }
    const response = NextResponse.json({ outcome: "deactivated" }, { headers: responseHeaders });
    response.cookies.set(PUSH_DEVICE_COOKIE, "", {
      httpOnly: true, secure: process.env.NODE_ENV === "production",
      sameSite: "lax", path: "/", maxAge: 0,
    });
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
