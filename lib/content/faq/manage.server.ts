import "server-only";

import { supabaseAdmin } from "@/lib/db/admin";
import type { FaqContentDocument } from "./types";

export type FaqContentMutationResult = Readonly<{
  operation: "save_publish";
  requestId: string;
  stateVersion: number;
  revisionId: number;
  revisionNumber: number;
  replayed: boolean;
}>;

const CONFLICT_CODES = Object.freeze([
  "FAQ_CONTENT_IDEMPOTENCY_CONFLICT",
  "FAQ_CONTENT_STATE_CONFLICT",
  "FAQ_CONTENT_NO_CHANGES",
]);

function isMutationResult(value: unknown): value is FaqContentMutationResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;

  return (
    result.operation === "save_publish" &&
    typeof result.requestId === "string" &&
    typeof result.stateVersion === "number" &&
    typeof result.revisionId === "number" &&
    typeof result.revisionNumber === "number" &&
    typeof result.replayed === "boolean"
  );
}

export async function saveAndPublishFaqContent(params: {
  actorDiscordUserId: string;
  expectedStateVersion: number;
  content: FaqContentDocument;
  idempotencyKey: string;
}): Promise<FaqContentMutationResult> {
  const { data, error } = await supabaseAdmin.rpc("manage_faq_content", {
    p_actor_discord_user_id: params.actorDiscordUserId,
    p_expected_state_version: params.expectedStateVersion,
    p_content: params.content,
    p_idempotency_key: params.idempotencyKey,
  });

  if (error) {
    const message = error.message ?? "";

    if (message.includes("FAQ_CONTENT_FORBIDDEN")) {
      throw Object.assign(new Error("Forbidden"), { status: 403 });
    }

    const conflict = CONFLICT_CODES.find((code) => message.includes(code));
    if (conflict) {
      throw Object.assign(
        new Error("The published FAQ changed. Refresh and try again."),
        { status: 409, code: conflict }
      );
    }

    if (message.includes("INVALID_FAQ_CONTENT_REQUEST")) {
      throw Object.assign(new Error("Invalid FAQ content request"), {
        status: 400,
      });
    }

    console.error("[FAQ_CONTENT][rpc]", { code: error.code });
    throw Object.assign(
      new Error("FAQ content management is temporarily unavailable"),
      { status: 503 }
    );
  }

  if (!isMutationResult(data)) {
    console.error("[FAQ_CONTENT][invalid response]");
    throw Object.assign(
      new Error("FAQ content management returned an invalid response"),
      { status: 503 }
    );
  }

  return Object.freeze(data);
}
