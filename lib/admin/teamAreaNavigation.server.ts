import "server-only";

import { cache } from "react";
import { getTeamAuthorizationContext } from "@/lib/auth/teamAuthorization";
import { supabaseAdmin } from "@/lib/db/admin";
import {
  resolveTeamAreaNavigation,
  type ResolvedTeamAreaNavigation,
} from "@/lib/admin/teamAreaNavigation";
import { loadSubmissionReportUnreadCounts } from "@/lib/reports/submissionReportTeam.server";
import { loadTeamInboxOverview } from "@/lib/teamInbox/teamInbox.server";

async function addTeamInboxNavigation(
  navigation: ResolvedTeamAreaNavigation,
  authorization: Awaited<ReturnType<typeof getTeamAuthorizationContext>>
): Promise<ResolvedTeamAreaNavigation> {
  try {
    const topics = await loadTeamInboxOverview(authorization);
    if (topics.length === 0 && !authorization.isAdmin) return navigation;
    const newCount = topics.reduce((total, topic) => total + (topic.newCount ?? 0), 0);
    return Object.freeze([
      Object.freeze({
        id: "team-inbox",
        title: "Team Inbox",
        direct: true,
        badges: newCount > 0 ? Object.freeze([`${newCount} new`]) : undefined,
        items: Object.freeze([
          Object.freeze({
            id: "team-inbox",
            title: "Team Inbox",
            href: "/admin/inbox",
            categoryId: "team-inbox",
            parentId: "team-inbox",
            description: "Open topic-based team work queues.",
            requirement: Object.freeze({
              type: "capability" as const,
              capability: "winners.payouts.view" as const,
            }),
            implemented: true,
            badges: newCount > 0 ? Object.freeze([`${newCount} new`]) : undefined,
          }),
        ]),
      }),
      ...navigation,
    ]);
  } catch {
    return navigation;
  }
}

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

  const withInbox = await addTeamInboxNavigation(navigation, authorization);
  const withFlagBadges = canReview
    ? addFlagBadges(withInbox, authorization.isAdmin)
    : withInbox;
  return addSubmissionReportBadges(await withFlagBadges, authorization);
});
