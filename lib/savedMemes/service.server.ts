import "server-only";

import { AuthError } from "@/lib/auth/AuthError";
import { supabaseAdmin } from "@/lib/db/admin";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type SavedMemeMutationResult = {
  outcome: "saved" | "removed" | "unchanged" | "not_public";
  submissionId: number;
  saved: boolean;
  changed: boolean;
};

export type SavedMemeItem = {
  bookmarkId: number;
  submissionId: number;
  savedAt: string;
  available: boolean;
  cycleNumber: number | null;
  mediaWidth: number | null;
  mediaHeight: number | null;
};

export type SavedMemeCursor = {
  savedAt: string;
  bookmarkId: number;
};

export type SavedMemePage = {
  items: SavedMemeItem[];
  nextCursor: SavedMemeCursor | null;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function nullablePositiveSafeInteger(value: unknown): value is number | null {
  return value === null || positiveSafeInteger(value);
}

function canonicalTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
}

function requireSessionId(sessionId: string) {
  if (!UUID_PATTERN.test(sessionId)) {
    throw new AuthError(401, "Not authenticated", "NOT_AUTHENTICATED");
  }
  return sessionId;
}

function requireSubmissionId(submissionId: number) {
  if (!positiveSafeInteger(submissionId)) {
    throw new SavedMemesError(400, "SAVED_MEME_INPUT_INVALID");
  }
  return submissionId;
}

async function rpc(functionName: string, parameters: object) {
  const { data, error } = await supabaseAdmin.rpc(functionName, parameters);
  if (error) {
    console.error("[SAVED_MEMES] RPC failed", {
      functionName,
      code: error.code,
    });
    throw new SavedMemesError(503, "SAVED_MEMES_UNAVAILABLE");
  }
  return data;
}

export class SavedMemesError extends Error {
  readonly status: 400 | 409 | 503;
  readonly code: string;

  constructor(
    status: 400 | 409 | 503,
    code: string,
  ) {
    super(code);
    this.name = "SavedMemesError";
    this.status = status;
    this.code = code;
  }
}

export async function setSavedMeme({
  sessionId,
  submissionId,
  saved,
}: {
  sessionId: string;
  submissionId: number;
  saved: boolean;
}): Promise<SavedMemeMutationResult> {
  const value = record(
    await rpc("set_account_saved_meme", {
      p_session_id: requireSessionId(sessionId),
      p_submission_id: requireSubmissionId(submissionId),
      p_saved: saved,
    }),
  );

  if (
    !["saved", "removed", "unchanged", "not_public"].includes(
      String(value.outcome),
    ) ||
    value.submissionId !== submissionId ||
    typeof value.saved !== "boolean" ||
    typeof value.changed !== "boolean" ||
    (value.outcome === "not_public" && value.saved !== false) ||
    (value.outcome !== "not_public" && value.saved !== saved)
  ) {
    throw new SavedMemesError(503, "SAVED_MEMES_RESPONSE_INVALID");
  }

  return {
    outcome: value.outcome as SavedMemeMutationResult["outcome"],
    submissionId,
    saved: value.saved,
    changed: value.changed,
  };
}

export async function getSavedMemeStatus(
  sessionId: string,
  submissionIds: number[],
) {
  const uniqueIds = [...new Set(submissionIds)];
  if (
    uniqueIds.length > 100 ||
    uniqueIds.some((submissionId) => !positiveSafeInteger(submissionId))
  ) {
    throw new SavedMemesError(400, "SAVED_MEME_STATUS_INPUT_INVALID");
  }

  const value = record(
    await rpc("get_account_saved_meme_status", {
      p_session_id: requireSessionId(sessionId),
      p_submission_ids: uniqueIds,
    }),
  );
  const savedIds = value.savedSubmissionIds;
  if (
    value.outcome !== "ok" ||
    !Array.isArray(savedIds) ||
    savedIds.some(
      (submissionId) =>
        !positiveSafeInteger(submissionId) || !uniqueIds.includes(submissionId),
    )
  ) {
    throw new SavedMemesError(503, "SAVED_MEMES_RESPONSE_INVALID");
  }

  return { savedSubmissionIds: [...new Set(savedIds as number[])] };
}

function parseSavedMemeItem(value: unknown): SavedMemeItem | null {
  const item = record(value);
  const savedAt = canonicalTimestamp(item.savedAt);
  if (
    !positiveSafeInteger(item.bookmarkId) ||
    !positiveSafeInteger(item.submissionId) ||
    !savedAt ||
    typeof item.available !== "boolean" ||
    !nullablePositiveSafeInteger(item.cycleNumber) ||
    !nullablePositiveSafeInteger(item.mediaWidth) ||
    !nullablePositiveSafeInteger(item.mediaHeight) ||
    (!item.available &&
      (item.cycleNumber !== null ||
        item.mediaWidth !== null ||
        item.mediaHeight !== null))
  ) {
    return null;
  }

  return {
    bookmarkId: item.bookmarkId,
    submissionId: item.submissionId,
    savedAt,
    available: item.available,
    cycleNumber: item.cycleNumber,
    mediaWidth: item.mediaWidth,
    mediaHeight: item.mediaHeight,
  };
}

function parseCursor(value: unknown): SavedMemeCursor | null | undefined {
  if (value === null) return null;
  const cursor = record(value);
  const savedAt = canonicalTimestamp(cursor.savedAt);
  if (!savedAt || !positiveSafeInteger(cursor.bookmarkId)) return undefined;
  return { savedAt, bookmarkId: cursor.bookmarkId };
}

export async function getOwnSavedMemes({
  sessionId,
  cursor = null,
  limit = 24,
}: {
  sessionId: string;
  cursor?: SavedMemeCursor | null;
  limit?: number;
}): Promise<SavedMemePage> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 48) {
    throw new SavedMemesError(400, "SAVED_MEME_PAGE_INPUT_INVALID");
  }
  const cursorSavedAt = cursor ? canonicalTimestamp(cursor.savedAt) : null;
  if (
    cursor &&
    (!cursorSavedAt || !positiveSafeInteger(cursor.bookmarkId))
  ) {
    throw new SavedMemesError(400, "SAVED_MEME_PAGE_INPUT_INVALID");
  }

  const value = record(
    await rpc("list_account_saved_memes", {
      p_session_id: requireSessionId(sessionId),
      p_before_saved_at: cursorSavedAt,
      p_before_id: cursor?.bookmarkId ?? null,
      p_limit: limit,
    }),
  );
  const items = Array.isArray(value.items)
    ? value.items.map(parseSavedMemeItem)
    : [];
  const nextCursor = parseCursor(value.nextCursor);
  if (
    value.outcome !== "ok" ||
    !Array.isArray(value.items) ||
    items.some((item) => item === null) ||
    nextCursor === undefined
  ) {
    throw new SavedMemesError(503, "SAVED_MEMES_RESPONSE_INVALID");
  }

  return {
    items: items as SavedMemeItem[],
    nextCursor,
  };
}
