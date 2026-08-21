"use server";

import { revalidatePath } from "next/cache";
import { requireDynamicTeamCapability } from "@/lib/auth/teamAuthorization";
import {
  abortCommunityPoll,
  createCommunityPoll,
  replaceCommunityPoll,
  transitionCommunityPoll,
} from "@/lib/communityPolls/data.server";

function value(formData: FormData, name: string) {
  return formData.get(name);
}

function invalidate() {
  revalidatePath("/community-votes");
  revalidatePath("/admin/community-votes");
}

export async function createCommunityPollAction(formData: FormData) {
  const authorization = await requireDynamicTeamCapability(
    "community.polls.manage"
  );
  await createCommunityPoll(
    authorization.discord_user_id,
    value(formData, "request_id"),
    {
      question: value(formData, "question"),
      context: value(formData, "context"),
      durationHours: value(formData, "duration_hours"),
      options: value(formData, "options"),
    }
  );
  invalidate();
}
export async function activateCommunityPollAction(formData: FormData) {
  const authorization = await requireDynamicTeamCapability(
    "community.polls.manage"
  );
  await transitionCommunityPoll("activate", authorization.discord_user_id, {
    pollPublicId: value(formData, "poll_public_id"),
    requestId: value(formData, "request_id"),
    expectedPollVersion: value(formData, "expected_version"),
  });
  invalidate();
}

export async function closeCommunityPollAction(formData: FormData) {
  const authorization = await requireDynamicTeamCapability(
    "community.polls.manage"
  );
  await transitionCommunityPoll("close", authorization.discord_user_id, {
    pollPublicId: value(formData, "poll_public_id"),
    requestId: value(formData, "request_id"),
    expectedPollVersion: value(formData, "expected_version"),
  });
  invalidate();
}

export async function abortCommunityPollAction(formData: FormData) {
  const authorization = await requireDynamicTeamCapability(
    "community.polls.manage"
  );
  await abortCommunityPoll(authorization.discord_user_id, {
    pollPublicId: value(formData, "poll_public_id"),
    requestId: value(formData, "request_id"),
    expectedPollVersion: value(formData, "expected_version"),
    reason: value(formData, "reason"),
  });
  invalidate();
}

export async function replaceCommunityPollAction(formData: FormData) {
  const authorization = await requireDynamicTeamCapability(
    "community.polls.manage"
  );
  await replaceCommunityPoll(
    authorization.discord_user_id,
    {
      pollPublicId: value(formData, "poll_public_id"),
      requestId: value(formData, "request_id"),
      expectedPollVersion: value(formData, "expected_version"),
      reason: value(formData, "reason"),
    },
    {
      question: value(formData, "question"),
      context: value(formData, "context"),
      durationHours: value(formData, "duration_hours"),
      options: value(formData, "options"),
    }
  );
  invalidate();
}
