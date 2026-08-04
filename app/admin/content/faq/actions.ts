"use server";

import { revalidatePath, updateTag } from "next/cache";
import { requireDynamicTeamCapability } from "@/lib/auth/teamAuthorization";
import { FAQ_CONTENT_CACHE_TAG } from "@/lib/content/faq/data.server";
import { saveAndPublishFaqContent } from "@/lib/content/faq/manage.server";
import { parseFaqContentJson } from "@/lib/content/faq/validation";

const ADMIN_PATH = "/admin/content/faq";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type FaqContentActionState = Readonly<{
  status: "idle" | "success" | "error";
  message: string;
}>;

function positiveInteger(formData: FormData, key: string) {
  const value = Number(formData.get(key));

  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Invalid FAQ state version");
  }

  return value;
}

function requestId(formData: FormData) {
  const value = formData.get("request_id");

  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error("Invalid FAQ request ID");
  }

  return value;
}

function invalidateFaqContent() {
  updateTag(FAQ_CONTENT_CACHE_TAG);
  revalidatePath("/faq");
  revalidatePath(ADMIN_PATH);
}

function errorState(error: unknown): FaqContentActionState {
  const status =
    error && typeof error === "object" && "status" in error
      ? Number(error.status)
      : null;
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : null;

  if (status === 403) {
    return {
      status: "error",
      message: "You no longer have permission to manage FAQ content.",
    };
  }

  if (status === 409) {
    if (code === "FAQ_CONTENT_NO_CHANGES") {
      return {
        status: "error",
        message: "There are no FAQ changes to save and publish.",
      };
    }

    return {
      status: "error",
      message: "The published FAQ changed. Refresh the page and try again.",
    };
  }

  if (status === 400 || (error instanceof Error && status === null)) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Invalid FAQ content.",
    };
  }

  return {
    status: "error",
    message: "FAQ content management is temporarily unavailable.",
  };
}

export async function saveAndPublishFaqAction(
  _previousState: FaqContentActionState,
  formData: FormData
): Promise<FaqContentActionState> {
  try {
    const authorization = await requireDynamicTeamCapability("faq.manage");
    const content = parseFaqContentJson(formData.get("content_json"));

    const result = await saveAndPublishFaqContent({
      actorDiscordUserId: authorization.discord_user_id,
      expectedStateVersion: positiveInteger(
        formData,
        "expected_state_version"
      ),
      content,
      idempotencyKey: requestId(formData),
    });

    invalidateFaqContent();
    return {
      status: "success",
      message: result.replayed
        ? "FAQ publication already completed."
        : `FAQ revision #${result.revisionNumber} saved and published.`,
    };
  } catch (error) {
    return errorState(error);
  }
}
