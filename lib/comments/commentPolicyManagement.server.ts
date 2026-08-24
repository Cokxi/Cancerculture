import "server-only";

import { supabaseAdmin } from "@/lib/db/admin";
import { assertServerMutationAllowed } from "@/lib/writeGate.server";

export const COMMUNITY_COMMENT_POLICY_ACTIONS = [
  "root",
  "reply",
  "edit",
  "vote",
  "report",
] as const;

export type CommunityCommentPolicyAction =
  (typeof COMMUNITY_COMMENT_POLICY_ACTIONS)[number];
export type CommunityCommentReleaseState = "off" | "read_only" | "open";

export type CommunityCommentAbusePolicy = Readonly<{
  policyVersion: number;
  windowSeconds: number;
  maxActions: number;
  cooldownSeconds: number;
  turnstileAfter: number;
  createdAt: string;
}>;

export type CommunityCommentPolicyManagement = Readonly<{
  release: Readonly<{
    state: CommunityCommentReleaseState;
    version: number;
    updatedAt: string;
  }>;
  actions: readonly Readonly<{
    action: CommunityCommentPolicyAction;
    stateVersion: number;
    activePolicy: CommunityCommentAbusePolicy | null;
    updatedAt: string;
  }>[];
  spam: Readonly<{
    stateVersion: number;
    activePolicy: Readonly<{
      policyVersion: number;
      minimumEventCount: number;
      lookbackSeconds: number;
      thresholdScore: number;
      signalWeights: Readonly<Record<string, number>>;
      createdAt: string;
    }> | null;
    updatedAt: string;
  }>;
}>;

export class CommunityCommentPolicyManagementError extends Error {
  constructor(
    public readonly status: 400 | 403 | 409 | 503,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "CommunityCommentPolicyManagementError";
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function action(value: unknown): value is CommunityCommentPolicyAction {
  return COMMUNITY_COMMENT_POLICY_ACTIONS.includes(
    value as CommunityCommentPolicyAction
  );
}

function releaseState(value: unknown): value is CommunityCommentReleaseState {
  return value === "off" || value === "read_only" || value === "open";
}

function parseAbusePolicy(value: unknown): CommunityCommentAbusePolicy | null {
  if (value === null) return null;
  const policy = record(value);
  if (
    !positiveInteger(policy.policyVersion) ||
    !positiveInteger(policy.windowSeconds) ||
    !positiveInteger(policy.maxActions) ||
    !positiveInteger(policy.cooldownSeconds) ||
    !Number.isSafeInteger(policy.turnstileAfter) ||
    Number(policy.turnstileAfter) < 0 ||
    !timestamp(policy.createdAt)
  ) return null;
  return Object.freeze({
    policyVersion: policy.policyVersion,
    windowSeconds: policy.windowSeconds,
    maxActions: policy.maxActions,
    cooldownSeconds: policy.cooldownSeconds,
    turnstileAfter: Number(policy.turnstileAfter),
    createdAt: policy.createdAt,
  });
}

function parseSignalWeights(value: unknown) {
  const weights = record(value);
  const parsed: Record<string, number> = {};
  for (const [key, weight] of Object.entries(weights)) {
    if (!positiveInteger(weight)) return null;
    parsed[key] = weight;
  }
  return Object.freeze(parsed);
}

function parseManagement(value: unknown): CommunityCommentPolicyManagement {
  const root = record(value);
  const release = record(root.release);
  const spam = record(root.spam);
  if (
    root.outcome !== "ok" ||
    !releaseState(release.state) ||
    !positiveInteger(release.version) ||
    !timestamp(release.updatedAt) ||
    !Array.isArray(root.actions) ||
    !positiveInteger(spam.stateVersion) ||
    !timestamp(spam.updatedAt)
  ) throw new CommunityCommentPolicyManagementError(
    503,
    "INVALID_RESPONSE",
    "Comment policy management returned an invalid response."
  );

  const actions = root.actions.map((value) => {
    const item = record(value);
    const activePolicy = parseAbusePolicy(item.activePolicy);
    if (
      !action(item.action) ||
      !positiveInteger(item.stateVersion) ||
      !timestamp(item.updatedAt) ||
      (item.activePolicy !== null && activePolicy === null)
    ) throw new CommunityCommentPolicyManagementError(
      503,
      "INVALID_RESPONSE",
      "Comment policy management returned an invalid response."
    );
    return Object.freeze({
      action: item.action,
      stateVersion: item.stateVersion,
      activePolicy,
      updatedAt: item.updatedAt,
    });
  });
  if (
    actions.length !== COMMUNITY_COMMENT_POLICY_ACTIONS.length ||
    new Set(actions.map((item) => item.action)).size !== actions.length
  ) throw new CommunityCommentPolicyManagementError(
    503,
    "INVALID_RESPONSE",
    "Comment policy management returned an invalid response."
  );

  let activeSpamPolicy: CommunityCommentPolicyManagement["spam"]["activePolicy"] = null;
  if (spam.activePolicy !== null) {
    const policy = record(spam.activePolicy);
    const signalWeights = parseSignalWeights(policy.signalWeights);
    if (
      !positiveInteger(policy.policyVersion) ||
      !positiveInteger(policy.minimumEventCount) ||
      !positiveInteger(policy.lookbackSeconds) ||
      !positiveInteger(policy.thresholdScore) ||
      !signalWeights ||
      !timestamp(policy.createdAt)
    ) throw new CommunityCommentPolicyManagementError(
      503,
      "INVALID_RESPONSE",
      "Comment policy management returned an invalid response."
    );
    activeSpamPolicy = Object.freeze({
      policyVersion: policy.policyVersion,
      minimumEventCount: policy.minimumEventCount,
      lookbackSeconds: policy.lookbackSeconds,
      thresholdScore: policy.thresholdScore,
      signalWeights,
      createdAt: policy.createdAt,
    });
  }

  return Object.freeze({
    release: Object.freeze({
      state: release.state,
      version: release.version,
      updatedAt: release.updatedAt,
    }),
    actions: Object.freeze(actions),
    spam: Object.freeze({
      stateVersion: spam.stateVersion,
      activePolicy: activeSpamPolicy,
      updatedAt: spam.updatedAt,
    }),
  });
}

function rpcError(error: { message?: string; code?: string }): never {
  const message = error.message ?? "";
  if (message.includes("COMMUNITY_COMMENT_OWNER_REQUIRED")) {
    throw new CommunityCommentPolicyManagementError(403, "OWNER_REQUIRED", "Owner access required.");
  }
  if (message.includes("_INPUT_INVALID")) {
    throw new CommunityCommentPolicyManagementError(400, "INVALID_INPUT", "Invalid Comment policy input.");
  }
  console.error("[COMMENT_POLICY] RPC failed", { code: error.code });
  throw new CommunityCommentPolicyManagementError(
    503,
    "UNAVAILABLE",
    "Comment policy management is temporarily unavailable."
  );
}

function result(value: unknown) {
  const parsed = record(value);
  if (parsed.outcome === "stale_version" || parsed.outcome === "idempotency_conflict") {
    throw new CommunityCommentPolicyManagementError(
      409,
      parsed.outcome === "stale_version" ? "STALE_VERSION" : "IDEMPOTENCY_CONFLICT",
      "Comment policy state changed. Refresh and try again."
    );
  }
  if (!["updated", "unchanged", "activated", "deactivated"].includes(String(parsed.outcome))) {
    throw new CommunityCommentPolicyManagementError(
      503,
      "INVALID_RESPONSE",
      "Comment policy management returned an invalid response."
    );
  }
  return parsed;
}

export async function getCommunityCommentPolicyManagement(sessionId: string) {
  const { data, error } = await supabaseAdmin.rpc(
    "get_community_comment_policy_management",
    { p_session_id: sessionId }
  );
  if (error) rpcError(error);
  return parseManagement(data);
}

export async function manageCommunityCommentReleaseState(input: {
  sessionId: string;
  releaseState: CommunityCommentReleaseState;
  expectedVersion: number;
  requestId: string;
}) {
  assertServerMutationAllowed();
  const { data, error } = await supabaseAdmin.rpc(
    "manage_community_comment_release_state",
    {
      p_session_id: input.sessionId,
      p_release_state: input.releaseState,
      p_expected_version: input.expectedVersion,
      p_request_id: input.requestId,
    }
  );
  if (error) rpcError(error);
  return result(data);
}

export async function manageCommunityCommentAbusePolicy(input: {
  sessionId: string;
  action: CommunityCommentPolicyAction;
  expectedStateVersion: number;
  active: boolean;
  windowSeconds: number | null;
  maxActions: number | null;
  cooldownSeconds: number | null;
  turnstileAfter: number | null;
  requestId: string;
}) {
  assertServerMutationAllowed();
  const { data, error } = await supabaseAdmin.rpc(
    "manage_community_comment_abuse_policy",
    {
      p_session_id: input.sessionId,
      p_action: input.action,
      p_expected_state_version: input.expectedStateVersion,
      p_activate: input.active,
      p_window_seconds: input.windowSeconds,
      p_max_actions: input.maxActions,
      p_cooldown_seconds: input.cooldownSeconds,
      p_turnstile_after: input.turnstileAfter,
      p_request_id: input.requestId,
    }
  );
  if (error) rpcError(error);
  return result(data);
}

export async function manageCommunityCommentSpamPolicy(input: {
  sessionId: string;
  expectedStateVersion: number;
  active: boolean;
  minimumEventCount: number | null;
  lookbackSeconds: number | null;
  thresholdScore: number | null;
  signalWeights: Readonly<Record<string, number>> | null;
  requestId: string;
}) {
  assertServerMutationAllowed();
  const { data, error } = await supabaseAdmin.rpc(
    "manage_community_comment_spam_policy",
    {
      p_session_id: input.sessionId,
      p_expected_state_version: input.expectedStateVersion,
      p_activate: input.active,
      p_minimum_event_count: input.minimumEventCount,
      p_lookback_seconds: input.lookbackSeconds,
      p_threshold_score: input.thresholdScore,
      p_signal_weights: input.signalWeights,
      p_request_id: input.requestId,
    }
  );
  if (error) rpcError(error);
  return result(data);
}
