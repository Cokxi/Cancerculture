export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import {
  commentError,
  commentJson,
  parseCommunityCommentJson,
} from "@/lib/comments/commentRoute.server";
import { getCommunityCommentsBatch } from "@/lib/comments/commentService.server";

export async function POST(request: Request) {
  try {
    const body = await parseCommunityCommentJson(request);
    if (!Array.isArray(body.publicCommentIds)) {
      return commentJson({ error: "COMMENT_BATCH_INVALID" }, 400);
    }
    return commentJson(await getCommunityCommentsBatch(
      body.publicCommentIds as string[]
    ));
  } catch (error) {
    return commentError(error);
  }
}
