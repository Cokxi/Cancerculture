import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import {
  evaluateWriteGateRequest,
  resolveWriteGateMode,
  WRITE_GATE_RETRY_AFTER_SECONDS,
} from "@/lib/writeGate";

export function proxy(request: NextRequest) {
  const mode = resolveWriteGateMode({
    configuredMode: process.env.CANCERCULTURE_WRITE_MODE,
    nodeEnvironment: process.env.NODE_ENV,
  });
  const decision = evaluateWriteGateRequest({
    mode,
    method: request.method,
    pathname: request.nextUrl.pathname,
    hasWebsiteSession: request.cookies.has("session_id"),
  });

  if (decision.allowed) return NextResponse.next();

  return NextResponse.json(
    { error: "Service temporarily unavailable" },
    {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
        "Retry-After": String(WRITE_GATE_RETRY_AFTER_SECONDS),
      },
    }
  );
}

export const config = {
  matcher: ["/:path*"],
};
