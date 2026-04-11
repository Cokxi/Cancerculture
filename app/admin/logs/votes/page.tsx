"use client";

import { useEffect, useState } from "react";

type VoteLog = {
  id: number;
  created_at: string;
  cycle_id: number | null;
  submission_id: number | null;
  discord_user_id: string | null;
  status: string;
  reason: string | null;
};

export default function AdminVoteLogsPage() {
  const [logs, setLogs] = useState<VoteLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadLogs() {
      try {
        setLoading(true);
        const res = await fetch("/api/admin/logs/votes");
        const data = await res.json();

        if (!res.ok) {
          throw new Error(
            data.error || "Failed to load vote logs"
          );
        }

        setLogs(data.logs);
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }

    loadLogs();
  }, []);

  if (loading) return <p>Loading vote logs…</p>;
  if (error)
    return <p style={{ color: "red" }}>{error}</p>;

  if (logs.length === 0) {
    return (
      <div style={{ padding: 24 }}>
        <h1>Admin – Vote Logs</h1>
        <p>No vote logs found.</p>
      </div>
    );
  }

  
  const logsByCycle = logs.reduce<
    Record<string, VoteLog[]>
  >((acc, log) => {
    const key = log.cycle_id
      ? `Cycle ${log.cycle_id}`
      : "No Cycle";

    acc[key] ||= [];
    acc[key].push(log);
    return acc;
  }, {});

  return (
    <div style={{ padding: 24 }}>
      <h1>Admin – Vote Logs</h1>

      <div style={{ marginTop: 24 }}>
        {Object.entries(logsByCycle).map(
          ([cycleLabel, cycleLogs]) => (
            <details
              key={cycleLabel}
              open
              style={{
                marginBottom: 24,
                border: "1px solid #333",
                borderRadius: 6,
                padding: 12,
              }}
            >
              <summary
                style={{
                  cursor: "pointer",
                  fontWeight: "bold",
                  color: "#f97316",
                  marginBottom: 8,
                }}
              >
                {cycleLabel} ({cycleLogs.length})
              </summary>

              {cycleLogs.map((log) => (
                <div
                  key={log.id}
                  style={{
                    padding: 12,
                    borderBottom: "1px solid #333",
                    fontSize: 13,
                  }}
                >
                  <div>
                    <strong>
                      {log.status.toUpperCase()}
                    </strong>
                    {log.submission_id && (
                      <> – Submission #{log.submission_id}</>
                    )}
                  </div>

                  {log.discord_user_id && (
                    <div
                      style={{
                        color: "#f97316",
                        marginTop: 4,
                      }}
                    >
                      Discord ID:{" "}
                      <code>
                        {log.discord_user_id}
                      </code>
                    </div>
                  )}

                  {log.reason && (
                    <div
                      style={{
                        color: "#aaa",
                        marginTop: 4,
                      }}
                    >
                      Reason: {log.reason}
                    </div>
                  )}

                  <div
                    style={{
                      opacity: 0.6,
                      marginTop: 4,
                    }}
                  >
                    {new Date(
                      log.created_at
                    ).toLocaleString()}
                  </div>
                </div>
              ))}
            </details>
          )
        )}
      </div>
    </div>
  );
}
