import { redirect } from "next/navigation";
import { getAuthErrorStatus } from "@/lib/auth/AuthError";
import { getTeamMember } from "@/lib/auth/guards";
import { getSponsoredCycleDraft } from "@/lib/cycles/sponsoredCycle";
import { supabaseAdmin } from "@/lib/db/admin";
import CycleControls from "./CycleControls";

export default async function AdminCyclesPage() {
  let member;

  try {
    member = await getTeamMember();
  } catch (error) {
    const status = getAuthErrorStatus(error);

    if (status === 401 || status === 403) {
      redirect("/403");
    }

    throw error;
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
  const { data: currentCycle } = await supabaseAdmin
    .from("voting_cycles")
    .select(
      "id, status, votes_per_user, paused_from_status, reset_at"
    )
    .in("status", [
      "draft",
      "submission_open",
      "submission_closed",
      "voting_open",
      "voting_closed",
      "paused",
      "active",
      "finalizing",
    ])
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();

  let resetPreview = {
    submissions: 0,
    votes: 0,
    affectedSubmitters: 0,
  };

  if (currentCycle) {
    const [submissionsResult, votesResult] = await Promise.all([
      supabaseAdmin
        .from("submissions")
        .select("id, discord_user_id")
        .eq("cycle_id", currentCycle.id),
      supabaseAdmin
        .from("votes")
        .select("id", { count: "exact", head: true })
        .eq("cycle_id", currentCycle.id),
    ]);

    if (submissionsResult.error || votesResult.error) {
      console.error("[admin cycles][reset preview]", {
        submissionsCode: submissionsResult.error?.code,
        votesCode: votesResult.error?.code,
      });
      throw new Error("Failed to load cycle reset preview");
    }

    resetPreview = {
      submissions: submissionsResult.data?.length ?? 0,
      votes: votesResult.count ?? 0,
      affectedSubmitters: new Set(
        (submissionsResult.data ?? []).map(
          (submission) => submission.discord_user_id
        )
      ).size,
    };
  }

  return (
    <div style={{ padding: 24 }}>
      <h1>Admin - Voting Cycles</h1>

      {isAdmin ? (
        <CycleControls
          initialNextTheme={initialNextTheme}
          initialSponsoredDraft={initialSponsoredDraft}
          currentCycleId={currentCycle?.id ?? null}
          currentPhaseStatus={currentCycle?.status ?? null}
          pausedFromStatus={currentCycle?.paused_from_status ?? null}
          initialVotesPerUser={currentCycle?.votes_per_user ?? 2}
          resetPreview={resetPreview}
        />
      ) : (
        <p style={{ opacity: 0.7 }}>
          Only admins can start or end cycles.
        </p>
      )}
    </div>
  );
}
