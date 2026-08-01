export const dynamic = "force-dynamic";

import { requireTeamCapabilityPage } from "@/lib/auth/pageAccess";
import { supabaseAdmin } from "@/lib/db/admin";
import { formatDiscordUserLabel } from "@/lib/discord/formatDiscordUserLabel";

type WebsiteBanEvent = {
  event_id: string;
  action: string;
  target_discord_user_id: string;
  actor_discord_user_id: string | null;
  actor_username: string | null;
  source: string | null;
  reason: string | null;
  previous_is_banned: boolean;
  new_is_banned: boolean;
  ban_version: number;
  occurred_at: string;
  recorded_at: string;
};

export default async function WebsiteBanHistoryPage() {
  await requireTeamCapabilityPage(
    "logs.website_bans.view",
    "/admin/website-ban-history"
  );

  const { data, error } = await supabaseAdmin
    .from("website_ban_events")
    .select("*")
    .order("occurred_at", { ascending: false })
    .order("event_id", { ascending: false })
    .limit(500);

  if (error) throw error;
  const events = (data ?? []) as WebsiteBanEvent[];
  const userIds = [
    ...new Set(
      events.flatMap((event) => [
        event.target_discord_user_id,
        ...(event.actor_discord_user_id
          ? [event.actor_discord_user_id]
          : []),
      ])
    ),
  ];
  const { data: users, error: usersError } = userIds.length
    ? await supabaseAdmin
        .from("user_logs")
        .select(
          "discord_user_id, current_discord_username, current_discord_handle, current_display_name, current_guild_nickname"
        )
        .in("discord_user_id", userIds)
    : { data: [], error: null };
  if (usersError) throw usersError;

  const labels = new Map(
    (users ?? []).map((user) => [
      user.discord_user_id,
      formatDiscordUserLabel(user),
    ])
  );

  return (
    <main className="mx-auto max-w-6xl p-6">
      <h1 className="text-2xl font-semibold">Website Ban History</h1>
      <p className="mt-2 text-sm text-white/60">
        Append-only website ban and revocation events. This page does not grant
        permission to create or revoke bans.
      </p>
      <div className="mt-6 space-y-3">
        {events.map((event) => (
          <article
            key={event.event_id}
            className="rounded-lg border border-white/10 bg-white/[0.03] p-4"
          >
            <div className="flex flex-wrap justify-between gap-3">
              <strong>
                {event.new_is_banned ? "Website ban created" : "Website ban revoked"}
              </strong>
              <span className="text-sm text-white/60">
                {new Date(event.occurred_at).toLocaleString()}
              </span>
            </div>
            <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
              <div>
                <dt className="text-white/50">Target</dt>
                <dd>{labels.get(event.target_discord_user_id) ?? event.target_discord_user_id}</dd>
              </div>
              <div>
                <dt className="text-white/50">Actor</dt>
                <dd>
                  {event.actor_discord_user_id
                    ? labels.get(event.actor_discord_user_id) ??
                      event.actor_username ??
                      event.actor_discord_user_id
                    : "Legacy actor unavailable"}
                </dd>
              </div>
              <div>
                <dt className="text-white/50">Transition</dt>
                <dd>
                  {event.previous_is_banned ? "banned" : "not banned"} →{" "}
                  {event.new_is_banned ? "banned" : "not banned"} · version{" "}
                  {event.ban_version}
                </dd>
              </div>
              <div className="sm:col-span-2 lg:col-span-3">
                <dt className="text-white/50">Reason</dt>
                <dd className="break-words">{event.reason ?? "Legacy reason unavailable"}</dd>
              </div>
            </dl>
          </article>
        ))}
        {events.length === 0 ? (
          <p className="text-sm text-white/50">No website ban events recorded.</p>
        ) : null}
      </div>
    </main>
  );
}
