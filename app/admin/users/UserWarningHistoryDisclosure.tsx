import Link from "next/link";
import type { TeamUserWarningHistory } from "@/lib/warnings/userWarningVisibility.server";
import UserWarningOverruleAction from "./UserWarningOverruleAction";

const categoryLabels = {
  spam: "Spam",
  hate_speech: "Hate speech",
  other: "Other",
} as const;

const statusLabels = {
  active: "Active",
  expired: "Expired",
  overruled: "Overruled",
} as const;

function formatTimestamp(value: string | null) {
  return value ? new Date(value).toLocaleString() : "—";
}

export default function UserWarningHistoryDisclosure({
  history,
  userLabel,
  targetDiscordUserId,
  canOverrule,
}: {
  history: TeamUserWarningHistory;
  userLabel: string;
  targetDiscordUserId: string;
  canOverrule: boolean;
}) {
  return (
    <div data-user-warning-history style={{ minWidth: 260, fontSize: 12 }}>
      <div
        style={{
          border: `1px solid ${history.active ? "#f59e0b" : "#333"}`,
          borderRadius: 6,
          padding: "7px 9px",
          color: history.active ? "#fbbf24" : "rgba(255,255,255,.65)",
        }}
      >
        <strong>{history.active ? "ACTIVE WARNING" : "No active Warning"}</strong>
        {history.active ? (
          <div style={{ marginTop: 3 }}>
            {history.activeCount} active · latest expiry {formatTimestamp(history.latestActiveExpiresAt)}
          </div>
        ) : null}
      </div>

      {history.warnings.length === 0 ? (
        <div style={{ marginTop: 6, opacity: 0.55 }}>No Warning history</div>
      ) : (
        <details style={{ marginTop: 7 }}>
          <summary
            aria-label={`Show Warning history for ${userLabel}`}
            style={{ cursor: "pointer", fontWeight: 600 }}
          >
            Warning history ({history.warnings.length}{history.historyHasMore ? "+" : ""})
          </summary>
          <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
            {history.warnings.map((warning) => (
              <article
                key={warning.warningId}
                style={{ border: "1px solid #333", borderRadius: 6, padding: "9px 10px" }}
              >
                <strong>
                  {categoryLabels[warning.category]} · {statusLabels[warning.effectiveStatus]}
                </strong>
                <div style={{ marginTop: 4 }}>{warning.reason}</div>
                <div style={{ marginTop: 5, opacity: 0.72 }}>
                  Issued {formatTimestamp(warning.issuedAt)} by{" "}
                  {warning.issuedByDisplayName ?? "Team member"} ({warning.issuedByRoleKey})
                </div>
                <div style={{ marginTop: 3, opacity: 0.72 }}>
                  Original: {warning.originalTierDays} day(s), expires {formatTimestamp(warning.originalExpiresAt)}
                  <br />
                  Effective: {warning.effectiveTierDays} day(s), expires {formatTimestamp(warning.effectiveExpiresAt)}
                </div>
                <details style={{ marginTop: 6 }}>
                  <summary style={{ cursor: "pointer" }}>Source Comment evidence</summary>
                  <div style={{ marginTop: 5, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                    {warning.sourceCommentBody}
                  </div>
                  <div style={{ marginTop: 5, opacity: 0.65 }}>
                    Object v{warning.sourceCommentObjectVersion} · Text v{warning.sourceCommentTextVersion}
                  </div>
                  <Link
                    href={`/spread/${warning.sourceSubmissionId}?comment=${encodeURIComponent(warning.sourcePublicCommentId)}`}
                    style={{ display: "inline-block", marginTop: 5, color: "#ff9f1c" }}
                  >
                    Open public Comment position
                  </Link>
                </details>
                <details style={{ marginTop: 6 }}>
                  <summary style={{ cursor: "pointer" }}>
                    Lifecycle ({warning.events.length})
                  </summary>
                  <ol style={{ display: "grid", gap: 6, marginTop: 6, paddingLeft: 18 }}>
                    {warning.events.map((event) => (
                      <li key={`${warning.warningId}-${event.warningRowVersion}-${event.eventType}`}>
                        <strong>{event.eventType}</strong> · {formatTimestamp(event.occurredAt)}
                        <div style={{ opacity: 0.72 }}>
                          {event.previousState ?? "—"} → {event.newState};{" "}
                          {event.previousTierDays ?? "—"} → {event.newTierDays} day(s); expiry{" "}
                          {formatTimestamp(event.previousExpiresAt)} → {formatTimestamp(event.newExpiresAt)}
                        </div>
                        <div style={{ opacity: 0.72 }}>
                          {event.actorKind === "system"
                            ? "System"
                            : `${event.actorDisplayName ?? "Team member"} (${event.actorRoleKey ?? "role unavailable"})`}
                          {event.reason ? ` · ${event.reason}` : ""}
                        </div>
                      </li>
                    ))}
                  </ol>
                </details>
                {canOverrule && warning.effectiveStatus !== "overruled" ? (
                  <UserWarningOverruleAction
                    targetDiscordUserId={targetDiscordUserId}
                    publicWarningId={warning.warningId}
                    expectedRowVersion={warning.rowVersion}
                  />
                ) : null}
              </article>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
