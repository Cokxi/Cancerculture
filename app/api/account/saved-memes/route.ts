export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getAuthErrorCode, getAuthErrorStatus } from "@/lib/auth/AuthError";
import { requireSession } from "@/lib/auth/requireSession";
import {
  getOwnSavedMemes,
  SavedMemesError,
  type SavedMemeCursor,
} from "@/lib/savedMemes/service.server";

const headers = { "Cache-Control": "no-store, max-age=0" };

function errorResponse(error: unknown) {
  const status =
    error instanceof SavedMemesError
      ? error.status
      : (getAuthErrorStatus(error) ?? 503);
  const code =
    error instanceof SavedMemesError
      ? error.code
      : (getAuthErrorCode(error) ?? "SAVED_MEMES_UNAVAILABLE");
  return NextResponse.json({ error: code }, { status, headers });
}

function readCursor(url: URL): SavedMemeCursor | null {
  const savedAt = url.searchParams.get("beforeSavedAt");
  const rawBookmarkId = url.searchParams.get("beforeBookmarkId");
  if (savedAt === null && rawBookmarkId === null) return null;
  if (savedAt === null || rawBookmarkId === null) {
    throw new SavedMemesError(400, "SAVED_MEME_PAGE_INPUT_INVALID");
  }
  return { savedAt, bookmarkId: Number(rawBookmarkId) };
}

export async function GET(request: Request) {
  try {
    const session = await requireSession();
    const result = await getOwnSavedMemes({
      sessionId: session.session_id,
      cursor: readCursor(new URL(request.url)),
      limit: 24,
    });
    return NextResponse.json(result, { headers });
  } catch (error) {
    return errorResponse(error);
  }
}
