"use client";

import { useEffect, useState } from "react";

type CycleLog = {
  id: string;
  created_at: string;
  action: string;
  target_type: string;
  target_id: number | null;
  actor_role: string;
  actor_id: string;
};

export default function AdminCycleLogsPage() {
  const [logs, setLogs] = useState<CycleLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

const [cycleThemes, setCycleThemes] = useState<Record<number, string | null>>({});  

  useEffect(() => {
    async function loadLogs() {
      try {
        const res = await fetch("/api/admin/logs?type=cycle", {
  credentials: "include",
});
const text = await res.text();

if (!text) {
  throw new Error("Empty response from server");
}

const data = JSON.parse(text);

// 🔥 Cycle IDs sammeln
const cycleIds = Array.from(
  new Set(data.logs.map((l: any) => l.target_id))
);

// 🔥 Themes laden
const themeRes = await fetch(
  "/api/admin/cycles/themes?ids=" + cycleIds.join(",")
);
const themeData = await themeRes.json();

setCycleThemes(themeData.themes || {});



        if (!res.ok) {
          throw new Error(data.error || "Failed to load cycle logs");
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

  if (loading) return <p>Loading cycle logs…</p>;
  if (error) return <p style={{ color: "red" }}>{error}</p>;

  return (
    <div style={{ padding: 24 }}>
      <h1>Admin – Cycle Logs</h1>

      {logs.length === 0 && (
        <p style={{ marginTop: 16 }}>
          No cycle logs found.
        </p>
      )}

      <div style={{ marginTop: 24 }}>
        {logs.map((log) => (
          <div
            key={log.id}
            style={{
              borderBottom: "1px solid #333",
              padding: "12px 0",
              fontSize: 13,
            }}
          >
            <div style={{ fontWeight: "bold" }}>
              {log.action}
            </div>

            <div style={{ opacity: 0.7 }}>
  🔥 {log.target_id
  ? cycleThemes[log.target_id] ?? "Open Round"
  : "Open Round"} — Round {log.target_id ?? "?"}

</div>


            <div style={{ opacity: 0.5 }}>
              {new Date(log.created_at).toLocaleString()}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
