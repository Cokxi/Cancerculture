export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getSubmissionModerationLogs } from "@/lib/admin/moderationLogs";
import { requireDynamicTeamCapability } from "@/lib/auth/teamAuthorization";
import { supabaseAdmin } from "@/lib/db/admin";
import { getRouteErrorResponse } from "@/lib/http/getRouteErrorResponse";

export async function GET() {
  try {
    const authorization = await requireDynamicTeamCapability(
      "logs.submission_moderation.view"
    );

    
    const { data: cycles, error: cyclesError } = await supabaseAdmin
      .from("voting_cycles")
      .select("id, status, theme, starts_at, ends_at")
      .order("id", { ascending: false });

    if (cyclesError || !cycles) {
      return NextResponse.json(
        { error: "Failed to load cycles" },
        { status: 500 }
      );
    }

    
    const { data: logs, error: logsError } =
      await getSubmissionModerationLogs({
        includeAdminDetails: authorization.isAdmin,
      });

    if (logsError || !logs) {
      return NextResponse.json(
        { error: "Failed to load moderation logs" },
        { status: 500 }
      );
    }

    
    const logsByCycle = new Map<number | "unknown", typeof logs>();


    for (const log of logs) {
      const cycleId = log.cycle_id ?? "unknown";
      const cycleLogs = logsByCycle.get(cycleId) ?? [];
      cycleLogs.push(log);
      logsByCycle.set(cycleId, cycleLogs);
    }

    
    const response = [
      ...cycles.map((cycle) => ({
        cycle,
        logs: logsByCycle.get(cycle.id) ?? [],
      })),
      logsByCycle.has("unknown")
        ? {
            cycle: {
              id: "unknown",
              status: "legacy",
              starts_at: null,
              ends_at: null,
            },
            logs: logsByCycle.get("unknown") ?? [],
          }
        : null,
    ].filter(Boolean);

    return NextResponse.json({ cycles: response });
  } catch (error) {
    return getRouteErrorResponse(error);
  }
}
