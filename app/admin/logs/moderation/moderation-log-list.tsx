"use client";

import { useEffect, useState } from "react";
import type { ModerationLogRow } from "@/lib/admin/moderationLogs";
import Image from "next/image";
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
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <label
              htmlFor="moderation-log-submitter-filter"
              className="sr-only"
            >
              Filter moderation logs by submitter Discord ID
            </label>
            <input
              id="moderation-log-submitter-filter"
              type="text"
              placeholder="Filter by submitter Discord ID"
              value={discordIdFilter}
              onChange={(event) => setDiscordIdFilter(event.target.value)}
              style={{
                padding: "4px 8px",
                fontSize: 13,
                width: 280,
                maxWidth: "100%",
                background: "#0b0b0b",
                border: "1px solid #333",
                color: "white",
              }}
            />
            {discordIdFilter ? (
              <button
                type="button"
                onClick={() => setDiscordIdFilter("")}
                style={{ fontSize: 12 }}
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
                <details
                  key={log.id}
                  className="mt-3 rounded-lg border border-white/10 bg-black/35 p-3 text-sm"
                >
                  <summary className="cursor-pointer rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-orange-300">
                    <span className="ml-2 inline-flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <strong>{log.actor_role.toUpperCase()}</strong>
                      <span>{formatAction(log.action)}</span>
                      <span className="text-xs text-white/60">
                        {new Date(log.created_at).toLocaleString()}
                      </span>
                    </span>
                  </summary>

                  <div className="mt-4 grid gap-4 md:grid-cols-[minmax(0,1fr)_10rem]">
                    <dl className="grid min-w-0 gap-x-4 gap-y-2 sm:grid-cols-[7rem_minmax(0,1fr)]">
                      <dt className="font-semibold text-white/60">
                        Actor
                      </dt>
                      <dd className="min-w-0 break-words">
                        <UserProfileLink
                          discordUserId={log.actor_discord_user_id}
                          label={
                            log.actor_discord_user_label ??
                            log.actor_discord_user_id
                          }
                          publicProfileId={log.actor_public_profile_id}
                        />
                      </dd>

                      <dt className="font-semibold text-white/60">
                        Submitter
                      </dt>
                      <dd className="min-w-0 break-words">
                        {log.submitter_discord_user_id ? (
                          <UserProfileLink
                            discordUserId={
                              log.submitter_discord_user_id
                            }
                            label={
                              log.submitter_discord_user_label ??
                              log.submitter_discord_user_id
                            }
                            publicProfileId={
                              log.submitter_public_profile_id
                            }
                          />
                        ) : (
                          "unknown"
                        )}
                      </dd>

                      <dt className="font-semibold text-white/60">
                        Submission
                      </dt>
                      <dd className="min-w-0 break-words">
                        {log.submission_id === null
                          ? "unknown"
                          : `#${log.submission_id}`}
                        {log.submission_href ? (
                          <a
                            href={log.submission_href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="ml-3 text-orange-300 underline decoration-orange-300/50 underline-offset-2 transition hover:text-orange-200 focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-300"
                          >
                            Open current view
                          </a>
                        ) : null}
                      </dd>

                      <dt className="font-semibold text-white/60">
                        Cycle
                      </dt>
                      <dd>
                        {log.cycle_id === null
                          ? "unknown"
                          : `#${log.cycle_id}`}
                      </dd>

                      <dt className="font-semibold text-white/60">
                        Reason
                      </dt>
                      <dd className="min-w-0 break-words font-semibold">
                        {formatAction(log.reason)}
                      </dd>

                      {log.reason_text ? (
                        <>
                          <dt className="font-semibold text-white/60">
                            Details
                          </dt>
                          <dd className="min-w-0 whitespace-pre-wrap break-words text-white/70">
                            {log.reason_text}
                          </dd>
                        </>
                      ) : null}
                    </dl>

                    {log.submission_href &&
                    log.submission_thumbnail_url ? (
                      <a
                        href={log.submission_href}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`Open current view of submission #${log.submission_id}`}
                        className="block h-40 w-40 overflow-hidden rounded-lg border border-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-300"
                      >
                        <Image
                          src={log.submission_thumbnail_url}
                          alt={`Submission #${log.submission_id} preview`}
                          width={160}
                          height={160}
                          unoptimized
                          className="h-full w-full object-cover transition-transform hover:scale-105"
                        />
                      </a>
                    ) : null}
                  </div>
                </details>
              ))}
            </details>
          ))}
        </>
      ) : null}
    </div>
  );
}
