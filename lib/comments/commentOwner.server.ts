import "server-only";

import { AuthError } from "@/lib/auth/AuthError";
import { supabaseAdmin } from "@/lib/db/admin";
import {
  encodeCommentOwnerCursor,
  parseCommentOwnerCursor,
} from "@/lib/comments/commentOwnerCursor";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PAGE_SIZE = 20;

export type OwnCommentStatus =
  | "available"
  | "author_deleted"
  | "team_removed"
  | "unavailable";

export type OwnCommentItem = Readonly<{
  publicCommentId: string;
  createdAt: string;
  edited: boolean;
  isReply: boolean;
  status: OwnCommentStatus;
  body: string | null;
  submissionContext: string;
  destinationHref: string | null;
}>;

export type OwnMentionItem = Readonly<{
  mentionId: string;
  firstMentionedAt: string;
  commentCreatedAt: string;
  isReply: boolean;
  viewedAt: string | null;
  stateVersion: number;
  status: OwnCommentStatus;
  body: string | null;
  submissionContext: string;
  destinationHref: string | null;
}>;

export type OwnCommentPage = Readonly<{
  items: readonly OwnCommentItem[];
  snapshotAt: string;
  nextCursor: string | null;
}>;

export type OwnMentionPage = Readonly<{
  items: readonly OwnMentionItem[];
  snapshotAt: string;
  nextCursor: string | null;
}>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
}

function safeDate(value: unknown) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function safeDestination(value: unknown): value is string | null {
  return value === null || (
    typeof value === "string" &&
    /^\/(?!\/)[A-Za-z0-9/_?#=&.-]{1,240}$/u.test(value)
  );
}

function parseStatus(value: unknown): OwnCommentStatus | null {
  return value === "available" || value === "author_deleted" ||
    value === "team_removed" || value === "unavailable"
    ? value
    : null;
}

function parseComment(value: unknown): OwnCommentItem | null {
  const item = record(value);
  const status = parseStatus(item.status);
  if (
    typeof item.publicCommentId !== "string" ||
    !UUID_PATTERN.test(item.publicCommentId) ||
    !safeDate(item.createdAt) ||
    typeof item.edited !== "boolean" ||
    typeof item.isReply !== "boolean" ||
    !status ||
    (item.body !== null && (typeof item.body !== "string" || item.body.length > 10_000)) ||
    typeof item.submissionContext !== "string" ||
    item.submissionContext.length > 80 ||
    !safeDestination(item.destinationHref)
  ) return null;
  if (status !== "available" && (item.body !== null || item.destinationHref !== null)) return null;
  return Object.freeze({
    publicCommentId: item.publicCommentId,
    createdAt: item.createdAt as string,
    edited: item.edited,
    isReply: item.isReply,
    status,
    body: item.body as string | null,
    submissionContext: item.submissionContext,
    destinationHref: item.destinationHref as string | null,
  });
}

function parseMention(value: unknown): OwnMentionItem | null {
  const item = record(value);
  const status = parseStatus(item.status);
  if (
    typeof item.mentionId !== "string" ||
    !UUID_PATTERN.test(item.mentionId) ||
    !safeDate(item.firstMentionedAt) ||
    !safeDate(item.commentCreatedAt) ||
    typeof item.isReply !== "boolean" ||
    (item.viewedAt !== null && !safeDate(item.viewedAt)) ||
    !Number.isSafeInteger(item.stateVersion) ||
    (item.stateVersion as number) < 0 ||
    !status ||
    (item.body !== null && (typeof item.body !== "string" || item.body.length > 10_000)) ||
    typeof item.submissionContext !== "string" ||
    item.submissionContext.length > 80 ||
    !safeDestination(item.destinationHref)
  ) return null;
  if (status !== "available" && (item.body !== null || item.destinationHref !== null)) return null;
  return Object.freeze({
    mentionId: item.mentionId,
    firstMentionedAt: item.firstMentionedAt as string,
    commentCreatedAt: item.commentCreatedAt as string,
    isReply: item.isReply,
    viewedAt: item.viewedAt as string | null,
    stateVersion: item.stateVersion as number,
    status,
    body: item.body as string | null,
    submissionContext: item.submissionContext,
    destinationHref: item.destinationHref as string | null,
  });
}

async function rpc(label: string, functionName: string, parameters: object) {
  const { data, error } = await supabaseAdmin.rpc(functionName, parameters);
  if (error) {
    console.error(`[COMMENTS][OWNER] ${label} failed`, { code: error.code });
    throw new AuthError(503, "Comment history temporarily unavailable", "COMMENT_OWNER_UNAVAILABLE");
  }
  return data;
}

export async function loadOwnComments({
  sessionId,
  cursor,
  limit = PAGE_SIZE,
}: {
  sessionId: string;
  cursor?: string | null;
  limit?: number;
}): Promise<OwnCommentPage> {
  const parsedCursor = cursor ? parseCommentOwnerCursor(cursor, "comments") : null;
  if (cursor && !parsedCursor) {
    throw new AuthError(400, "Invalid comment cursor", "MY_COMMENTS_CURSOR_INVALID");
  }
  const boundedLimit = Math.min(Math.max(limit, 1), PAGE_SIZE);
  const result = record(await rpc("list comments", "get_own_community_comments", {
    p_session_id: sessionId,
    p_snapshot_at: parsedCursor?.snapshotAt ?? null,
    p_before_created_at: parsedCursor?.at ?? null,
    p_before_public_comment_id: parsedCursor?.id ?? null,
    p_limit: boundedLimit,
  }));
  if (!safeDate(result.snapshotAt) || !Array.isArray(result.items)) {
    throw new AuthError(503, "Comment history temporarily unavailable", "COMMENT_OWNER_INVALID_RESPONSE");
  }
  const parsedItems = result.items.map(parseComment);
  if (parsedItems.some((item) => item === null)) {
    throw new AuthError(503, "Comment history temporarily unavailable", "COMMENT_OWNER_INVALID_RESPONSE");
  }
  const allItems = parsedItems as OwnCommentItem[];
  const items = allItems.slice(0, boundedLimit);
  const tail = items.at(-1);
  return Object.freeze({
    items,
    snapshotAt: result.snapshotAt as string,
    nextCursor: allItems.length > boundedLimit && tail
      ? encodeCommentOwnerCursor({
          kind: "comments",
          snapshotAt: result.snapshotAt as string,
          at: tail.createdAt,
          id: tail.publicCommentId,
        })
      : null,
  });
}

export async function loadOwnMentions({
  sessionId,
  cursor,
  limit = PAGE_SIZE,
}: {
  sessionId: string;
  cursor?: string | null;
  limit?: number;
}): Promise<OwnMentionPage> {
  const parsedCursor = cursor ? parseCommentOwnerCursor(cursor, "mentions") : null;
  if (cursor && !parsedCursor) {
    throw new AuthError(400, "Invalid mention cursor", "MY_MENTIONS_CURSOR_INVALID");
  }
  const boundedLimit = Math.min(Math.max(limit, 1), PAGE_SIZE);
  const result = record(await rpc("list mentions", "get_own_community_mentions", {
    p_session_id: sessionId,
    p_snapshot_at: parsedCursor?.snapshotAt ?? null,
    p_before_first_mentioned_at: parsedCursor?.at ?? null,
    p_before_mention_id: parsedCursor?.id ?? null,
    p_limit: boundedLimit,
  }));
  if (!safeDate(result.snapshotAt) || !Array.isArray(result.items)) {
    throw new AuthError(503, "Mentions temporarily unavailable", "COMMENT_OWNER_INVALID_RESPONSE");
  }
  const parsedItems = result.items.map(parseMention);
  if (parsedItems.some((item) => item === null)) {
    throw new AuthError(503, "Mentions temporarily unavailable", "COMMENT_OWNER_INVALID_RESPONSE");
  }
  const allItems = parsedItems as OwnMentionItem[];
  const items = allItems.slice(0, boundedLimit);
  const tail = items.at(-1);
  return Object.freeze({
    items,
    snapshotAt: result.snapshotAt as string,
    nextCursor: allItems.length > boundedLimit && tail
      ? encodeCommentOwnerCursor({
          kind: "mentions",
          snapshotAt: result.snapshotAt as string,
          at: tail.firstMentionedAt,
          id: tail.mentionId,
        })
      : null,
  });
}

function validateMentionMutation(mentionId: string, expectedVersion: number, requestId: string) {
  if (!UUID_PATTERN.test(mentionId) || !UUID_PATTERN.test(requestId) ||
      !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
    throw new AuthError(400, "Invalid mention mutation", "MY_MENTION_MUTATION_INVALID");
  }
}

export async function markOwnMentionViewed(input: {
  sessionId: string;
  mentionId: string;
  expectedVersion: number;
  requestId: string;
}) {
  validateMentionMutation(input.mentionId, input.expectedVersion, input.requestId);
  return record(await rpc("mark mention viewed", "mark_own_community_mention_viewed", {
    p_session_id: input.sessionId,
    p_mention_id: input.mentionId,
    p_expected_version: input.expectedVersion,
    p_request_id: input.requestId,
  }));
}

export async function dismissOwnMention(input: {
  sessionId: string;
  mentionId: string;
  expectedVersion: number;
  requestId: string;
}) {
  validateMentionMutation(input.mentionId, input.expectedVersion, input.requestId);
  return record(await rpc("dismiss mention", "dismiss_own_community_mention", {
    p_session_id: input.sessionId,
    p_mention_id: input.mentionId,
    p_expected_version: input.expectedVersion,
    p_request_id: input.requestId,
  }));
}

export async function markAllOwnMentionsViewed(input: {
  sessionId: string;
  snapshotAt: string;
  requestId: string;
}) {
  if (!safeDate(input.snapshotAt) || !UUID_PATTERN.test(input.requestId)) {
    throw new AuthError(400, "Invalid mention snapshot", "MY_MENTIONS_SNAPSHOT_INVALID");
  }
  return record(await rpc("mark all mentions viewed", "mark_all_own_community_mentions_viewed", {
    p_session_id: input.sessionId,
    p_snapshot_at: input.snapshotAt,
    p_request_id: input.requestId,
  }));
}

export async function resolveOwnCommentDestination(
  sessionId: string,
  publicCommentId: string
) {
  if (!UUID_PATTERN.test(publicCommentId)) return null;
  const result = record(await rpc("resolve comment", "get_own_community_comment_destination", {
    p_session_id: sessionId,
    p_public_comment_id: publicCommentId,
  }));
  return result.outcome === "found" && safeDestination(result.destination)
    ? result.destination
    : null;
}

export async function resolveOwnMentionDestination(sessionId: string, mentionId: string) {
  if (!UUID_PATTERN.test(mentionId)) return null;
  const result = record(await rpc("resolve mention", "get_own_community_mention_destination", {
    p_session_id: sessionId,
    p_mention_id: mentionId,
  }));
  return result.outcome === "found" && safeDestination(result.destination)
    ? result.destination
    : null;
}
