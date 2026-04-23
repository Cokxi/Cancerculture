import { redirect } from "next/navigation";
import { getTeamMember } from "@/lib/auth/guards";
import { getSponsoredCycleDraft } from "@/lib/cycles/sponsoredCycle";
import { supabaseAdmin } from "@/lib/db/admin";
import CycleControls from "./CycleControls";

export default async function AdminCyclesPage() {
  let member;

  try {
    member = await getTeamMember();
  } catch {
    redirect("/403");
  }

  const isAdmin = member.role === "admin";
  const { data: nextThemeConfig } = await supabaseAdmin
    .from("app_config")
    .select("value")
    .eq("key", "next_cycle_theme")
    .maybeSingle();
  const initialNextTheme =
    typeof nextThemeConfig?.value === "string"
      ? nextThemeConfig.value
      : "";
  const initialSponsoredDraft =
    await getSponsoredCycleDraft();

  return (
    <div style={{ padding: 24 }}>
      <h1>Admin - Voting Cycles</h1>

      {isAdmin ? (
        <CycleControls
          initialNextTheme={initialNextTheme}
          initialSponsoredDraft={initialSponsoredDraft}
        />
      ) : (
        <p style={{ opacity: 0.7 }}>
          Only admins can start or end cycles.
        </p>
      )}
    </div>
  );
}
