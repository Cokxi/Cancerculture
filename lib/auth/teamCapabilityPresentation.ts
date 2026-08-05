export const TEAM_CAPABILITY_PERMISSION_TABS = Object.freeze([
  "view",
  "actions",
] as const);

export type TeamCapabilityPermissionTab =
  (typeof TEAM_CAPABILITY_PERMISSION_TABS)[number];

export function getTeamCapabilityPermissionTab(
  capabilityKey: string
): TeamCapabilityPermissionTab {
  return capabilityKey.endsWith(".view") ? "view" : "actions";
}
