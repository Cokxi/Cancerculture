import "server-only";

import { AuthError } from "@/lib/auth/AuthError";
import type { TeamAuthorizationContext } from "@/lib/auth/teamAuthorization";
import { getTeamAuthorizationContext } from "@/lib/auth/teamAuthorization";
import { supabaseAdmin } from "@/lib/db/admin";
import {
  encodeTeamInboxCursor,
  parseTeamInboxCursor,
} from "@/lib/teamInbox/teamInboxCursor";
import { loadWalletIssueCaseDetail } from "@/lib/walletIssues/service.server";
import { loadCommunityCommentReviewCaseDetail } from "@/lib/comments/commentModeration.server";

const TOPIC_PATTERN = /^[a-z][a-z0-9_]{2,63}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type TeamInboxTopic = Readonly<{
  topicKey: string;
  displayName: string;
  newCount?: number;
  openCount?: number;
  inProgressCount?: number;
}>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

async function rpc(functionName: string, parameters: object) {
  const { data, error } = await supabaseAdmin.rpc(functionName, parameters);
  if (error) {
    const forbidden = error.code === "42501";
    console.error("[TEAM_INBOX] RPC failed", { functionName, code: error.code });
    throw new AuthError(
      forbidden ? 403 : 503,
      forbidden ? "Forbidden" : "Team Inbox temporarily unavailable",
      forbidden ? "TEAM_INBOX_FORBIDDEN" : "TEAM_INBOX_UNAVAILABLE"
    );
  }
  return record(data);
}

function topicsFrom(value: unknown): TeamInboxTopic[] {
  const items = Array.isArray(value) ? value : [];
  return items.flatMap((raw) => {
    const topic = record(raw);
    if (
      typeof topic.topicKey !== "string" ||
      !TOPIC_PATTERN.test(topic.topicKey) ||
      typeof topic.displayName !== "string" ||
      topic.displayName.length > 80
    ) return [];
    const numberValue = (key: string) => {
      const candidate = Number(topic[key]);
      return Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : undefined;
    };
    return [Object.freeze({
      topicKey: topic.topicKey,
      displayName: topic.displayName,
      newCount: numberValue("newCount"),
      openCount: numberValue("openCount"),
      inProgressCount: numberValue("inProgressCount"),
    })];
  });
}

export async function loadAuthorizedTeamInboxTopics(
  authorization?: TeamAuthorizationContext
) {
  const context = authorization ?? await getTeamAuthorizationContext();
  const data = await rpc("get_authorized_team_inbox_topics", {
    p_actor_discord_user_id: context.discord_user_id,
  });
  return topicsFrom(data.topics);
}

export async function loadTeamInboxOverview(
  authorization?: TeamAuthorizationContext
) {
  const context = authorization ?? await getTeamAuthorizationContext();
  const data = await rpc("get_team_inbox_overview", {
    p_actor_discord_user_id: context.discord_user_id,
  });
  return topicsFrom(data.topics);
}

export async function loadTeamInboxCases({
  authorization,
  topicKey,
  filter,
  username,
  beforeUpdatedAt,
  beforeId,
}: {
  authorization?: TeamAuthorizationContext;
  topicKey: string;
  filter: string;
  username: string | null;
  beforeUpdatedAt: string | null;
  beforeId: string | null;
}) {
  if (!TOPIC_PATTERN.test(topicKey) || (beforeId && !UUID_PATTERN.test(beforeId))) {
    throw new AuthError(400, "Invalid Team Inbox query", "TEAM_INBOX_QUERY_INVALID");
  }
  const context = authorization ?? await getTeamAuthorizationContext();
  const data = await rpc("get_team_inbox_cases", {
    p_actor_discord_user_id: context.discord_user_id,
    p_topic_key: topicKey,
    p_filter: filter,
    p_username: username,
    p_before_updated_at: beforeUpdatedAt,
    p_before_id: beforeId,
    p_limit: 25,
  });
  const rawItems = Array.isArray(data.items) ? data.items.map(record) : [];
  const hasMore = rawItems.length > 25;
  const items = rawItems.slice(0, 25);
  const tail = items.at(-1);
  const tailAt = tail?.updatedAt;
  const tailId = tail?.id;
  return {
    items,
    nextCursor: hasMore && typeof tailAt === "string" && typeof tailId === "string"
      ? encodeTeamInboxCursor({ at: tailAt, id: tailId })
      : null,
  };
}

export async function loadTeamInboxCaseDetail(caseId: string, expectedTopicKey: string) {
  if (!UUID_PATTERN.test(caseId)) throw new AuthError(400, "Invalid case", "TEAM_INBOX_CASE_INVALID");
  const context = await getTeamAuthorizationContext();
  if (!["wallet_issues", "comment_reports", "comment_spam"].includes(expectedTopicKey)) {
    throw new AuthError(400, "Invalid topic", "TEAM_INBOX_TOPIC_INVALID");
  }
  if (expectedTopicKey === "comment_reports" || expectedTopicKey === "comment_spam") {
    return loadCommunityCommentReviewCaseDetail(
      context.discord_user_id, caseId, expectedTopicKey,
    );
  }
  const detail = await rpc("get_team_inbox_case_detail", {
    p_actor_discord_user_id: context.discord_user_id,
    p_case_id: caseId,
  });
  const caseValue = record(detail.case);
  if (detail.outcome === "found" && caseValue.topicKey !== expectedTopicKey) {
    return { outcome: "not_found" };
  }
  if (detail.outcome === "found" && caseValue.topicKey === "wallet_issues") {
    const walletIssue = await loadWalletIssueCaseDetail(context.discord_user_id, caseId);
    return { ...detail, walletIssue };
  }
  return detail;
}

export async function searchTeamInboxExactDiscordId({
  topicKey,
  exactDiscordId,
  cursor = null,
}: {
  topicKey: string;
  exactDiscordId: string;
  cursor?: string | null;
}) {
  if (!TOPIC_PATTERN.test(topicKey) || !/^[0-9]{1,100}$/u.test(exactDiscordId)) {
    throw new AuthError(400, "Invalid exact search", "TEAM_INBOX_SEARCH_INVALID");
  }
  const context = await getTeamAuthorizationContext();
  const parsedCursor = cursor ? parseTeamInboxCursor(cursor) : null;
  if (cursor && !parsedCursor) {
    throw new AuthError(400, "Invalid exact search cursor", "TEAM_INBOX_SEARCH_CURSOR_INVALID");
  }
  const data = await rpc("search_team_inbox_by_exact_discord_id", {
    p_actor_discord_user_id: context.discord_user_id,
    p_topic_key: topicKey,
    p_exact_discord_user_id: exactDiscordId,
    p_before_updated_at: parsedCursor?.at ?? null,
    p_before_id: parsedCursor?.id ?? null,
    p_limit: 25,
  });
  const rawItems = Array.isArray(data.items) ? data.items.map(record) : [];
  const hasMore = rawItems.length > 25;
  const items = rawItems.slice(0, 25);
  const tail = items.at(-1);
  return {
    items,
    nextCursor: hasMore && typeof tail?.updatedAt === "string" && typeof tail?.id === "string"
      ? encodeTeamInboxCursor({ at: tail.updatedAt, id: tail.id })
      : null,
  };
}

export async function mutateTeamInboxCase(input: {
  topicKey: string;
  caseId: string;
  idempotencyKey: string;
  action: string;
  expectedState: string;
  expectedRowVersion: number;
  expectedWorkVersion: number;
  note: string | null;
}) {
  if (
    !TOPIC_PATTERN.test(input.topicKey) ||
    !UUID_PATTERN.test(input.caseId) ||
    !UUID_PATTERN.test(input.idempotencyKey) ||
    !["claim", "return", "force_release"].includes(input.action) ||
    !["open", "in_progress", "solved"].includes(input.expectedState) ||
    !Number.isSafeInteger(input.expectedRowVersion) || input.expectedRowVersion < 1 ||
    !Number.isSafeInteger(input.expectedWorkVersion) || input.expectedWorkVersion < 1 ||
    (input.note !== null && (input.note.trim().length < 3 || input.note.trim().length > 1000))
  ) throw new AuthError(400, "Invalid mutation", "TEAM_INBOX_MUTATION_INVALID");
  await loadTeamInboxCaseDetail(input.caseId, input.topicKey);
  const context = await getTeamAuthorizationContext();
  return rpc("mutate_team_inbox_case", {
    p_actor_discord_user_id: context.discord_user_id,
    p_case_id: input.caseId,
    p_idempotency_key: input.idempotencyKey,
    p_action: input.action,
    p_expected_state: input.expectedState,
    p_expected_row_version: input.expectedRowVersion,
    p_expected_work_version: input.expectedWorkVersion,
    p_note: input.note,
  });
}
