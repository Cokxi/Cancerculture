export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getAuthErrorCode, getAuthErrorStatus } from "@/lib/auth/AuthError";
import { requireSession } from "@/lib/auth/requireSession";
import {
  SavedMemesError,
  setSavedMeme,
} from "@/lib/savedMemes/service.server";
import { enforceRouteMutationGate } from "@/lib/writeGate.server";

const headers = { "Cache-Control": "no-store, max-age=0" };
type SavedMemeRouteContext = {
  params: Promise<{ submissionId: string }>;
};

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

async function mutate(
  saved: boolean,
  context: SavedMemeRouteContext,
) {
  const gate = enforceRouteMutationGate();
  if (gate) return gate;

  try {
    const submissionId = Number((await context.params).submissionId);
    const session = await requireSession();
    const result = await setSavedMeme({
      sessionId: session.session_id,
      submissionId,
      saved,
    });
    if (result.outcome === "not_public") {
      return NextResponse.json(result, { status: 409, headers });
    }
    return NextResponse.json(result, { headers });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(
  _request: Request,
  context: SavedMemeRouteContext,
) {
  return mutate(true, context);
}

export async function DELETE(
  _request: Request,
  context: SavedMemeRouteContext,
) {
  return mutate(false, context);
}
