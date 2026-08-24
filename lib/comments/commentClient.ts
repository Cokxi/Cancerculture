import {
  COMMUNITY_COMMENT_PUBLIC_KEYS,
  parseCommunityCommentPublicDto,
  type CommunityCommentPublicDto,
} from "@/lib/comments/commentDto";
import type { GlobalAccountViewState } from "@/lib/auth/globalAccount";

export type CommunityCommentReleaseState = "read_only" | "open";
export type CommunityCommentSort = "top" | "newest";

export type CommunityCommentRootItem = CommunityCommentPublicDto & {
  replyPreview: CommunityCommentPublicDto[];
  replyPreviewHasMore: boolean;
};

export type CommunityCommentRootPage = {
  releaseState: CommunityCommentReleaseState;
  submissionId: number;
  sort: CommunityCommentSort;
  snapshotAt: string;
  threadVersion: number;
  items: CommunityCommentRootItem[];
  hasMore: boolean;
  nextCursor: string | null;
};

export type CommunityCommentReplyPage = {
  rootPublicCommentId: string;
  rootVersion: number;
  branchOpen: boolean;
  snapshotAt: string;
  items: CommunityCommentPublicDto[];
  hasMore: boolean;
  nextCursor: string | null;
};

export type CommunityCommentMutationReceipt = {
  outcome: "created" | "edited" | "author_deleted";
  replayed: boolean;
  threadVersion: number;
  branchClosed?: boolean;
  rootVersion?: number;
  comment: CommunityCommentPublicDto;
};

export type CommunityCommentVoteState = "up" | "down" | null;

export type CommunityCommentVoteViewerState = {
  publicCommentId: string;
  state: CommunityCommentVoteState;
  version: number;
};

export type CommunityCommentVoteReceipt = {
  outcome: "voted";
  replayed: boolean;
  projection: {
    publicCommentId: string;
    voteCounts: { up: number; down: number };
    viewerState: CommunityCommentVoteState;
    viewerVersion: number;
  };
};

export type CommunityCommentMentionTarget = {
  publicProfileId: string;
  displayName: string;
  isBanned: boolean;
};

export type CommunityCommentAccountState =
  | { kind: "loading" }
  | { kind: "anonymous" }
  | { kind: "restricted" | "dependency_unavailable" }
  | {
      kind: "authenticated";
      publicProfileId: string | null;
      displayName: string;
    };

export class CommunityCommentClientError extends Error {
  public readonly status: number;
  public readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
    this.name = "CommunityCommentClientError";
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function positiveInteger(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function nonNegativeInteger(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function timestamp(value: unknown) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

async function responseJson(response: Response) {
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const body = record(value);
    throw new CommunityCommentClientError(
      response.status,
      typeof body.error === "string" ? body.error : "COMMENTS_UNAVAILABLE",
    );
  }
  return value;
}

function parseRootItem(value: unknown): CommunityCommentRootItem {
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
    throw new CommunityCommentClientError(503, "COMMENTS_UNAVAILABLE");
  }
  const base = Object.fromEntries(
    COMMUNITY_COMMENT_PUBLIC_KEYS.map((key) => [key, item[key]]),
  );
  return {
    ...parseCommunityCommentPublicDto(base),
    replyPreview: item.replyPreview.map(parseCommunityCommentPublicDto),
    replyPreviewHasMore: item.replyPreviewHasMore,
  };
}

export function parseCommunityCommentRootPage(
  value: unknown,
  expectedSubmissionId: number,
  expectedSort: CommunityCommentSort,
): CommunityCommentRootPage {
  const page = record(value);
  if (
    !exactKeys(page, [
      "releaseState",
      "submissionId",
      "sort",
      "snapshotAt",
      "threadVersion",
      "items",
      "hasMore",
      "nextCursor",
    ]) ||
    !["read_only", "open"].includes(String(page.releaseState)) ||
    page.submissionId !== expectedSubmissionId ||
    page.sort !== expectedSort ||
    !timestamp(page.snapshotAt) ||
    !nonNegativeInteger(page.threadVersion) ||
    !Array.isArray(page.items) ||
    typeof page.hasMore !== "boolean" ||
    !(page.nextCursor === null || typeof page.nextCursor === "string") ||
    page.hasMore !== (typeof page.nextCursor === "string")
  ) {
    throw new CommunityCommentClientError(503, "COMMENTS_UNAVAILABLE");
  }
  return {
    releaseState: page.releaseState as CommunityCommentReleaseState,
    submissionId: expectedSubmissionId,
    sort: expectedSort,
    snapshotAt: page.snapshotAt as string,
    threadVersion: page.threadVersion as number,
    items: page.items.map(parseRootItem),
    hasMore: page.hasMore,
    nextCursor: page.nextCursor as string | null,
  };
}

export function parseCommunityCommentReplyPage(
  value: unknown,
  rootPublicCommentId: string,
): CommunityCommentReplyPage {
  const page = record(value);
  if (
    page.rootPublicCommentId !== rootPublicCommentId ||
    !positiveInteger(page.rootVersion) ||
    typeof page.branchOpen !== "boolean" ||
    !timestamp(page.snapshotAt) ||
    !Array.isArray(page.items) ||
    typeof page.hasMore !== "boolean" ||
    !(page.nextCursor === null || typeof page.nextCursor === "string") ||
    page.hasMore !== (typeof page.nextCursor === "string")
  ) {
    throw new CommunityCommentClientError(503, "COMMENTS_UNAVAILABLE");
  }
  return {
    rootPublicCommentId,
    rootVersion: page.rootVersion as number,
    branchOpen: page.branchOpen,
    snapshotAt: page.snapshotAt as string,
    items: page.items.map(parseCommunityCommentPublicDto),
    hasMore: page.hasMore,
    nextCursor: page.nextCursor as string | null,
  };
}

export function parseCommunityCommentMutationReceipt(
  value: unknown,
): CommunityCommentMutationReceipt {
  const receipt = record(value);
  if (
    !["created", "edited", "author_deleted"].includes(String(receipt.outcome)) ||
    typeof receipt.replayed !== "boolean" ||
    !positiveInteger(receipt.threadVersion)
  ) {
    throw new CommunityCommentClientError(503, "COMMENTS_UNAVAILABLE");
  }
  return {
    outcome: receipt.outcome as CommunityCommentMutationReceipt["outcome"],
    replayed: receipt.replayed,
    threadVersion: receipt.threadVersion as number,
    ...(typeof receipt.branchClosed === "boolean"
      ? { branchClosed: receipt.branchClosed }
      : {}),
    ...(positiveInteger(receipt.rootVersion)
      ? { rootVersion: receipt.rootVersion as number }
      : {}),
    comment: parseCommunityCommentPublicDto(receipt.comment),
  };
}

export async function fetchCommunityCommentRootPage(input: {
  submissionId: number;
  sort: CommunityCommentSort;
  cursor?: string | null;
  signal?: AbortSignal;
}) {
  const query = new URLSearchParams({ sort: input.sort });
  if (input.cursor) query.set("cursor", input.cursor);
  const response = await fetch(
    `/api/comments/submissions/${input.submissionId}?${query.toString()}`,
    { cache: "no-store", signal: input.signal },
  );
  return parseCommunityCommentRootPage(
    await responseJson(response),
    input.submissionId,
    input.sort,
  );
}

export async function fetchCommunityCommentReplyPage(input: {
  submissionId: number;
  rootPublicCommentId: string;
  cursor?: string | null;
}) {
  const suffix = input.cursor
    ? `?cursor=${encodeURIComponent(input.cursor)}`
    : "";
  const response = await fetch(
    `/api/comments/submissions/${input.submissionId}/${encodeURIComponent(input.rootPublicCommentId)}/replies${suffix}`,
    { cache: "no-store" },
  );
  return parseCommunityCommentReplyPage(
    await responseJson(response),
    input.rootPublicCommentId,
  );
}

export async function fetchCommunityCommentDeepLink(publicCommentId: string) {
  const response = await fetch(
    `/api/comments/${encodeURIComponent(publicCommentId)}`,
    { cache: "no-store" },
  );
  const value = record(await responseJson(response));
  if (
    !positiveInteger(value.submissionId) ||
    value.targetPublicCommentId !== publicCommentId ||
    typeof value.branchOpen !== "boolean" ||
    value.windowLimit !== 20 ||
    !Array.isArray(value.replies)
  ) {
    throw new CommunityCommentClientError(503, "COMMENTS_UNAVAILABLE");
  }
  return {
    submissionId: value.submissionId as number,
    targetPublicCommentId: publicCommentId,
    root: parseCommunityCommentPublicDto(value.root),
    replies: value.replies.map(parseCommunityCommentPublicDto),
    branchOpen: value.branchOpen,
    windowLimit: 20 as const,
  };
}

export async function fetchCommunityCommentsBatch(publicCommentIds: string[]) {
  const response = await fetch("/api/comments/batch", {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicCommentIds: [...new Set(publicCommentIds)] }),
  });
  const value = record(await responseJson(response));
  if (!exactKeys(value, ["items"]) || !Array.isArray(value.items)) {
    throw new CommunityCommentClientError(503, "COMMENTS_UNAVAILABLE");
  }
  return value.items.map(parseCommunityCommentPublicDto);
}

export async function fetchCommunityCommentAccount(): Promise<CommunityCommentAccountState> {
  try {
    const response = await fetch("/api/auth/account", { cache: "no-store" });
    const value = record(await responseJson(response)) as GlobalAccountViewState;
    if (value.kind === "authenticated") {
      return {
        kind: "authenticated",
        publicProfileId:
          typeof value.publicProfileId === "string" ? value.publicProfileId : null,
        displayName: value.displayName,
      };
    }
    if (value.kind === "anonymous" || value.kind === "restricted") return value;
    return { kind: "dependency_unavailable" };
  } catch {
    return { kind: "dependency_unavailable" };
  }
}

export async function searchCommunityCommentMentions(query: string) {
  const response = await fetch(
    `/api/comments/mentions?q=${encodeURIComponent(query)}`,
    { cache: "no-store" },
  );
  const value = record(await responseJson(response));
  if (!Array.isArray(value.items)) {
    throw new CommunityCommentClientError(503, "COMMENTS_UNAVAILABLE");
  }
  return value.items.map((candidate) => {
    const item = record(candidate);
    if (
      typeof item.publicProfileId !== "string" ||
      typeof item.displayName !== "string" ||
      !item.displayName.trim() ||
      typeof item.isBanned !== "boolean"
    ) {
      throw new CommunityCommentClientError(503, "COMMENTS_UNAVAILABLE");
    }
    return item as CommunityCommentMentionTarget;
  });
}

export async function sendCommunityCommentMutation(input: {
  url: string;
  method: "POST" | "PATCH" | "DELETE";
  body: Record<string, unknown>;
  turnstileToken?: string | null;
}) {
  const response = await fetch(input.url, {
    method: input.method,
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      ...(input.turnstileToken
        ? { "X-Turnstile-Token": input.turnstileToken }
        : {}),
    },
    body: JSON.stringify(input.body),
  });
  return parseCommunityCommentMutationReceipt(await responseJson(response));
}

function parseVoteState(value: unknown): CommunityCommentVoteState {
  if (value === null || value === "up" || value === "down") return value;
  throw new CommunityCommentClientError(503, "COMMENTS_UNAVAILABLE");
}

export async function fetchCommunityCommentVoteViewerState(
  publicCommentIds: string[],
) {
  const response = await fetch("/api/comments/votes/viewer-state", {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicCommentIds: [...new Set(publicCommentIds)] }),
  });
  const value = record(await responseJson(response));
  if (!exactKeys(value, ["items"]) || !Array.isArray(value.items)) {
    throw new CommunityCommentClientError(503, "COMMENTS_UNAVAILABLE");
  }
  return value.items.map((candidate): CommunityCommentVoteViewerState => {
    const item = record(candidate);
    if (
      !exactKeys(item, ["publicCommentId", "state", "version"]) ||
      typeof item.publicCommentId !== "string" ||
      !nonNegativeInteger(item.version)
    ) {
      throw new CommunityCommentClientError(503, "COMMENTS_UNAVAILABLE");
    }
    return {
      publicCommentId: item.publicCommentId,
      state: parseVoteState(item.state),
      version: item.version as number,
    };
  });
}

export async function sendCommunityCommentVote(input: {
  publicCommentId: string;
  desiredState: CommunityCommentVoteState;
  expectedVersion: number;
  requestId: string;
}) {
  const response = await fetch(
    `/api/comments/${encodeURIComponent(input.publicCommentId)}/vote`,
    {
      method: "PUT",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        desiredState: input.desiredState,
        expectedVersion: input.expectedVersion,
        requestId: input.requestId,
      }),
    },
  );
  const receipt = record(await responseJson(response));
  const projection = record(receipt.projection);
  const counts = record(projection.voteCounts);
  if (
    !exactKeys(receipt, ["outcome", "projection", "replayed"]) ||
    receipt.outcome !== "voted" ||
    typeof receipt.replayed !== "boolean" ||
    !exactKeys(projection, [
      "publicCommentId",
      "viewerState",
      "viewerVersion",
      "voteCounts",
    ]) ||
    projection.publicCommentId !== input.publicCommentId ||
    !nonNegativeInteger(projection.viewerVersion) ||
    !exactKeys(counts, ["down", "up"]) ||
    !nonNegativeInteger(counts.up) ||
    !nonNegativeInteger(counts.down)
  ) {
    throw new CommunityCommentClientError(503, "COMMENTS_UNAVAILABLE");
  }
  return {
    outcome: "voted" as const,
    replayed: receipt.replayed,
    projection: {
      publicCommentId: input.publicCommentId,
      voteCounts: { up: counts.up as number, down: counts.down as number },
      viewerState: parseVoteState(projection.viewerState),
      viewerVersion: projection.viewerVersion as number,
    },
  } satisfies CommunityCommentVoteReceipt;
}

export function mergeCommunityComments(
  current: CommunityCommentPublicDto[],
  incoming: CommunityCommentPublicDto[],
) {
  const byId = new Map(current.map((comment) => [comment.publicCommentId, comment]));
  for (const comment of incoming) byId.set(comment.publicCommentId, comment);
  return [...byId.values()].sort(
    (left, right) =>
      Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
      left.publicCommentId.localeCompare(right.publicCommentId),
  );
}

export function getCommunityCommentLoginHref() {
  const returnPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  return `/api/auth/discord/login?state=${encodeURIComponent(returnPath)}`;
}
