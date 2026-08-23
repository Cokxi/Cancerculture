import "server-only";

import {
  COMMUNITY_COMMENT_CURSOR_CONTRACT_VERSION,
  PUBLIC_PAGINATION_CURSOR_VERSION,
  PUBLIC_PAGINATION_SCOPES,
  type PublicPaginationCursorPayload,
} from "@/lib/pagination/publicPagination";
import {
  decodeServerPublicPaginationCursor,
  encodeServerPublicPaginationCursor,
} from "@/lib/pagination/publicPaginationCursor.server";

export type CommunityCommentSort = "top" | "newest";

const ROOT_SCOPE = {
  top: PUBLIC_PAGINATION_SCOPES.commentRootsTop,
  newest: PUBLIC_PAGINATION_SCOPES.commentRootsNewest,
} as const;

export function encodeCommunityCommentRootCursor(input: {
  submissionId: number;
  sort: CommunityCommentSort;
  snapshotAt: string;
  netScore?: number | null;
  createdAt: string;
  publicCommentId: string;
}) {
  const context = {
    submissionId: input.submissionId,
    sort: input.sort,
    contractVersion: COMMUNITY_COMMENT_CURSOR_CONTRACT_VERSION,
  } as const;

  const payload =
    input.sort === "top"
      ? {
          version: PUBLIC_PAGINATION_CURSOR_VERSION,
          scope: PUBLIC_PAGINATION_SCOPES.commentRootsTop,
          context,
          values: {
            snapshotAt: input.snapshotAt,
            netScore: input.netScore ?? 0,
            createdAt: input.createdAt,
            publicCommentId: input.publicCommentId,
          },
        }
      : {
          version: PUBLIC_PAGINATION_CURSOR_VERSION,
          scope: PUBLIC_PAGINATION_SCOPES.commentRootsNewest,
          context,
          values: {
            snapshotAt: input.snapshotAt,
            createdAt: input.createdAt,
            publicCommentId: input.publicCommentId,
          },
        };

  return encodeServerPublicPaginationCursor(
    payload as PublicPaginationCursorPayload
  );
}
export function decodeCommunityCommentRootCursor(
  cursor: string,
  submissionId: number,
  sort: CommunityCommentSort
) {
  return decodeServerPublicPaginationCursor(
    cursor,
    ROOT_SCOPE[sort],
    {
      submissionId,
      sort,
      contractVersion: COMMUNITY_COMMENT_CURSOR_CONTRACT_VERSION,
    }
  ) as Extract<
    PublicPaginationCursorPayload,
    {
      scope:
        | typeof PUBLIC_PAGINATION_SCOPES.commentRootsTop
        | typeof PUBLIC_PAGINATION_SCOPES.commentRootsNewest;
    }
  >;
}

export function encodeCommunityCommentReplyCursor(input: {
  submissionId: number;
  rootPublicCommentId: string;
  snapshotAt: string;
  createdAt: string;
  publicCommentId: string;
}) {
  return encodeServerPublicPaginationCursor({
    version: PUBLIC_PAGINATION_CURSOR_VERSION,
    scope: PUBLIC_PAGINATION_SCOPES.commentReplies,
    context: {
      submissionId: input.submissionId,
      rootPublicCommentId: input.rootPublicCommentId,
      contractVersion: COMMUNITY_COMMENT_CURSOR_CONTRACT_VERSION,
    },
    values: {
      snapshotAt: input.snapshotAt,
      createdAt: input.createdAt,
      publicCommentId: input.publicCommentId,
    },
  });
}

export function decodeCommunityCommentReplyCursor(
  cursor: string,
  submissionId: number,
  rootPublicCommentId: string
) {
  return decodeServerPublicPaginationCursor(
    cursor,
    PUBLIC_PAGINATION_SCOPES.commentReplies,
    {
      submissionId,
      rootPublicCommentId,
      contractVersion: COMMUNITY_COMMENT_CURSOR_CONTRACT_VERSION,
    }
  );
}
