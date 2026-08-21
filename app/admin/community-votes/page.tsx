import { randomUUID } from "node:crypto";
import Link from "next/link";
import { requireTeamCapabilityPage } from "@/lib/auth/pageAccess";
import { getCommunityPollManagement } from "@/lib/communityPolls/data.server";
import {
  COMMUNITY_POLL_DURATIONS,
  type CommunityPoll,
} from "@/lib/communityPolls/types";
import { COMMUNITY_POLL_LIMITS } from "@/lib/communityPolls/validation";
import {
  abortCommunityPollAction,
  activateCommunityPollAction,
  closeCommunityPollAction,
  createCommunityPollAction,
  replaceCommunityPollAction,
} from "./actions";
import CommunityPollActionButton from "./CommunityPollActionButton";

export const dynamic = "force-dynamic";

const inputClassName =
  "min-h-11 w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-white outline-none transition focus:border-orange-400 focus-visible:ring-2 focus-visible:ring-orange-300";
const primaryButtonClassName =
  "min-h-11 rounded-lg bg-[var(--orange-main)] px-4 py-2 font-bold text-black transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-200";
const secondaryButtonClassName =
  "min-h-11 rounded-lg border border-white/15 bg-white/[0.06] px-4 py-2 font-semibold text-white transition hover:border-orange-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-300";

function DurationSelect({ defaultValue = 24 }: { defaultValue?: number }) {
  return (
    <select
      name="duration_hours"
      defaultValue={defaultValue}
      className={inputClassName}
      required
    >
      {COMMUNITY_POLL_DURATIONS.map((hours) => (
        <option key={hours} value={hours}>
          {hours === 168 ? "7 days" : `${hours} hours`}
        </option>
      ))}
    </select>
  );
}

function DraftFields({ poll }: { poll?: CommunityPoll }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="space-y-1 text-sm sm:col-span-2">
        <span className="font-semibold">Question</span>
        <input
          name="question"
          className={inputClassName}
          defaultValue={poll?.question ?? ""}
          minLength={COMMUNITY_POLL_LIMITS.questionMin}
          maxLength={COMMUNITY_POLL_LIMITS.questionMax}
          required
        />
      </label>
      <label className="space-y-1 text-sm sm:col-span-2">
        <span className="font-semibold">Public context</span>
        <textarea
          name="context"
          className={`${inputClassName} min-h-28 resize-y`}
          defaultValue={poll?.context ?? ""}
          maxLength={COMMUNITY_POLL_LIMITS.contextMax}
        />
      </label>
      <label className="space-y-1 text-sm sm:col-span-2">
        <span className="font-semibold">Options — one per line</span>
        <textarea
          name="options"
          className={`${inputClassName} min-h-36 resize-y`}
          defaultValue={poll?.options.map((option) => option.label).join("\n") ?? ""}
          required
        />
        <span className="block text-xs text-white/50">2–8 unique options, maximum 160 characters each.</span>
      </label>
      <label className="space-y-1 text-sm">
        <span className="font-semibold">Duration</span>
        <DurationSelect defaultValue={poll?.durationHours ?? 24} />
      </label>
    </div>
  );
}

function HiddenTransitionFields({ poll }: { poll: CommunityPoll }) {
  return (
    <>
      <input type="hidden" name="poll_public_id" value={poll.publicId} />
      <input type="hidden" name="expected_version" value={poll.rowVersion} />
      <input type="hidden" name="request_id" value={randomUUID()} />
    </>
  );
}

function formatDate(value?: string) {
  return value
    ? new Intl.DateTimeFormat("en", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value))
    : "—";
}

export default async function CommunityVotesAdminPage() {
  const authorization = await requireTeamCapabilityPage(
    "community.polls.manage",
    "/admin/community-votes"
  );
  const management = await getCommunityPollManagement(
    authorization.discord_user_id
  );
  const serverNow = new Date(management.serverNow).getTime();

  return (
    <div className="mx-auto max-w-6xl space-y-10">
      <header className="space-y-3">
        <p className="text-xs uppercase tracking-[0.2em] text-white/50">Community</p>
        <h1 className="font-permanent-marker text-4xl text-[var(--orange-main)]">
          Community Votes
        </h1>
        <p className="max-w-3xl text-sm leading-6 text-white/65">
          Create generic polls without publishing a Homepage Info Box. Activated content and deadlines are immutable; corrections use Abort or Replace. Closing after the database deadline records the result and creates a 24-hour runoff automatically for a tied lead.
        </p>
        <Link className="inline-flex text-sm font-semibold text-orange-300 hover:underline" href="/community-votes">
          Open public Community Votes
        </Link>
      </header>

      <section className="rounded-2xl border border-orange-500/25 bg-white/[0.04] p-5 sm:p-7">
        <h2 className="font-permanent-marker text-2xl text-white">Create draft</h2>
        <form action={createCommunityPollAction} className="mt-5 space-y-5">
          <input type="hidden" name="request_id" value={randomUUID()} />
          <DraftFields />
          <CommunityPollActionButton
            className={primaryButtonClassName}
            pendingLabel="Creating draft…"
          >
            Create private draft
          </CommunityPollActionButton>
        </form>
      </section>

      <section className="space-y-4" aria-labelledby="managed-polls">
        <h2 id="managed-polls" className="font-permanent-marker text-2xl text-white">Polls</h2>
        {management.polls.length === 0 ? (
          <p className="rounded-xl border border-dashed border-white/20 p-5 text-white/55">No polls exist yet.</p>
        ) : null}
        {management.polls.map((poll) => {
          const deadlineReached = poll.deadlineAt
            ? new Date(poll.deadlineAt).getTime() <= serverNow
            : false;
          return (
            <details key={poll.publicId} className="rounded-2xl border border-white/10 bg-white/[0.035] p-5">
              <summary className="cursor-pointer rounded font-semibold text-orange-200 outline-none focus-visible:ring-2 focus-visible:ring-orange-300">
                {poll.question} — {poll.status} — version {poll.rowVersion}
              </summary>
              <div className="mt-5 space-y-5">
                <dl className="grid gap-3 text-sm text-white/65 sm:grid-cols-2 lg:grid-cols-4">
                  <div><dt className="font-semibold text-white">Created</dt><dd>{formatDate(poll.createdAt)}</dd></div>
                  <div><dt className="font-semibold text-white">Activated</dt><dd>{formatDate(poll.activatedAt)}</dd></div>
                  <div><dt className="font-semibold text-white">Deadline</dt><dd>{formatDate(poll.deadlineAt)}</dd></div>
                  <div><dt className="font-semibold text-white">Outcome</dt><dd>{poll.outcome ?? "—"}</dd></div>
                </dl>
                <ol className="list-decimal space-y-1 pl-5 text-sm text-white/70">
                  {poll.options.map((option) => <li key={option.publicId}>{option.label}</li>)}
                </ol>
                <div className="flex flex-wrap gap-3">
                  {poll.status === "draft" ? (
                    <form action={activateCommunityPollAction}>
                      <HiddenTransitionFields poll={poll} />
                      <CommunityPollActionButton
                        className={primaryButtonClassName}
                        pendingLabel="Activating…"
                        confirmation="Activate this poll now? Its question, options, duration, and database deadline become immutable."
                      >
                        Activate poll
                      </CommunityPollActionButton>
                    </form>
                  ) : null}
                  {poll.status === "active" ? (
                    <form action={closeCommunityPollAction}>
                      <HiddenTransitionFields poll={poll} />
                      <CommunityPollActionButton
                        disabled={!deadlineReached}
                        className={`${primaryButtonClassName} disabled:cursor-not-allowed disabled:opacity-40`}
                        pendingLabel="Closing…"
                        confirmation="Close this poll and record its database-authoritative outcome now?"
                      >
                        {deadlineReached ? "Close and determine result" : "Close available after deadline"}
                      </CommunityPollActionButton>
                    </form>
                  ) : null}
                  {poll.status === "active" ? (
                    <Link className={secondaryButtonClassName} href={`/community-votes/${poll.publicId}`}>Open public state</Link>
                  ) : poll.status !== "draft" ? (
                    <Link className={secondaryButtonClassName} href={`/community-votes/${poll.publicId}`}>Open history</Link>
                  ) : null}
                </div>
                {poll.status === "draft" || poll.status === "active" ? (
                  <div className="grid gap-5 border-t border-white/10 pt-5 lg:grid-cols-2">
                    <form action={abortCommunityPollAction} className="space-y-3 rounded-xl border border-red-400/20 p-4">
                      <HiddenTransitionFields poll={poll} />
                      <h3 className="font-semibold text-red-100">Abort without replacement</h3>
                      <textarea name="reason" required minLength={COMMUNITY_POLL_LIMITS.reasonMin} maxLength={COMMUNITY_POLL_LIMITS.reasonMax} className={`${inputClassName} min-h-24`} placeholder="Bounded internal reason" />
                      <CommunityPollActionButton
                        className={secondaryButtonClassName}
                        pendingLabel="Aborting…"
                        confirmation="Abort this poll? Its existing record and administration history will remain append-only."
                      >
                        Abort poll
                      </CommunityPollActionButton>
                    </form>
                    <form action={replaceCommunityPollAction} className="space-y-4 rounded-xl border border-orange-400/20 p-4">
                      <HiddenTransitionFields poll={poll} />
                      <h3 className="font-semibold text-orange-100">Replace with a new draft</h3>
                      <DraftFields poll={poll} />
                      <textarea name="reason" required minLength={COMMUNITY_POLL_LIMITS.reasonMin} maxLength={COMMUNITY_POLL_LIMITS.reasonMax} className={`${inputClassName} min-h-24`} placeholder="Why a replacement is required" />
                      <CommunityPollActionButton
                        className={secondaryButtonClassName}
                        pendingLabel="Replacing…"
                        confirmation="Replace this poll with the reviewed draft below? The original record will remain in history."
                      >
                        Replace poll
                      </CommunityPollActionButton>
                    </form>
                  </div>
                ) : null}
              </div>
            </details>
          );
        })}
      </section>

      <section className="space-y-4 border-t border-white/10 pt-8" aria-labelledby="poll-audit">
        <div>
          <h2 id="poll-audit" className="font-permanent-marker text-2xl text-white">Append-only administration history</h2>
          <p className="mt-1 text-sm text-white/50">Management events only. No participant or voter-to-option data exists here.</p>
        </div>
        <ol className="space-y-3">
          {management.events.map((event) => (
            <li key={event.eventId} className="rounded-xl border border-white/10 bg-black/25 p-4 text-sm">
              <div className="flex flex-wrap justify-between gap-2">
                <span className="font-semibold text-orange-200">{event.eventType.replaceAll("_", " ")}</span>
                <time className="text-white/50">{formatDate(event.occurredAt)}</time>
              </div>
              <p className="mt-2 break-all text-white/60">Poll {event.pollPublicId} · version {event.pollVersion} · {event.actorRole} {event.actorDiscordUserId}</p>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
