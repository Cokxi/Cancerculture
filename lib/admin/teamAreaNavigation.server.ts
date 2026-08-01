import "server-only";

import { cache } from "react";
import { getTeamAuthorizationContext } from "@/lib/auth/teamAuthorization";
import { supabaseAdmin } from "@/lib/db/admin";
import {
  resolveTeamAreaNavigation,
  type ResolvedTeamAreaNavigation,
} from "@/lib/admin/teamAreaNavigation";

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

export const getResolvedTeamAreaNavigation = cache(async () => {
  const authorization = await getTeamAuthorizationContext();
  const navigation = resolveTeamAreaNavigation(authorization);
  const canReview =
    authorization.isAdmin ||
    authorization.resolvedCapabilities.includes("users.flag.review");

  return canReview
    ? addFlagBadges(navigation, authorization.isAdmin)
    : navigation;
});
