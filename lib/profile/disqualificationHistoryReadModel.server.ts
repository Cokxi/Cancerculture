import "server-only";

import { getDelegatedSubmissionModerationReason } from "@/lib/admin/submissionModerationLogAccess";
import { AuthError } from "@/lib/auth/AuthError";
import { requireSession } from "@/lib/auth/requireSession";
import {
  getTeamAuthorizationContext,
  hasResolvedTeamCapability,
  type TeamAuthorizationContext,
} from "@/lib/auth/teamAuthorization";
import { supabaseAdmin } from "@/lib/db/admin";
import { formatDiscordUserLabel } from "@/lib/discord/formatDiscordUserLabel";
import {
  encodeDisqualificationHistoryCursor,
  encodeDisqualificationProfileCursor,
  isDisqualificationPublicProfileId,
  parseDisqualificationHistoryCursor,
  parseDisqualificationProfileCursor,
} from "@/lib/profile/disqualificationHistoryCursor";
import { getPublicImageUrl } from "@/lib/r2/getPublicImageUrl";
import { getSubmissionThumbnailUrl } from "@/lib/r2/getSubmissionThumbnailUrl";
import { getSubmissionDestinationHref } from "@/lib/submissions/getSubmissionDestinationHref";

const PAGE_SIZE = 25;

type ViewerMode = "self" | "owner" | "delegate";

type RawHistoryEvent = {
  id: string;
  transition: "disqualified" | "reinstated";
  occurredAt: string;
  source: string;
  provenance: "complete" | "legacy_partial";
  actorDiscordUserId: string | null;
  actorDisplayName: string | null;
  reasonCode: string;
  reasonText: string | null;
};

type RawHistoryRow = {
  submission_id: number;
  cycle_id: number;
  cycle_status: string;
  subject_discord_user_id: string;
  current_is_disqualified: boolean;
  public_visibility_status: string | null;
  r2_key: string | null;
  latest_event_at: string;
  latest_event_id: string;
  event_count: number;
  events: unknown;
};

type RawProfileRow = {
  discord_user_id: string;
  public_profile_id: string;
  current_discord_username: string | null;
  current_discord_handle: string | null;
  current_display_name: string | null;
  current_guild_nickname: string | null;
  latest_event_at: string;
  current_disqualified_count: number;
  submission_count: number;
  event_count: number;
};

export type DisqualificationHistoryEvent = Readonly<{
  id: string;
  transition: "disqualified" | "reinstated";
  occurredAt: string;
  reasonCategory: string;
  reasonCode: string | null;
  reasonText: string | null;
  actorLabel: string | null;
  source: string | null;
  legacyPartial: boolean;
}>;

export type DisqualificationHistoryItem = Readonly<{
  submissionId: number;
  cycleId: number;
  status: "currently_disqualified" | "reinstated";
  imageUrl: string | null;
  destinationHref: string | null;
  latestEventAt: string;
  eventCount: number;
  legacyPartial: boolean;
  events: readonly DisqualificationHistoryEvent[];
}>;

export type DisqualificationHistoryPage = Readonly<{
  items: readonly DisqualificationHistoryItem[];
  nextCursor: string | null;
  legacyMayBeIncomplete: boolean;
}>;

function readUnavailable(code: string) {
  return new AuthError(
    503,
    "Disqualification history is temporarily unavailable",
    code
  );
}

function requireHistoryCapability(
  authorization: TeamAuthorizationContext
) {
  if (
    !hasResolvedTeamCapability(
      authorization,
      "users.disqualified_submissions.view"
    )
  ) {
    throw new AuthError(403, "Forbidden", "TEAM_CAPABILITY_DENIED");
  }
}

function parseEvents(value: unknown): RawHistoryEvent[] {
  if (!Array.isArray(value)) {
    throw readUnavailable("USER_DQ_HISTORY_EVENT_SHAPE_INVALID");
  }

  return value.map((entry) => {
    if (!entry || typeof entry !== "object") {
      throw readUnavailable("USER_DQ_HISTORY_EVENT_SHAPE_INVALID");
    }

    const event = entry as Record<string, unknown>;
    if (
      typeof event.id !== "string" ||
      (event.transition !== "disqualified" &&
        event.transition !== "reinstated") ||
      typeof event.occurredAt !== "string" ||
      !Number.isFinite(Date.parse(event.occurredAt)) ||
      typeof event.source !== "string" ||
      (event.provenance !== "complete" &&
        event.provenance !== "legacy_partial") ||
      typeof event.reasonCode !== "string"
    ) {
      throw readUnavailable("USER_DQ_HISTORY_EVENT_SHAPE_INVALID");
    }

    return {
      id: event.id,
      transition: event.transition,
      occurredAt: event.occurredAt,
      source: event.source,
      provenance: event.provenance,
      actorDiscordUserId:
        typeof event.actorDiscordUserId === "string"
          ? event.actorDiscordUserId
          : null,
      actorDisplayName:
        typeof event.actorDisplayName === "string"
          ? event.actorDisplayName
          : null,
      reasonCode: event.reasonCode,
      reasonText:
        typeof event.reasonText === "string"
          ? event.reasonText
          : null,
    };
  });
}

function ownerActorLabel(event: RawHistoryEvent) {
  const displayName = event.actorDisplayName?.trim() || null;
  const discordUserId = event.actorDiscordUserId?.trim() || null;

  if (displayName && discordUserId) {
    return `${displayName} • ID: ${discordUserId}`;
  }

  return displayName ?? discordUserId;
}

async function readHistoryPage({
  subjectDiscordUserId,
  cursorValue,
  viewerMode,
}: {
  subjectDiscordUserId: string;
  cursorValue?: string | null;
  viewerMode: ViewerMode;
}): Promise<DisqualificationHistoryPage> {
  const cursor = parseDisqualificationHistoryCursor(cursorValue);
  if (cursorValue && !cursor) {
    throw new AuthError(400, "Invalid history cursor", "DQ_CURSOR_INVALID");
  }

  const { data, error } = await supabaseAdmin.rpc(
    "get_user_disqualification_history",
    {
      p_subject_discord_user_id: subjectDiscordUserId,
      p_after_at: cursor?.at ?? null,
      p_after_event_id: cursor?.eventId ?? null,
      p_limit: PAGE_SIZE + 1,
    }
  );

  if (error) {
    console.error("[USER_DQ_HISTORY] read failed", {
      code: error.code,
    });
    throw readUnavailable("USER_DQ_HISTORY_READ_UNAVAILABLE");
  }

  const rows = (data ?? []) as RawHistoryRow[];
  const visibleRows = rows.slice(0, PAGE_SIZE);
  const items = visibleRows.map((row): DisqualificationHistoryItem => {
    const rawEvents = parseEvents(row.events);
    if (rawEvents.length !== row.event_count || rawEvents.length === 0) {
      throw readUnavailable("USER_DQ_HISTORY_EVENT_COUNT_INVALID");
    }

    const legacyPartial = rawEvents.some(
      (event) => event.provenance === "legacy_partial"
    );
    const latestEvent = rawEvents.at(-1);
    if (
      !latestEvent ||
      (!legacyPartial &&
        (latestEvent.transition === "disqualified") !==
          row.current_is_disqualified)
    ) {
      throw readUnavailable("USER_DQ_HISTORY_STATE_CONFLICT");
    }

    const publicImageUrl =
      row.public_visibility_status === "visible"
        ? getPublicImageUrl(row.r2_key)
        : null;

    return Object.freeze({
      submissionId: row.submission_id,
      cycleId: row.cycle_id,
      status: row.current_is_disqualified
        ? "currently_disqualified"
        : "reinstated",
      imageUrl: publicImageUrl
        ? getSubmissionThumbnailUrl(publicImageUrl)
        : null,
      destinationHref: getSubmissionDestinationHref({
        cycleId: row.cycle_id,
        cycleStatus: row.cycle_status,
        isDisqualified: row.current_is_disqualified,
        publicVisibilityStatus: row.public_visibility_status,
        submissionId: row.submission_id,
      }),
      latestEventAt: row.latest_event_at,
      eventCount: row.event_count,
      legacyPartial,
      events: Object.freeze(
        rawEvents.map((event) => {
          const canViewExactReason =
            viewerMode === "owner" ||
            (viewerMode === "self" &&
              event.transition === "disqualified");

          return Object.freeze({
            id: event.id,
            transition: event.transition,
            occurredAt: event.occurredAt,
            reasonCategory:
              getDelegatedSubmissionModerationReason(event.reasonCode),
            reasonCode: canViewExactReason ? event.reasonCode : null,
            reasonText: canViewExactReason ? event.reasonText : null,
            actorLabel:
              viewerMode === "owner"
                ? ownerActorLabel(event)
                : null,
            source: viewerMode === "owner" ? event.source : null,
            legacyPartial:
              event.provenance === "legacy_partial",
          });
        })
      ),
    });
  });

  const lastVisible = visibleRows.at(-1);
  return Object.freeze({
    items: Object.freeze(items),
    nextCursor:
      rows.length > PAGE_SIZE && lastVisible
        ? encodeDisqualificationHistoryCursor({
            at: lastVisible.latest_event_at,
            eventId: lastVisible.latest_event_id,
          })
        : null,
    legacyMayBeIncomplete: items.some((item) => item.legacyPartial),
  });
}

export async function loadOwnDisqualificationHistory({
  cursor,
}: {
  cursor?: string | null;
}) {
  const session = await requireSession();

  return readHistoryPage({
    subjectDiscordUserId: session.discord_user_id,
    cursorValue: cursor,
    viewerMode: "self",
  });
}

export async function loadTeamDisqualificationHistory({
  publicProfileId,
  cursor,
}: {
  publicProfileId: string;
  cursor?: string | null;
}) {
  const authorization = await getTeamAuthorizationContext();
  requireHistoryCapability(authorization);

  if (!isDisqualificationPublicProfileId(publicProfileId)) {
    throw new AuthError(404, "History not found", "DQ_HISTORY_NOT_FOUND");
  }

  const { data: user, error } = await supabaseAdmin
    .from("user_logs")
    .select(
      "discord_user_id, public_profile_id, current_discord_username, current_discord_handle, current_display_name, current_guild_nickname"
    )
    .eq("public_profile_id", publicProfileId)
    .maybeSingle();

  if (error) {
    console.error("[USER_DQ_HISTORY] target read failed", {
      code: error.code,
    });
    throw readUnavailable("USER_DQ_HISTORY_TARGET_UNAVAILABLE");
  }

  if (!user) {
    throw new AuthError(404, "History not found", "DQ_HISTORY_NOT_FOUND");
  }

  const page = await readHistoryPage({
    subjectDiscordUserId: user.discord_user_id,
    cursorValue: cursor,
    viewerMode: authorization.isAdmin ? "owner" : "delegate",
  });

  return Object.freeze({
    profile: Object.freeze({
      publicProfileId: user.public_profile_id,
      label: formatDiscordUserLabel(
        user,
        authorization.isAdmin ? "admin" : "standard"
      ),
    }),
    page,
  });
}

export async function loadDisqualificationProfiles({
  cursor: cursorValue,
}: {
  cursor?: string | null;
}) {
  const authorization = await getTeamAuthorizationContext();
  requireHistoryCapability(authorization);

  const cursor = parseDisqualificationProfileCursor(cursorValue);
  if (cursorValue && !cursor) {
    throw new AuthError(400, "Invalid profile cursor", "DQ_CURSOR_INVALID");
  }

  const { data, error } = await supabaseAdmin.rpc(
    "get_user_disqualification_profiles",
    {
      p_after_at: cursor?.at ?? null,
      p_after_public_profile_id: cursor?.publicProfileId ?? null,
      p_limit: PAGE_SIZE + 1,
    }
  );

  if (error) {
    console.error("[USER_DQ_PROFILES] read failed", {
      code: error.code,
    });
    throw readUnavailable("USER_DQ_PROFILES_READ_UNAVAILABLE");
  }

  const rows = (data ?? []) as RawProfileRow[];
  const visibleRows = rows.slice(0, PAGE_SIZE);
  const items = visibleRows.map((row) =>
    Object.freeze({
      publicProfileId: row.public_profile_id,
      label: formatDiscordUserLabel(
        row,
        authorization.isAdmin ? "admin" : "standard"
      ),
      latestEventAt: row.latest_event_at,
      currentDisqualifiedCount: row.current_disqualified_count,
      submissionCount: row.submission_count,
      eventCount: row.event_count,
    })
  );
  const lastVisible = visibleRows.at(-1);

  return Object.freeze({
    items: Object.freeze(items),
    nextCursor:
      rows.length > PAGE_SIZE && lastVisible
        ? encodeDisqualificationProfileCursor({
            at: lastVisible.latest_event_at,
            publicProfileId: lastVisible.public_profile_id,
          })
        : null,
  });
}
