"use server";

import { revalidatePath, updateTag } from "next/cache";
import { requireDynamicTeamCapability } from "@/lib/auth/teamAuthorization";
import { RULES_CONTENT_CACHE_TAG } from "@/lib/content/rules/data.server";
import { manageRulesContent } from "@/lib/content/rules/manage.server";
import { parseRulesContentJson } from "@/lib/content/rules/validation";

const ADMIN_PATH = "/admin/content/rules";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type RulesContentActionState = Readonly<{
  status: "idle" | "success" | "error";
  message: string;
}>;

function positiveInteger(formData: FormData, key: string) {
  const value = Number(formData.get(key));

  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Invalid Rules state version");
  }

  return value;
}

function requestId(formData: FormData) {
  const value = formData.get("request_id");

  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error("Invalid Rules request ID");
  }

  return value;
}

function invalidateRulesContent() {
  updateTag(RULES_CONTENT_CACHE_TAG);
  revalidatePath("/rules");
  revalidatePath(ADMIN_PATH);
}

function errorState(error: unknown): RulesContentActionState {
  const status =
    error && typeof error === "object" && "status" in error
      ? Number(error.status)
      : null;

  if (status === 403) {
    return { status: "error", message: "You no longer have permission to manage Rules." };
  }

  if (status === 409) {
    return {
      status: "error",
      message: "The Rules draft changed. Refresh the page and try again.",
    };
  }

  if (status === 400 || (error instanceof Error && status === null)) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Invalid Rules content.",
    };
  }

  return {
    status: "error",
    message: "Rules content management is temporarily unavailable.",
  };
}

export async function saveRulesDraftAction(
  _previousState: RulesContentActionState,
  formData: FormData
): Promise<RulesContentActionState> {
  try {
    const authorization =
      await requireDynamicTeamCapability("rules.manage");
    const content = parseRulesContentJson(formData.get("content_json"));

    await manageRulesContent({
      actorDiscordUserId: authorization.discord_user_id,
      operation: "save_draft",
      expectedStateVersion: positiveInteger(
        formData,
        "expected_state_version"
      ),
      content,
      idempotencyKey: requestId(formData),
    });

    invalidateRulesContent();
    return { status: "success", message: "Versioned Rules draft saved." };
  } catch (error) {
    return errorState(error);
  }
}

export async function publishRulesDraftAction(
  _previousState: RulesContentActionState,
  formData: FormData
): Promise<RulesContentActionState> {
  try {
    const authorization =
      await requireDynamicTeamCapability("rules.manage");
    const materialChangeValue = formData.get("material_change");

    if (
      materialChangeValue !== "true" &&
      materialChangeValue !== "false"
    ) {
      throw new Error("Choose whether the Rules change is material");
    }

    await manageRulesContent({
      actorDiscordUserId: authorization.discord_user_id,
      operation: "publish",
      expectedStateVersion: positiveInteger(
        formData,
        "expected_state_version"
      ),
      materialChange: materialChangeValue === "true",
      idempotencyKey: requestId(formData),
    });

    invalidateRulesContent();
    return { status: "success", message: "Rules draft published." };
  } catch (error) {
    return errorState(error);
  }
}
