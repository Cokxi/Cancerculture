import "server-only";

import { NextResponse } from "next/server";
import { AuthError } from "@/lib/auth/AuthError";
import { CommunityCommentServiceError } from "@/lib/comments/commentService.server";
import { PublicPaginationCursorError } from "@/lib/pagination/publicPaginationCursor";

const MAX_JSON_BODY_BYTES = 50_000;
export const COMMENT_NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
} as const;

export async function parseCommunityCommentJson(request: Request) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_JSON_BODY_BYTES) {
    throw new CommunityCommentServiceError(400, "COMMENT_BODY_INVALID");
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_JSON_BODY_BYTES) {
    throw new CommunityCommentServiceError(400, "COMMENT_BODY_INVALID");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    value = null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CommunityCommentServiceError(400, "COMMENT_BODY_INVALID");
  }
  return value as Record<string, unknown>;
}

export function commentJson(value: unknown, status = 200) {
  return NextResponse.json(value, { status, headers: COMMENT_NO_STORE_HEADERS });
}

export function commentError(error: unknown) {
  if (error instanceof CommunityCommentServiceError) {
    return commentJson({ error: error.code }, error.status);
  }
  if (error instanceof PublicPaginationCursorError) {
    return commentJson({ error: "INVALID_CURSOR" }, 400);
  }
  if (error instanceof AuthError) {
    return commentJson({ error: error.code }, error.status);
  }
  console.error("[COMMENTS] route failure", {
    name: error instanceof Error ? error.name : "unknown",
  });
  return commentJson({ error: "COMMENTS_UNAVAILABLE" }, 503);
}
