import "server-only";

import { supabaseAdmin } from "@/lib/db/admin";

export type DiscordSyncHealthRow = {
  last_heartbeat_at: string | null;
  last_full_reconciliation_succeeded_at: string | null;
  last_failure_at: string | null;
};

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

export async function readDiscordSyncHealth(): Promise<DiscordSyncHealthRow | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from("discord_sync_health")
      .select(
        "last_heartbeat_at, last_full_reconciliation_succeeded_at, last_failure_at"
      )
      .eq("id", 1)
      .single<DiscordSyncHealthRow>();

    if (
      error ||
      !data ||
      !isNullableString(data.last_heartbeat_at) ||
      !isNullableString(data.last_full_reconciliation_succeeded_at) ||
      !isNullableString(data.last_failure_at)
    ) {
      return null;
    }

    return data;
  } catch {
    return null;
  }
}
