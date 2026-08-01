import "server-only";

import type { RegisteredTeamCapabilityKey } from "@/lib/auth/teamCapabilityRegistry";

export type TeamAreaAuthorizationContext = Readonly<{
  role: string;
  isAdmin: boolean;
  resolvedCapabilities: readonly RegisteredTeamCapabilityKey[];
}>;

export type TeamAreaRequirement =
  | Readonly<{ type: "admin" }>
  | Readonly<{
      type: "capability";
      capability: RegisteredTeamCapabilityKey;
    }>
  | Readonly<{
      type: "anyCapability";
      capabilities: readonly RegisteredTeamCapabilityKey[];
    }>;

export type TeamAreaNavigationItem = Readonly<{
  id: string;
  title: string;
  href: string | null;
  categoryId: string;
  description?: string;
  requirement: TeamAreaRequirement;
  parentId: string;
  implemented: boolean;
  badges?: readonly string[];
}>;

export type TeamAreaNavigationCategory = Readonly<{
  id: string;
  title: string;
  items: readonly TeamAreaNavigationItem[];
}>;

export type ResolvedTeamAreaNavigation = readonly TeamAreaNavigationCategory[];

const adminOnly = Object.freeze({ type: "admin" } as const);
const submissionModeration = Object.freeze({
  type: "anyCapability",
  capabilities: Object.freeze([
    "submissions.submission_phase.disqualify",
    "submissions.submission_phase.reinstate",
    "submissions.voting_phase.disqualify",
    "submissions.voting_phase.reinstate",
  ] as const),
} as const);
const submissionReinstatement = Object.freeze({
  type: "anyCapability",
  capabilities: Object.freeze([
    "submissions.submission_phase.reinstate",
    "submissions.voting_phase.reinstate",
  ] as const),
} as const);
const basicUserDirectory = Object.freeze({
  type: "anyCapability",
  capabilities: Object.freeze([
    "users.directory.basic.view",
    "users.directory.full.view",
    "users.flag.create",
    "users.flag.view",
  ] as const),
} as const);
const uploadBlockView = Object.freeze({
  type: "capability",
  capability: "users.upload_blocks.view",
} as const);
const uploadLogsView = Object.freeze({
  type: "capability",
  capability: "logs.uploads.view",
} as const);
const websiteBanView = Object.freeze({
  type: "capability",
  capability: "users.website_bans.view",
} as const);
const websiteBanHistoryView = Object.freeze({
  type: "capability",
  capability: "logs.website_bans.view",
} as const);
const userFlagWork = Object.freeze({
  type: "anyCapability",
  capabilities: Object.freeze([
    "users.flag.view",
    "users.flag.review",
  ] as const),
} as const);

function item(
  definition: Omit<TeamAreaNavigationItem, "parentId">
): TeamAreaNavigationItem {
  return Object.freeze({
    ...definition,
    parentId: definition.categoryId,
  });
}

export const TEAM_AREA_NAVIGATION: readonly TeamAreaNavigationCategory[] =
  Object.freeze([
    {
      id: "cycles",
      title: "Cycles",
      items: [
        item({
          id: "cycle-management",
          title: "Cycle Management",
          href: "/admin/cycles",
          categoryId: "cycles",
          description: "Manage the active cycle and its phase.",
          requirement: adminOnly,
          implemented: true,
        }),
        item({
          id: "cycle-logs",
          title: "Cycle Logs",
          href: "/admin/logs/cycles",
          categoryId: "cycles",
          description: "Review cycle history and operational events.",
          requirement: adminOnly,
          implemented: true,
        }),
      ],
    },
    {
      id: "moderation",
      title: "Moderation",
      items: [
        item({
          id: "live-moderation",
          title: "Live Moderation",
          href: "/admin/moderation/submissions",
          categoryId: "moderation",
          description: "Moderate submissions in the current open phase.",
          requirement: submissionModeration,
          implemented: true,
        }),
        item({
          id: "disqualified-submissions",
          title: "Disqualified Submissions",
          href: "/admin/moderation/disqualified",
          categoryId: "moderation",
          description: "Review disqualified submissions in the active cycle.",
          requirement: submissionReinstatement,
          implemented: true,
        }),
        item({
          id: "legal-review",
          title: "Legal Review",
          href: "/admin/moderation/legal-review",
          categoryId: "moderation",
          description: "Review submissions hidden for legal checks.",
          requirement: adminOnly,
          implemented: true,
        }),
        item({
          id: "flagged-users",
          title: "Flagged Users",
          href: "/admin/flags",
          categoryId: "moderation",
          description: "Review users flagged for follow-up.",
          requirement: userFlagWork,
          implemented: true,
        }),
        item({
          id: "blocked-users",
          title: "Blocked Users",
          href: "/admin/moderation/upload-blocks",
          categoryId: "moderation",
          description: "Review submission upload blocks.",
          requirement: uploadBlockView,
          implemented: true,
        }),
        item({
          id: "banned-users",
          title: "Banned Users",
          href: "/admin/bans",
          categoryId: "moderation",
          description: "Review website bans.",
          requirement: websiteBanView,
          implemented: true,
        }),
      ],
    },
    {
      id: "logs",
      title: "Logs",
      items: [
        item({
          id: "user-logs",
          title: "User Logs",
          href: "/admin/users",
          categoryId: "logs",
          description: "Browse the authorized user directory view.",
          requirement: basicUserDirectory,
          implemented: true,
        }),
        item({
          id: "upload-logs",
          title: "Upload Logs",
          href: "/admin/logs/uploads",
          categoryId: "logs",
          description: "Browse redacted submission-upload outcomes.",
          requirement: uploadLogsView,
          implemented: true,
        }),
        item({
          id: "avatar-upload-logs",
          title: "Avatar Upload Logs",
          href: "/admin/logs/avatar-uploads",
          categoryId: "logs",
          requirement: adminOnly,
          implemented: true,
        }),
        item({
          id: "vote-logs",
          title: "Vote Logs",
          href: "/admin/logs/votes",
          categoryId: "logs",
          requirement: adminOnly,
          implemented: true,
        }),
        item({
          id: "social-logs",
          title: "Social Logs",
          href: "/admin/logs/socials",
          categoryId: "logs",
          requirement: adminOnly,
          implemented: true,
        }),
        item({
          id: "moderation-logs",
          title: "Moderation Logs",
          href: "/admin/logs/moderation",
          categoryId: "logs",
          requirement: adminOnly,
          implemented: true,
        }),
        item({
          id: "website-ban-history",
          title: "Website Ban History",
          href: "/admin/website-ban-history",
          categoryId: "logs",
          description: "Review immutable website ban and revocation events.",
          requirement: websiteBanHistoryView,
          implemented: true,
        }),
      ],
    },
    {
      id: "discord",
      title: "Discord",
      items: [
        item({
          id: "discord-status",
          title: "Discord Status",
          href: null,
          categoryId: "discord",
          requirement: adminOnly,
          implemented: false,
        }),
        item({
          id: "discord-sync-health",
          title: "Discord Sync Health",
          href: "/admin/logs/discord-sync",
          categoryId: "discord",
          description: "Inspect aggregate Discord synchronization health.",
          requirement: adminOnly,
          implemented: true,
        }),
      ],
    },
    {
      id: "sponsoring",
      title: "Sponsoring",
      items: [
        item({
          id: "sponsor-reports",
          title: "Sponsor Reports",
          href: "/admin/logs/sponsors",
          categoryId: "sponsoring",
          description: "Review sponsor reporting data.",
          requirement: adminOnly,
          implemented: true,
        }),
      ],
    },
    {
      id: "team",
      title: "Team",
      items: [
        item({
          id: "team-members",
          title: "Team Members",
          href: "/admin/team/members",
          categoryId: "team",
          description: "Manage existing team assignments and Owner accounts.",
          requirement: adminOnly,
          implemented: true,
        }),
        item({
          id: "add-team-member",
          title: "Add Team Member",
          href: "/admin/team/members/add",
          categoryId: "team",
          description:
            "Add a known Discord identity with an active non-Admin role.",
          requirement: adminOnly,
          implemented: true,
        }),
        item({
          id: "roles-permissions",
          title: "Roles & Permissions",
          href: "/admin/team/roles",
          categoryId: "team",
          description: "Manage team roles and registered capability grants.",
          requirement: adminOnly,
          implemented: true,
        }),
        item({
          id: "authorization-history",
          title: "Authorization History",
          href: "/admin/team/authorization-history",
          categoryId: "team",
          description: "Review append-only authorization events.",
          requirement: adminOnly,
          implemented: true,
        }),
      ],
    },
    {
      id: "content",
      title: "Content",
      items: [
        item({
          id: "homepage-info-boxes",
          title: "Homepage Info Boxes",
          href: "/admin/homepage-info-blocks",
          categoryId: "content",
          description: "Manage the public homepage information boxes.",
          requirement: adminOnly,
          implemented: true,
        }),
        item({
          id: "update-rules",
          title: "Update Rules",
          href: null,
          categoryId: "content",
          requirement: adminOnly,
          implemented: false,
        }),
        item({
          id: "coin-launch-links",
          title: "Coin Launch Links",
          href: "/admin/coin-launches",
          categoryId: "content",
          description: "Manage public coin launch destinations.",
          requirement: adminOnly,
          implemented: true,
        }),
      ],
    },
    {
      id: "winner-payouts",
      title: "Winner & Payouts",
      items: [
        item({
          id: "winner-payouts",
          title: "Winner Payouts",
          href: "/admin/logs/winners",
          categoryId: "winner-payouts",
          description: "Review protected winner and payout records.",
          requirement: adminOnly,
          implemented: true,
        }),
      ],
    },
  ].map((category) =>
    Object.freeze({
      ...category,
      items: Object.freeze(category.items),
    })
  ));

export function meetsTeamAreaRequirement(
  context: TeamAreaAuthorizationContext,
  requirement: TeamAreaRequirement
): boolean {
  if (requirement.type === "admin") {
    return context.isAdmin && context.role === "admin";
  }

  if (requirement.type === "capability") {
    return (
      context.isAdmin ||
      context.resolvedCapabilities.includes(requirement.capability)
    );
  }

  return requirement.capabilities.some((capability) =>
    context.isAdmin || context.resolvedCapabilities.includes(capability)
  );
}

export function resolveTeamAreaNavigation(
  context: TeamAreaAuthorizationContext
): ResolvedTeamAreaNavigation {
  return Object.freeze(
    TEAM_AREA_NAVIGATION.map((category) => ({
      ...category,
      items: Object.freeze(
        category.items.filter(
          (entry) =>
            entry.implemented &&
            entry.href !== null &&
            meetsTeamAreaRequirement(context, entry.requirement)
        )
      ),
    }))
      .filter((category) => category.items.length > 0)
      .map((category) => Object.freeze(category))
  );
}
