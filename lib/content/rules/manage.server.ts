import "server-only";

import { supabaseAdmin } from "@/lib/db/admin";
import { assertServerMutationAllowed } from "@/lib/writeGate.server";
import type { RulesContentDocument } from "./types";

export type RulesContentOperation = "save_draft" | "publish";

export type RulesContentMutationResult = Readonly<{
  operation: RulesContentOperation;
  requestId: string;
  stateVersion: number;
  revisionId: number;
  revisionNumber: number;
  rulesVersion: number;
  materialChange: boolean | null;
  structureChanged: boolean | null;
  replayed: boolean;
}>;

const CONFLICT_CODES = Object.freeze([
  "RULES_CONTENT_IDEMPOTENCY_CONFLICT",
  "RULES_CONTENT_STATE_CONFLICT",
  "RULES_CONTENT_NO_DRAFT",
  "RULES_CONTENT_NO_CHANGES",
]);

function isMutationResult(value: unknown): value is RulesContentMutationResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;

  return (
    (result.operation === "save_draft" || result.operation === "publish") &&
    typeof result.requestId === "string" &&
    typeof result.stateVersion === "number" &&
    typeof result.revisionId === "number" &&
    typeof result.revisionNumber === "number" &&
    typeof result.rulesVersion === "number" &&
    (typeof result.materialChange === "boolean" ||
      result.materialChange === null) &&
    (typeof result.structureChanged === "boolean" ||
      result.structureChanged === null) &&
    typeof result.replayed === "boolean"
  );
}

export async function manageRulesContent(params: {
  actorDiscordUserId: string;
  operation: RulesContentOperation;
  expectedStateVersion: number;
  content?: RulesContentDocument | null;
  materialChange?: boolean | null;
  idempotencyKey: string;
}): Promise<RulesContentMutationResult> {
  assertServerMutationAllowed();
  const { data, error } = await supabaseAdmin.rpc(
    "manage_rules_content",
    {
      p_actor_discord_user_id: params.actorDiscordUserId,
      p_operation: params.operation,
      p_expected_state_version: params.expectedStateVersion,
      p_content: params.content ?? null,
      p_material_change: params.materialChange ?? null,
      p_idempotency_key: params.idempotencyKey,
    }
  );

  if (error) {
    const message = error.message ?? "";

    if (message.includes("RULES_CONTENT_FORBIDDEN")) {
      throw Object.assign(new Error("Forbidden"), { status: 403 });
    }

    const conflict = CONFLICT_CODES.find((code) =>
      message.includes(code)
    );
    if (conflict) {
      throw Object.assign(
        new Error("The Rules draft changed. Refresh and try again."),
        { status: 409, code: conflict }
      );
    }

    if (message.includes("INVALID_RULES_CONTENT_REQUEST")) {
      throw Object.assign(new Error("Invalid Rules content request"), {
        status: 400,
      });
    }

    console.error("[RULES_CONTENT][rpc]", { code: error.code });
    throw Object.assign(
      new Error("Rules content management is temporarily unavailable"),
      { status: 503 }
    );
  }

  if (!isMutationResult(data)) {
    console.error("[RULES_CONTENT][invalid response]");
    throw Object.assign(
      new Error("Rules content management returned an invalid response"),
      { status: 503 }
    );
  }

  return Object.freeze(data);
}
