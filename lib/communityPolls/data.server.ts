import "server-only";

import { supabaseAdmin } from "@/lib/db/admin";
import type {
  CommunityPoll,
  CommunityPollAdminEvent,
  CommunityPollDurationHours,
  CommunityPollIndex,
  CommunityPollManagement,
  CommunityPollOption,
} from "@/lib/communityPolls/types";
import {
  COMMUNITY_POLL_DURATIONS,
} from "@/lib/communityPolls/types";
import {
  requirePositiveVersion,
  requireReason,
  requireUuid,
  validateCommunityPollDraft,
} from "@/lib/communityPolls/validation";

type JsonRecord = Record<string, unknown>;

function record(value: unknown, name: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Community poll ${name} is unavailable`);
  }
  return value as JsonRecord;
}

function string(value: unknown, name: string) {
  if (typeof value !== "string" || !value) {
    throw new Error(`Community poll ${name} is unavailable`);
  }
  return value;
}

function optionalString(value: unknown) {
  return typeof value === "string" && value ? value : undefined;
}

function integer(value: unknown, name: string) {
  const normalized = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new Error(`Community poll ${name} is unavailable`);
  }
  return normalized;
}

function parseOption(value: unknown): CommunityPollOption {
  const item = record(value, "option");
  const parsed: CommunityPollOption = {
    publicId: requireUuid(item.publicId, "Option"),
    label: string(item.label, "option label"),
    displayOrder: integer(item.displayOrder, "option order"),
    ...(item.voteCount === undefined
      ? {}
      : { voteCount: integer(item.voteCount, "option count") }),
    ...(typeof item.percentage === "number"
      ? { percentage: item.percentage }
      : {}),
  };
  return Object.freeze(parsed);
}

const POLL_STATUSES = new Set([
  "draft",
  "active",
  "closed",
  "aborted",
  "replaced",
]);
const POLL_OUTCOMES = new Set([
  "winner",
  "runoff",
  "no_result",
  "aborted",
  "replaced",
]);
const ADMIN_EVENT_TYPES = new Set([
  "created",
  "activated",
  "closed",
  "aborted",
  "replaced",
  "replacement_created",
  "runoff_created",
]);

function requireManagementOutcome(value: unknown, expected: string) {
  const item = record(value, "management mutation");
  const outcome = string(item.outcome, "management outcome");
  if (outcome !== expected) {
    const message =
      outcome === "stale"
        ? "This poll changed. Refresh the page and review its current state."
        : outcome === "deadline_not_reached"
          ? "The database deadline has not been reached yet."
          : outcome === "not_found"
            ? "This poll no longer exists."
            : "This poll action is no longer available in its current state.";
    throw new Error(message);
  }
  return Object.freeze({ ...item, outcome });
}

export function parseCommunityPoll(value: unknown): CommunityPoll {
  const item = record(value, "record");
  const status = string(item.status, "status");
  const outcome = optionalString(item.outcome);
  const durationHours = integer(item.durationHours, "duration");
  const options = Array.isArray(item.options)
    ? item.options.map(parseOption)
    : null;

  if (
    !POLL_STATUSES.has(status) ||
    (outcome !== undefined && !POLL_OUTCOMES.has(outcome)) ||
    !COMMUNITY_POLL_DURATIONS.includes(
      durationHours as CommunityPollDurationHours
    ) ||
    !options ||
    options.length < 2 ||
    options.length > 8 ||
    typeof item.participated !== "boolean" ||
    typeof item.resultsVisible !== "boolean" ||
    typeof item.votingOpen !== "boolean"
  ) {
    throw new Error("Community poll response is unavailable");
  }

  return Object.freeze({
    publicId: requireUuid(item.publicId, "Poll"),
    status: status as CommunityPoll["status"],
    rowVersion: integer(item.rowVersion, "version"),
    question: string(item.question, "question"),
    context: typeof item.context === "string" ? item.context : "",
    durationHours: durationHours as CommunityPollDurationHours,
    createdAt: string(item.createdAt, "created time"),
    ...(optionalString(item.activatedAt)
      ? { activatedAt: optionalString(item.activatedAt) }
      : {}),
    ...(optionalString(item.deadlineAt)
      ? { deadlineAt: optionalString(item.deadlineAt) }
      : {}),
    ...(optionalString(item.closedAt)
      ? { closedAt: optionalString(item.closedAt) }
      : {}),
    ...(outcome ? { outcome: outcome as CommunityPoll["outcome"] } : {}),
    ...(optionalString(item.rootPollPublicId)
      ? { rootPollPublicId: requireUuid(item.rootPollPublicId, "Root poll") }
      : {}),
    ...(optionalString(item.parentPollPublicId)
      ? { parentPollPublicId: requireUuid(item.parentPollPublicId, "Parent poll") }
      : {}),
    ...(optionalString(item.replacementPollPublicId)
      ? {
          replacementPollPublicId: requireUuid(
            item.replacementPollPublicId,
            "Replacement poll"
          ),
        }
      : {}),
    ...(optionalString(item.winningOptionPublicId)
      ? {
          winningOptionPublicId: requireUuid(
            item.winningOptionPublicId,
            "Winning option"
          ),
        }
      : {}),
    participated: item.participated,
    resultsVisible: item.resultsVisible,
    votingOpen: item.votingOpen,
    ...(item.totalVotes === undefined
      ? {}
      : { totalVotes: integer(item.totalVotes, "total") }),
    ...(optionalString(item.lastUpdatedAt)
      ? { lastUpdatedAt: optionalString(item.lastUpdatedAt) }
      : {}),
    options: Object.freeze(options),
  });
}

function parseIndex(value: unknown): CommunityPollIndex {
  const item = record(value, "index");
  if (!Array.isArray(item.activePolls) || !Array.isArray(item.historyPolls)) {
    throw new Error("Community poll index is unavailable");
  }
  return Object.freeze({
    serverNow: string(item.serverNow, "server time"),
    activePolls: Object.freeze(item.activePolls.map(parseCommunityPoll)),
    historyPolls: Object.freeze(item.historyPolls.map(parseCommunityPoll)),
  });
}

async function rpc(name: string, parameters: JsonRecord) {
  const { data, error } = await supabaseAdmin.rpc(name, parameters);
  if (error) {
    console.error("[COMMUNITY_POLLS] database request failed", {
      operation: name,
      code: error.code,
    });
    throw new Error("Community polls are temporarily unavailable");
  }
  return data;
}

export async function getCommunityPollIndex(
  viewerDiscordUserId?: string
) {
  return parseIndex(
    await rpc("get_community_poll_index", {
      p_viewer_discord_user_id: viewerDiscordUserId ?? null,
    })
  );
}

export async function getCommunityPoll(
  pollPublicId: string,
  viewerDiscordUserId?: string
) {
  const publicId = requireUuid(pollPublicId, "Poll");
  const result = record(
    await rpc("get_community_poll", {
      p_poll_public_id: publicId,
      p_viewer_discord_user_id: viewerDiscordUserId ?? null,
    }),
    "detail"
  );
  return result.outcome === "ok"
    ? Object.freeze({
        poll: parseCommunityPoll(result.poll),
        serverNow: string(result.serverNow, "detail server time"),
      })
    : null;
}

export async function castCommunityPollVote(input: {
  sessionId: string;
  pollPublicId: unknown;
  optionPublicId: unknown;
  requestId: unknown;
  expectedPollVersion: unknown;
}) {
  const result = record(
    await rpc("cast_community_poll_vote", {
      p_session_id: requireUuid(input.sessionId, "Session"),
      p_poll_public_id: requireUuid(input.pollPublicId, "Poll"),
      p_option_public_id: requireUuid(input.optionPublicId, "Option"),
      p_request_id: requireUuid(input.requestId, "Request"),
      p_expected_poll_version: requirePositiveVersion(
        input.expectedPollVersion
      ),
    }),
    "vote"
  );
  const outcome = string(result.outcome, "vote outcome");
  return Object.freeze({
    outcome,
    ...(result.poll ? { poll: parseCommunityPoll(result.poll) } : {}),
    ...(result.selectedOption
      ? {
          selectedOption: Object.freeze({
            publicId: requireUuid(
              record(result.selectedOption, "selected option").publicId,
              "Selected option"
            ),
            label: string(
              record(result.selectedOption, "selected option").label,
              "selected option label"
            ),
          }),
        }
      : {}),
  });
}

function parseAdminEvent(value: unknown): CommunityPollAdminEvent {
  const item = record(value, "audit event");
  const details = record(item.details, "audit details");
  const eventType = string(item.eventType, "audit event type");
  if (!ADMIN_EVENT_TYPES.has(eventType)) {
    throw new Error("Community poll audit event is unavailable");
  }
  return Object.freeze({
    eventId: integer(item.eventId, "audit ID"),
    pollPublicId: requireUuid(item.pollPublicId, "Audit poll"),
    eventType: eventType as CommunityPollAdminEvent["eventType"],
    actorDiscordUserId: string(item.actorDiscordUserId, "audit actor"),
    actorRole: string(item.actorRole, "audit role"),
    pollVersion: integer(item.pollVersion, "audit version"),
    details: Object.freeze({ ...details }),
    occurredAt: string(item.occurredAt, "audit time"),
  });
}

export async function getCommunityPollManagement(actorDiscordUserId: string) {
  const item = record(
    await rpc("get_community_poll_management", {
      p_actor_discord_user_id: actorDiscordUserId,
    }),
    "management"
  );
  if (!Array.isArray(item.polls) || !Array.isArray(item.events)) {
    throw new Error("Community poll management is unavailable");
  }
  return Object.freeze({
    serverNow: string(item.serverNow, "management server time"),
    actorRole: string(item.actorRole, "management role"),
    polls: Object.freeze(item.polls.map(parseCommunityPoll)),
    events: Object.freeze(item.events.map(parseAdminEvent)),
  }) satisfies CommunityPollManagement;
}

export async function createCommunityPoll(
  actorDiscordUserId: string,
  requestId: unknown,
  input: Parameters<typeof validateCommunityPollDraft>[0]
) {
  const draft = validateCommunityPollDraft(input);
  return requireManagementOutcome(await rpc("create_community_poll", {
    p_actor_discord_user_id: actorDiscordUserId,
    p_request_id: requireUuid(requestId, "Request"),
    p_question: draft.question,
    p_context: draft.context,
    p_duration_hours: draft.durationHours,
    p_options: draft.options,
  }), "created");
}

export async function transitionCommunityPoll(
  action: "activate" | "close",
  actorDiscordUserId: string,
  input: {
    pollPublicId: unknown;
    requestId: unknown;
    expectedPollVersion: unknown;
  }
) {
  return requireManagementOutcome(await rpc(`${action}_community_poll`, {
    p_actor_discord_user_id: actorDiscordUserId,
    p_poll_public_id: requireUuid(input.pollPublicId, "Poll"),
    p_request_id: requireUuid(input.requestId, "Request"),
    p_expected_poll_version: requirePositiveVersion(
      input.expectedPollVersion
    ),
  }), action === "activate" ? "activated" : "closed");
}

export async function abortCommunityPoll(
  actorDiscordUserId: string,
  input: {
    pollPublicId: unknown;
    requestId: unknown;
    expectedPollVersion: unknown;
    reason: unknown;
  }
) {
  return requireManagementOutcome(await rpc("abort_community_poll", {
    p_actor_discord_user_id: actorDiscordUserId,
    p_poll_public_id: requireUuid(input.pollPublicId, "Poll"),
    p_request_id: requireUuid(input.requestId, "Request"),
    p_expected_poll_version: requirePositiveVersion(
      input.expectedPollVersion
    ),
    p_reason: requireReason(input.reason),
  }), "aborted");
}

export async function replaceCommunityPoll(
  actorDiscordUserId: string,
  request: {
    pollPublicId: unknown;
    requestId: unknown;
    expectedPollVersion: unknown;
    reason: unknown;
  },
  input: Parameters<typeof validateCommunityPollDraft>[0]
) {
  const draft = validateCommunityPollDraft(input);
  return requireManagementOutcome(await rpc("replace_community_poll", {
    p_actor_discord_user_id: actorDiscordUserId,
    p_poll_public_id: requireUuid(request.pollPublicId, "Poll"),
    p_request_id: requireUuid(request.requestId, "Request"),
    p_expected_poll_version: requirePositiveVersion(
      request.expectedPollVersion
    ),
    p_question: draft.question,
    p_context: draft.context,
    p_duration_hours: draft.durationHours,
    p_options: draft.options,
    p_reason: requireReason(request.reason),
  }), "replaced");
}
