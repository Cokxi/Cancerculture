export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import {
  commentError,
  commentJson,
  parseCommunityCommentJson,
} from "@/lib/comments/commentRoute.server";
import { getCommunityCommentCounts } from "@/lib/comments/commentService.server";

export async function POST(request: Request) {
  try {
    const body = await parseCommunityCommentJson(request);
    if (
      Object.keys(body).length !== 1 ||
      !Array.isArray(body.submissionIds)
    ) {
      return commentJson({ error: "COMMENT_COUNT_BATCH_INVALID" }, 400);
    }
    return commentJson(await getCommunityCommentCounts(
      body.submissionIds as number[],
    ));
  } catch (error) {
    return commentError(error);
  }
}
