export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { requireSession } from "@/lib/auth/requireSession";
import {
  commentError,
  commentJson,
  parseCommunityCommentJson,
} from "@/lib/comments/commentRoute.server";
import {
  createCommunityCommentReply,
  getCommunityCommentReplyPage,
} from "@/lib/comments/commentService.server";

type Context = {
  params: Promise<{ submissionId: string; rootPublicCommentId: string }>;
};

export async function GET(request: Request, context: Context) {
  try {
    const params = await context.params;
    return commentJson(await getCommunityCommentReplyPage({
      submissionId: Number(params.submissionId),
      rootPublicCommentId: params.rootPublicCommentId,
      cursor: new URL(request.url).searchParams.get("cursor"),
    }));
  } catch (error) {
    return commentError(error);
  }
}

export async function POST(request: Request, context: Context) {
  try {
    const session = await requireSession();
    const { rootPublicCommentId } = await context.params;
    return commentJson(await createCommunityCommentReply({
      request,
      sessionId: session.session_id,
      rootPublicCommentId,
      body: await parseCommunityCommentJson(request),
    }), 201);
  } catch (error) {
    return commentError(error);
  }
}
