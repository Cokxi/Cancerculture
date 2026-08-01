import "server-only";

import { AuthError } from "@/lib/auth/AuthError";
import { requireDynamicTeamCapability } from "@/lib/auth/teamAuthorization";
import {
  buildTeamAuthorizationHistoryEntry,
  type TeamAuthorizationAuditRow,
  type TeamAuthorizationHistoryEntry,
} from "@/lib/auth/teamAuthorizationHistoryProjection";
import { supabaseAdmin } from "@/lib/db/admin";

export type {
  TeamAuthorizationAdminAuditContext,
  TeamAuthorizationHistoryEntry,
  TeamAuthorizationRoleSnapshot,
} from "@/lib/auth/teamAuthorizationHistoryProjection";

export const TEAM_AUTHORIZATION_HISTORY_PAGE_SIZE = 25;

export const TEAM_AUTHORIZATION_HISTORY_VIEWS = Object.freeze([
  "team-changes",
  "roles-permissions",
] as const);

export type TeamAuthorizationHistoryView =
  (typeof TEAM_AUTHORIZATION_HISTORY_VIEWS)[number];

const EVENT_TYPES_BY_VIEW = Object.freeze({
  "team-changes": Object.freeze([
    "member_added",
    "member_removed",
    "member_role_changed",
    "admin_role_changed",
  ]),
  "roles-permissions": Object.freeze([
    "role_created",
    "role_updated",
    "role_activated",
    "role_deactivated",
    "capability_granted",
    "capability_revoked",
  ]),
} satisfies Readonly<Record<TeamAuthorizationHistoryView, readonly string[]>>);

export type TeamAuthorizationHistoryReadModel = Readonly<{
  view: TeamAuthorizationHistoryView;
  entries: readonly TeamAuthorizationHistoryEntry[];
  page: number;
  pageSize: number;
  total: number;
  isAdmin: boolean;
}>;

type UserLogIdentityRow = {
  discord_user_id: string;
  current_discord_username: string | null;
};

type TeamMemberIdentityRow = {
  discord_user_id: string;
  discord_username: string | null;
};

function addKnownDiscordUsernames(
  namesByDiscordUserId: Map<string, string>,
  rows: readonly { discordUserId: string; discordUsername: string | null }[]
) {
  for (const row of rows) {
    const username = row.discordUsername?.trim() ?? "";
    if (
      !namesByDiscordUserId.has(row.discordUserId) &&
      username.length >= 1 &&
      username.length <= 100
    ) {
      namesByDiscordUserId.set(row.discordUserId, username);
    }
  }
}

function historyUnavailable() {
  return new AuthError(
    503,
    "Team authorization history is temporarily unavailable",
    "TEAM_AUTHORIZATION_HISTORY_UNAVAILABLE"
  );
}

export async function loadTeamAuthorizationHistoryReadModel({
  view,
  page,
}: {
  view: TeamAuthorizationHistoryView;
  page: number;
}): Promise<TeamAuthorizationHistoryReadModel> {
  if (
    !TEAM_AUTHORIZATION_HISTORY_VIEWS.includes(view) ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > Math.floor(Number.MAX_SAFE_INTEGER / TEAM_AUTHORIZATION_HISTORY_PAGE_SIZE)
  ) {
    throw new TypeError("Invalid team authorization history request");
  }

  const authorization = await requireDynamicTeamCapability(
    "logs.team_authorization.view"
  );
  const offset = (page - 1) * TEAM_AUTHORIZATION_HISTORY_PAGE_SIZE;
  const selectedColumns = [
    "id",
    "occurred_at",
    "actor_discord_user_id",
    "actor_role_key",
    "event_type",
    "target_role_key",
    "target_discord_user_id",
    "capability_key",
    "before_state",
    "after_state",
    "reason",
    ...(authorization.isAdmin ? ["request_id"] : []),
  ].join(", ");

  const result = await supabaseAdmin
    .from("team_authorization_audit")
    .select(selectedColumns, { count: "exact" })
    .in("event_type", [...EVENT_TYPES_BY_VIEW[view]])
    .order("occurred_at", { ascending: false })
    .order("id", { ascending: false })
    .range(
      offset,
      offset + TEAM_AUTHORIZATION_HISTORY_PAGE_SIZE - 1
    );

  if (result.error || !Number.isSafeInteger(result.count)) {
    console.error("[TEAM_AUTHORIZATION_HISTORY] read model unavailable", {
      view,
      errorCode: result.error?.code ?? null,
    });
    throw historyUnavailable();
  }

  const auditRows = (result.data ?? []) as unknown as TeamAuthorizationAuditRow[];
  const targetDiscordUserIds =
    view === "team-changes"
      ? [
          ...new Set(
            auditRows.flatMap((row) =>
              row.target_discord_user_id ? [row.target_discord_user_id] : []
            )
          ),
        ]
      : [];
  const namesByDiscordUserId = new Map<string, string>();

  if (targetDiscordUserIds.length > 0) {
    const [userLogsResult, teamMembersResult, memberStateResult] =
      await Promise.all([
        supabaseAdmin
          .from("user_logs")
          .select("discord_user_id, current_discord_username")
          .in("discord_user_id", targetDiscordUserIds),
        supabaseAdmin
          .from("team_members")
          .select("discord_user_id, discord_username")
          .in("discord_user_id", targetDiscordUserIds),
        supabaseAdmin
          .from("discord_member_state")
          .select("discord_user_id, current_discord_username")
          .in("discord_user_id", targetDiscordUserIds),
      ]);

    if (userLogsResult.error || teamMembersResult.error || memberStateResult.error) {
      console.error("[TEAM_AUTHORIZATION_HISTORY] identity lookup unavailable", {
        userLogs: userLogsResult.error?.code ?? null,
        teamMembers: teamMembersResult.error?.code ?? null,
        memberState: memberStateResult.error?.code ?? null,
      });
    }

    if (!userLogsResult.error) {
      addKnownDiscordUsernames(
        namesByDiscordUserId,
        ((userLogsResult.data ?? []) as unknown as UserLogIdentityRow[]).map(
          (row) => ({
            discordUserId: row.discord_user_id,
            discordUsername: row.current_discord_username,
          })
        )
      );
    }
    if (!teamMembersResult.error) {
      addKnownDiscordUsernames(
        namesByDiscordUserId,
        (
          (teamMembersResult.data ?? []) as unknown as TeamMemberIdentityRow[]
        ).map((row) => ({
          discordUserId: row.discord_user_id,
          discordUsername: row.discord_username,
        }))
      );
    }
    if (!memberStateResult.error) {
      addKnownDiscordUsernames(
        namesByDiscordUserId,
        ((memberStateResult.data ?? []) as unknown as UserLogIdentityRow[]).map(
          (row) => ({
            discordUserId: row.discord_user_id,
            discordUsername: row.current_discord_username,
          })
        )
      );
    }
  }

  const entries = auditRows.map((row) =>
    buildTeamAuthorizationHistoryEntry(
      row,
      authorization.isAdmin,
      row.target_discord_user_id
        ? namesByDiscordUserId.get(row.target_discord_user_id) ?? null
        : null
    )
  );

  return Object.freeze({
    view,
    entries: Object.freeze(entries),
    page,
    pageSize: TEAM_AUTHORIZATION_HISTORY_PAGE_SIZE,
    total: result.count ?? 0,
    isAdmin: authorization.isAdmin,
  });
}
