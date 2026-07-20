import "server-only";

import { evaluateDiscordSyncHealth } from "@/lib/discord/discordSyncHealth";
import { readDiscordSyncHealth } from "@/lib/discord/readDiscordSyncHealth";
import {
  decideDiscordSyncDelayNotice,
  isDiscordSyncDelayNoticeCandidate,
  type DiscordSyncDelayNoticeContext,
} from "@/lib/eligibility/discordSyncDelayNotice";

export async function getDiscordSyncDelayNotice(
  context: DiscordSyncDelayNoticeContext
) {
  if (!isDiscordSyncDelayNoticeCandidate(context)) {
    return false;
  }

  try {
    const healthRow = await readDiscordSyncHealth();
    if (!healthRow) return false;

    const health = evaluateDiscordSyncHealth({
      now: new Date(),
      lastHeartbeatAt: healthRow.last_heartbeat_at,
      lastFullReconciliationSucceededAt:
        healthRow.last_full_reconciliation_succeeded_at,
      lastFailureAt: healthRow.last_failure_at,
    });

    if (health.reasons.some((reason) => reason.endsWith("_invalid"))) {
      return false;
    }

    return decideDiscordSyncDelayNotice({
      ...context,
      syncHealthStatus: health.status,
    }).showDiscordSyncDelayNotice;
  } catch {
    return false;
  }
}
