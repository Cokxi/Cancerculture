export const CYCLE_LOG_ACTIONS = Object.freeze([
  "cycle_started",
  "cycle_finalized",
  "cycle_reset",
] as const);

export type CycleLogAction = (typeof CYCLE_LOG_ACTIONS)[number];
export type CycleLogEventType = CycleLogAction | "cycle_event";

export const CYCLE_LOG_EVENT_LABELS: Readonly<
  Record<CycleLogEventType, string>
> = Object.freeze({
  cycle_started: "Cycle started",
  cycle_finalized: "Cycle finalized",
  cycle_reset: "Cycle reset",
  cycle_event: "Cycle event",
});

export type CycleLogQueryRow = Readonly<{
  id: string;
  created_at: string;
  actor_id: string;
  action: string;
  target_id: string | null;
  actor_type?: string;
  target_type?: string | null;
  meta?: unknown;
}>;

export type CycleLogAdminAuditContext = Readonly<{
  actorType: string | null;
  targetType: string | null;
  rawAction: string;
  metadata: Readonly<Record<string, unknown>>;
}>;

export type CycleLogEntry = Readonly<{
  id: string;
  occurredAt: string;
  eventType: CycleLogEventType;
  eventLabel: string;
  cycleId: number | null;
  cycleTheme: string | null;
  actorDiscordUserId: string;
  actorLabel: string | null;
  actorPublicProfileId: string | null;
  adminAudit: CycleLogAdminAuditContext | null;
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedText(value: string | null | undefined, maxLength: number) {
  const normalized = value?.trim() ?? "";
  return normalized.length >= 1 && normalized.length <= maxLength
    ? normalized
    : null;
}

function parseCycleId(value: string | null): number | null {
  if (!value || !/^[1-9][0-9]{0,18}$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function buildCycleLogEntry(
  row: CycleLogQueryRow,
  isAdmin: boolean,
  context: {
    actorLabel?: string | null;
    actorPublicProfileId?: string | null;
    cycleTheme?: string | null;
  } = {}
): CycleLogEntry {
  const eventType: CycleLogEventType = CYCLE_LOG_ACTIONS.includes(
    row.action as CycleLogAction
  )
    ? (row.action as CycleLogAction)
    : "cycle_event";
  const metadata = asRecord(row.meta) ?? {};

  return Object.freeze({
    id: row.id,
    occurredAt: row.created_at,
    eventType,
    eventLabel: CYCLE_LOG_EVENT_LABELS[eventType],
    cycleId: parseCycleId(row.target_id),
    cycleTheme: boundedText(context.cycleTheme, 200),
    actorDiscordUserId: row.actor_id,
    actorLabel: boundedText(context.actorLabel, 200),
    actorPublicProfileId: isAdmin
      ? boundedText(context.actorPublicProfileId, 100)
      : null,
    adminAudit: isAdmin
      ? Object.freeze({
          actorType: boundedText(row.actor_type, 100),
          targetType: boundedText(row.target_type, 100),
          rawAction: row.action,
          metadata: Object.freeze({ ...metadata }),
        })
      : null,
  });
}
