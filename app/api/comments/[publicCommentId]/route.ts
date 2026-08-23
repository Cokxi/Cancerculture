export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { requireSession } from "@/lib/auth/requireSession";
import {
  commentError,
  commentJson,
  parseCommunityCommentJson,
} from "@/lib/comments/commentRoute.server";
import {
  deleteCommunityComment,
  editCommunityComment,
  getCommunityCommentDeepLink,
} from "@/lib/comments/commentService.server";

type Context = { params: Promise<{ publicCommentId: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    return commentJson(await getCommunityCommentDeepLink(
      (await context.params).publicCommentId
    ));
  } catch (error) {
    return commentError(error);
  }
}

export async function PATCH(request: Request, context: Context) {
  try {
    const session = await requireSession();
    return commentJson(await editCommunityComment({
      request,
      sessionId: session.session_id,
      publicCommentId: (await context.params).publicCommentId,
      body: await parseCommunityCommentJson(request),
    }));
  } catch (error) {
    return commentError(error);
  }
}

export async function DELETE(request: Request, context: Context) {
  try {
    const session = await requireSession();
    return commentJson(await deleteCommunityComment({
      sessionId: session.session_id,
      publicCommentId: (await context.params).publicCommentId,
      body: await parseCommunityCommentJson(request),
    }));
  } catch (error) {
    return commentError(error);
  }
}
