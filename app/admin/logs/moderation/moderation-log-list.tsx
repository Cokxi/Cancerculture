"use client";

import { useEffect, useState } from "react";
import type { ModerationLogRow } from "@/lib/admin/moderationLogs";
import UserProfileLink from "../shared/UserProfileLink";

function formatAction(action: string) {
  return action.replaceAll("_", " ");
}

export default function ModerationLogList() {
  const [logs, setLogs] = useState<ModerationLogRow[]>([]);
  const [discordIdFilter, setDiscordIdFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadLogs() {
      try {
        const response = await fetch("/api/admin/logs/moderation");
        const body = await response.json();

        if (!response.ok) {
          throw new Error(body.error || "Failed to load moderation logs");
        }

        setLogs(body.logs ?? []);
      } catch (loadError) {
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Failed to load moderation logs"
        );
      } finally {
        setLoading(false);
      }
    }

    loadLogs();
  }, []);

  const normalizedFilter = discordIdFilter.trim();
  const filteredLogs = normalizedFilter
    ? logs.filter((log) =>
        log.submitter_discord_user_id?.includes(normalizedFilter)
      )
    : logs;
  const byCycle = filteredLogs.reduce<Map<string, ModerationLogRow[]>>(
    (groups, log) => {
      const key = log.cycle_id === null ? "unknown" : String(log.cycle_id);
      const cycleLogs = groups.get(key) ?? [];
      cycleLogs.push(log);
      groups.set(key, cycleLogs);
      return groups;
    },
    new Map()
  );

  return (
    <div style={{ padding: 24 }}>
      <h1>Admin - Submission Moderation Logs</h1>

      {loading ? <p>Loading moderation logs...</p> : null}
      {error ? <p style={{ color: "red" }}>{error}</p> : null}

      {!loading && !error ? (
        <>
          <div style={{ marginTop: 12 }}>
            <input
              type="text"
              placeholder="Filter by submitter Discord ID"
              value={discordIdFilter}
              onChange={(event) => setDiscordIdFilter(event.target.value)}
              style={{
                padding: "4px 8px",
                fontSize: 13,
                width: 280,
                background: "#0b0b0b",
                border: "1px solid #333",
                color: "white",
              }}
            />
            {discordIdFilter ? (
              <button
                onClick={() => setDiscordIdFilter("")}
                style={{ marginLeft: 8, fontSize: 12 }}
              >
                Clear
              </button>
            ) : null}
          </div>

          {filteredLogs.length === 0 ? (
            <p style={{ marginTop: 24 }}>No moderation logs found.</p>
          ) : null}

          {[...byCycle.entries()].map(([cycleId, cycleLogs]) => (
            <details
              key={cycleId}
              open
              style={{
                marginTop: 24,
                border: "1px solid #333",
                borderRadius: 6,
                padding: 12,
              }}
            >
              <summary style={{ cursor: "pointer", fontWeight: 600 }}>
                {cycleId === "unknown" ? "No Cycle" : `Cycle #${cycleId}`} (
                {cycleLogs.length})
              </summary>

              {cycleLogs.map((log) => (
                <div
                  key={log.id}
                  style={{
                    marginTop: 12,
                    padding: 12,
                    background: "#0b0b0b",
                    border: "1px solid #222",
                    borderRadius: 6,
                    fontSize: 13,
                  }}
                >
                  <div>
                    <strong>{log.actor_role.toUpperCase()}</strong> - {" "}
                    {formatAction(log.action)}
                  </div>
                  <div style={{ opacity: 0.7 }}>
                    {new Date(log.created_at).toLocaleString()}
                  </div>

                  <div style={{ marginTop: 4 }}>
                    Actor: {" "}
                    <UserProfileLink
                      discordUserId={log.actor_discord_user_id}
                      label={
                        log.actor_discord_user_label ??
                        log.actor_discord_user_id
                      }
                      publicProfileId={log.actor_public_profile_id}
                    />
                  </div>

                  <div style={{ marginTop: 4 }}>
                    Submitter: {" "}
                    {log.submitter_discord_user_id ? (
                      <UserProfileLink
                        discordUserId={log.submitter_discord_user_id}
                        label={
                          log.submitter_discord_user_label ??
                          log.submitter_discord_user_id
                        }
                        publicProfileId={log.submitter_public_profile_id}
                      />
                    ) : (
                      "unknown"
                    )}
                  </div>

                  <div style={{ marginTop: 4 }}>
                    Submission: {" "}
                    {log.submission_id === null
                      ? "unknown"
                      : `#${log.submission_id}`}
                  </div>
                  <div style={{ marginTop: 8, fontWeight: 600 }}>
                    Reason: {formatAction(log.reason)}
                  </div>
                  {log.reason_text ? (
                    <div style={{ marginTop: 4, color: "#aaa" }}>
                      Details: {log.reason_text}
                    </div>
                  ) : null}
                </div>
              ))}
            </details>
          ))}
        </>
      ) : null}
    </div>
  );
}
