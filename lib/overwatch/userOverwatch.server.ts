import "server-only";

import { AuthError } from "@/lib/auth/AuthError";
import { requireDynamicTeamCapability } from "@/lib/auth/teamAuthorization";
import { supabaseAdmin } from "@/lib/db/admin";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DISCORD_ID_PATTERN = /^[0-9]{5,32}$/u;
const STATES = ["active", "removed"] as const;
const TARGET_STATES = ["absent", ...STATES] as const;
const EVENT_TYPES = ["added", "removed"] as const;

export type UserOverwatchState = (typeof STATES)[number];
export type UserOverwatchTargetState = (typeof TARGET_STATES)[number];
export type UserOverwatchSection = "active" | "history";

export type UserOverwatchEvent = Readonly<{
  eventType: (typeof EVENT_TYPES)[number];
  reason: string;
  actorDisplayName: string | null;
  actorRoleKey: string;
  entryRowVersion: number;
  occurredAt: string;
}>;

export type UserOverwatchEntry = Readonly<{
  entryId: string;
  targetDiscordUserId: string;
  publicProfileId: string | null;
  currentDiscordUsername: string | null;
  currentDiscordHandle: string | null;
  currentDisplayName: string | null;
  currentGuildNickname: string | null;
  generation: number;
  state: UserOverwatchState;
  rowVersion: number;
  openedAt: string;
  closedAt: string | null;
  events: readonly UserOverwatchEvent[];
}>;

export type UserOverwatchTarget = Readonly<{
  targetDiscordUserId: string;
  currentState: UserOverwatchTargetState;
  entryId: string | null;
  generation: number;
  rowVersion: number;
}>;

export type UserOverwatchMutationReceipt = Readonly<{
  operation: "add" | "remove";
  entryId: string;
  targetDiscordUserId: string;
  generation: number;
  state: UserOverwatchState;
  rowVersion: number;
  occurredAt: string;
  replayed: boolean;
}>;

export class UserOverwatchConflict extends Error {
  readonly reason: "idempotency_conflict" | "stale_state" | "target_mismatch";

  constructor(reason: UserOverwatchConflict["reason"]) {
    super("Overwatch state changed");
    this.name = "UserOverwatchConflict";
    this.reason = reason;
  }
}

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

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isNullableText(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length <= 1000);
}

function unavailable() {
  return new AuthError(
    503,
    "Overwatch is temporarily unavailable",
    "USER_OVERWATCH_UNAVAILABLE",
  );
}

function parseEvent(value: unknown): UserOverwatchEvent | null {
  const event = record(value);
  if (
    !hasExactKeys(event, [
      "actorDisplayName",
      "actorRoleKey",
      "entryRowVersion",
      "eventType",
      "occurredAt",
      "reason",
    ]) ||
    typeof event.eventType !== "string" ||
    !(EVENT_TYPES as readonly string[]).includes(event.eventType) ||
    typeof event.reason !== "string" ||
    event.reason !== event.reason.trim() ||
    event.reason.length < 3 || event.reason.length > 1000 ||
    !isNullableText(event.actorDisplayName) ||
    typeof event.actorRoleKey !== "string" || event.actorRoleKey.length < 1 ||
    !isPositiveInteger(event.entryRowVersion) ||
    !isTimestamp(event.occurredAt)
  ) return null;
  return Object.freeze(event as UserOverwatchEvent);
}

function parseEntry(value: unknown): UserOverwatchEntry | null {
  const entry = record(value);
  const rawEvents = Array.isArray(entry.events) ? entry.events : null;
  const parsedEvents = rawEvents?.map(parseEvent) ?? [];
  if (
    !hasExactKeys(entry, [
      "closedAt",
      "currentDiscordHandle",
      "currentDiscordUsername",
      "currentDisplayName",
      "currentGuildNickname",
      "entryId",
      "events",
      "generation",
      "openedAt",
      "publicProfileId",
      "rowVersion",
      "state",
      "targetDiscordUserId",
    ]) ||
    typeof entry.entryId !== "string" || !UUID_PATTERN.test(entry.entryId) ||
    typeof entry.targetDiscordUserId !== "string" ||
    !DISCORD_ID_PATTERN.test(entry.targetDiscordUserId) ||
    (entry.publicProfileId !== null && (
      typeof entry.publicProfileId !== "string" ||
      !UUID_PATTERN.test(entry.publicProfileId)
    )) ||
    !isNullableText(entry.currentDiscordUsername) ||
    !isNullableText(entry.currentDiscordHandle) ||
    !isNullableText(entry.currentDisplayName) ||
    !isNullableText(entry.currentGuildNickname) ||
    !isPositiveInteger(entry.generation) ||
    (entry.state !== "active" && entry.state !== "removed") ||
    !isPositiveInteger(entry.rowVersion) ||
    !isTimestamp(entry.openedAt) ||
    (entry.closedAt !== null && !isTimestamp(entry.closedAt)) ||
    rawEvents === null || parsedEvents.some((event) => event === null)
  ) return null;

  const events = parsedEvents.filter(
    (event): event is UserOverwatchEvent => event !== null,
  );
  const isActive = entry.state === "active";
  if (
    (isActive && (
      entry.closedAt !== null || entry.rowVersion !== 1 || events.length !== 1 ||
      events[0]?.eventType !== "added" || events[0].entryRowVersion !== 1 ||
      events[0].occurredAt !== entry.openedAt
    )) ||
    (!isActive && (
      entry.closedAt === null || entry.rowVersion !== 2 || events.length !== 2 ||
      events[0]?.eventType !== "added" || events[0].entryRowVersion !== 1 ||
      events[1]?.eventType !== "removed" || events[1].entryRowVersion !== 2 ||
      events[0].occurredAt !== entry.openedAt ||
      events[1].occurredAt !== entry.closedAt
    ))
  ) return null;

  return Object.freeze({
    ...(entry as Omit<UserOverwatchEntry, "events">),
    events: Object.freeze(events),
  });
}

function parseTarget(value: unknown, targetDiscordUserId: string) {
  const target = record(value);
  if (hasExactKeys(target, ["outcome"]) && target.outcome === "not_found") {
    throw new UserOverwatchConflict("target_mismatch");
  }
  if (
    !hasExactKeys(target, [
      "currentState",
      "entryId",
      "generation",
      "outcome",
      "rowVersion",
      "targetDiscordUserId",
    ]) ||
    target.outcome !== "found" ||
    target.targetDiscordUserId !== targetDiscordUserId ||
    typeof target.currentState !== "string" ||
    !(TARGET_STATES as readonly string[]).includes(target.currentState) ||
    !Number.isSafeInteger(target.generation) || Number(target.generation) < 0 ||
    !Number.isSafeInteger(target.rowVersion) || Number(target.rowVersion) < 0 ||
    (target.entryId !== null && (
      typeof target.entryId !== "string" || !UUID_PATTERN.test(target.entryId)
    )) ||
    (target.currentState === "absent"
      ? target.entryId !== null || target.generation !== 0 || target.rowVersion !== 0
      : target.entryId === null || !isPositiveInteger(target.generation) ||
        !isPositiveInteger(target.rowVersion))
  ) throw unavailable();

  return Object.freeze({
    targetDiscordUserId,
    currentState: target.currentState,
    entryId: target.entryId,
    generation: Number(target.generation),
    rowVersion: Number(target.rowVersion),
  }) as UserOverwatchTarget;
}

function parseReceipt(
  value: unknown,
  operation: "add" | "remove",
  targetDiscordUserId: string,
): UserOverwatchMutationReceipt {
  const receipt = record(value);
  const expectedState = operation === "add" ? "active" : "removed";
  const expectedVersion = operation === "add" ? 1 : 2;
  if (
    !hasExactKeys(receipt, [
      "entryId",
      "generation",
      "occurredAt",
      "operation",
      "replayed",
      "rowVersion",
      "state",
      "targetDiscordUserId",
    ]) ||
    receipt.operation !== operation ||
    typeof receipt.entryId !== "string" || !UUID_PATTERN.test(receipt.entryId) ||
    receipt.targetDiscordUserId !== targetDiscordUserId ||
    !isPositiveInteger(receipt.generation) ||
    receipt.state !== expectedState ||
    receipt.rowVersion !== expectedVersion ||
    !isTimestamp(receipt.occurredAt) ||
    typeof receipt.replayed !== "boolean"
  ) throw unavailable();
  return Object.freeze(receipt as UserOverwatchMutationReceipt);
}

async function callRpc(functionName: string, parameters: object) {
  const { data, error } = await supabaseAdmin.rpc(functionName, parameters);
  if (error) {
    console.error("[USER_OVERWATCH] RPC failed", {
      functionName,
      code: error.code,
    });
    if (error.code === "42501") {
      throw new AuthError(403, "Forbidden", "TEAM_CAPABILITY_DENIED");
    }
    if (error.code === "PT409") {
      throw new UserOverwatchConflict(
        (error.message ?? "").includes("IDEMPOTENCY_CONFLICT")
          ? "idempotency_conflict"
          : "stale_state",
      );
    }
    if (error.code === "P0002") {
      throw new UserOverwatchConflict("target_mismatch");
    }
    throw unavailable();
  }
  return record(data);
}

async function loadManageTarget(
  actorDiscordUserId: string,
  targetDiscordUserId: string,
) {
  const value = await callRpc("get_user_overwatch_manage_target", {
    p_actor_discord_user_id: actorDiscordUserId,
    p_target_discord_user_id: targetDiscordUserId,
  });
  return parseTarget(value, targetDiscordUserId);
}

export async function prepareUserOverwatchTarget(
  targetDiscordUserId: string,
): Promise<UserOverwatchTarget> {
  if (!DISCORD_ID_PATTERN.test(targetDiscordUserId)) {
    throw new TypeError("Invalid Overwatch target");
  }
  const authorization = await requireDynamicTeamCapability(
    "users.overwatch.manage",
  );
  return loadManageTarget(authorization.discord_user_id, targetDiscordUserId);
}

export async function loadUserOverwatchEntries(
  section: UserOverwatchSection,
): Promise<readonly UserOverwatchEntry[]> {
  if (section !== "active" && section !== "history") throw unavailable();
  const authorization = await requireDynamicTeamCapability(
    "users.overwatch.view",
  );
  const value = await callRpc("list_user_overwatch_entries", {
    p_actor_discord_user_id: authorization.discord_user_id,
    p_section: section,
    p_limit: 100,
    p_offset: 0,
  });
  const rawItems = Array.isArray(value.items) ? value.items : null;
  const parsedItems = rawItems?.map(parseEntry) ?? [];
  if (
    !hasExactKeys(value, ["items"]) || rawItems === null ||
    parsedItems.some((item) => item === null) ||
    parsedItems.some((item) => item?.state !== (section === "active" ? "active" : "removed"))
  ) throw unavailable();
  return Object.freeze(parsedItems.filter(
    (item): item is UserOverwatchEntry => item !== null,
  ));
}

export async function addUserToOverwatch(params: {
  targetDiscordUserId: string;
  expectedState: "absent" | "removed";
  expectedRowVersion: number;
  reason: string;
  requestId: string;
}): Promise<UserOverwatchMutationReceipt> {
  const reason = params.reason.trim();
  if (
    !DISCORD_ID_PATTERN.test(params.targetDiscordUserId) ||
    (params.expectedState !== "absent" && params.expectedState !== "removed") ||
    !Number.isSafeInteger(params.expectedRowVersion) ||
    params.expectedRowVersion < 0 ||
    (params.expectedState === "absent" && params.expectedRowVersion !== 0) ||
    (params.expectedState === "removed" && params.expectedRowVersion < 1) ||
    reason.length < 3 || reason.length > 1000 ||
    !UUID_PATTERN.test(params.requestId)
  ) throw new TypeError("Invalid Overwatch Add request");

  const authorization = await requireDynamicTeamCapability(
    "users.overwatch.manage",
  );
  await loadManageTarget(
    authorization.discord_user_id,
    params.targetDiscordUserId,
  );
  const value = await callRpc("add_user_to_overwatch", {
    p_actor_discord_user_id: authorization.discord_user_id,
    p_target_discord_user_id: params.targetDiscordUserId,
    p_expected_state: params.expectedState,
    p_expected_row_version: params.expectedRowVersion,
    p_reason: reason,
    p_request_id: params.requestId,
  });
  return parseReceipt(value, "add", params.targetDiscordUserId);
}

export async function removeUserFromOverwatch(params: {
  targetDiscordUserId: string;
  entryId: string;
  expectedRowVersion: number;
  reason: string;
  requestId: string;
}): Promise<UserOverwatchMutationReceipt> {
  const reason = params.reason.trim();
  if (
    !DISCORD_ID_PATTERN.test(params.targetDiscordUserId) ||
    !UUID_PATTERN.test(params.entryId) ||
    !isPositiveInteger(params.expectedRowVersion) ||
    reason.length < 3 || reason.length > 1000 ||
    !UUID_PATTERN.test(params.requestId)
  ) throw new TypeError("Invalid Overwatch Remove request");

  const authorization = await requireDynamicTeamCapability(
    "users.overwatch.manage",
  );
  await loadManageTarget(
    authorization.discord_user_id,
    params.targetDiscordUserId,
  );
  const value = await callRpc("remove_user_from_overwatch", {
    p_actor_discord_user_id: authorization.discord_user_id,
    p_target_discord_user_id: params.targetDiscordUserId,
    p_public_entry_id: params.entryId,
    p_expected_state: "active",
    p_expected_row_version: params.expectedRowVersion,
    p_reason: reason,
    p_request_id: params.requestId,
  });
  return parseReceipt(value, "remove", params.targetDiscordUserId);
}
