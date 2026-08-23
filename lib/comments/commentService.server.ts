import "server-only";

import { supabaseAdmin } from "@/lib/db/admin";
import {
  COMMUNITY_COMMENT_BATCH_MAX_IDS,
  COMMUNITY_COMMENT_REPLY_PAGE_SIZE,
  COMMUNITY_COMMENT_ROOT_PAGE_SIZE,
} from "@/lib/pagination/publicPagination";
import {
  decodeCommunityCommentReplyCursor,
  decodeCommunityCommentRootCursor,
  encodeCommunityCommentReplyCursor,
  encodeCommunityCommentRootCursor,
  type CommunityCommentSort,
} from "@/lib/comments/commentCursor.server";
import {
  COMMUNITY_COMMENT_PUBLIC_KEYS,
  parseCommunityCommentPublicDto,
} from "@/lib/comments/commentDto";
import {
  CommunityCommentTextError,
  prepareCommunityCommentText,
} from "@/lib/comments/commentText";
import { getCommunityCommentContentDigest } from "@/lib/comments/commentAbuse.server";
import {
  TURNSTILE_ACTIONS,
  TURNSTILE_TOKEN_HEADER,
} from "@/lib/turnstile/shared";
import { verifyTurnstileRequest } from "@/lib/turnstile/verify.server";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const COMMENT_TURNSTILE_MAX_AGE_MS = 5 * 60_000;

type JsonRecord = Record<string, unknown>;

export class CommunityCommentServiceError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 503,
    public readonly code: string
  ) {
    super(code);
    this.name = "CommunityCommentServiceError";
  }
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function exactKeys(value: JsonRecord, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function unavailable(): never {
  throw new CommunityCommentServiceError(503, "COMMENTS_UNAVAILABLE");
}

async function rpc(functionName: string, parameters: object) {
  const { data, error } = await supabaseAdmin.rpc(functionName, parameters);
  if (error) {
    console.error("[COMMENTS] RPC failed", { functionName, code: error.code });
    unavailable();
  }
  return record(data);
}

function readOutcome(value: JsonRecord) {
  if (value.outcome === "feature_off") {
    throw new CommunityCommentServiceError(404, "COMMENTS_UNAVAILABLE");
  }
  if (
    value.outcome === "submission_unavailable" ||
    value.outcome === "comment_unavailable"
  ) {
    throw new CommunityCommentServiceError(404, "COMMENT_NOT_FOUND");
  }
  if (value.outcome !== "ok") unavailable();
}

function parseRootItem(value: unknown) {
  const item = record(value);
  if (
    !exactKeys(item, [
      ...COMMUNITY_COMMENT_PUBLIC_KEYS,
      "replyPreview",
      "replyPreviewHasMore",
    ]) ||
    !Array.isArray(item.replyPreview) ||
    typeof item.replyPreviewHasMore !== "boolean"
  ) {
    unavailable();
  }
  const base = Object.fromEntries(
    COMMUNITY_COMMENT_PUBLIC_KEYS.map((key) => [key, item[key]])
  );
  return {
    ...parseCommunityCommentPublicDto(base),
    replyPreview: item.replyPreview.map(parseCommunityCommentPublicDto),
    replyPreviewHasMore: item.replyPreviewHasMore,
  };
}

function parsePageTuple(value: unknown, sort?: CommunityCommentSort) {
  if (value === null) return null;
  const tuple = record(value);
  const expected = sort === "top"
    ? ["createdAt", "netScore", "publicCommentId"]
    : ["createdAt", "publicCommentId"];
  if (
    !exactKeys(tuple, expected) ||
    !timestamp(tuple.createdAt) ||
    !uuid(tuple.publicCommentId) ||
    (sort === "top" && !Number.isSafeInteger(tuple.netScore))
  ) {
    unavailable();
  }
  return tuple as {
    createdAt: string;
    publicCommentId: string;
    netScore?: number;
  };
}

export async function getCommunityCommentRootPage(input: {
  submissionId: number;
  sort: CommunityCommentSort;
  cursor: string | null;
}) {
  if (!positiveInteger(input.submissionId) || !["top", "newest"].includes(input.sort)) {
    throw new CommunityCommentServiceError(400, "COMMENT_PAGE_INVALID");
  }
  const decoded = input.cursor
    ? decodeCommunityCommentRootCursor(input.cursor, input.submissionId, input.sort)
    : null;
  const values = decoded?.values;
  const value = await rpc("get_community_comment_thread_page", {
    p_submission_id: input.submissionId,
    p_sort: input.sort,
    p_snapshot_at: values?.snapshotAt ?? null,
    p_after_score: values && "netScore" in values ? values.netScore : null,
    p_after_created_at: values?.createdAt ?? null,
    p_after_public_comment_id: values?.publicCommentId ?? null,
    p_limit: COMMUNITY_COMMENT_ROOT_PAGE_SIZE,
  });
  readOutcome(value);
  if (
    !["read_only", "open"].includes(String(value.releaseState)) ||
    value.submissionId !== input.submissionId ||
    value.sort !== input.sort ||
    !timestamp(value.snapshotAt) ||
    !nonNegativeInteger(value.threadVersion) ||
    !Array.isArray(value.items) ||
    typeof value.hasMore !== "boolean"
  ) unavailable();
  const tuple = parsePageTuple(value.nextTuple, input.sort);
  if (value.hasMore !== (tuple !== null)) unavailable();
  return {
    releaseState: value.releaseState as "read_only" | "open",
    submissionId: input.submissionId,
    sort: input.sort,
    snapshotAt: value.snapshotAt,
    threadVersion: value.threadVersion,
    items: value.items.map(parseRootItem),
    hasMore: value.hasMore,
    nextCursor: tuple
      ? encodeCommunityCommentRootCursor({
          submissionId: input.submissionId,
          sort: input.sort,
          snapshotAt: value.snapshotAt,
          netScore: tuple.netScore,
          createdAt: tuple.createdAt,
          publicCommentId: tuple.publicCommentId,
        })
      : null,
  };
}

export async function getCommunityCommentReplyPage(input: {
  submissionId: number;
  rootPublicCommentId: string;
  cursor: string | null;
}) {
  if (!positiveInteger(input.submissionId) || !uuid(input.rootPublicCommentId)) {
    throw new CommunityCommentServiceError(400, "COMMENT_PAGE_INVALID");
  }
  const decoded = input.cursor
    ? decodeCommunityCommentReplyCursor(
        input.cursor,
        input.submissionId,
        input.rootPublicCommentId
      )
    : null;
  const value = await rpc("get_community_comment_replies", {
    p_root_public_comment_id: input.rootPublicCommentId,
    p_snapshot_at: decoded?.values.snapshotAt ?? null,
    p_before_created_at: decoded?.values.createdAt ?? null,
    p_before_public_comment_id: decoded?.values.publicCommentId ?? null,
    p_limit: COMMUNITY_COMMENT_REPLY_PAGE_SIZE,
  });
  readOutcome(value);
  if (
    value.submissionId !== input.submissionId ||
    value.rootPublicCommentId !== input.rootPublicCommentId ||
    !positiveInteger(value.rootVersion) ||
    typeof value.branchOpen !== "boolean" ||
    !timestamp(value.snapshotAt) ||
    !Array.isArray(value.items) ||
    typeof value.hasMore !== "boolean"
  ) unavailable();
  const tuple = parsePageTuple(value.nextTuple);
  if (value.hasMore !== (tuple !== null)) unavailable();
  return {
    rootPublicCommentId: input.rootPublicCommentId,
    rootVersion: value.rootVersion,
    branchOpen: value.branchOpen,
    snapshotAt: value.snapshotAt,
    items: value.items.map(parseCommunityCommentPublicDto),
    hasMore: value.hasMore,
    nextCursor: tuple
      ? encodeCommunityCommentReplyCursor({
          submissionId: input.submissionId,
          rootPublicCommentId: input.rootPublicCommentId,
          snapshotAt: value.snapshotAt,
          createdAt: tuple.createdAt,
          publicCommentId: tuple.publicCommentId,
        })
      : null,
  };
}

export async function getCommunityCommentDeepLink(publicCommentId: string) {
  if (!uuid(publicCommentId)) {
    throw new CommunityCommentServiceError(400, "COMMENT_ID_INVALID");
  }
  const value = await rpc("get_community_comment_deep_link", {
    p_public_comment_id: publicCommentId,
  });
  readOutcome(value);
  if (
    !positiveInteger(value.submissionId) ||
    value.targetPublicCommentId !== publicCommentId ||
    typeof value.branchOpen !== "boolean" ||
    value.windowLimit !== 20 ||
    !Array.isArray(value.replies)
  ) unavailable();
  return {
    submissionId: value.submissionId,
    targetPublicCommentId: publicCommentId,
    root: parseCommunityCommentPublicDto(value.root),
    replies: value.replies.map(parseCommunityCommentPublicDto),
    branchOpen: value.branchOpen,
    windowLimit: 20,
  };
}

export async function getCommunityCommentsBatch(publicCommentIds: string[]) {
  const ids = [...new Set(publicCommentIds)];
  if (ids.length > COMMUNITY_COMMENT_BATCH_MAX_IDS || ids.some((id) => !uuid(id))) {
    throw new CommunityCommentServiceError(400, "COMMENT_BATCH_INVALID");
  }
  const value = await rpc("get_community_comments_batch", {
    p_public_comment_ids: ids,
  });
  readOutcome(value);
  if (!Array.isArray(value.items)) unavailable();
  return { items: value.items.map(parseCommunityCommentPublicDto) };
}

export async function searchCommunityCommentMentionTargets(input: {
  sessionId: string;
  query: string;
}) {
  if (!uuid(input.sessionId) || input.query !== input.query.trim() || input.query.length < 2 || input.query.length > 64) {
    throw new CommunityCommentServiceError(400, "COMMENT_MENTION_SEARCH_INVALID");
  }
  const value = await rpc("search_community_comment_mention_targets", {
    p_session_id: input.sessionId,
    p_query: input.query,
    p_limit: 20,
  });
  if (value.outcome === "feature_not_open") {
    throw new CommunityCommentServiceError(404, "COMMENTS_UNAVAILABLE");
  }
  if (value.outcome !== "ok" || !Array.isArray(value.items)) unavailable();
  return {
    items: value.items.map((candidate) => {
      const item = record(candidate);
      if (
        !exactKeys(item, ["displayName", "isBanned", "publicProfileId"]) ||
        !uuid(item.publicProfileId) ||
        typeof item.displayName !== "string" ||
        !item.displayName.trim() ||
        typeof item.isBanned !== "boolean"
      ) unavailable();
      return item as { publicProfileId: string; displayName: string; isBanned: boolean };
    }),
  };
}

async function turnstileVerified(request: Request) {
  if (!request.headers.get(TURNSTILE_TOKEN_HEADER)?.trim()) return false;
  const result = await verifyTurnstileRequest(
    request,
    TURNSTILE_ACTIONS.communityComment,
    { maxTokenAgeMs: COMMENT_TURNSTILE_MAX_AGE_MS }
  );
  if (result.status === "verified") return true;
  if (result.status === "rejected") {
    throw new CommunityCommentServiceError(400, result.code);
  }
  throw new CommunityCommentServiceError(
    503,
    result.status === "configuration_error"
      ? result.code
      : "TURNSTILE_PROVIDER_UNAVAILABLE"
  );
}

const MUTATION_OUTCOMES = new Set([
  "feature_off", "read_only", "submission_unavailable", "author_profile_unavailable",
  "stale_thread", "root_unavailable", "target_unavailable", "branch_closed",
  "stale_comment", "comment_unavailable", "author_deleted", "edit_window_closed",
  "text_or_mentions_invalid", "cooldown", "turnstile_required", "idempotency_conflict",
]);

function mutationResult(value: JsonRecord) {
  if (["created", "edited", "author_deleted"].includes(String(value.outcome))) {
    if (
      typeof value.replayed !== "boolean" ||
      !positiveInteger(value.threadVersion) ||
      !value.comment
    ) unavailable();
    return {
      outcome: value.outcome,
      replayed: value.replayed,
      threadVersion: value.threadVersion,
      ...(typeof value.branchClosed === "boolean" ? { branchClosed: value.branchClosed } : {}),
      ...(positiveInteger(value.rootVersion) ? { rootVersion: value.rootVersion } : {}),
      comment: parseCommunityCommentPublicDto(value.comment),
    };
  }
  if (!MUTATION_OUTCOMES.has(String(value.outcome))) unavailable();
  const status = value.outcome === "cooldown" || value.outcome === "turnstile_required"
    ? 429
    : value.outcome === "feature_off" || value.outcome === "submission_unavailable" ||
        value.outcome === "root_unavailable" || value.outcome === "target_unavailable" ||
        value.outcome === "comment_unavailable"
      ? 404
      : value.outcome === "read_only" ? 503
      : value.outcome === "author_profile_unavailable" ? 403
      : value.outcome === "text_or_mentions_invalid" ? 400
      : 409;
  throw new CommunityCommentServiceError(status, String(value.outcome).toUpperCase());
}

function mutationInput(input: JsonRecord) {
  if (!uuid(input.requestId)) {
    throw new CommunityCommentServiceError(400, "COMMENT_MUTATION_INVALID");
  }
  try {
    const prepared = prepareCommunityCommentText(String(input.body ?? ""), input.mentions);
    return { ...prepared, requestId: input.requestId };
  } catch (error) {
    if (error instanceof CommunityCommentTextError) {
      throw new CommunityCommentServiceError(400, error.code);
    }
    throw error;
  }
}

export async function createCommunityCommentRoot(input: {
  request: Request; sessionId: string; submissionId: number; body: JsonRecord;
}) {
  if (!positiveInteger(input.submissionId) || !nonNegativeInteger(input.body.expectedThreadVersion)) {
    throw new CommunityCommentServiceError(400, "COMMENT_MUTATION_INVALID");
  }
  const prepared = mutationInput(input.body);
  return mutationResult(await rpc("create_community_comment_root", {
    p_session_id: input.sessionId,
    p_submission_id: input.submissionId,
    p_expected_thread_version: input.body.expectedThreadVersion,
    p_normalized_body: prepared.normalizedBody,
    p_mentions: prepared.normalizedMentions,
    p_request_id: prepared.requestId,
    p_content_digest: getCommunityCommentContentDigest(prepared.normalizedBody),
    p_turnstile_verified: await turnstileVerified(input.request),
  }));
}

export async function createCommunityCommentReply(input: {
  request: Request; sessionId: string; rootPublicCommentId: string; body: JsonRecord;
}) {
  if (
    !uuid(input.rootPublicCommentId) || !uuid(input.body.targetPublicCommentId) ||
    !positiveInteger(input.body.expectedRootVersion) ||
    !positiveInteger(input.body.expectedTargetVersion)
  ) throw new CommunityCommentServiceError(400, "COMMENT_MUTATION_INVALID");
  const prepared = mutationInput(input.body);
  return mutationResult(await rpc("create_community_comment_reply", {
    p_session_id: input.sessionId,
    p_root_public_comment_id: input.rootPublicCommentId,
    p_target_public_comment_id: input.body.targetPublicCommentId,
    p_expected_root_version: input.body.expectedRootVersion,
    p_expected_target_version: input.body.expectedTargetVersion,
    p_normalized_body: prepared.normalizedBody,
    p_mentions: prepared.normalizedMentions,
    p_request_id: prepared.requestId,
    p_content_digest: getCommunityCommentContentDigest(prepared.normalizedBody),
    p_turnstile_verified: await turnstileVerified(input.request),
  }));
}

export async function editCommunityComment(input: {
  request: Request; sessionId: string; publicCommentId: string; body: JsonRecord;
}) {
  if (!uuid(input.publicCommentId) || !positiveInteger(input.body.expectedVersion)) {
    throw new CommunityCommentServiceError(400, "COMMENT_MUTATION_INVALID");
  }
  const prepared = mutationInput(input.body);
  return mutationResult(await rpc("edit_community_comment", {
    p_session_id: input.sessionId,
    p_public_comment_id: input.publicCommentId,
    p_expected_version: input.body.expectedVersion,
    p_normalized_body: prepared.normalizedBody,
    p_mentions: prepared.normalizedMentions,
    p_request_id: prepared.requestId,
    p_content_digest: getCommunityCommentContentDigest(prepared.normalizedBody),
    p_turnstile_verified: await turnstileVerified(input.request),
  }));
}

export async function deleteCommunityComment(input: {
  sessionId: string; publicCommentId: string; body: JsonRecord;
}) {
  if (
    !uuid(input.publicCommentId) || !positiveInteger(input.body.expectedVersion) ||
    !uuid(input.body.requestId) || input.body.confirmed !== true
  ) throw new CommunityCommentServiceError(400, "COMMENT_DELETE_CONFIRMATION_REQUIRED");
  return mutationResult(await rpc("delete_community_comment", {
    p_session_id: input.sessionId,
    p_public_comment_id: input.publicCommentId,
    p_expected_version: input.body.expectedVersion,
    p_request_id: input.body.requestId,
    p_confirmed: true,
  }));
}
