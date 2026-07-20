export type HomeNavigationItem = {
  id: string;
  label: string;
  href: string;
  showInDesktopBar: boolean;
};

export const HOME_NAVIGATION_ITEMS: HomeNavigationItem[] = [
  { id: "about", label: "About", href: "/#about", showInDesktopBar: true },
  { id: "upload", label: "Upload", href: "/upload", showInDesktopBar: true },
  {
    id: "submissions",
    label: "Submissions",
    href: "/submissions",
    showInDesktopBar: true,
  },
  { id: "faq", label: "FAQ", href: "/faq", showInDesktopBar: true },
  { id: "rules", label: "Rules", href: "/rules", showInDesktopBar: true },
  {
    id: "wall-fame",
    label: "Wall of Fame",
    href: "/wall/fame",
    showInDesktopBar: true,
  },
  {
    id: "wall-shame",
    label: "Wall of Shame",
    href: "/wall/shame",
    showInDesktopBar: true,
  },
  {
    id: "cycle-history",
    label: "Cycle History",
    href: "/cycle-history",
    showInDesktopBar: false,
  },
];

export function getHomeDesktopNavigationItems() {
  return HOME_NAVIGATION_ITEMS.filter((item) => item.showInDesktopBar);
}

export function getHomeMenuItems({ mobile }: { mobile: boolean }) {
  return mobile
    ? HOME_NAVIGATION_ITEMS
    : HOME_NAVIGATION_ITEMS.filter((item) => !item.showInDesktopBar);
}
