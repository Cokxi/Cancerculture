import "server-only";

import { supabaseAdmin } from "@/lib/db/admin";
import type { CycleAutomationOutcome } from "@/lib/cycles/phaseAutomation";

type SchedulerRunWriteResult = {
  outcome: "started" | "resumed" | "recorded" | "replay" | "stale";
};

function isSchedulerRunWriteResult(
  value: unknown
): value is SchedulerRunWriteResult {
  if (!value || typeof value !== "object") {
    return false;
  }

  return ["started", "resumed", "recorded", "replay", "stale"].includes(
    String((value as Record<string, unknown>).outcome)
  );
}

async function runHealthRpc(
  name: "begin_cycle_scheduler_run" | "finish_cycle_scheduler_run",
  parameters: Record<string, unknown>
) {
  const { data, error } = await supabaseAdmin.rpc(name, parameters);

  if (error || !isSchedulerRunWriteResult(data)) {
    throw new Error("Cycle scheduler health recording failed");
  }

  return data;
}

export function beginCycleSchedulerRun(runId: string) {
  return runHealthRpc("begin_cycle_scheduler_run", {
    p_run_id: runId,
  });
}

export function finishCycleSchedulerRun({
  runId,
  succeeded,
  outcome,
}: {
  runId: string;
  succeeded: boolean;
  outcome: CycleAutomationOutcome | "failed";
}) {
  return runHealthRpc("finish_cycle_scheduler_run", {
    p_run_id: runId,
    p_succeeded: succeeded,
    p_outcome: outcome,
  });
}
