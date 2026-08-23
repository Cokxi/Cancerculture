export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getAuthErrorCode, getAuthErrorStatus } from "@/lib/auth/AuthError";
import { requireSession } from "@/lib/auth/requireSession";
import {
  getSavedMemeStatus,
  SavedMemesError,
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

export async function GET(request: Request) {
  try {
    const session = await requireSession();
    const rawIds = new URL(request.url).searchParams.get("submissionIds");
    if (!rawIds || rawIds.length > 2200) {
      throw new SavedMemesError(400, "SAVED_MEME_STATUS_INPUT_INVALID");
    }
    const submissionIds = rawIds.split(",").map((value) => Number(value));
    const result = await getSavedMemeStatus(
      session.session_id,
      submissionIds,
    );
    return NextResponse.json(result, { headers });
  } catch (error) {
    return errorResponse(error);
  }
}
