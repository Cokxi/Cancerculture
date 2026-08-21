import { requireTeamCapabilityPage } from "@/lib/auth/pageAccess";
import { getSponsoredCycleDraft } from "@/lib/cycles/sponsoredCycle";
import { supabaseAdmin } from "@/lib/db/admin";
import CycleControls from "./CycleControls";
import {
  DEFAULT_SUBMISSIONS_PER_USER,
  DEFAULT_UPLOAD_SUCCESS_COOLDOWN_SECONDS,
} from "@/lib/cycles/submissionSettings";
import { getCyclePrizePoolManagementContext } from "@/lib/cycles/prizePool.server";

export default async function AdminCyclesPage() {
  const authorization = await requireTeamCapabilityPage(
    "cycles.manage",
    "/admin/cycles"
  );
  const nextThemeResult = await supabaseAdmin
    .from("app_config")
    .select("value")
    .eq("key", "next_cycle_theme")
    .maybeSingle();
  if (nextThemeResult.error) {
    console.error("[admin cycles][next theme]", {
      code: nextThemeResult.error.code,
    });
    throw new Error("Failed to load cycle management configuration");
  }
  const nextThemeConfig = nextThemeResult.data;
  const initialNextTheme =
    typeof nextThemeConfig?.value === "string"
      ? nextThemeConfig.value
      : "";
  const initialSponsoredDraft =
    await getSponsoredCycleDraft();
  const currentCycleResult = await supabaseAdmin
    .from("voting_cycles")
    .select(
      "id, public_number, status, votes_per_user, submissions_per_user, upload_success_cooldown_seconds, paused_from_status, reset_at"
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
  if (currentCycleResult.error) {
    console.error("[admin cycles][current cycle]", {
      code: currentCycleResult.error.code,
    });
    throw new Error("Cycle management schema or state is unavailable");
  }
  const currentCycle = currentCycleResult.data;
  const prizePool = currentCycle
    ? await getCyclePrizePoolManagementContext(
        authorization.discord_user_id,
        currentCycle.id
      )
    : null;

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

      <CycleControls
        initialNextTheme={initialNextTheme}
        initialSponsoredDraft={initialSponsoredDraft}
        currentCycleId={currentCycle?.id ?? null}
        currentCycleNumber={currentCycle?.public_number ?? null}
        currentPhaseStatus={currentCycle?.status ?? null}
        pausedFromStatus={currentCycle?.paused_from_status ?? null}
        initialVotesPerUser={currentCycle?.votes_per_user ?? 2}
        initialSubmissionsPerUser={
          currentCycle?.submissions_per_user ?? DEFAULT_SUBMISSIONS_PER_USER
        }
        initialUploadSuccessCooldownSeconds={
          currentCycle?.upload_success_cooldown_seconds ??
          DEFAULT_UPLOAD_SUCCESS_COOLDOWN_SECONDS
        }
        resetPreview={resetPreview}
        initialPrizePool={prizePool}
      />
    </div>
  );
}
