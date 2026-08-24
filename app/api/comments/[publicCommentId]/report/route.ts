export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { requireSession } from "@/lib/auth/requireSession";
import {
  commentError,
  commentJson,
  parseCommunityCommentJson,
} from "@/lib/comments/commentRoute.server";
import { submitCommunityCommentReport } from "@/lib/comments/commentReport.server";

type Context = { params: Promise<{ publicCommentId: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const session = await requireSession();
    return commentJson(await submitCommunityCommentReport({
      request,
      sessionId: session.session_id,
      reporterDiscordUserId: session.discord_user_id,
      publicCommentId: (await context.params).publicCommentId,
      body: await parseCommunityCommentJson(request),
    }), 201);
  } catch (error) {
    return commentError(error);
  }
}
