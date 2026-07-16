import { requireAdminPage } from "@/lib/auth/pageAccess";
import { supabaseAdmin } from "@/lib/db/admin";

function displayTimestamp(value: string | null) {
  return value ? new Date(value).toLocaleString("en-GB") : "Never";
}

export default async function DiscordSyncHealthPage() {
  await requireAdminPage("/admin/logs/discord-sync");

  const [healthResult, banCountResult] = await Promise.all([
    supabaseAdmin
      .from("discord_sync_health")
      .select(
        "last_event_at, last_reconciliation_started_at, last_reconciliation_succeeded_at, last_ban_snapshot_at, last_membership_snapshot_at, last_error_at, last_error_code"
      )
      .eq("id", 1)
      .single(),
    supabaseAdmin
      .from("discord_member_state")
      .select("discord_user_id", { count: "exact", head: true })
      .eq("discord_ban_active", true),
  ]);

  if (healthResult.error || banCountResult.error) {
    throw new Error("Discord sync health is temporarily unavailable");
  }

  const health = healthResult.data;
  const rows = [
    ["Last event", health.last_event_at],
    ["Last reconciliation start", health.last_reconciliation_started_at],
    ["Last successful reconciliation", health.last_reconciliation_succeeded_at],
    ["Last complete ban snapshot", health.last_ban_snapshot_at],
    ["Last complete membership snapshot", health.last_membership_snapshot_at],
    ["Last error", health.last_error_at],
  ] as const;

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Discord Sync Health</h1>
        <p className="mt-2 text-sm text-white/60">
          Internal aggregate status only. No Discord identities or payloads are
          displayed.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-white/10 bg-white/5 p-4">
          <div className="text-sm text-white/60">Active Discord bans</div>
          <div className="mt-2 text-3xl font-semibold">
            {banCountResult.count ?? 0}
          </div>
        </div>
        <div className="rounded-xl border border-white/10 bg-white/5 p-4">
          <div className="text-sm text-white/60">Last error code</div>
          <div className="mt-2 font-mono text-sm">
            {health.last_error_code ?? "None"}
          </div>
        </div>
      </div>

      <dl className="divide-y divide-white/10 rounded-xl border border-white/10">
        {rows.map(([label, value]) => (
          <div
            key={label}
            className="grid gap-2 p-4 md:grid-cols-[240px_1fr]"
          >
            <dt className="text-sm text-white/60">{label}</dt>
            <dd className="text-sm">{displayTimestamp(value)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
