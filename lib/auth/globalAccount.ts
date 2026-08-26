import type { AccountNavigationState } from "@/lib/auth/accountNavigation";

type AuthenticatedNavigation = Extract<
  AccountNavigationState,
  { kind: "authenticated" }
>;

export const GLOBAL_ACCOUNT_HIDDEN_STORAGE_KEY =
  "cancerculture:global-account-hidden";

export type GlobalAccountViewState =
  | { kind: "anonymous" }
  | { kind: "dependency_unavailable" }
  | { kind: "restricted" }
  | {
      kind: "authenticated";
      avatarUrl: string | null;
      canModerateComments: boolean;
      displayName: string;
      publicProfileId: string | null;
      unreadNotificationCount: number;
      navigation: AuthenticatedNavigation;
    };

export function isGlobalAccountVisible({
  pathname,
  hiddenOnSubpages,
}: {
  pathname: string;
  hiddenOnSubpages: boolean;
}) {
  return pathname === "/" || !hiddenOnSubpages;
}

export function getGlobalAccountVisibilityAction(hiddenOnSubpages: boolean) {
  return hiddenOnSubpages ? "Show always" : "Hide";
}
