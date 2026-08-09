import "server-only";

import { cache } from "react";
import { getTeamAuthorizationContext } from "@/lib/auth/teamAuthorization";
import { supabaseAdmin } from "@/lib/db/admin";
import {
  resolveTeamAreaNavigation,
  type ResolvedTeamAreaNavigation,
} from "@/lib/admin/teamAreaNavigation";
import { loadSubmissionReportUnreadCounts } from "@/lib/reports/submissionReportTeam.server";

async function addFlagBadges(
  navigation: ResolvedTeamAreaNavigation,
  isAdmin: boolean
): Promise<ResolvedTeamAreaNavigation> {
  const queries = [
    supabaseAdmin
      .from("user_flag_cases")
      .select("case_id", { count: "exact", head: true })
      .eq("status", "open"),
  ];
  if (isAdmin) {
    queries.push(
      supabaseAdmin
        .from("user_flag_cases")
        .select("case_id", { count: "exact", head: true })
        .eq("status", "escalated")
    );
  }
  const results = await Promise.all(queries);
  if (results.some((result) => result.error)) return navigation;

  const badges = [`Open ${results[0].count ?? 0}`];
  if (isAdmin) badges.push(`Escalated ${results[1].count ?? 0}`);

  return Object.freeze(
    navigation.map((category) =>
      Object.freeze({
        ...category,
        items: Object.freeze(
          category.items.map((entry) =>
            entry.id === "flagged-users"
              ? Object.freeze({ ...entry, badges: Object.freeze(badges) })
              : entry
          )
        ),
      })
    )
  );
}

async function addSubmissionReportBadges(
  navigation: ResolvedTeamAreaNavigation,
  authorization: Awaited<ReturnType<typeof getTeamAuthorizationContext>>
): Promise<ResolvedTeamAreaNavigation> {
  const hasReportArea =
    authorization.isAdmin ||
    authorization.resolvedCapabilities.includes("submissions.reports.live.view") ||
    authorization.resolvedCapabilities.includes("submissions.reports.finalized.view");
  if (!hasReportArea) return navigation;

  try {
    const counts = await loadSubmissionReportUnreadCounts(authorization);
    return Object.freeze(
      navigation.map((category) => {
        const isModeration = category.id === "moderation";
        return Object.freeze({
          ...category,
          badges:
            isModeration && counts.total > 0
              ? Object.freeze([`${counts.total} new`])
              : category.badges,
          items: Object.freeze(
            category.items.map((entry) => {
              const count =
                entry.id === "live-submission-reports"
                  ? counts.live
                  : entry.id === "finalized-submission-reports"
                    ? counts.finalized
                    : 0;
              return count > 0
                ? Object.freeze({
                    ...entry,
                    badges: Object.freeze([`${count} new`]),
                  })
                : entry;
            })
          ),
        });
      })
    );
  } catch {
    return navigation;
  }
}

export const getResolvedTeamAreaNavigation = cache(async () => {
  const authorization = await getTeamAuthorizationContext();
  const navigation = resolveTeamAreaNavigation(authorization);
  const canReview =
    authorization.isAdmin ||
    authorization.resolvedCapabilities.includes("users.flag.review");

  const withFlagBadges = canReview
    ? addFlagBadges(navigation, authorization.isAdmin)
    : navigation;
  return addSubmissionReportBadges(await withFlagBadges, authorization);
});
