export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import { requireDynamicTeamCapability } from "@/lib/auth/teamAuthorization";
import { getRouteErrorResponse } from "@/lib/http/getRouteErrorResponse";
import { getTeamPayoutLogs } from "@/lib/payouts/service.server";

const EXPORT_LIMIT = 500;

export async function GET() {
  try {
    const authorization = await requireDynamicTeamCapability("winners.payout_logs.view");
    const items = await getTeamPayoutLogs(authorization.discord_user_id, EXPORT_LIMIT);
    const exportedAt = new Date().toISOString();
    const payload = {
      schemaVersion: 1,
      exportedAt,
      entryCount: items.length,
      truncated: items.length === EXPORT_LIMIT,
      limit: EXPORT_LIMIT,
      items,
    };

    return new NextResponse(JSON.stringify(payload, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="cancerculture-payout-audit-${exportedAt.slice(0, 10)}.json"`,
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const response = getRouteErrorResponse(error);
    response.headers.set("Cache-Control", "private, no-store, max-age=0");
    response.headers.set("X-Content-Type-Options", "nosniff");
    return response;
  }
}
