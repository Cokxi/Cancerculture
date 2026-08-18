export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getAuthErrorStatus } from "@/lib/auth/AuthError";
import { enforceRouteMutationGate } from "@/lib/writeGate.server";
import { loadWalletIssueMonitor } from "@/lib/walletIssues/service.server";

export async function POST() {
  const gate = enforceRouteMutationGate();
  if (gate) return gate;
  try {
    return NextResponse.json(await loadWalletIssueMonitor(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const status = getAuthErrorStatus(error) ?? 503;
    return NextResponse.json({ error: status === 403 ? "FORBIDDEN" : "UNAVAILABLE" }, {
      status,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
