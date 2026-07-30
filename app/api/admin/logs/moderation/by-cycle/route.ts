export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/guards";
import { supabaseAdmin } from "@/lib/db/admin";
import { getRouteErrorResponse } from "@/lib/http/getRouteErrorResponse";

export async function GET() {
  try {
    
    await requireAdmin();

    
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

    
    const { data: logs, error: logsError } = await supabaseAdmin
      .from("moderation_action_logs")
      .select(
        "id, created_at, action, target_type, target_id, reason_code, reason_text, actor_role, actor_id"
      )
      .eq("target_type", "submission")
      .order("created_at", { ascending: false })
      .limit(500);

    if (logsError || !logs) {
      return NextResponse.json(
        { error: "Failed to load moderation logs" },
        { status: 500 }
      );
    }

    
    const submissionIds = Array.from(
      new Set(
        logs
          .map((l) => Number(l.target_id))
          .filter((id) => !isNaN(id))
      )
    );

    
    const { data: submissions, error: submissionsError } =
      submissionIds.length > 0
        ? await supabaseAdmin
            .from("submissions")
            .select("id, cycle_id")
            .in("id", submissionIds)
        : { data: [], error: null };

    if (submissionsError) {
      return NextResponse.json(
        { error: "Failed to load submissions" },
        { status: 500 }
      );
    }

    
    const submissionToCycle: Record<number, number> = {};
    for (const sub of submissions ?? []) {
      submissionToCycle[sub.id] = sub.cycle_id;
    }

    
    const actorIds = Array.from(
      new Set(
        logs
          .map((l) => l.actor_id)
          .filter((id): id is string => typeof id === "string" && id.length > 0)
      )
    );

    
    const { data: actorUsers, error: actorUsersError } =
      actorIds.length > 0
        ? await supabaseAdmin
            .from("user_logs")
            .select(
              "discord_user_id, current_discord_username, known_discord_usernames"
            )
            .in("discord_user_id", actorIds)
        : { data: [], error: null };

    if (actorUsersError) {
      return NextResponse.json(
        { error: "Failed to load actor user logs" },
        { status: 500 }
      );
    }

    
    const actorMap: Record<
      string,
      {
        username: string | null;
        known_usernames: string[];
      }
    > = {};

    for (const user of actorUsers ?? []) {
      actorMap[user.discord_user_id] = {
        username: user.current_discord_username ?? null,
        known_usernames: user.known_discord_usernames ?? [],
      };
    }

    
    const logsByCycle: Partial<
      Record<
        number | "unknown",
        Array<{
          id: string;
          created_at: string;
          action: string;
          submission_id: number;
          reason_code: string | null;
          reason_text: string | null;
          actor: {
            id: string;
            role: string;
            username: string | null;
          } | null;
        }>
      >
    > = {};


    for (const log of logs) {
      const submissionId = Number(log.target_id);
      const cycleId =
        submissionToCycle[submissionId] !== undefined
          ? submissionToCycle[submissionId]
          : "unknown";

      if (!logsByCycle[cycleId]) {
        logsByCycle[cycleId] = [];
      }

      const actor = log.actor_id
        ? actorMap[log.actor_id] ?? null
        : null;

      logsByCycle[cycleId].push({
        id: log.id,
        created_at: log.created_at,
        action: log.action,
        submission_id: submissionId,
        reason_code: log.reason_code,
        reason_text: log.reason_text,

        actor: log.actor_id
          ? {
              id: log.actor_id,
              role: log.actor_role,
              username: actor?.username ?? null,
            }
          : null,
      });
    }

    
    const response = [
      ...cycles.map((cycle) => ({
        cycle,
        logs: logsByCycle[cycle.id] ?? [],
      })),
      logsByCycle["unknown"]
        ? {
            cycle: {
              id: "unknown",
              status: "legacy",
              starts_at: null,
              ends_at: null,
            },
            logs: logsByCycle["unknown"],
          }
        : null,
    ].filter(Boolean);

    return NextResponse.json({ cycles: response });
  } catch (error) {
    return getRouteErrorResponse(error);
  }
}
