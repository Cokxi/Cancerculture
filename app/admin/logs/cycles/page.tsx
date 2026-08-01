import Link from "next/link";
import { redirect } from "next/navigation";
import UserProfileLink from "../shared/UserProfileLink";
import { getTeamPageAccessRedirect } from "@/lib/auth/pageAccessDecision";
import {
  CYCLE_LOG_PAGE_SIZE,
  loadCycleLogsReadModel,
  type CycleLogEntry,
} from "@/lib/admin/cycleLogsReadModel";

export const dynamic = "force-dynamic";

function pageHref(page: number) {
  return page > 1 ? `/admin/logs/cycles?page=${page}` : "/admin/logs/cycles";
}

function Actor({ entry, isAdmin }: { entry: CycleLogEntry; isAdmin: boolean }) {
  const label = entry.actorLabel ?? entry.actorDiscordUserId;

  if (isAdmin) {
    return (
      <UserProfileLink
        discordUserId={entry.actorDiscordUserId}
        label={label}
        publicProfileId={entry.actorPublicProfileId}
      />
    );
  }

  return (
    <span className="min-w-0">
      {entry.actorLabel ? (
        <span className="block break-words font-medium">{entry.actorLabel}</span>
      ) : null}
      <span
        className={`block break-all ${entry.actorLabel ? "mt-0.5 text-xs text-white/45" : ""}`}
      >
        {entry.actorDiscordUserId}
      </span>
    </span>
  );
}

function CycleLogCard({ entry, isAdmin }: { entry: CycleLogEntry; isAdmin: boolean }) {
  return (
    <article className="rounded-xl border border-white/10 bg-white/[0.025] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">{entry.eventLabel}</h2>
          <p className="mt-1 text-xs text-white/45">
            {new Date(entry.occurredAt).toLocaleString()}
          </p>
        </div>
        <span className="rounded border border-white/15 px-2 py-0.5 text-xs text-white/65">
          Cycle {entry.cycleId ?? "unknown"}
        </span>
      </div>

      <dl className="mt-4 grid gap-x-5 gap-y-2 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
        <dt className="text-white/40">Theme</dt>
        <dd className="break-words">{entry.cycleTheme ?? "Theme unavailable"}</dd>
        <dt className="text-white/40">Actor</dt>
        <dd className="min-w-0">
          <Actor entry={entry} isAdmin={isAdmin} />
        </dd>
      </dl>

      {isAdmin && entry.adminAudit ? (
        <details className="mt-4 border-t border-white/10 pt-4">
          <summary className="cursor-pointer rounded-sm text-xs font-semibold text-white/55 outline-none focus-visible:ring-2 focus-visible:ring-orange-300">
            Owner-only raw audit context
          </summary>
          <dl className="mt-3 grid gap-x-4 gap-y-2 text-xs sm:grid-cols-[auto_minmax(0,1fr)]">
            <dt className="text-white/40">Actor type</dt>
            <dd className="break-words text-white/70">
              {entry.adminAudit.actorType ?? "Unavailable"}
            </dd>
            <dt className="text-white/40">Target type</dt>
            <dd className="break-words text-white/70">
              {entry.adminAudit.targetType ?? "Unavailable"}
            </dd>
            <dt className="text-white/40">Raw action</dt>
            <dd className="break-words text-white/70">
              {entry.adminAudit.rawAction}
            </dd>
          </dl>
          <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-white/10 bg-black/30 p-3 text-xs text-white/65">
            {JSON.stringify(entry.adminAudit.metadata, null, 2)}
          </pre>
        </details>
      ) : null}
    </article>
  );
}

export default async function AdminCycleLogsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const params = await searchParams;
  const parsedPage = Number.parseInt(params.page ?? "1", 10);
  const page =
    Number.isSafeInteger(parsedPage) &&
    parsedPage >= 1 &&
    parsedPage <= Math.floor(Number.MAX_SAFE_INTEGER / CYCLE_LOG_PAGE_SIZE)
      ? parsedPage
      : 1;
  let readModel;

  try {
    readModel = await loadCycleLogsReadModel({ page });
  } catch (error) {
    const destination = getTeamPageAccessRedirect(error);
    if (destination) redirect(destination);
    throw error;
  }

  const hasNextPage = readModel.page * readModel.pageSize < readModel.total;

  return (
    <div className="mx-auto max-w-5xl pb-12">
      <header className="mb-7">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-orange-300/75">
          {readModel.isAdmin
            ? "Owner audit · Read-only"
            : "Delegated audit · Read-only"}
        </p>
        <h1 className="mt-2 text-2xl font-semibold sm:text-3xl">Cycle Logs</h1>
        <p className="mt-2 max-w-3xl text-sm text-white/60">
          Server-paginated cycle start, finalization, and reset events. This
          surface cannot change cycle state.
        </p>
      </header>

      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">Recorded events</h2>
        <p className="text-xs text-white/45">
          {readModel.total} event{readModel.total === 1 ? "" : "s"}
        </p>
      </div>

      {readModel.entries.length === 0 ? (
        <p className="rounded-xl border border-white/10 p-5 text-sm text-white/50">
          No cycle events have been recorded.
        </p>
      ) : (
        <div className="grid gap-3">
          {readModel.entries.map((entry) => (
            <CycleLogCard
              key={entry.id}
              entry={entry}
              isAdmin={readModel.isAdmin}
            />
          ))}
        </div>
      )}

      <nav aria-label="Cycle Log pages" className="mt-5 flex items-center gap-4 text-sm">
        {readModel.page > 1 ? (
          <Link
            href={pageHref(readModel.page - 1)}
            className="text-orange-200 hover:text-orange-100"
          >
            Previous
          </Link>
        ) : null}
        <span className="text-white/40">Page {readModel.page}</span>
        {hasNextPage ? (
          <Link
            href={pageHref(readModel.page + 1)}
            className="text-orange-200 hover:text-orange-100"
          >
            Next
          </Link>
        ) : null}
      </nav>
    </div>
  );
}
