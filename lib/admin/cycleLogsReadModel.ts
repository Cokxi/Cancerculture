import "server-only";

import { AuthError } from "@/lib/auth/AuthError";
import { requireDynamicTeamCapability } from "@/lib/auth/teamAuthorization";
import {
  buildCycleLogEntry,
  CYCLE_LOG_ACTIONS,
  type CycleLogEntry,
  type CycleLogQueryRow,
} from "@/lib/admin/cycleLogProjection";
import { formatDiscordUserLabel } from "@/lib/discord/formatDiscordUserLabel";
import { supabaseAdmin } from "@/lib/db/admin";

export type {
  CycleLogAdminAuditContext,
  CycleLogEntry,
  CycleLogEventType,
} from "@/lib/admin/cycleLogProjection";

export const CYCLE_LOG_PAGE_SIZE = 25;

export type CycleLogsReadModel = Readonly<{
  entries: readonly CycleLogEntry[];
  page: number;
  pageSize: number;
  total: number;
  isAdmin: boolean;
}>;

type UserIdentityRow = {
  discord_user_id: string;
  current_discord_username: string | null;
  public_profile_id?: string | null;
  current_discord_handle?: string | null;
  current_display_name?: string | null;
  current_guild_nickname?: string | null;
};

type CycleThemeRow = {
  id: number;
  theme: string | null;
};

function cycleLogsUnavailable() {
  return new AuthError(
    503,
    "Cycle logs are temporarily unavailable",
    "CYCLE_LOGS_UNAVAILABLE"
  );
}

function parseCycleId(value: string | null): number | null {
  if (!value || !/^[1-9][0-9]{0,18}$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export async function loadCycleLogsReadModel({
  page,
}: {
  page: number;
}): Promise<CycleLogsReadModel> {
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > Math.floor(Number.MAX_SAFE_INTEGER / CYCLE_LOG_PAGE_SIZE)
  ) {
    throw new TypeError("Invalid Cycle Logs request");
  }

  const authorization = await requireDynamicTeamCapability("cycles.logs.view");
  const offset = (page - 1) * CYCLE_LOG_PAGE_SIZE;
  const selectedColumns = [
    "id",
    "created_at",
    "actor_id",
    "action",
    "target_id",
    ...(authorization.isAdmin ? ["actor_type", "target_type", "meta"] : []),
  ].join(", ");

  const result = await supabaseAdmin
    .from("admin_action_logs")
    .select(selectedColumns, { count: "exact" })
    .eq("target_type", "cycle")
    .in("action", [...CYCLE_LOG_ACTIONS])
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(offset, offset + CYCLE_LOG_PAGE_SIZE - 1);

  if (result.error || !Number.isSafeInteger(result.count)) {
    console.error("[CYCLE_LOGS] read model unavailable", {
      errorCode: result.error?.code ?? null,
    });
    throw cycleLogsUnavailable();
  }

  const rows = (result.data ?? []) as unknown as CycleLogQueryRow[];
  const actorIds = [...new Set(rows.map((row) => row.actor_id).filter(Boolean))];
  const cycleIds = [
    ...new Set(
      rows.flatMap((row) => {
        const cycleId = parseCycleId(row.target_id);
        return cycleId === null ? [] : [cycleId];
      })
    ),
  ];

  const [actorsResult, cyclesResult] = await Promise.all([
    actorIds.length > 0
      ? supabaseAdmin
          .from("user_logs")
          .select(
            authorization.isAdmin
              ? "discord_user_id, public_profile_id, current_discord_username, current_discord_handle, current_display_name, current_guild_nickname"
              : "discord_user_id, current_discord_username"
          )
          .in("discord_user_id", actorIds)
      : Promise.resolve({ data: [], error: null }),
    cycleIds.length > 0
      ? supabaseAdmin
          .from("voting_cycles")
          .select("id, theme")
          .in("id", cycleIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (actorsResult.error || cyclesResult.error) {
    console.error("[CYCLE_LOGS] related display lookup unavailable", {
      actors: actorsResult.error?.code ?? null,
      cycles: cyclesResult.error?.code ?? null,
    });
  }

  const identitiesByDiscordUserId = new Map(
    (
      actorsResult.error
        ? []
        : ((actorsResult.data ?? []) as unknown as UserIdentityRow[])
    ).map((user) => [user.discord_user_id, user])
  );
  const themesByCycleId = new Map(
    (
      cyclesResult.error
        ? []
        : ((cyclesResult.data ?? []) as unknown as CycleThemeRow[])
    ).map((cycle) => [cycle.id, cycle.theme])
  );

  const entries = rows.map((row) => {
    const actor = identitiesByDiscordUserId.get(row.actor_id);
    const cycleId = parseCycleId(row.target_id);
    const delegatedActorName = actor?.current_discord_username?.trim() || null;

    return buildCycleLogEntry(row, authorization.isAdmin, {
      actorLabel:
        authorization.isAdmin && actor
          ? formatDiscordUserLabel(actor, "admin")
          : delegatedActorName,
      actorPublicProfileId:
        authorization.isAdmin && actor ? actor.public_profile_id ?? null : null,
      cycleTheme: cycleId === null ? null : themesByCycleId.get(cycleId) ?? null,
    });
  });

  return Object.freeze({
    entries: Object.freeze(entries),
    page,
    pageSize: CYCLE_LOG_PAGE_SIZE,
    total: result.count ?? 0,
    isAdmin: authorization.isAdmin,
  });
}
