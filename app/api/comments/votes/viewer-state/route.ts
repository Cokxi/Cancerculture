export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { requireSession } from "@/lib/auth/requireSession";
import {
  commentError,
  commentJson,
  parseCommunityCommentJson,
} from "@/lib/comments/commentRoute.server";
import { getCommunityCommentVoteViewerState } from "@/lib/comments/commentService.server";

export async function POST(request: Request) {
  try {
    const session = await requireSession();
    const body = await parseCommunityCommentJson(request);
    if (
      Object.keys(body).length !== 1 ||
      !("publicCommentIds" in body) ||
      !Array.isArray(body.publicCommentIds)
    ) {
      return commentJson({ error: "COMMENT_VOTE_VIEWER_INVALID" }, 400);
    }
    return commentJson(await getCommunityCommentVoteViewerState({
      sessionId: session.session_id,
      publicCommentIds: body.publicCommentIds as string[],
    }));
  } catch (error) {
    return commentError(error);
  }
}
