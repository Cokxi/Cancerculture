export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { requireSession } from "@/lib/auth/requireSession";
import {
  commentError,
  commentJson,
  parseCommunityCommentJson,
} from "@/lib/comments/commentRoute.server";
import { setCommunityCommentVote } from "@/lib/comments/commentService.server";

type Context = { params: Promise<{ publicCommentId: string }> };

export async function PUT(request: Request, context: Context) {
  try {
    const session = await requireSession();
    return commentJson(await setCommunityCommentVote({
      request,
      sessionId: session.session_id,
      publicCommentId: (await context.params).publicCommentId,
      body: await parseCommunityCommentJson(request),
    }));
  } catch (error) {
    return commentError(error);
  }
}
