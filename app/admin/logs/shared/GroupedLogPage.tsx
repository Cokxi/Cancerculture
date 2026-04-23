"use client";

import { useEffect, useState } from "react";

type BaseLog = {
  id: number;
  created_at: string;
  cycle_id: number | null;
  discord_user_id: string | null;
  status: string;
  reason: string | null;
  submission_id?: number | null;
};

type GroupedLogPageProps<TLog extends BaseLog> = {
  emptyMessage: string;
  endpoint: string;
  getGroupKey?: (log: TLog) => string;
  loadingMessage: string;
  prioritizeStatuses?: string[];
  renderGroupTitle?: (groupKey: string, logs: TLog[]) => string;
  title: string;
  renderTitle?: (log: TLog) => string;
};

export default function GroupedLogPage<TLog extends BaseLog>({
  emptyMessage,
  endpoint,
  getGroupKey,
  loadingMessage,
  prioritizeStatuses,
  renderGroupTitle,
  title,
  renderTitle,
}: GroupedLogPageProps<TLog>) {
  const [logs, setLogs] = useState<TLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadLogs() {
      try {
        setLoading(true);
        setError(null);

        const res = await fetch(endpoint);
        const data = await res.json();

        if (!res.ok) {
          throw new Error(data.error || `Failed to load ${title}`);
        }

        setLogs(data.logs);
      } catch (error) {
        setError(
          error instanceof Error ? error.message : `Failed to load ${title}`
        );
      } finally {
        setLoading(false);
      }
    }

    loadLogs();
  }, [endpoint, title]);

  if (loading) return <p>{loadingMessage}</p>;
  if (error) return <p style={{ color: "red" }}>{error}</p>;

  if (logs.length === 0) {
    return (
      <div style={{ padding: 24 }}>
        <h1>{title}</h1>
        <p>{emptyMessage}</p>
      </div>
    );
  }

  const logsByGroup = logs.reduce<Record<string, TLog[]>>((acc, log) => {
    const key = getGroupKey
      ? getGroupKey(log)
      : log.cycle_id
        ? `Cycle ${log.cycle_id}`
        : "No Cycle";

    acc[key] ||= [];
    acc[key].push(log);
    return acc;
  }, {});

  function getStatusSections(groupLogs: TLog[]) {
    const logsByStatus = groupLogs.reduce<Record<string, TLog[]>>(
      (acc, log) => {
        const statusKey = log.status?.trim() || "unknown";
        acc[statusKey] ||= [];
        acc[statusKey].push(log);
        return acc;
      },
      {}
    );

    const preferredStatuses =
      prioritizeStatuses?.map((status) => status.toLowerCase()) ??
      ["failed", "success"];

    const orderedStatuses = Object.keys(logsByStatus).sort(
      (left, right) => {
        const leftIndex = preferredStatuses.indexOf(
          left.toLowerCase()
        );
        const rightIndex = preferredStatuses.indexOf(
          right.toLowerCase()
        );

        if (leftIndex !== -1 || rightIndex !== -1) {
          if (leftIndex === -1) return 1;
          if (rightIndex === -1) return -1;
          return leftIndex - rightIndex;
        }

        return left.localeCompare(right);
      }
    );

    return orderedStatuses.map((status) => ({
      status,
      logs: logsByStatus[status],
    }));
  }

  return (
    <div style={{ padding: 24 }}>
      <h1>{title}</h1>

      <div style={{ marginTop: 24 }}>
        {Object.entries(logsByGroup).map(([groupKey, groupLogs]) => (
          <details
            key={groupKey}
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
              {renderGroupTitle
                ? renderGroupTitle(groupKey, groupLogs)
                : `${groupKey} (${groupLogs.length})`}
            </summary>

            <div style={{ marginTop: 12 }}>
              {getStatusSections(groupLogs).map(
                ({ status, logs: statusLogs }) => (
                  <details
                    key={`${groupKey}-${status}`}
                    open={status.toLowerCase() === "failed"}
                    style={{
                      marginBottom: 16,
                      border: "1px solid #2d2d2d",
                      borderRadius: 6,
                      padding: 10,
                      background:
                        status.toLowerCase() === "failed"
                          ? "#140f0f"
                          : "#101010",
                    }}
                  >
                    <summary
                      style={{
                        cursor: "pointer",
                        fontWeight: "bold",
                        color:
                          status.toLowerCase() === "failed"
                            ? "#fca5a5"
                            : status.toLowerCase() === "success"
                              ? "#86efac"
                              : "#facc15",
                      }}
                    >
                      {status.toUpperCase()} ({statusLogs.length})
                    </summary>

                    <div style={{ marginTop: 10 }}>
                      {statusLogs.map((log) => (
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
                              {renderTitle
                                ? renderTitle(log)
                                : log.status.toUpperCase()}
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
                              <code>{log.discord_user_id}</code>
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
                    </div>
                  </details>
                )
              )}
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}
