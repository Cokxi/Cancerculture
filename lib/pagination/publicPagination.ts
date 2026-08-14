export const PUBLIC_SUBMISSION_PAGE_SIZE = 48;
export const PUBLIC_PAGINATION_CURSOR_VERSION = 1;

export const PUBLIC_PAGINATION_SCOPES = {
  submissions: "submissions",
  fame: "fame",
  shame: "shame",
  historyCycles: "history-cycles",
  historySubmissions: "history-submissions",
  feedLive: "feed-live",
  feedTop10: "feed-top-10",
  feedAll: "feed-all",
  feedTrash: "feed-trash",
  feedCycleCatalog: "feed-cycle-catalog",
} as const;

export type PublicPaginationScope =
  (typeof PUBLIC_PAGINATION_SCOPES)[keyof typeof PUBLIC_PAGINATION_SCOPES];

export type PublicPage<T> = {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
};

export type PaginationView = "public" | "admin";

export type PublicPaginationCursorPayload =
  | {
      version: typeof PUBLIC_PAGINATION_CURSOR_VERSION;
      scope: typeof PUBLIC_PAGINATION_SCOPES.submissions;
      context: { cycleId: number };
      values: { id: number };
    }
  | {
      version: typeof PUBLIC_PAGINATION_CURSOR_VERSION;
      scope:
        | typeof PUBLIC_PAGINATION_SCOPES.fame
        | typeof PUBLIC_PAGINATION_SCOPES.shame;
      context: { wall: "fame" | "shame" };
      values: { createdAt: string | null; id: number };
    }
  | {
      version: typeof PUBLIC_PAGINATION_CURSOR_VERSION;
      scope: typeof PUBLIC_PAGINATION_SCOPES.historyCycles;
      context: { view: PaginationView };
      values: { id: number };
    }
  | {
      version: typeof PUBLIC_PAGINATION_CURSOR_VERSION;
      scope: typeof PUBLIC_PAGINATION_SCOPES.historySubmissions;
      context: { cycleId: number; view: PaginationView };
      values: { id: number };
    }
  | {
      version: typeof PUBLIC_PAGINATION_CURSOR_VERSION;
      scope: typeof PUBLIC_PAGINATION_SCOPES.feedLive;
      context: {
        feed: "live";
        cycleNumber: number;
        resetCount: number;
      };
      values: {
        createdAt: string;
        submissionId: number;
      };
    }
  | {
      version: typeof PUBLIC_PAGINATION_CURSOR_VERSION;
      scope:
        | typeof PUBLIC_PAGINATION_SCOPES.feedTop10
        | typeof PUBLIC_PAGINATION_SCOPES.feedAll
        | typeof PUBLIC_PAGINATION_SCOPES.feedTrash;
      context: {
        feed: "top10" | "all" | "trash";
        classificationVersion: number;
        cycleNumber: number | null;
      };
      values: {
        finalizedAt: string;
        cycleNumber: number;
        rankInCycle: number;
        submissionId: number;
      };
    }
  | {
      version: typeof PUBLIC_PAGINATION_CURSOR_VERSION;
      scope: typeof PUBLIC_PAGINATION_SCOPES.feedCycleCatalog;
      context: { catalog: "finalized-cycles" };
      values: { cycleNumber: number };
    };

export type PublicPaginationCursorPayloadForScope<
  Scope extends PublicPaginationScope,
> = PublicPaginationCursorPayload extends infer Payload
  ? Payload extends { scope: infer PayloadScope }
    ? Scope extends PayloadScope
      ? Payload
      : never
    : never
  : never;
