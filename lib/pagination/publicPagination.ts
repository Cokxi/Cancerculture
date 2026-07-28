export const PUBLIC_SUBMISSION_PAGE_SIZE = 48;
export const PUBLIC_PAGINATION_CURSOR_VERSION = 1;

export const PUBLIC_PAGINATION_SCOPES = {
  submissions: "submissions",
  fame: "fame",
  shame: "shame",
  historyCycles: "history-cycles",
  historySubmissions: "history-submissions",
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
    };

