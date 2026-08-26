"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type {
  OwnCommentItem,
  OwnMentionItem,
  OwnMentionPage,
} from "@/lib/comments/commentOwner.server";

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function statusCopy(status: OwnCommentItem["status"]) {
  if (status === "author_deleted") return "Comment deleted by its author";
  if (status === "team_removed") return "Deleted by admin/mod";
  if (status === "unavailable") return "Comment destination no longer available";
  return null;
}

function CommentCard({ item, mentioned }: {
  item: OwnCommentItem;
  mentioned?: boolean;
}) {
  const unavailableCopy = statusCopy(item.status);
  return (
    <article className="min-w-0 rounded-xl border border-white/10 bg-black/35 p-4">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 text-xs text-white/55">
        <span>{item.submissionContext} · {item.isReply ? "Reply" : "Comment"}</span>
        <time dateTime={item.createdAt}>{formatDate(item.createdAt)}</time>
      </div>
      {mentioned ? (
        <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-[var(--orange-main)]">
          You were mentioned
        </p>
      ) : (
        <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-[var(--orange-main)]">
          Your contribution
        </p>
      )}
      {item.body ? (
        <p className="mt-2 min-w-0 whitespace-pre-wrap break-words text-sm leading-relaxed text-white/90">
          {item.body}
          {item.edited ? <span className="ml-2 text-xs text-white/45">(edited)</span> : null}
        </p>
      ) : (
        <p className="mt-2 rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/65" role="status">
          {unavailableCopy}
        </p>
      )}
      {item.destinationHref ? (
        <Link
          href={item.destinationHref}
          className="mt-3 inline-flex min-h-11 items-center rounded-full border border-[var(--orange-main)]/45 px-4 py-2 text-sm font-semibold text-[var(--orange-main)] transition hover:bg-[var(--orange-main)]/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400"
          aria-label={`Open this ${item.isReply ? "reply" : "comment"} in its conversation`}
        >
          Open conversation
        </Link>
      ) : null}
    </article>
  );
}

export function OwnCommentsList({ items }: { items: readonly OwnCommentItem[] }) {
  if (items.length === 0) {
    return <p className="rounded-xl border border-white/10 bg-black/35 p-5 text-sm text-white/65">You have not posted any comments yet.</p>;
  }
  return <div className="space-y-3">{items.map((item) => <CommentCard key={item.publicCommentId} item={item} />)}</div>;
}

function MentionCard({
  item,
  busy,
  onViewed,
  onDismiss,
}: {
  item: OwnMentionItem;
  busy: boolean;
  onViewed: () => void;
  onDismiss: () => void;
}) {
  const commentItem = useMemo<OwnCommentItem>(() => ({
    publicCommentId: item.mentionId,
    createdAt: item.commentCreatedAt,
    edited: false,
    isReply: item.isReply,
    status: item.status,
    body: item.body,
    submissionContext: item.submissionContext,
    destinationHref: item.destinationHref,
  }), [item]);

  return (
    <div className={`rounded-xl ${item.viewedAt ? "opacity-80" : "ring-1 ring-[var(--orange-main)]/45"}`}>
      <CommentCard item={commentItem} mentioned />
      <div className="-mt-1 flex flex-wrap gap-2 rounded-b-xl border border-t-0 border-white/10 bg-black/35 px-4 pb-4">
        {!item.viewedAt ? (
          <button
            type="button"
            disabled={busy}
            onClick={onViewed}
            className="min-h-11 cursor-pointer rounded-full border border-white/20 px-4 py-2 text-sm text-white transition hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Mark this mention as viewed"
          >
            Mark viewed
          </button>
        ) : <span className="inline-flex min-h-11 items-center text-xs text-white/55">Viewed</span>}
        <button
          type="button"
          disabled={busy}
          onClick={onDismiss}
          className="min-h-11 cursor-pointer rounded-full border border-white/20 px-4 py-2 text-sm text-white transition hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 disabled:cursor-not-allowed disabled:opacity-50"
          aria-label="Hide this mention from My Mentions"
        >
          Hide
        </button>
      </div>
    </div>
  );
}

export function OwnMentionsList({
  page,
  preview = false,
}: {
  page: OwnMentionPage;
  preview?: boolean;
}) {
  const [items, setItems] = useState<readonly OwnMentionItem[]>(page.items);
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [message, setMessage] = useState<string | null>(null);

  const mutate = async (key: string, request: () => Promise<Response>, apply: () => void) => {
    if (busyKeys.has(key)) return;
    setBusyKeys((current) => new Set(current).add(key));
    setMessage(null);
    try {
      const response = await request();
      const result = await response.json() as Record<string, unknown>;
      if (!response.ok || (result.outcome !== "viewed" && result.outcome !== "dismissed")) {
        throw new Error(result.outcome === "stale_state"
          ? "This mention changed. Reload the page and try again."
          : "The mention could not be updated.");
      }
      apply();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The mention could not be updated.");
    } finally {
      setBusyKeys((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };

  const markViewed = (item: OwnMentionItem) => {
    const requestId = crypto.randomUUID();
    void mutate(`view:${item.mentionId}`, () => fetch(`/api/my-profile/mentions/${item.mentionId}/view`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: item.stateVersion, requestId }),
    }), () => setItems((current) => current.map((candidate) => candidate.mentionId === item.mentionId
      ? { ...candidate, viewedAt: new Date().toISOString(), stateVersion: candidate.stateVersion + 1 }
      : candidate)));
  };

  const dismiss = (item: OwnMentionItem) => {
    const requestId = crypto.randomUUID();
    void mutate(`dismiss:${item.mentionId}`, () => fetch(`/api/my-profile/mentions/${item.mentionId}/dismiss`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: item.stateVersion, requestId }),
    }), () => setItems((current) => current.filter((candidate) => candidate.mentionId !== item.mentionId)));
  };

  const markAllViewed = () => {
    const requestId = crypto.randomUUID();
    void mutate("mark-all", () => fetch("/api/my-profile/mentions/view-all", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ snapshotAt: page.snapshotAt, requestId }),
    }), () => setItems((current) => current.map((item) => item.viewedAt
      ? item
      : { ...item, viewedAt: new Date().toISOString(), stateVersion: item.stateVersion + 1 })));
  };

  if (items.length === 0) {
    return <p className="rounded-xl border border-white/10 bg-black/35 p-5 text-sm text-white/65">No active mentions yet.</p>;
  }

  return (
    <div>
      {!preview && items.some((item) => !item.viewedAt) ? (
        <button
          type="button"
          disabled={busyKeys.has("mark-all")}
          onClick={markAllViewed}
          className="mb-4 min-h-11 cursor-pointer rounded-full bg-[var(--orange-main)] px-4 py-2 text-sm font-semibold text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-300 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Mark all shown by this snapshot as viewed
        </button>
      ) : null}
      <div className="space-y-3">
        {items.map((item) => (
          <MentionCard
            key={item.mentionId}
            item={item}
            busy={busyKeys.has(`view:${item.mentionId}`) || busyKeys.has(`dismiss:${item.mentionId}`)}
            onViewed={() => markViewed(item)}
            onDismiss={() => dismiss(item)}
          />
        ))}
      </div>
      {message ? <p className="mt-4 text-sm text-amber-200" role="status">{message}</p> : null}
    </div>
  );
}
