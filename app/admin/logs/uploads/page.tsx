"use client";

import { useEffect, useState } from "react";

type UploadLog = {
  id: number;
  created_at: string;
  cycle_id: number | null;
  status: string;
  reason: string | null;
  discord_user_id: string | null;
  submission_id: number | null;
};

export default function AdminUploadLogsPage() {
  const [logs, setLogs] = useState<UploadLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadLogs() {
      try {
        setLoading(true);
        const res = await fetch("/api/admin/logs/uploads");
        const data = await res.json();

        if (!res.ok) {
          throw new Error(
            data.error || "Failed to load upload logs"
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

  if (loading) return <p>Loading upload logs…</p>;
  if (error)
    return <p style={{ color: "red" }}>{error}</p>;

  if (logs.length === 0) {
    return (
      <div style={{ padding: 24 }}>
        <h1>Admin – Upload Logs</h1>
        <p>No upload logs found.</p>
      </div>
    );
  }

  // 🔹 Logs nach Cycle gruppieren
  const logsByCycle = logs.reduce<
    Record<string, UploadLog[]>
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
      <h1>Admin – Upload Logs</h1>

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
