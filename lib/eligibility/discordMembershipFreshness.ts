export const DISCORD_MEMBERSHIP_FRESHNESS_MINUTES = 90;
export const DISCORD_MEMBERSHIP_COOLDOWN_MINUTES = 10;

export const DISCORD_MEMBERSHIP_FRESHNESS_MS =
  DISCORD_MEMBERSHIP_FRESHNESS_MINUTES * 60 * 1000;

const DISCORD_MEMBERSHIP_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const DISCORD_MEMBERSHIP_COOLDOWN_MS =
  DISCORD_MEMBERSHIP_COOLDOWN_MINUTES * 60 * 1000;

export type DiscordMembershipCooldown = {
  joinedTooRecently: boolean;
  retryAfterMs: number;
};

export function getDiscordMembershipCooldown(
  joinedAt: string | null | undefined,
  nowMs = Date.now()
): DiscordMembershipCooldown | null {
  const joinedAtMs = joinedAt ? new Date(joinedAt).getTime() : NaN;
  if (!Number.isFinite(joinedAtMs)) return null;

  const retryAfterMs = Math.max(
    0,
    DISCORD_MEMBERSHIP_COOLDOWN_MS - (nowMs - joinedAtMs)
  );

  return {
    joinedTooRecently: retryAfterMs > 0,
    retryAfterMs,
  };
}

export function isDiscordMembershipObservationFresh(
  observedAt: string | null | undefined,
  nowMs = Date.now()
) {
  if (!observedAt) return false;

  const observedAtMs = new Date(observedAt).getTime();
  return (
    Number.isFinite(observedAtMs) &&
    observedAtMs <= nowMs + DISCORD_MEMBERSHIP_MAX_CLOCK_SKEW_MS &&
    nowMs - observedAtMs <= DISCORD_MEMBERSHIP_FRESHNESS_MS
  );
}
