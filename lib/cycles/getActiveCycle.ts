import { supabaseAdmin } from "@/lib/db/admin";

export async function getActiveCycle() {
  const { data: cycle } = await supabaseAdmin
    .from("voting_cycles")
    .select("id")
    .eq("status", "active")
    .maybeSingle();

  return cycle ?? null;
}
