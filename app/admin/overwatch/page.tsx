export const dynamic = "force-dynamic";

import Link from "next/link";
import { formatDiscordUserLabel } from "@/lib/discord/formatDiscordUserLabel";
import { requireTeamCapabilityPage } from "@/lib/auth/pageAccess";
import { hasResolvedTeamCapability } from "@/lib/auth/teamAuthorization";
import {
  loadUserOverwatchEntries,
  type UserOverwatchEntry,
} from "@/lib/overwatch/userOverwatch.server";
import UserOverwatchRemoveAction from "./UserOverwatchRemoveAction";

function userLabel(entry: UserOverwatchEntry) {
  return formatDiscordUserLabel({
    discord_user_id: entry.targetDiscordUserId,
    current_discord_username: entry.currentDiscordUsername,
    current_discord_handle: entry.currentDiscordHandle,
    current_display_name: entry.currentDisplayName,
    current_guild_nickname: entry.currentGuildNickname,
  });
}

function EntryCard({
  entry,
  canManage,
}: {
  entry: UserOverwatchEntry;
  canManage: boolean;
}) {
  const label = userLabel(entry);
  return (
    <article
      data-overwatch-entry={entry.state}
      style={{
        border: "1px solid rgba(129,140,248,.42)",
        borderRadius: 10,
        padding: 14,
        background: "rgba(30,27,75,.16)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 14,
          alignItems: "flex-start",
          flexWrap: "wrap",
        }}
      >
        <div>
          <div style={{ fontWeight: 800, color: "#e0e7ff" }}>
            {entry.publicProfileId ? (
              <Link
                href={`/profile/${entry.publicProfileId}`}
                style={{ color: "inherit", textUnderlineOffset: 4 }}
              >
                {label}
              </Link>
            ) : label}
          </div>
          <div style={{ marginTop: 3, fontFamily: "monospace", fontSize: 12, opacity: 0.62 }}>
            {entry.targetDiscordUserId}
          </div>
        </div>
        <div style={{ textAlign: "right", fontSize: 12 }}>
          <strong>{entry.state === "active" ? "ACTIVE" : "REMOVED"}</strong>
          <div style={{ marginTop: 3, opacity: 0.65 }}>
            Generation {entry.generation} · version {entry.rowVersion}
          </div>
        </div>
      </div>

      <ol style={{ margin: "14px 0 0", paddingLeft: 20 }}>
        {entry.events.map((event) => (
          <li
            key={`${event.eventType}-${event.entryRowVersion}`}
            style={{ marginTop: 10, paddingLeft: 4 }}
          >
            <div style={{ fontWeight: 700 }}>
              {event.eventType === "added" ? "Added" : "Removed"} · {new Date(event.occurredAt).toLocaleString()}
            </div>
            <div style={{ marginTop: 4, whiteSpace: "pre-wrap" }}>{event.reason}</div>
            <div style={{ marginTop: 4, fontSize: 12, opacity: 0.62 }}>
              Team actor: {event.actorDisplayName ?? "Name unavailable"} · role {event.actorRoleKey}
            </div>
          </li>
        ))}
      </ol>

      {entry.state === "active" && canManage ? (
        <UserOverwatchRemoveAction
          targetDiscordUserId={entry.targetDiscordUserId}
          entryId={entry.entryId}
          expectedRowVersion={entry.rowVersion}
        />
      ) : null}
    </article>
  );
}

export default async function OverwatchPage() {
  const authorization = await requireTeamCapabilityPage(
    "users.overwatch.view",
  );
  const canManage = hasResolvedTeamCapability(
    authorization,
    "users.overwatch.manage",
  );
  const [activeEntries, historyEntries] = await Promise.all([
    loadUserOverwatchEntries("active"),
    loadUserOverwatchEntries("history"),
  ]);

  return (
    <main style={{ padding: 24, maxWidth: 1120, margin: "0 auto" }}>
      <h1>Overwatch</h1>
      <p style={{ marginTop: 8, maxWidth: 780, opacity: 0.72 }}>
        Team-only bookmarks for a second opinion. Overwatch is not a Flag,
        Warning, sanction, behavior monitor, or member notification surface.
      </p>

      <section aria-labelledby="active-overwatch-heading" style={{ marginTop: 28 }}>
        <h2 id="active-overwatch-heading">Active entries</h2>
        <p style={{ marginTop: 5, opacity: 0.65 }}>
          {activeEntries.length} active {activeEntries.length === 1 ? "generation" : "generations"}
        </p>
        {activeEntries.length === 0 ? (
          <p style={{ marginTop: 14, opacity: 0.65 }}>No active Overwatch entries.</p>
        ) : (
          <div style={{ display: "grid", gap: 14, marginTop: 14 }}>
            {activeEntries.map((entry) => (
              <EntryCard key={entry.entryId} entry={entry} canManage={canManage} />
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="overwatch-history-heading" style={{ marginTop: 36 }}>
        <h2 id="overwatch-history-heading">Immutable history</h2>
        <p style={{ marginTop: 5, opacity: 0.65 }}>
          Removed generations remain complete and cannot be rewritten or deleted.
        </p>
        {historyEntries.length === 0 ? (
          <p style={{ marginTop: 14, opacity: 0.65 }}>No removed generations yet.</p>
        ) : (
          <div style={{ display: "grid", gap: 14, marginTop: 14 }}>
            {historyEntries.map((entry) => (
              <EntryCard key={entry.entryId} entry={entry} canManage={false} />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
