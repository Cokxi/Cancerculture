export type TeamAreaNavigationStateItem = Readonly<{
  id: string;
  title: string;
  href: string | null;
}>;

export type TeamAreaNavigationStateCategory = Readonly<{
  id: string;
  title: string;
  items: readonly TeamAreaNavigationStateItem[];
  direct?: boolean;
}>;

export function isTeamAreaPathActive(
  pathname: string,
  href: string
): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function findActiveTeamAreaItem<
  TCategory extends TeamAreaNavigationStateCategory,
>(
  navigation: readonly TCategory[],
  pathname: string
): {
  category: TCategory;
  entry: TCategory["items"][number];
} | null {
  const matches = navigation.flatMap((category) =>
    category.items
      .filter(
        (entry) =>
          entry.href !== null &&
          isTeamAreaPathActive(pathname, entry.href)
      )
      .map((entry) => ({ category, entry }))
  );

  return (
    matches.sort(
      (a, b) =>
        (b.entry.href?.length ?? 0) -
        (a.entry.href?.length ?? 0)
    )[0] ?? null
  );
}

export function getTeamAreaBreadcrumbs(
  navigation: readonly TeamAreaNavigationStateCategory[],
  pathname: string
): readonly string[] {
  const active = findActiveTeamAreaItem(navigation, pathname);
  return active
    ? active.category.direct
      ? ["Team Area", active.entry.title]
      : ["Team Area", active.category.title, active.entry.title]
    : ["Team Area"];
}
