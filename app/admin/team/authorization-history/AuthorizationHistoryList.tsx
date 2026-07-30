import type { TeamAuthorizationAuditEntry } from "@/lib/auth/teamRoleAdminReadModel";

const eventLabels: Readonly<Record<string, string>> = {
  role_created: "Role created",
  role_updated: "Role updated",
  role_activated: "Role activated",
  role_deactivated: "Role deactivated",
  capability_granted: "Capability granted",
  capability_revoked: "Capability revoked",
  member_role_changed: "Member role changed",
  admin_role_changed: "Owner access changed",
  member_added: "Team member added",
  member_removed: "Team member removed",
};

function formatAuditValue(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(formatAuditValue).join(", ");
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => `${key}: ${formatAuditValue(entry)}`)
      .join(" · ");
  }
  return "Unsupported value";
}

function AuditState({
  title,
  state,
}: {
  title: string;
  state: Readonly<Record<string, unknown>>;
}) {
  const entries = Object.entries(state);
  return (
    <div className="min-w-0">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-white/40">
        {title}
      </h3>
      {entries.length === 0 ? (
        <p className="mt-1 text-xs text-white/45">Empty</p>
      ) : (
        <dl className="mt-2 grid gap-2 text-xs">
          {entries.map(([key, value]) => (
            <div
              key={key}
              className="grid min-w-0 gap-1 sm:grid-cols-[minmax(100px,auto)_minmax(0,1fr)]"
            >
              <dt className="text-white/40">{key}</dt>
              <dd className="min-w-0 break-words text-white/70">
                {formatAuditValue(value)}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
function AuditEntry({ entry }: { entry: TeamAuthorizationAuditEntry }) {
  return (
    <article className="rounded-xl border border-white/10 bg-white/[0.025] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">
            {eventLabels[entry.eventType] ?? entry.eventType}
          </h2>
          <p className="mt-1 text-xs text-white/45">
            {new Date(entry.occurredAt).toLocaleString()}
          </p>
        </div>
        <span className="rounded border border-white/15 px-2 py-0.5 text-xs text-white/65">
          Actor role: {entry.actorRoleKey}
        </span>
      </div>

      <dl className="mt-4 grid gap-x-5 gap-y-2 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
        <dt className="text-white/40">Actor</dt>
        <dd className="break-all">{entry.actorDiscordUserId}</dd>
        {entry.targetRoleKey ? (
          <>
            <dt className="text-white/40">Affected role</dt>
            <dd className="break-all">{entry.targetRoleKey}</dd>
          </>
        ) : null}
        {entry.capabilityKey ? (
          <>
            <dt className="text-white/40">Affected capability</dt>
            <dd className="break-all">{entry.capabilityKey}</dd>
          </>
        ) : null}
        {entry.targetDiscordUserId ? (
          <>
            <dt className="text-white/40">Affected member</dt>
            <dd className="break-all">{entry.targetDiscordUserId}</dd>
          </>
        ) : null}
        <dt className="text-white/40">Reason</dt>
        <dd className="break-words">{entry.reason}</dd>
      </dl>

      <div className="mt-4 grid min-w-0 gap-4 border-t border-white/10 pt-4 md:grid-cols-2">
        <AuditState title="Before" state={entry.beforeState} />
        <AuditState title="After" state={entry.afterState} />
      </div>
    </article>
  );
}

export default function AuthorizationHistoryList({
  audit,
}: {
  audit: readonly TeamAuthorizationAuditEntry[];
}) {
  if (audit.length === 0) {
    return (
      <p className="rounded-xl border border-white/10 p-5 text-sm text-white/50">
        No authorization changes have been recorded.
      </p>
    );
  }

  return (
    <div className="grid gap-3">
      {audit.map((entry) => (
        <AuditEntry key={entry.id} entry={entry} />
      ))}
    </div>
  );
}
