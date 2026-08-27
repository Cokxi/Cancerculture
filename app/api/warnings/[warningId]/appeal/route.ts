export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getAuthErrorStatus } from "@/lib/auth/AuthError";
import { requireSession } from "@/lib/auth/requireSession";
import {
  submitOwnUserWarningAppeal,
  UserWarningAppealConflict,
} from "@/lib/warnings/userWarningAppeal.server";
import { enforceRouteMutationGate } from "@/lib/writeGate.server";

export async function POST(request: Request, context: { params: Promise<{ warningId: string }> }) {
  const gate = enforceRouteMutationGate();
  if (gate) return gate;
  try {
    const [session, { warningId }, body] = await Promise.all([
      requireSession(),
      context.params,
      request.json() as Promise<Record<string, unknown>>,
    ]);
    const result = await submitOwnUserWarningAppeal({
      sessionId: session.session_id,
      publicWarningId: warningId,
      appealText: typeof body.appealText === "string" ? body.appealText : "",
      requestId: typeof body.requestId === "string" ? body.requestId : "",
    });
    return NextResponse.json(result, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof UserWarningAppealConflict) {
      return NextResponse.json({ error: error.reason }, { status: 409, headers: { "Cache-Control": "no-store" } });
    }
    const status = getAuthErrorStatus(error) ?? 503;
    return NextResponse.json(
      { error: status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "UNAVAILABLE" },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
