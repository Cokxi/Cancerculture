import "server-only";

import { supabaseAdmin } from "@/lib/db/admin";
import { assertServerMutationAllowed } from "@/lib/writeGate.server";
import type { DonationOrganizationDraftPayload } from "./types";

const CONFLICT_CODES = [
  "DONATION_ORGANIZATION_IDEMPOTENCY_CONFLICT",
  "DONATION_ORGANIZATION_STATE_CONFLICT",
  "DONATION_ORGANIZATION_EXACT_URL_CONFLICT",
  "ORGANIZATION_REFERENCE_IDEMPOTENCY_CONFLICT",
  "ORGANIZATION_REFERENCE_STATE_CONFLICT",
] as const;

function mapRpcError(error: { code?: string; message?: string }) {
  const message = error.message ?? "";
  if (message.includes("FORBIDDEN")) {
    return Object.assign(new Error("Forbidden"), { status: 403 });
  }
  const conflict = CONFLICT_CODES.find((code) => message.includes(code));
  if (conflict) {
    return Object.assign(new Error("The organization state changed"), {
      status: 409,
      code: conflict,
    });
  }
  if (message.includes("INVALID_") || message.includes("REASON_REQUIRED")) {
    return Object.assign(new Error("Invalid organization request"), {
      status: 400,
    });
  }
  console.error("[DONATION_ORGANIZATIONS][rpc]", { code: error.code });
  return Object.assign(new Error("Organization management is unavailable"), {
    status: 503,
  });
}

export async function manageDonationOrganization(params: {
  actorDiscordUserId: string;
  operation: "save_draft" | "publish" | "archive";
  requestId: string;
  publicKey: string;
  expectedStateVersion: number;
  payload?: (DonationOrganizationDraftPayload & { reuseDraftLogo?: boolean }) | null;
  reason?: string | null;
}) {
  assertServerMutationAllowed();
  const { data, error } = await supabaseAdmin.rpc(
    "manage_donation_organization",
    {
      p_actor_discord_user_id: params.actorDiscordUserId,
      p_operation: params.operation,
      p_request_id: params.requestId,
      p_public_key: params.publicKey,
      p_expected_state_version: params.expectedStateVersion,
      p_payload: params.payload ?? {},
      p_reason: params.reason ?? null,
    }
  );
  if (error) throw mapRpcError(error);
  return data;
}

export async function manageSubmissionOrganizationReference(params: {
  actorDiscordUserId: string;
  requestId: string;
  submissionId: number;
  expectedVersion: number;
  operation: "verify" | "correct" | "quarantine" | "create_candidate";
  name?: string | null;
  websiteUrl?: string | null;
  reason: string;
}) {
  assertServerMutationAllowed();
  const { data, error } = await supabaseAdmin.rpc(
    "manage_submission_organization_reference",
    {
      p_actor_discord_user_id: params.actorDiscordUserId,
      p_request_id: params.requestId,
      p_submission_id: params.submissionId,
      p_expected_version: params.expectedVersion,
      p_operation: params.operation,
      p_name: params.name ?? null,
      p_website_url: params.websiteUrl ?? null,
      p_reason: params.reason,
    }
  );
  if (error) throw mapRpcError(error);
  return data;
}
