export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { requireSession } from "@/lib/auth/requireSession";
import { commentError, commentJson } from "@/lib/comments/commentRoute.server";
import { searchCommunityCommentMentionTargets } from "@/lib/comments/commentService.server";

export async function GET(request: Request) {
  try {
    const session = await requireSession();
    return commentJson(await searchCommunityCommentMentionTargets({
      sessionId: session.session_id,
      query: new URL(request.url).searchParams.get("q") ?? "",
    }));
  } catch (error) {
    return commentError(error);
  }
}
