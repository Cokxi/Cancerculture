import "server-only";

import { supabaseAdmin } from "@/lib/db/admin";
import { assertServerMutationAllowed } from "@/lib/writeGate.server";

export type CycleAutomationOutcome =
  | "transitioned"
  | "repaired"
  | "noop"
  | "diagnostic";

export type CycleAutomationResult = {
  outcome: CycleAutomationOutcome;
  cycleId: number | null;
  previousStatus: string | null;
  status: string | null;
  transition: string | null;
  reason: string;
  repairCodes: string[];
  eventCreated: boolean;
  processedAt: string;
};

let inMemoryPhaseCheck: Promise<CycleAutomationResult> | null = null;

function isCycleAutomationResult(
  value: unknown
): value is CycleAutomationResult {
  if (!value || typeof value !== "object") {
    return false;
  }

  const result = value as Record<string, unknown>;

  return (
    ["transitioned", "repaired", "noop", "diagnostic"].includes(
      String(result.outcome)
    ) &&
    (typeof result.cycleId === "number" || result.cycleId === null) &&
    (typeof result.previousStatus === "string" ||
      result.previousStatus === null) &&
    (typeof result.status === "string" || result.status === null) &&
    (typeof result.transition === "string" ||
      result.transition === null) &&
    typeof result.reason === "string" &&
    Array.isArray(result.repairCodes) &&
    result.repairCodes.every((code) => typeof code === "string") &&
    typeof result.eventCreated === "boolean" &&
    typeof result.processedAt === "string"
  );
}

async function runPhaseCheck(): Promise<CycleAutomationResult> {
  const { data, error } = await supabaseAdmin.rpc(
    "process_due_cycle_transitions",
    { p_cycle_id: null }
  );

  if (error) {
    console.error("[cycle phase automation][rpc]", {
      code: error.code,
    });
    throw new Error("Cycle phase automation failed");
  }

  if (!isCycleAutomationResult(data)) {
    console.error("[cycle phase automation][invalid response]");
    throw new Error("Cycle phase automation returned an invalid response");
  }

  if (data.outcome === "diagnostic") {
    console.warn("[cycle phase automation][diagnostic]", {
      cycleId: data.cycleId,
      reason: data.reason,
      status: data.status,
    });
  }

  return data;
}

export async function processDueCycleTransitions() {
  assertServerMutationAllowed();
  if (!inMemoryPhaseCheck) {
    inMemoryPhaseCheck = runPhaseCheck().finally(() => {
      inMemoryPhaseCheck = null;
    });
  }

  return inMemoryPhaseCheck;
}

// Compatibility alias for server-side callers that have not migrated yet.
export const ensureCyclePhaseFresh = processDueCycleTransitions;
