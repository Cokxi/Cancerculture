export type AccountNavigationItem =
  | {
      id: "profile" | "team_area";
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
  hasVisibleTeamAreaItems?: boolean;
  teamAccessUnavailable?: boolean;
};

const logoutItem: AccountNavigationItem = {
  id: "logout",
  label: "Logout",
  kind: "logout",
};

export function createAccountNavigationState({
  sessionStatus,
  hasVisibleTeamAreaItems = false,
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
    hasVisibleTeamAreaItems
  ) {
    items.push({
      id: "team_area",
      label: "Team Area",
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
