import "server-only";

import { AuthError } from "@/lib/auth/AuthError";
import {
  getTeamAuthorizationContext,
  hasResolvedTeamCapability,
  requireDynamicTeamCapability,
  type TeamAuthorizationContext,
} from "@/lib/auth/teamAuthorization";
import { supabaseAdmin } from "@/lib/db/admin";
import { getPublicImageUrl } from "@/lib/r2/getPublicImageUrl";
import { getSubmissionThumbnailUrl } from "@/lib/r2/getSubmissionThumbnailUrl";
import { canModerateSubmission } from "@/lib/moderation/submissionModerationAuthorization";
import { getSubmissionDestinationHref } from "@/lib/submissions/getSubmissionDestinationHref";
import type { SubmissionReportOutcomeHistoryFilter } from "@/lib/reports/submissionReportOutcomeHistory";
import { addVisibilitySafeSubmissionReportThumbnails } from "@/lib/reports/submissionReportThumbnail.server";

export type SubmissionReportArea = "live" | "finalized";
type JsonObject = Record<string, unknown>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const SUBMISSION_REPORT_AREA_CAPABILITIES = Object.freeze({
  live: "submissions.reports.live.view",
  finalized: "submissions.reports.finalized.view",
} as const);

function readUnavailable(): AuthError {
  return new AuthError(
    503,
    "Submission Report service unavailable",
    "SUBMISSION_REPORT_READ_UNAVAILABLE"
  );
}

function asObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw readUnavailable();
  }
  return value as JsonObject;
}

function asArray(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) throw readUnavailable();
  const result = value.filter(
    (item): item is JsonObject =>
      Boolean(item) && typeof item === "object" && !Array.isArray(item)
  );
  if (result.length !== value.length) throw readUnavailable();
  return result;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function safeInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function assertUuid(value: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new AuthError(
      404,
      "Report record not found",
      "SUBMISSION_REPORT_NOT_FOUND"
    );
  }
}

function readFailure(error: { code?: string | null; message?: string | null }) {
  const message = error.message ?? "";
  if (
    message.includes("SUBMISSION_REPORT_CASE_NOT_FOUND") ||
    message.includes("SUBMISSION_REPORT_REPORTER_NOT_FOUND") ||
    message.includes("SUBMISSION_REPORT_NOT_FOUND")
  ) {
    return new AuthError(
      404,
      "Report record not found",
      "SUBMISSION_REPORT_NOT_FOUND"
    );
  }
  if (error.code === "42501" || message.includes("SUBMISSION_REPORT_FORBIDDEN")) {
    return new AuthError(403, "Forbidden", "TEAM_CAPABILITY_DENIED");
  }
  if (error.code === "PT409") {
    return new AuthError(
      409,
      "The Report case changed. Refresh and try again.",
      "SUBMISSION_REPORT_STALE"
    );
  }
  return readUnavailable();
}

function can(
  authorization: TeamAuthorizationContext,
  capability: Parameters<typeof hasResolvedTeamCapability>[1]
) {
  return hasResolvedTeamCapability(authorization, capability);
}

function getSubmissionAction(
  item: JsonObject,
  authorization: TeamAuthorizationContext,
  historyHref: string | null
) {
  const submissionId = safeInteger(item.submissionId);
  const cycleId = safeInteger(item.cycleId);
  const cycleStatus = text(item.currentCycleStatus);
  if (
    submissionId === null ||
    cycleId === null ||
    item.currentAvailable !== true
  ) {
    return null;
  }

  if (cycleStatus === "submission_open" || cycleStatus === "voting_open") {
    const canOpen = canModerateSubmission(
      authorization,
      cycleStatus,
      "disqualify"
    ) || canModerateSubmission(
      authorization,
      cycleStatus,
      "reinstate"
    );
    return canOpen
      ? Object.freeze({
          href: `/admin/moderation/submissions?submission=${submissionId}`,
          label: "Open Live Moderation",
        })
      : null;
  }

  if (cycleStatus === "voting_closed") {
    const canOpen = canModerateSubmission(
      authorization,
      cycleStatus,
      "disqualify"
    ) || canModerateSubmission(
      authorization,
      cycleStatus,
      "reinstate"
    );
    return canOpen
      ? Object.freeze({
          href: `/admin/cycles/end-moderation?submission=${submissionId}`,
          label: "Open Cycle End Moderation",
        })
      : null;
  }

  return cycleStatus === "finished" && historyHref
    ? Object.freeze({
        href: historyHref,
        label: "Open Cycle History",
      })
    : null;
}

async function addSafeQueueThumbnails(
  cases: JsonObject[],
  authorization: TeamAuthorizationContext
) {
  const ids = Array.from(
    new Set(
      cases
        .filter((item) => item.thumbnailAvailable === true)
        .map((item) => safeInteger(item.submissionId))
        .filter((id): id is number => id !== null)
    )
  );
  const { data, error } = ids.length > 0
    ? await supabaseAdmin.from("submissions").select("id, r2_key").in("id", ids)
    : { data: [], error: null };
  const keyById = new Map<number, string>();
  if (!error) {
    for (const row of data ?? []) {
      const id = safeInteger(row.id);
      const key = text(row.r2_key);
      if (id !== null && key) keyById.set(id, key);
    }
  }

  return cases.map((item) => {
    const id = safeInteger(item.submissionId);
    const publicUrl = id === null ? undefined : getPublicImageUrl(keyById.get(id));
    const cycleId = safeInteger(item.cycleId);
    const destinationHref =
      id !== null && cycleId !== null && item.currentAvailable === true
        ? getSubmissionDestinationHref({
            submissionId: id,
            cycleId,
            cycleStatus: text(item.currentCycleStatus) ?? "",
            isDisqualified: item.currentDisqualified === true,
            publicVisibilityStatus: text(item.currentVisibility),
          })
        : null;
    const submissionAction = getSubmissionAction(
      item,
      authorization,
      destinationHref
    );
    return Object.freeze({
      ...item,
      thumbnailUrl: publicUrl ? getSubmissionThumbnailUrl(publicUrl) : null,
      destinationHref,
      submissionActionHref: submissionAction?.href ?? null,
      submissionActionLabel: submissionAction?.label ?? null,
    });
  });
}

async function addSafeReporterThumbnails(
  history: JsonObject
): Promise<JsonObject> {
  const reports = asArray(history.reports);
  const ids = Array.from(
    new Set(
      reports
        .filter(
          (item) =>
            item.currentAvailable === true &&
            item.currentDisqualified !== true &&
            text(item.currentVisibility) === "visible"
        )
        .map((item) => safeInteger(item.submissionId))
        .filter((id): id is number => id !== null)
    )
  );
  const { data, error } = ids.length > 0
    ? await supabaseAdmin
        .from("submissions")
        .select("id, r2_key, is_disqualified, public_visibility_status")
        .in("id", ids)
    : { data: [], error: null };
  const keyById = new Map<number, string>();
  if (!error) {
    for (const row of data ?? []) {
      const id = safeInteger(row.id);
      const key = text(row.r2_key);
      if (
        id !== null &&
        key &&
        row.is_disqualified !== true &&
        row.public_visibility_status === "visible"
      ) {
        keyById.set(id, key);
      }
    }
  }

  return Object.freeze({
    ...history,
    reports: Object.freeze(
      reports.map((item) => {
        const id = safeInteger(item.submissionId);
        const publicUrl = id === null
          ? undefined
          : getPublicImageUrl(keyById.get(id));
        return Object.freeze({
          ...item,
          thumbnailUrl: publicUrl
            ? getSubmissionThumbnailUrl(publicUrl)
            : null,
        });
      })
    ),
  });
}

export async function loadSubmissionReportLandingArea(): Promise<SubmissionReportArea> {
  const authorization = await getTeamAuthorizationContext();
  if (can(authorization, SUBMISSION_REPORT_AREA_CAPABILITIES.live)) return "live";
  if (can(authorization, SUBMISSION_REPORT_AREA_CAPABILITIES.finalized)) {
    return "finalized";
  }
  throw new AuthError(403, "Forbidden", "TEAM_CAPABILITY_DENIED");
}

export async function loadSubmissionReportQueue(area: SubmissionReportArea) {
  const authorization = await requireDynamicTeamCapability(
    SUBMISSION_REPORT_AREA_CAPABILITIES[area]
  );
  const { data, error } = await supabaseAdmin.rpc(
    "list_submission_report_cases_v2",
    {
      p_actor_discord_user_id: authorization.discord_user_id,
      p_area: area,
      p_limit: 50,
    }
  );
  if (error) throw readFailure(error);
  const cases = await addSafeQueueThumbnails(asArray(data), authorization);
  return Object.freeze({
    area,
    cases: Object.freeze(cases),
    canReview: can(authorization, "submissions.reports.review"),
    canOverrideRelease: authorization.isAdmin,
    canViewLive: can(authorization, SUBMISSION_REPORT_AREA_CAPABILITIES.live),
    canViewFinalized: can(
      authorization,
      SUBMISSION_REPORT_AREA_CAPABILITIES.finalized
    ),
  });
}

export async function loadSubmissionReportCaseSummary(caseId: string) {
  assertUuid(caseId);
  const authorization = await getTeamAuthorizationContext();
  const { data, error } = await supabaseAdmin.rpc(
    "get_submission_report_case_summary_v2",
    {
      p_actor_discord_user_id: authorization.discord_user_id,
      p_case_id: caseId,
    }
  );
  if (error) throw readFailure(error);
  return Object.freeze({
    case: Object.freeze(asObject(data)),
    canReview: can(authorization, "submissions.reports.review"),
    canOverrideRelease: authorization.isAdmin,
  });
}

export async function loadSubmissionReportDetail(reportId: string) {
  assertUuid(reportId);
  const authorization = await getTeamAuthorizationContext();
  const { data, error } = await supabaseAdmin.rpc(
    "get_submission_report_detail_v2",
    {
      p_actor_discord_user_id: authorization.discord_user_id,
      p_report_id: reportId,
    }
  );
  if (error) throw readFailure(error);
  return Object.freeze(asObject(data));
}

export async function loadSubmissionReportUnreadCounts(
  currentAuthorization?: TeamAuthorizationContext
) {
  const authorization = currentAuthorization ?? (await getTeamAuthorizationContext());
  const hasArea = can(authorization, SUBMISSION_REPORT_AREA_CAPABILITIES.live) ||
    can(authorization, SUBMISSION_REPORT_AREA_CAPABILITIES.finalized);
  if (!hasArea) return Object.freeze({ live: 0, finalized: 0, total: 0 });
  const { data, error } = await supabaseAdmin.rpc(
    "get_submission_report_unread_counts_v2",
    { p_actor_discord_user_id: authorization.discord_user_id }
  );
  if (error) throw readFailure(error);
  const counts = asObject(data);
  const live = safeInteger(counts.live);
  const finalized = safeInteger(counts.finalized);
  const total = safeInteger(counts.total);
  if (live === null || finalized === null || total !== live + finalized) {
    throw readUnavailable();
  }
  return Object.freeze({ live, finalized, total });
}

export async function loadSubmissionReporterProfiles() {
  const authorization = await requireDynamicTeamCapability(
    "logs.submission_reporters.view"
  );
  const { data, error } = await supabaseAdmin.rpc(
    "list_submission_reporter_profiles",
    { p_actor_discord_user_id: authorization.discord_user_id, p_limit: 50 }
  );
  if (error) throw readFailure(error);
  return Object.freeze(asArray(data).map((item) => Object.freeze(item)));
}

export async function loadSubmissionReporterHistory(publicProfileId: string) {
  assertUuid(publicProfileId);
  const authorization = await requireDynamicTeamCapability(
    "logs.submission_reporters.view"
  );
  const { data, error } = await supabaseAdmin.rpc(
    "get_submission_reporter_history",
    {
      p_actor_discord_user_id: authorization.discord_user_id,
      p_public_profile_id: publicProfileId,
      p_limit: 100,
    }
  );
  if (error) throw readFailure(error);
  const history = await addSafeReporterThumbnails(asObject(data));
  return Object.freeze({
    history,
    canViewLive: can(authorization, SUBMISSION_REPORT_AREA_CAPABILITIES.live),
    canViewFinalized: can(
      authorization,
      SUBMISSION_REPORT_AREA_CAPABILITIES.finalized
    ),
  });
}

export type SubmissionReportWorkflowInput = Readonly<{
  caseId: string;
  operation:
    | "claim"
    | "release"
    | "forced_release"
    | "close";
  expectedStatus: "open" | "in_review" | "closed";
  expectedRowVersion: number;
  expectedLatestReportId: string;
  targetDiscordUserId: string | null;
  disposition: string | null;
  note: string | null;
  idempotencyKey: string;
}>;

export async function manageSubmissionReportCase(
  input: SubmissionReportWorkflowInput
) {
  const authorization = await requireDynamicTeamCapability(
    "submissions.reports.review"
  );
  if (input.operation === "forced_release" && !authorization.isAdmin) {
    throw new AuthError(403, "Forbidden", "TEAM_CAPABILITY_DENIED");
  }
  const { data, error } = await supabaseAdmin.rpc(
    "manage_submission_report_case_v2",
    {
      p_actor_discord_user_id: authorization.discord_user_id,
      p_case_id: input.caseId,
      p_operation: input.operation,
      p_expected_status: input.expectedStatus,
      p_expected_row_version: input.expectedRowVersion,
      p_expected_latest_report_id: input.expectedLatestReportId,
      p_target_discord_user_id: input.targetDiscordUserId,
      p_disposition: input.disposition,
      p_note: input.note,
      p_idempotency_key: input.idempotencyKey,
    }
  );
  if (error) throw readFailure(error);
  return Object.freeze(asObject(data));
}

export type SubmissionReportModerationCursor = Readonly<{
  occurredAt: string;
  eventId: string;
}>;

export async function loadSubmissionReportModerationEvents(
  cursor: SubmissionReportModerationCursor | null = null,
  outcomeFilter: SubmissionReportOutcomeHistoryFilter | null = null
) {
  const authorization = await requireDynamicTeamCapability(
    "logs.submission_report_moderation.view"
  );
  const { data, error } = await supabaseAdmin.rpc(
    "list_submission_report_outcome_events_v3",
    {
      p_actor_discord_user_id: authorization.discord_user_id,
      p_before_occurred_at: cursor?.occurredAt ?? null,
      p_before_event_id: cursor?.eventId ?? null,
      p_outcome_filter: outcomeFilter,
      p_limit: 50,
    }
  );
  if (error) throw readFailure(error);
  const page = asObject(data);
  const events = await addVisibilitySafeSubmissionReportThumbnails(
    asArray(page.events)
  );
  const nextCursor = page.nextCursor === null ? null : asObject(page.nextCursor);
  const nextOccurredAt = nextCursor ? text(nextCursor.occurredAt) : null;
  const nextEventId = nextCursor ? text(nextCursor.eventId) : null;
  if (
    nextCursor &&
    (!nextOccurredAt ||
      !Number.isFinite(Date.parse(nextOccurredAt)) ||
      !nextEventId ||
      !UUID_PATTERN.test(nextEventId))
  ) {
    throw readUnavailable();
  }
  return Object.freeze({
    events: Object.freeze(events.map((event) => Object.freeze(event))),
    canViewLive: can(authorization, SUBMISSION_REPORT_AREA_CAPABILITIES.live),
    canViewFinalized: can(
      authorization,
      SUBMISSION_REPORT_AREA_CAPABILITIES.finalized
    ),
    nextCursor: nextCursor
      ? Object.freeze({
          occurredAt: nextOccurredAt!,
          eventId: nextEventId!,
        })
      : null,
  });
}
