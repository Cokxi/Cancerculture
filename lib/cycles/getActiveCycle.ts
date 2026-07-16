import { supabaseAdmin } from "@/lib/db/admin";

export async function getActiveCycle() {
  const { data: cycles } = await supabaseAdmin
    .from("voting_cycles")
    .select("id, status, paused_from_status")
    .in("status", ["active", "submission_open", "paused"])
    .order("id", { ascending: false })
    .limit(10);

  const cycle = cycles?.find(
    (candidate) =>
      candidate.status === "active" ||
      candidate.status === "submission_open" ||
      (candidate.status === "paused" &&
        candidate.paused_from_status === "submission_open")
  );

  return cycle ?? null;
}
