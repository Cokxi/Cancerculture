"use client";

import { useState } from "react";

export default function ModerationLogList({
  byCycle,
  actorMap,
  submissionUserMap,
}: {
  byCycle: Map<number, any[]>;
  actorMap: Map<string, any>;
  submissionUserMap: Map<number, string>;
}) {
  const [discordIdFilter, setDiscordIdFilter] = useState("");

  return (
    <>
      
      <div style={{ marginTop: 12 }}>
        <input
          type="text"
          placeholder="Filter by submitter Discord ID"
          value={discordIdFilter}
          onChange={(e) =>
            setDiscordIdFilter(e.target.value)
          }
          style={{
            padding: "4px 8px",
            fontSize: 13,
            width: 280,
            background: "#0b0b0b",
            border: "1px solid #333",
            color: "white",
          }}
        />
        {discordIdFilter && (
          <button
            onClick={() => setDiscordIdFilter("")}
            style={{ marginLeft: 8, fontSize: 12 }}
          >
            Clear
          </button>
        )}
      </div>

      
      {[...byCycle.entries()].map(
        ([cycleId, cycleLogs]) => {
          const filteredLogs =
            discordIdFilter.trim() === ""
              ? cycleLogs
              : cycleLogs.filter((log) => {
                  const submitter =
                    submissionUserMap.get(
                      Number(log.target_id)
                    );
                  return (
                    submitter &&
                    submitter.includes(
                      discordIdFilter
                    )
                  );
                });

          if (filteredLogs.length === 0) {
            return null;
          }

          return (
            <details
              key={cycleId}
              style={{
                marginTop: 24,
                borderTop: "1px solid #333",
                paddingTop: 16,
              }}
            >
              <summary
                style={{
                  cursor: "pointer",
                  fontSize: 18,
                  fontWeight: 600,
                }}
              >
                Cycle #{cycleId} (
                {filteredLogs.length} Logs)
              </summary>

              {filteredLogs.map((log) => {
                const actor =
                  actorMap.get(log.actor_id);
                const submitter =
                  submissionUserMap.get(
                    Number(log.target_id)
                  );

                return (
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
                      <strong>
                        {log.actor_role.toUpperCase()}
                      </strong>{" "}
                      – {log.action}
                    </div>

                    <div style={{ opacity: 0.7 }}>
                      {new Date(
                        log.created_at
                      ).toLocaleString()}
                    </div>

                    <div style={{ marginTop: 4 }}>
                      by{" "}
                      {actor
                        ?.current_discord_username ??
                        "Unknown"}{" "}
                      <span style={{ opacity: 0.5 }}>
                        ({log.actor_id})
                      </span>
                    </div>

                    <div
                      style={{
                        marginTop: 4,
                        opacity: 0.75,
                        fontFamily: "monospace",
                      }}
                    >
                      Submitter:{" "}
                      {submitter ??
                        "unknown (deleted)"}
                    </div>

                    {log.evidence
                      ?.submission_image_url && (
                      <img
                        src={
                          log.evidence
                            .submission_image_url
                        }
                        alt=""
                        style={{
                          width: 96,
                          height: 96,
                          objectFit: "cover",
                          marginTop: 8,
                          border:
                            "1px solid #444",
                        }}
                      />
                    )}
                  </div>
                );
              })}
            </details>
          );
        }
      )}
    </>
  );
}
