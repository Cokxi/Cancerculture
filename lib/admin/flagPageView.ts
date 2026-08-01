export type FlagPageView = "open" | "history";

export function resolveFlagPageView(value: string | undefined): FlagPageView {
  return value === "history" ? "history" : "open";
}
