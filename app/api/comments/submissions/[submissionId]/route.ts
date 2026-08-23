export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { requireSession } from "@/lib/auth/requireSession";
import {
  commentError,
  commentJson,
  parseCommunityCommentJson,
} from "@/lib/comments/commentRoute.server";
import {
  createCommunityCommentRoot,
  getCommunityCommentRootPage,
} from "@/lib/comments/commentService.server";

type Context = { params: Promise<{ submissionId: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const submissionId = Number((await context.params).submissionId);
    const url = new URL(request.url);
    const sort = url.searchParams.get("sort") ?? "top";
    if (sort !== "top" && sort !== "newest") {
      return commentJson({ error: "COMMENT_PAGE_INVALID" }, 400);
    }
    return commentJson(await getCommunityCommentRootPage({
      submissionId,
      sort,
      cursor: url.searchParams.get("cursor"),
    }));
  } catch (error) {
    return commentError(error);
  }
}

export async function POST(request: Request, context: Context) {
  try {
    const session = await requireSession();
    const submissionId = Number((await context.params).submissionId);
    const body = await parseCommunityCommentJson(request);
    return commentJson(await createCommunityCommentRoot({
      request,
      sessionId: session.session_id,
      submissionId,
      body,
    }), 201);
  } catch (error) {
    return commentError(error);
  }
}
