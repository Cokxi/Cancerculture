import "server-only";

import { AuthError } from "@/lib/auth/AuthError";
import { requireDynamicTeamCapability } from "@/lib/auth/teamAuthorization";
import { supabaseAdmin } from "@/lib/db/admin";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DISCORD_ID_PATTERN = /^[0-9]{5,32}$/u;
const WARNING_CATEGORIES = ["spam", "hate_speech", "other"] as const;
const WARNING_STATES = ["active", "expired", "overruled"] as const;
const WARNING_EVENT_TYPES = [
  "issued",
  "overruled",
  "recalculated",
  "expired",
] as const;

export type UserWarningCategory = (typeof WARNING_CATEGORIES)[number];
export type UserWarningState = (typeof WARNING_STATES)[number];

export type OwnUserWarningDetail = Readonly<{
  warningId: string;
  category: UserWarningCategory;
  reason: string;
  issuedAt: string;
  effectiveStatus: UserWarningState;
  expiresAt: string;
}>;

export type TeamUserWarningEvent = Readonly<{
  eventType: (typeof WARNING_EVENT_TYPES)[number];
  occurredAt: string;
  actorKind: "team" | "system";
  actorDisplayName: string | null;
  actorRoleKey: string | null;
  reason: string | null;
  previousState: UserWarningState | null;
  newState: UserWarningState;
  previousTierDays: 1 | 3 | 7 | 14 | null;
  newTierDays: 1 | 3 | 7 | 14;
  previousExpiresAt: string | null;
  newExpiresAt: string;
  warningRowVersion: number;
}>;

export type TeamUserWarning = Readonly<{
  warningId: string;
  category: UserWarningCategory;
  reason: string;
  issuedAt: string;
  issuedByDisplayName: string | null;
  issuedByRoleKey: string;
  sourcePublicCommentId: string;
  sourceSubmissionId: number;
  sourceCommentObjectVersion: number;
  sourceCommentTextVersion: number;
  sourceCommentBody: string;
  originalTierDays: 1 | 3 | 7 | 14;
  originalExpiresAt: string;
  effectiveTierDays: 1 | 3 | 7 | 14;
  effectiveStatus: UserWarningState;
  effectiveExpiresAt: string;
  rowVersion: number;
  events: readonly TeamUserWarningEvent[];
}>;

export type TeamUserWarningHistory = Readonly<{
  active: boolean;
  activeCount: number;
  latestActiveExpiresAt: string | null;
  warnings: readonly TeamUserWarning[];
  historyHasMore: boolean;
}>;

export type TeamUserWarningSummary = Readonly<{
  targetDiscordUserId: string;
  active: boolean;
  activeCount: number;
  latestActiveExpiresAt: string | null;
  historyCount: number;
}>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isNullableTimestamp(value: unknown): value is string | null {
  return value === null || isTimestamp(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isTier(value: unknown): value is 1 | 3 | 7 | 14 {
  return value === 1 || value === 3 || value === 7 || value === 14;
}

function isNullableTier(value: unknown): value is 1 | 3 | 7 | 14 | null {
  return value === null || isTier(value);
}

function isCategory(value: unknown): value is UserWarningCategory {
  return typeof value === "string" &&
    (WARNING_CATEGORIES as readonly string[]).includes(value);
}

function isState(value: unknown): value is UserWarningState {
  return typeof value === "string" &&
    (WARNING_STATES as readonly string[]).includes(value);
}

function parseEvent(value: unknown): TeamUserWarningEvent | null {
  const event = record(value);
  if (
    !hasExactKeys(event, [
      "actorDisplayName",
      "actorKind",
      "actorRoleKey",
      "eventType",
      "newExpiresAt",
      "newState",
      "newTierDays",
      "occurredAt",
      "previousExpiresAt",
      "previousState",
      "previousTierDays",
      "reason",
      "warningRowVersion",
    ]) ||
    typeof event.eventType !== "string" ||
    !(WARNING_EVENT_TYPES as readonly string[]).includes(event.eventType) ||
    (event.actorKind !== "team" && event.actorKind !== "system") ||
    (event.actorDisplayName !== null && typeof event.actorDisplayName !== "string") ||
    (event.actorRoleKey !== null && typeof event.actorRoleKey !== "string") ||
    (event.reason !== null && (
      typeof event.reason !== "string" ||
      event.reason.length < 3 ||
      event.reason.length > 1000
    )) ||
    !isTimestamp(event.occurredAt) ||
    (event.previousState !== null && !isState(event.previousState)) ||
    !isState(event.newState) ||
    !isNullableTier(event.previousTierDays) ||
    !isTier(event.newTierDays) ||
    !isNullableTimestamp(event.previousExpiresAt) ||
    !isTimestamp(event.newExpiresAt) ||
    !isPositiveInteger(event.warningRowVersion)
  ) return null;

  return Object.freeze(event as TeamUserWarningEvent);
}

function parseTeamWarning(value: unknown): TeamUserWarning | null {
  const warning = record(value);
  const rawEvents = Array.isArray(warning.events) ? warning.events : null;
  const parsedEvents = rawEvents?.map(parseEvent) ?? [];
  if (
    !hasExactKeys(warning, [
      "category",
      "effectiveExpiresAt",
      "effectiveStatus",
      "effectiveTierDays",
      "events",
      "issuedAt",
      "issuedByDisplayName",
      "issuedByRoleKey",
      "originalExpiresAt",
      "originalTierDays",
      "reason",
      "rowVersion",
      "sourceCommentBody",
      "sourceCommentObjectVersion",
      "sourceCommentTextVersion",
      "sourcePublicCommentId",
      "sourceSubmissionId",
      "warningId",
    ]) ||
    typeof warning.warningId !== "string" || !UUID_PATTERN.test(warning.warningId) ||
    !isCategory(warning.category) ||
    typeof warning.reason !== "string" || warning.reason.length < 3 || warning.reason.length > 1000 ||
    !isTimestamp(warning.issuedAt) ||
    (warning.issuedByDisplayName !== null && typeof warning.issuedByDisplayName !== "string") ||
    typeof warning.issuedByRoleKey !== "string" || warning.issuedByRoleKey.length < 1 ||
    typeof warning.sourcePublicCommentId !== "string" || !UUID_PATTERN.test(warning.sourcePublicCommentId) ||
    !isPositiveInteger(warning.sourceSubmissionId) ||
    !isPositiveInteger(warning.sourceCommentObjectVersion) ||
    !isPositiveInteger(warning.sourceCommentTextVersion) ||
    typeof warning.sourceCommentBody !== "string" ||
    warning.sourceCommentBody.length < 1 || warning.sourceCommentBody.length > 10_000 ||
    !isTier(warning.originalTierDays) ||
    !isTimestamp(warning.originalExpiresAt) ||
    !isTier(warning.effectiveTierDays) ||
    !isState(warning.effectiveStatus) ||
    !isTimestamp(warning.effectiveExpiresAt) ||
    !isPositiveInteger(warning.rowVersion) ||
    rawEvents === null || parsedEvents.some((event) => event === null)
  ) return null;
  const events = parsedEvents.filter(
    (event): event is TeamUserWarningEvent => event !== null,
  );

  return Object.freeze({
    ...(warning as Omit<TeamUserWarning, "events">),
    events: Object.freeze(events),
  });
}

function unavailable() {
  return new AuthError(
    503,
    "Warning details temporarily unavailable",
    "USER_WARNING_VISIBILITY_UNAVAILABLE",
  );
}

async function rpc(functionName: string, parameters: object) {
  const { data, error } = await supabaseAdmin.rpc(functionName, parameters);
  if (error) {
    console.error("[USER_WARNING_VISIBILITY] RPC failed", {
      functionName,
      code: error.code,
    });
    if (error.code === "42501") {
      throw new AuthError(403, "Forbidden", "TEAM_CAPABILITY_DENIED");
    }
    throw unavailable();
  }
  return record(data);
}

export async function loadOwnUserWarningDetail({
  sessionId,
  publicWarningId,
}: {
  sessionId: string;
  publicWarningId: string;
}): Promise<OwnUserWarningDetail | null> {
  if (!UUID_PATTERN.test(publicWarningId)) return null;
  const value = await rpc("get_own_user_warning_detail", {
    p_session_id: sessionId,
    p_public_warning_id: publicWarningId,
  });
  if (hasExactKeys(value, ["outcome"]) && value.outcome === "not_found") {
    return null;
  }
  if (
    !hasExactKeys(value, [
      "category",
      "effectiveStatus",
      "expiresAt",
      "issuedAt",
      "outcome",
      "reason",
      "warningId",
    ]) ||
    value.outcome !== "found" ||
    value.warningId !== publicWarningId ||
    !isCategory(value.category) ||
    typeof value.reason !== "string" || value.reason.length < 3 || value.reason.length > 1000 ||
    !isTimestamp(value.issuedAt) ||
    !isState(value.effectiveStatus) ||
    !isTimestamp(value.expiresAt)
  ) throw unavailable();

  return Object.freeze({
    warningId: publicWarningId,
    category: value.category,
    reason: value.reason,
    issuedAt: value.issuedAt,
    effectiveStatus: value.effectiveStatus,
    expiresAt: value.expiresAt,
  });
}

export async function loadTeamUserWarningHistory(
  targetDiscordUserId: string,
): Promise<TeamUserWarningHistory> {
  if (!DISCORD_ID_PATTERN.test(targetDiscordUserId)) throw unavailable();
  const authorization = await requireDynamicTeamCapability("users.warnings.view");
  const value = await rpc("get_user_warning_team_history", {
    p_actor_discord_user_id: authorization.discord_user_id,
    p_target_discord_user_id: targetDiscordUserId,
  });
  const rawWarnings = Array.isArray(value.warnings) ? value.warnings : null;
  const parsedWarnings = rawWarnings?.map(parseTeamWarning) ?? [];
  if (
    !hasExactKeys(value, [
      "active",
      "activeCount",
      "historyHasMore",
      "latestActiveExpiresAt",
      "outcome",
      "warnings",
    ]) ||
    value.outcome !== "found" ||
    typeof value.active !== "boolean" ||
    !Number.isSafeInteger(value.activeCount) || Number(value.activeCount) < 0 ||
    value.active !== (Number(value.activeCount) > 0) ||
    !isNullableTimestamp(value.latestActiveExpiresAt) ||
    typeof value.historyHasMore !== "boolean" ||
    rawWarnings === null || parsedWarnings.some((warning) => warning === null)
  ) throw unavailable();
  const warnings = parsedWarnings.filter(
    (warning): warning is TeamUserWarning => warning !== null,
  );

  return Object.freeze({
    active: value.active,
    activeCount: Number(value.activeCount),
    latestActiveExpiresAt: value.latestActiveExpiresAt,
    warnings: Object.freeze(warnings),
    historyHasMore: value.historyHasMore,
  });
}

function parseSummary(value: unknown): TeamUserWarningSummary | null {
  const summary = record(value);
  if (
    !hasExactKeys(summary, [
      "active",
      "activeCount",
      "historyCount",
      "latestActiveExpiresAt",
      "targetDiscordUserId",
    ]) ||
    typeof summary.targetDiscordUserId !== "string" ||
    !DISCORD_ID_PATTERN.test(summary.targetDiscordUserId) ||
    typeof summary.active !== "boolean" ||
    !Number.isSafeInteger(summary.activeCount) || Number(summary.activeCount) < 0 ||
    summary.active !== (Number(summary.activeCount) > 0) ||
    !isNullableTimestamp(summary.latestActiveExpiresAt) ||
    !Number.isSafeInteger(summary.historyCount) || Number(summary.historyCount) < 0 ||
    Number(summary.activeCount) > Number(summary.historyCount)
  ) return null;
  return Object.freeze({
    targetDiscordUserId: summary.targetDiscordUserId,
    active: summary.active,
    activeCount: Number(summary.activeCount),
    latestActiveExpiresAt: summary.latestActiveExpiresAt,
    historyCount: Number(summary.historyCount),
  });
}

export async function loadTeamUserWarningSummaries(
  targetDiscordUserIds: readonly string[],
): Promise<readonly TeamUserWarningSummary[]> {
  if (targetDiscordUserIds.length === 0) return Object.freeze([]);
  const uniqueIds = [...new Set(targetDiscordUserIds)];
  if (
    uniqueIds.length !== targetDiscordUserIds.length ||
    uniqueIds.some((targetId) => !DISCORD_ID_PATTERN.test(targetId))
  ) throw unavailable();

  const authorization = await requireDynamicTeamCapability("users.warnings.view");
  const summaries: TeamUserWarningSummary[] = [];
  for (let index = 0; index < uniqueIds.length; index += 200) {
    const chunk = uniqueIds.slice(index, index + 200);
    const value = await rpc("get_user_warning_team_summaries", {
      p_actor_discord_user_id: authorization.discord_user_id,
      p_target_discord_user_ids: chunk,
    });
    const rawItems = Array.isArray(value.items) ? value.items : null;
    const parsedItems = rawItems?.map(parseSummary) ?? [];
    if (
      !hasExactKeys(value, ["items"]) ||
      rawItems === null ||
      parsedItems.some((item) => item === null)
    ) throw unavailable();
    const items = parsedItems.filter(
      (item): item is TeamUserWarningSummary => item !== null,
    );
    summaries.push(...items);
  }

  return Object.freeze(summaries);
}
