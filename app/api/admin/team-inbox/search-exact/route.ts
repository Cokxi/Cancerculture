export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getAuthErrorStatus } from "@/lib/auth/AuthError";
import { searchTeamInboxExactDiscordId } from "@/lib/teamInbox/teamInbox.server";
import { enforceRouteMutationGate } from "@/lib/writeGate.server";

export async function POST(request: Request) {
  const gate = enforceRouteMutationGate();
  if (gate) return gate;
  try {
    const body = await request.json() as Record<string, unknown>;
    const result = await searchTeamInboxExactDiscordId({
      topicKey: typeof body.topicKey === "string" ? body.topicKey : "",
      exactDiscordId: typeof body.exactDiscordId === "string" ? body.exactDiscordId : "",
      cursor: typeof body.cursor === "string" ? body.cursor : null,
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = getAuthErrorStatus(error) ?? 503;
    return NextResponse.json({ error: status === 403 ? "FORBIDDEN" : status === 400 ? "INVALID_INPUT" : "UNAVAILABLE" }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
