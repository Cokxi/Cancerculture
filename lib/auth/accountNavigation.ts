import {
  hasTeamCapability,
  isAdminTeamRole,
  type CanonicalTeamRole,
} from "@/lib/auth/teamRoles";

export type AccountNavigationRole =
  | CanonicalTeamRole
  | null;

export type AccountNavigationItem =
  | {
      id: "profile" | "moderation" | "admin";
      label: string;
      href: string;
      kind: "link";
    }
  | {
      id: "logout";
      label: string;
      kind: "logout";
    };

export type AccountNavigationState =
  | { kind: "anonymous"; items: [] }
  | { kind: "restricted"; items: [AccountNavigationItem] }
  | { kind: "dependency_unavailable"; items: [] }
  | {
      kind: "authenticated";
      items: AccountNavigationItem[];
      teamAccessUnavailable: boolean;
    };

type AccountNavigationInput = {
  sessionStatus:
    | "anonymous"
    | "authenticated"
    | "restricted"
    | "dependency_unavailable";
  teamRole?: AccountNavigationRole;
  teamAccessUnavailable?: boolean;
};

const logoutItem: AccountNavigationItem = {
  id: "logout",
  label: "Logout",
  kind: "logout",
};

export function createAccountNavigationState({
  sessionStatus,
  teamRole = null,
  teamAccessUnavailable = false,
}: AccountNavigationInput): AccountNavigationState {
  if (sessionStatus === "anonymous") {
    return { kind: "anonymous", items: [] };
  }

  if (sessionStatus === "dependency_unavailable") {
    return { kind: "dependency_unavailable", items: [] };
  }

  if (sessionStatus === "restricted") {
    return { kind: "restricted", items: [logoutItem] };
  }

  const items: AccountNavigationItem[] = [
    {
      id: "profile",
      label: "My Profile",
      href: "/my-profile",
      kind: "link",
    },
  ];

  if (
    !teamAccessUnavailable &&
    hasTeamCapability(
      teamRole,
      "canModerateSubmissionPhase"
    )
  ) {
    items.push({
      id: "moderation",
      label: "Moderation",
      href: "/admin/moderation/submissions",
      kind: "link",
    });
  }

  if (
    !teamAccessUnavailable &&
    isAdminTeamRole(teamRole)
  ) {
    items.push({
      id: "admin",
      label: "Admin",
      href: "/admin",
      kind: "link",
    });
  }

  items.push(logoutItem);

  return {
    kind: "authenticated",
    items,
    teamAccessUnavailable,
  };
}
