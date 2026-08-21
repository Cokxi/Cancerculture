export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import {
  getAuthErrorCode,
  getAuthErrorStatus,
} from "@/lib/auth/AuthError";
import { requireSession } from "@/lib/auth/requireSession";
import { getSessionState } from "@/lib/auth/sessionState";
import {
  castCommunityPollVote,
  getCommunityPoll,
} from "@/lib/communityPolls/data.server";
import { UUID_PATTERN } from "@/lib/communityPolls/validation";

function json(body: unknown, status = 200) {
  const response = NextResponse.json(body, { status });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ pollId: string }> }
) {
  const { pollId } = await params;
  if (!UUID_PATTERN.test(pollId)) return json({ error: "NOT_FOUND" }, 404);

  try {
    const sessionState = await getSessionState();
    const viewerId =
      sessionState.status === "authenticated"
        ? sessionState.session.discord_user_id
        : undefined;
    const detail = await getCommunityPoll(pollId, viewerId);
    return detail ? json(detail) : json({ error: "NOT_FOUND" }, 404);
  } catch {
    return json({ error: "COMMUNITY_POLLS_UNAVAILABLE" }, 503);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ pollId: string }> }
) {
  const { pollId } = await params;
  if (!UUID_PATTERN.test(pollId)) return json({ error: "NOT_FOUND" }, 404);

  try {
    const session = await requireSession();
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("application/json")) {
      return json({ error: "INVALID_REQUEST" }, 415);
    }
    const body = (await request.json()) as Record<string, unknown>;
    const result = await castCommunityPollVote({
      sessionId: session.session_id,
      pollPublicId: pollId,
      optionPublicId: body.optionPublicId,
      requestId: body.requestId,
      expectedPollVersion: body.expectedPollVersion,
    });

    switch (result.outcome) {
      case "voted":
      case "already_participated":
        return json(result);
      case "not_found":
      case "option_not_found":
        return json({ outcome: result.outcome, error: "NOT_FOUND" }, 404);
      case "stale":
      case "not_active":
      case "deadline_passed":
        return json({ outcome: result.outcome, error: "POLL_CHANGED" }, 409);
      case "not_authenticated":
        return json({ outcome: result.outcome, error: "NOT_AUTHENTICATED" }, 401);
      case "website_banned":
      case "discord_banned":
        return json({ outcome: result.outcome, error: "ACCOUNT_RESTRICTED" }, 403);
      default:
        return json({ outcome: result.outcome, error: "INVALID_REQUEST" }, 400);
    }
  } catch (error) {
    const authStatus = getAuthErrorStatus(error);
    if (authStatus) {
      return json(
        {
          error:
            getAuthErrorCode(error)?.split(":")[0] ??
            "AUTHENTICATION_UNAVAILABLE",
        },
        authStatus
      );
    }
    if (
      error instanceof SyntaxError ||
      (error instanceof Error && /invalid|must|version/iu.test(error.message))
    ) {
      return json({ error: "INVALID_REQUEST" }, 400);
    }
    return json({ error: "COMMUNITY_POLLS_UNAVAILABLE" }, 503);
  }
}
