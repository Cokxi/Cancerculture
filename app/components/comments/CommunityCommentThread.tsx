"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import CommunityCommentComposer from "@/app/components/comments/CommunityCommentComposer";
import CommunityCommentReportDialog from "@/app/components/comments/CommunityCommentReportDialog";
import {
  CommunityCommentClientError,
  fetchCommunityCommentAccount,
  fetchCommunityCommentCounts,
  fetchCommunityCommentsBatch,
  fetchCommunityCommentDeepLink,
  fetchCommunityCommentReplyPage,
  fetchCommunityCommentRootPage,
  fetchCommunityCommentVoteViewerState,
  getCommunityCommentLoginHref,
  mergeCommunityComments,
  sendCommunityCommentMutation,
  sendCommunityCommentVote,
  type CommunityCommentAccountState,
  type CommunityCommentMutationReceipt,
  type CommunityCommentReleaseState,
  type CommunityCommentReplyPage,
  type CommunityCommentRootItem,
  type CommunityCommentRootPage,
  type CommunityCommentSort,
  type CommunityCommentVoteState,
} from "@/lib/comments/commentClient";
import type { CommunityCommentPublicDto } from "@/lib/comments/commentDto";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const INTERNAL_LINK_PATTERN =
  /(?:https:\/\/cancerculture\.fun)?\/(?:spread\/\d+|cycle-history|wall\/(?:fame|shame)|profile\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:[?#][^\s<>()]*)?/gu;
const COMMENT_VOTE_LAYOUT_STORAGE_KEY = "cancerculture.comment-vote-layout.v1";
const COMMENT_RECONCILIATION_INTERVAL_MS = 10_000;
const COMMENT_PAGE_SIZE = 20;

type CommentVoteLayout = "thumbs" | "expressive";

let releaseProbe: Promise<CommunityCommentReleaseState | null> | null = null;
let releaseProbeStartedAt = 0;
let accountProbe: Promise<CommunityCommentAccountState> | null = null;
type CommentCountListener = (totalCount: number | null) => void;
const commentCountCache = new Map<number, number>();
const commentCountListeners = new Map<number, Set<CommentCountListener>>();
const pendingCommentCountIds = new Set<number>();
let commentCountFlushTimer: number | null = null;
let commentCountFlushBusy = false;

function publishCommunityCommentCount(submissionId: number, totalCount: number) {
  commentCountCache.set(submissionId, totalCount);
  for (const listener of commentCountListeners.get(submissionId) ?? []) {
    listener(totalCount);
  }
}

function clearCommunityCommentCount(submissionId: number) {
  commentCountCache.delete(submissionId);
  for (const listener of commentCountListeners.get(submissionId) ?? []) {
    listener(null);
  }
}

function scheduleCommunityCommentCountFlush() {
  if (commentCountFlushTimer !== null || commentCountFlushBusy) return;
  commentCountFlushTimer = window.setTimeout(() => {
    commentCountFlushTimer = null;
    void flushCommunityCommentCounts();
  }, 0);
}

function queueCommunityCommentCountRefresh(submissionId: number) {
  pendingCommentCountIds.add(submissionId);
  scheduleCommunityCommentCountFlush();
}

async function flushCommunityCommentCounts() {
  if (commentCountFlushBusy) return;
  const submissionIds = [...pendingCommentCountIds].slice(0, 100);
  if (submissionIds.length === 0) return;
  for (const submissionId of submissionIds) pendingCommentCountIds.delete(submissionId);
  commentCountFlushBusy = true;
  try {
    const items = await fetchCommunityCommentCounts(submissionIds);
    const counts = new Map(items.map((item) => [item.submissionId, item.totalCount]));
    for (const submissionId of submissionIds) {
      const totalCount = counts.get(submissionId);
      if (totalCount === undefined) clearCommunityCommentCount(submissionId);
      else publishCommunityCommentCount(submissionId, totalCount);
    }
  } catch {
    // Keep the last server-confirmed count; opening the thread retries through its Root page.
  } finally {
    commentCountFlushBusy = false;
    if (pendingCommentCountIds.size > 0) scheduleCommunityCommentCountFlush();
  }
}

function subscribeCommunityCommentCount(
  submissionId: number,
  listener: CommentCountListener,
) {
  const listeners = commentCountListeners.get(submissionId) ?? new Set<CommentCountListener>();
  listeners.add(listener);
  commentCountListeners.set(submissionId, listeners);
  if (commentCountCache.has(submissionId)) {
    listener(commentCountCache.get(submissionId)!);
  }
  queueCommunityCommentCountRefresh(submissionId);
  return () => {
    const current = commentCountListeners.get(submissionId);
    current?.delete(listener);
    if (current?.size === 0) commentCountListeners.delete(submissionId);
  };
}

async function probeReleaseState(submissionId: number) {
  if (!releaseProbe || Date.now() - releaseProbeStartedAt >= COMMENT_RECONCILIATION_INTERVAL_MS) {
    releaseProbeStartedAt = Date.now();
    releaseProbe = fetchCommunityCommentRootPage({ submissionId, sort: "top" })
      .then((page) => {
        publishCommunityCommentCount(page.submissionId, page.totalCount);
        return page.releaseState;
      })
      .catch((error) => {
        if (
          error instanceof CommunityCommentClientError &&
          error.status === 404 &&
          error.code === "COMMENTS_UNAVAILABLE"
        ) return null;
        releaseProbe = null;
        releaseProbeStartedAt = 0;
        throw error;
      });
  }
  return releaseProbe;
}

function loadAccountOnce() {
  accountProbe ??= fetchCommunityCommentAccount();
  return accountProbe;
}

function textParts(value: string, keyPrefix: string) {
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const match of value.matchAll(INTERNAL_LINK_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push(value.slice(cursor, index));
    const raw = match[0];
    const href = raw.startsWith("https://cancerculture.fun")
      ? raw.slice("https://cancerculture.fun".length)
      : raw;
    parts.push(
      <Link
        key={`${keyPrefix}:${index}`}
        href={href}
        className="text-orange-200 underline decoration-orange-400/60 underline-offset-2 hover:text-orange-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400"
      >
        {raw}
      </Link>,
    );
    cursor = index + raw.length;
  }
  if (cursor < value.length) parts.push(value.slice(cursor));
  return parts;
}

function CommentBody({ comment }: { comment: CommunityCommentPublicDto }) {
  if (comment.tombstone === "author_deleted") {
    return <p className="mt-2 italic text-white/55">Comment deleted by its author</p>;
  }
  if (comment.tombstone === "team_removed") {
    return <p className="mt-2 italic text-white/65">Comment removed by the team</p>;
  }
  const characters = Array.from(comment.body ?? "");
  const content: React.ReactNode[] = [];
  let cursor = 0;
  for (const mention of [...comment.mentions].sort((a, b) => a.startIndex - b.startIndex)) {
    if (mention.startIndex < cursor || mention.endIndex > characters.length) continue;
    const before = characters.slice(cursor, mention.startIndex).join("");
    content.push(...textParts(before, `${comment.publicCommentId}:text:${cursor}`));
    content.push(
      <Link
        key={`${comment.publicCommentId}:mention:${mention.startIndex}`}
        href={`/profile/${encodeURIComponent(mention.targetPublicProfileId)}`}
        className="font-semibold text-orange-200 hover:text-orange-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400"
      >
        @{mention.displayName}
      </Link>,
    );
    cursor = mention.endIndex;
  }
  content.push(
    ...textParts(
      characters.slice(cursor).join(""),
      `${comment.publicCommentId}:text:${cursor}`,
    ),
  );
  return <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-white/90">{content}</p>;
}

function CommentVoteThumb({ direction }: { direction: "up" | "down" }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[18px] w-[18px] shrink-0"
    >
      {direction === "up" ? (
        <>
          <path d="M7 10v12" />
          <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z" />
        </>
      ) : (
        <>
          <path d="M17 14V2" />
          <path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z" />
        </>
      )}
    </svg>
  );
}

function CommentVoteSymbol({
  direction,
  layout,
}: {
  direction: "up" | "down";
  layout: CommentVoteLayout;
}) {
  if (layout === "thumbs") return <CommentVoteThumb direction={direction} />;
  return (
    <span
      aria-hidden="true"
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center text-[18px] leading-none"
    >
      {direction === "up" ? "✌️" : "🖕"}
    </span>
  );
}

function CommentVoteLayoutMenu({
  layout,
  onChange,
}: {
  layout: CommentVoteLayout;
  onChange: (layout: CommentVoteLayout) => void;
}) {
  const menuRef = useRef<HTMLDetailsElement>(null);
  const selectLayout = (nextLayout: CommentVoteLayout) => {
    onChange(nextLayout);
    menuRef.current?.removeAttribute("open");
  };

  return (
    <details ref={menuRef} className="relative">
      <summary
        aria-label="Choose vote icons"
        className="inline-flex min-h-8 w-7 list-none cursor-pointer items-center justify-center rounded text-white/50 hover:bg-white/5 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 [&::-webkit-details-marker]:hidden"
      >
        <span aria-hidden="true" className="text-lg leading-none">⋯</span>
      </summary>
      <div className="absolute bottom-full left-0 z-20 mb-2 w-48 rounded-xl border border-white/15 bg-neutral-900 p-2 shadow-2xl shadow-black/60">
        <p className="px-2 pb-1 pt-0.5 text-[11px] font-semibold uppercase tracking-wider text-white/45">Vote icons</p>
        <button
          type="button"
          aria-pressed={layout === "thumbs"}
          onClick={() => selectLayout("thumbs")}
          className={`flex min-h-10 w-full items-center gap-2 rounded-lg px-2 text-left font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 ${layout === "thumbs" ? "bg-orange-500/15 text-orange-100" : "text-white/70 hover:bg-white/5 hover:text-white"}`}
        >
          <span aria-hidden="true" className="inline-flex w-12 items-center gap-1 text-base">👍 👎</span>
          <span>Thumbs</span>
        </button>
        <button
          type="button"
          aria-pressed={layout === "expressive"}
          onClick={() => selectLayout("expressive")}
          className={`mt-1 flex min-h-10 w-full items-center gap-2 rounded-lg px-2 text-left font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 ${layout === "expressive" ? "bg-orange-500/15 text-orange-100" : "text-white/70 hover:bg-white/5 hover:text-white"}`}
        >
          <span aria-hidden="true" className="inline-flex w-12 items-center gap-1 text-base">✌️ 🖕</span>
          <span>Expressive</span>
        </button>
      </div>
    </details>
  );
}

function formatCommentTime(value: string) {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function login() {
  window.location.assign(getCommunityCommentLoginHref());
}

type ReplyBranch = {
  items: CommunityCommentPublicDto[];
  rootVersion: number;
  branchOpen: boolean;
  expanded: boolean;
  hasMore: boolean;
  nextCursor: string | null;
  initialized: boolean;
  loading: boolean;
  error: string | null;
};

type VoteViewerProjection = {
  state: CommunityCommentVoteState;
  version: number;
  loading: boolean;
  error: string | null;
};

function initialBranch(root: CommunityCommentRootItem): ReplyBranch {
  return {
    items: root.replyPreview,
    rootVersion: root.version,
    branchOpen: root.tombstone === null,
    expanded: false,
    hasMore: root.replyPreviewHasMore,
    nextCursor: null,
    initialized: !root.replyPreviewHasMore,
    loading: false,
    error: null,
  };
}

type ScrollAnchor = {
  id: string | null;
  scrollContainer: HTMLElement | null;
  scrollTop: number;
  top: number;
};

function findVerticalScrollContainer(container: HTMLElement | null) {
  let scrollContainer: HTMLElement | null = container?.parentElement ?? null;
  while (scrollContainer) {
    const style = window.getComputedStyle(scrollContainer);
    if (
      scrollContainer.scrollHeight > scrollContainer.clientHeight &&
      (style.overflowY === "auto" || style.overflowY === "scroll")
    ) return scrollContainer;
    scrollContainer = scrollContainer.parentElement;
  }
  return null;
}

function captureScrollAnchor(container: HTMLElement | null): ScrollAnchor | null {
  if (!container) return null;
  const comments = [...container.querySelectorAll<HTMLElement>('article[id^="comment-"]')];
  const anchor = comments.find((element) => element.getBoundingClientRect().bottom > 0) ?? null;
  const scrollContainer = findVerticalScrollContainer(container);
  return {
    id: anchor?.id ?? null,
    scrollContainer,
    scrollTop: scrollContainer?.scrollTop ?? window.scrollY,
    top: anchor?.getBoundingClientRect().top ?? 0,
  };
}

function restoreScrollAnchor(anchor: ScrollAnchor | null) {
  if (!anchor) return;
  window.requestAnimationFrame(() => {
    const element = anchor.id ? document.getElementById(anchor.id) : null;
    if (element) {
      const delta = element.getBoundingClientRect().top - anchor.top;
      if (anchor.scrollContainer) {
        anchor.scrollContainer.scrollBy({ top: delta });
      } else {
        window.scrollBy({ top: delta });
      }
      return;
    }
    if (anchor.scrollContainer) {
      anchor.scrollContainer.scrollTo({ top: anchor.scrollTop });
    } else {
      window.scrollTo({ top: anchor.scrollTop });
    }
  });
}

async function fetchRootWindow(input: {
  submissionId: number;
  sort: CommunityCommentSort;
  pageCount: number;
  signal: AbortSignal;
}) {
  const pages: CommunityCommentRootPage[] = [];
  let cursor: string | null = null;
  for (let index = 0; index < input.pageCount; index += 1) {
    const next = await fetchCommunityCommentRootPage({
      submissionId: input.submissionId,
      sort: input.sort,
      cursor,
      signal: input.signal,
    });
    pages.push(next);
    cursor = next.nextCursor;
    if (!cursor) break;
  }
  const first = pages[0];
  const last = pages.at(-1);
  if (!first || !last) throw new CommunityCommentClientError(503, "COMMENTS_UNAVAILABLE");
  return {
    ...last,
    snapshotAt: first.snapshotAt,
    threadVersion: Math.max(...pages.map((item) => item.threadVersion)),
    items: pages.flatMap((item) => item.items),
  } satisfies CommunityCommentRootPage;
}

async function fetchReplyWindow(input: {
  submissionId: number;
  rootPublicCommentId: string;
  pageCount: number;
  signal: AbortSignal;
}) {
  const pages: CommunityCommentReplyPage[] = [];
  let cursor: string | null = null;
  for (let index = 0; index < input.pageCount; index += 1) {
    const next = await fetchCommunityCommentReplyPage({
      submissionId: input.submissionId,
      rootPublicCommentId: input.rootPublicCommentId,
      cursor,
      signal: input.signal,
    });
    pages.push(next);
    cursor = next.nextCursor;
    if (!cursor) break;
  }
  const last = pages.at(-1);
  if (!last) throw new CommunityCommentClientError(503, "COMMENTS_UNAVAILABLE");
  return {
    ...last,
    items: mergeCommunityComments([], pages.flatMap((item) => item.items)),
  } satisfies CommunityCommentReplyPage;
}

function DeleteConfirmation({
  busy,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useEffect(() => confirmRef.current?.focus(), []);
  return (
    <div className="mt-3 rounded-xl border border-red-400/35 bg-red-950/30 p-3" role="alertdialog" aria-modal="true" aria-labelledby={titleId}>
      <p id={titleId} className="font-semibold text-red-100">Permanently delete this comment?</p>
      <p className="mt-1 text-sm text-white/70">Its text cannot be restored. The deletion notice stays in this position.</p>
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <button type="button" onClick={onCancel} disabled={busy} className="min-h-11 rounded-full border border-white/15 px-4 py-2 text-sm text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 disabled:opacity-50">Cancel</button>
        <button ref={confirmRef} type="button" onClick={onConfirm} disabled={busy} className="min-h-11 rounded-full bg-red-500 px-4 py-2 text-sm font-bold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-50">{busy ? "Deleting…" : "Delete permanently"}</button>
      </div>
    </div>
  );
}

function CommentItem({
  account,
  branchOpen,
  comment,
  isReply,
  releaseState,
  replyTargetName,
  repliesExpanded,
  onToggleReplies,
  turnstileSiteKey,
  onDelete,
  onEdit,
  onReply,
  onVote,
  onVoteLayoutChange,
  sendMutation,
  voteLayout,
  voteViewer,
}: {
  account: CommunityCommentAccountState;
  branchOpen: boolean;
  comment: CommunityCommentPublicDto;
  isReply: boolean;
  releaseState: CommunityCommentReleaseState;
  replyTargetName?: string | null;
  repliesExpanded?: boolean;
  onToggleReplies?: () => void;
  turnstileSiteKey: string | null;
  onDelete: (receipt: CommunityCommentMutationReceipt) => void;
  onEdit: (receipt: CommunityCommentMutationReceipt) => void;
  onReply: () => void;
  onVote: (desiredState: CommunityCommentVoteState) => void;
  onVoteLayoutChange: (layout: CommentVoteLayout) => void;
  sendMutation: typeof sendCommunityCommentMutation;
  voteLayout: CommentVoteLayout;
  voteViewer: VoteViewerProjection;
}) {
  const [editing, setEditing] = useState(false);
  const [editBaseVersion, setEditBaseVersion] = useState<number | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteBaseVersion, setDeleteBaseVersion] = useState<number | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const deleteBusyRef = useRef(false);
  const own =
    account.kind === "authenticated" &&
    account.publicProfileId === comment.author.publicProfileId;
  const editWindowOpen = Date.now() < Date.parse(comment.createdAt) + 15 * 60_000;
  const canMutate = releaseState === "open" && comment.tombstone === null;
  const canReply =
    canMutate &&
    branchOpen &&
    (account.kind === "authenticated" || account.kind === "anonymous");
  const canToggleReplies =
    !isReply && comment.replyCount > 0 && onToggleReplies !== undefined;
  const canManage = canMutate && own;
  const canReport = canMutate && !own && account.kind === "authenticated";
  const canVote =
    canMutate &&
    (account.kind === "authenticated" || account.kind === "anonymous");
  const voteCounts = comment.voteCounts;

  async function deleteComment() {
    if (deleteBusyRef.current) return;
    deleteBusyRef.current = true;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      const receipt = await sendMutation({
        url: `/api/comments/${encodeURIComponent(comment.publicCommentId)}`,
        method: "DELETE",
        body: {
          expectedVersion: deleteBaseVersion ?? comment.version,
          requestId: crypto.randomUUID(),
          confirmed: true,
        },
      });
      setConfirmingDelete(false);
      setDeleteBaseVersion(null);
      onDelete(receipt);
    } catch (error) {
      if (error instanceof CommunityCommentClientError && error.status === 401) {
        login();
        return;
      }
      setDeleteError(
        error instanceof CommunityCommentClientError && error.status === 409
          ? "This comment changed elsewhere. The latest version has been loaded; review it before trying again."
          : "The comment could not be deleted. Please try again.",
      );
    } finally {
      deleteBusyRef.current = false;
      setDeleteBusy(false);
    }
  }

  return (
    <article
      id={`comment-${comment.publicCommentId}`}
      tabIndex={-1}
      className={`scroll-mt-24 rounded-2xl border p-3 outline-none sm:p-4 ${isReply ? "border-white/10 bg-white/[0.025]" : "border-white/15 bg-black/35"}`}
    >
      <header className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-white/55">
        <Link href={`/profile/${encodeURIComponent(comment.author.publicProfileId)}`} className="max-w-full truncate font-semibold text-white hover:text-orange-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400">
          {comment.author.displayName}
        </Link>
        {comment.author.isCreator ? <span className="rounded-full border border-orange-400/30 px-2 py-0.5 text-orange-200">Creator</span> : null}
        {comment.author.isBanned ? <span className="rounded-full border border-white/15 px-2 py-0.5 text-white/60">Banned</span> : null}
        <time dateTime={comment.createdAt}>{formatCommentTime(comment.createdAt)}</time>
        {comment.edited ? <span>edited</span> : null}
      </header>
      {replyTargetName ? <p className="mt-2 text-xs text-white/55">Replying to @{replyTargetName}</p> : null}
      {editing ? (
        <div className="mt-3">
          <CommunityCommentComposer
            initialBody={comment.body ?? ""}
            initialMentions={comment.mentions}
            label="Edit comment"
            submitLabel="Save changes"
            turnstileSiteKey={turnstileSiteKey}
            onCancel={() => {
              setEditing(false);
              setEditBaseVersion(null);
            }}
            onSubmit={({ body, mentions, requestId, turnstileToken }) =>
              sendMutation({
                url: `/api/comments/${encodeURIComponent(comment.publicCommentId)}`,
                method: "PATCH",
                body: {
                  body,
                  mentions,
                  requestId,
                  expectedVersion: editBaseVersion ?? comment.version,
                },
                turnstileToken,
              })
            }
            onSuccess={(receipt) => {
              setEditing(false);
              setEditBaseVersion(null);
              onEdit(receipt);
            }}
          />
        </div>
      ) : (
        <CommentBody comment={comment} />
      )}

      {!editing && (voteCounts || canReply || canToggleReplies || canManage || canReport) ? (
        <div className="mt-2 flex min-h-8 flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          {voteCounts ? (
            <div className="flex items-center gap-1" aria-label="Comment votes">
              <CommentVoteLayoutMenu layout={voteLayout} onChange={onVoteLayoutChange} />
              {canVote ? (
                <>
                  <button
                    type="button"
                    aria-label="Upvote comment"
                    aria-pressed={voteViewer.state === "up"}
                    disabled={account.kind === "authenticated" && voteViewer.loading}
                    onClick={account.kind === "anonymous" ? login : () => onVote(voteViewer.state === "up" ? null : "up")}
                    className={`inline-flex min-h-8 cursor-pointer items-center gap-1 rounded px-1.5 py-1 font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 disabled:cursor-wait disabled:opacity-50 ${voteViewer.state === "up" ? "bg-orange-500/20 text-orange-200" : "text-white/60 hover:text-white"}`}
                  >
                    <CommentVoteSymbol direction="up" layout={voteLayout} />
                    <span>{voteCounts.up}</span>
                  </button>
                  <button
                    type="button"
                    aria-label="Downvote comment"
                    aria-pressed={voteViewer.state === "down"}
                    disabled={account.kind === "authenticated" && voteViewer.loading}
                    onClick={account.kind === "anonymous" ? login : () => onVote(voteViewer.state === "down" ? null : "down")}
                    className={`inline-flex min-h-8 cursor-pointer items-center gap-1 rounded px-1.5 py-1 font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 disabled:cursor-wait disabled:opacity-50 ${voteViewer.state === "down" ? "bg-orange-500/20 text-orange-200" : "text-white/60 hover:text-white"}`}
                  >
                    <CommentVoteSymbol direction="down" layout={voteLayout} />
                    <span>{voteCounts.down}</span>
                  </button>
                </>
              ) : (
                <>
                  <span aria-label={`${voteCounts.up} upvotes`} className="inline-flex items-center gap-1 px-1.5 py-1 text-white/55"><CommentVoteSymbol direction="up" layout={voteLayout} /><span>{voteCounts.up}</span></span>
                  <span aria-label={`${voteCounts.down} downvotes`} className="inline-flex items-center gap-1 px-1.5 py-1 text-white/55"><CommentVoteSymbol direction="down" layout={voteLayout} /><span>{voteCounts.down}</span></span>
                </>
              )}
            </div>
          ) : null}
          {canReply ? (
            <button type="button" onClick={account.kind === "anonymous" ? login : onReply} className="min-h-8 cursor-pointer rounded px-1 py-1.5 font-semibold text-white/60 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400">
              {account.kind === "anonymous" ? "Sign in to reply" : "Reply"}
            </button>
          ) : null}
          {canToggleReplies ? (
            <button
              type="button"
              aria-expanded={repliesExpanded}
              onClick={onToggleReplies}
              className="min-h-8 cursor-pointer rounded px-1 py-1.5 font-semibold text-orange-300 hover:text-orange-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400"
            >
              <span aria-hidden="true" className="mr-1">{repliesExpanded ? "▴" : "▾"}</span>
              {repliesExpanded
                ? "Hide replies"
                : `View ${comment.replyCount} ${comment.replyCount === 1 ? "reply" : "replies"}`}
            </button>
          ) : null}
          {canManage ? (
            <div className="ml-auto flex items-center gap-3 pl-3">
              {editWindowOpen ? (
                <button type="button" onClick={() => { setEditBaseVersion(comment.version); setEditing(true); }} className="min-h-8 cursor-pointer rounded px-1 py-1.5 font-semibold text-white/55 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400">Edit</button>
              ) : null}
              <button type="button" onClick={() => { setDeleteBaseVersion(comment.version); setConfirmingDelete(true); }} className="min-h-8 cursor-pointer rounded px-1 py-1.5 font-semibold text-red-300/80 hover:text-red-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300">Delete</button>
            </div>
          ) : null}
          {canReport ? (
            <button type="button" onClick={() => setReportOpen(true)} className="ml-auto min-h-8 cursor-pointer rounded px-1 py-1.5 font-semibold text-white/55 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400">
              Report
            </button>
          ) : null}
        </div>
      ) : null}
      {reportOpen ? <CommunityCommentReportDialog publicCommentId={comment.publicCommentId} siteKey={turnstileSiteKey} onClose={() => setReportOpen(false)} /> : null}
      {confirmingDelete ? <DeleteConfirmation busy={deleteBusy} onCancel={() => { setConfirmingDelete(false); setDeleteBaseVersion(null); }} onConfirm={() => void deleteComment()} /> : null}
      {deleteError ? <p className="mt-2 text-sm text-red-200" role="alert">{deleteError}</p> : null}
      {voteViewer.error ? <p className="mt-2 text-sm text-red-200" role="alert">{voteViewer.error}</p> : null}
    </article>
  );
}

export default function CommunityCommentThread({
  submissionId,
  turnstileSiteKey,
  defaultOpen = false,
}: {
  submissionId: number;
  turnstileSiteKey: string | null;
  defaultOpen?: boolean;
}) {
  const pathname = usePathname();
  const [releaseState, setReleaseState] = useState<CommunityCommentReleaseState | null>(null);
  const [hidden, setHidden] = useState(false);
  const [open, setOpen] = useState(defaultOpen);
  const [sort, setSort] = useState<CommunityCommentSort>("top");
  const [page, setPage] = useState<CommunityCommentRootPage | null>(null);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [roots, setRoots] = useState<CommunityCommentRootItem[]>([]);
  const [branches, setBranches] = useState<Record<string, ReplyBranch>>({});
  const [account, setAccount] = useState<CommunityCommentAccountState>({ kind: "loading" });
  const [voteViewerById, setVoteViewerById] = useState<Record<string, VoteViewerProjection>>({});
  const [voteLayout, setVoteLayout] = useState<CommentVoteLayout>("thumbs");
  const [ownNewRoot, setOwnNewRoot] = useState<CommunityCommentRootItem | null>(null);
  const [replyTarget, setReplyTarget] = useState<{ root: CommunityCommentRootItem; target: CommunityCommentPublicDto } | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replyConflict, setReplyConflict] = useState<string | null>(null);
  const [composerKey, setComposerKey] = useState(0);
  const [loadedRootPages, setLoadedRootPages] = useState(1);
  const sectionRef = useRef<HTMLElement>(null);
  const deepLinkHandled = useRef(false);
  const previousOpen = useRef(open);
  const previousPathname = useRef(pathname);
  const initialLoadBusy = useRef(false);
  const reconciliationBusy = useRef(false);
  const reconciliationController = useRef<AbortController | null>(null);
  const disclosureScrollAnchoring = useRef<{
    previousOverflowAnchor: string;
    restoreTimer: number | null;
    scrollContainer: HTMLElement;
  } | null>(null);
  const voteBusyIds = useRef(new Set<string>());
  const voteViewerAccountGeneration = useRef(0);
  const voteViewerAccountKey =
    account.kind === "authenticated"
      ? `authenticated:${account.publicProfileId ?? account.displayName}`
      : account.kind;
  const latestState = useRef({
    account,
    branches,
    loadedRootPages,
    open,
    ownNewRoot,
    page,
    replyTarget,
    roots,
    sort,
  });
  latestState.current = {
    account,
    branches,
    loadedRootPages,
    open,
    ownNewRoot,
    page,
    replyTarget,
    roots,
    sort,
  };
  const hasPage = page !== null;

  function restoreDisclosureScrollAnchoring() {
    const current = disclosureScrollAnchoring.current;
    if (!current) return;
    if (current.restoreTimer !== null) {
      window.clearTimeout(current.restoreTimer);
    }
    if (current.scrollContainer.style.overflowAnchor === "none") {
      current.scrollContainer.style.overflowAnchor = current.previousOverflowAnchor;
    }
    disclosureScrollAnchoring.current = null;
  }

  function suppressDisclosureScrollAnchoring() {
    restoreDisclosureScrollAnchoring();
    const scrollContainer =
      findVerticalScrollContainer(sectionRef.current) ??
      (document.scrollingElement instanceof HTMLElement
        ? document.scrollingElement
        : null);
    if (!scrollContainer) return;
    const previousOverflowAnchor = scrollContainer.style.overflowAnchor;
    scrollContainer.style.overflowAnchor = "none";
    disclosureScrollAnchoring.current = {
      previousOverflowAnchor,
      restoreTimer: null,
      scrollContainer,
    };
  }

  function handleDisclosureToggle(event: React.SyntheticEvent<HTMLDetailsElement>) {
    setOpen(event.currentTarget.open);
    const current = disclosureScrollAnchoring.current;
    if (!current) return;
    current.restoreTimer = window.setTimeout(() => {
      if (disclosureScrollAnchoring.current === current) {
        restoreDisclosureScrollAnchoring();
      }
    }, 100);
  }

  useEffect(() => () => restoreDisclosureScrollAnchoring(), []);

  useEffect(() => {
    if (!releaseState) return;
    return subscribeCommunityCommentCount(submissionId, setTotalCount);
  }, [releaseState, submissionId]);

  useEffect(() => {
    if (page) publishCommunityCommentCount(submissionId, page.totalCount);
  }, [page, submissionId]);

  useEffect(() => {
    voteViewerAccountGeneration.current += 1;
    setVoteViewerById({});
  }, [voteViewerAccountKey]);

  useEffect(() => {
    try {
      const storedLayout = window.localStorage.getItem(COMMENT_VOTE_LAYOUT_STORAGE_KEY);
      if (storedLayout === "thumbs" || storedLayout === "expressive") {
        setVoteLayout(storedLayout);
      }
    } catch {
      // The default thumbs remain available when browser storage is unavailable.
    }
  }, []);

  function updateVoteLayout(nextLayout: CommentVoteLayout) {
    setVoteLayout(nextLayout);
    try {
      window.localStorage.setItem(COMMENT_VOTE_LAYOUT_STORAGE_KEY, nextLayout);
    } catch {
      // The in-memory preference still applies for the current page.
    }
  }

  useEffect(() => {
    let disposed = false;
    reconciliationController.current?.abort();
    reconciliationBusy.current = false;
    deepLinkHandled.current = false;
    setHidden(false);
    setReleaseState(null);
    setTotalCount(null);
    setPage(null);
    setRoots([]);
    setBranches({});
    setOwnNewRoot(null);
    setReplyTarget(null);
    setReplyConflict(null);
    setLoadedRootPages(1);
    probeReleaseState(submissionId)
      .then((state) => {
        if (disposed) return;
        if (!state) {
          setHidden(true);
          return;
        }
        setReleaseState(state);
        if (state === "open" && latestState.current.open) {
          void loadAccountOnce().then((value) => {
            if (!disposed) setAccount(value);
          });
        } else {
          setAccount({ kind: "anonymous" });
        }
      })
      .catch(() => {
        if (!disposed) setError("Comments are temporarily unavailable.");
      });
    return () => {
      disposed = true;
      reconciliationController.current?.abort();
    };
  }, [submissionId]);

  useEffect(() => {
    if (releaseState !== "open" || account.kind !== "authenticated") return;
    const ids = new Set<string>();
    for (const root of roots) {
      if (root.tombstone === null) ids.add(root.publicCommentId);
      for (const reply of root.replyPreview) {
        if (reply.tombstone === null) ids.add(reply.publicCommentId);
      }
    }
    for (const branch of Object.values(branches)) {
      for (const reply of branch.items) {
        if (reply.tombstone === null) ids.add(reply.publicCommentId);
      }
    }
    if (ownNewRoot?.tombstone === null) ids.add(ownNewRoot.publicCommentId);
    const missing = [...ids].filter((publicCommentId) => !voteViewerById[publicCommentId]);
    if (missing.length === 0) return;

    setVoteViewerById((current) => {
      const next = { ...current };
      for (const publicCommentId of missing) {
        next[publicCommentId] ??= { state: null, version: 0, loading: true, error: null };
      }
      return next;
    });

    const accountGeneration = voteViewerAccountGeneration.current;
    const batches: string[][] = [];
    for (let index = 0; index < missing.length; index += 100) {
      batches.push(missing.slice(index, index + 100));
    }
    void Promise.all(batches.map((ids) => fetchCommunityCommentVoteViewerState(ids)))
      .then((pages) => {
        if (accountGeneration !== voteViewerAccountGeneration.current) return;
        const loaded = new Map(pages.flat().map((item) => [item.publicCommentId, item]));
        setVoteViewerById((current) => {
          const next = { ...current };
          for (const publicCommentId of missing) {
            const item = loaded.get(publicCommentId);
            next[publicCommentId] = item
              ? { state: item.state, version: item.version, loading: false, error: null }
              : { state: null, version: 0, loading: false, error: null };
          }
          return next;
        });
      })
      .catch(() => {
        if (accountGeneration !== voteViewerAccountGeneration.current) return;
        setVoteViewerById((current) => {
          const next = { ...current };
          for (const publicCommentId of missing) {
            next[publicCommentId] = {
              ...(next[publicCommentId] ?? { state: null, version: 0 }),
              loading: false,
              error: "Your vote state could not be loaded.",
            };
          }
          return next;
        });
      });
  }, [account, branches, ownNewRoot, releaseState, roots, voteViewerById]);

  function applyPage(next: CommunityCommentRootPage, replace: boolean) {
    setPage(next);
    setReleaseState(next.releaseState);
    setRoots((current) => {
      const source = replace ? [] : current;
      const byId = new Map(source.map((root) => [root.publicCommentId, root]));
      for (const root of next.items) byId.set(root.publicCommentId, root);
      return [...byId.values()];
    });
    setBranches((current) => {
      const nextBranches = replace ? {} : { ...current };
      for (const root of next.items) {
        nextBranches[root.publicCommentId] ??= initialBranch(root);
      }
      return nextBranches;
    });
  }

  async function loadInitial(nextSort = sort, force = false) {
    if (initialLoadBusy.current || (!force && page?.sort === nextSort)) return;
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setError("You appear to be offline. Reconnect and try again.");
      return;
    }
    initialLoadBusy.current = true;
    setLoading(true);
    setError(null);
    try {
      const next = await fetchCommunityCommentRootPage({ submissionId, sort: nextSort });
      setSort(nextSort);
      applyPage(next, true);
      setLoadedRootPages(1);
      setOwnNewRoot(null);
      setReplyConflict(null);
      if (next.releaseState === "open") {
        void loadAccountOnce().then(setAccount);
      } else {
        setAccount({ kind: "anonymous" });
      }
    } catch (reason) {
      if (reason instanceof CommunityCommentClientError && reason.status === 404) {
        setHidden(true);
      } else {
        setError("Comments are temporarily unavailable. Please try again.");
      }
    } finally {
      initialLoadBusy.current = false;
      setLoading(false);
    }
  }

  const loadInitialRef = useRef(loadInitial);
  loadInitialRef.current = loadInitial;

  useEffect(() => {
    if (open && releaseState && !page) void loadInitialRef.current(sort, true);
  }, [open, page, releaseState, sort]);

  useEffect(() => {
    if (!open || !page || deepLinkHandled.current) return;
    const params = new URLSearchParams(window.location.search);
    const hash = window.location.hash.match(/^#comment-([0-9a-f-]+)$/u)?.[1];
    const targetId = params.get("comment") ?? hash ?? null;
    if (!targetId || !UUID_PATTERN.test(targetId)) {
      deepLinkHandled.current = true;
      return;
    }
    deepLinkHandled.current = true;
    fetchCommunityCommentDeepLink(targetId)
      .then((result) => {
        if (result.submissionId !== submissionId) return;
        const rootItem: CommunityCommentRootItem = {
          ...result.root,
          replyPreview: result.replies,
          replyPreviewHasMore: result.replies.length < result.root.replyCount,
        };
        setRoots((current) => {
          const byId = new Map(current.map((root) => [root.publicCommentId, root]));
          byId.set(rootItem.publicCommentId, rootItem);
          return [...byId.values()];
        });
        setBranches((current) => ({
          ...current,
          [rootItem.publicCommentId]: {
            items: result.replies,
            rootVersion: result.root.version,
            branchOpen: result.branchOpen,
            expanded: true,
            hasMore: result.replies.length < result.root.replyCount,
            nextCursor: null,
            initialized: result.replies.length >= result.root.replyCount,
            loading: false,
            error: null,
          },
        }));
        window.requestAnimationFrame(() => {
          document.getElementById(`comment-${targetId}`)?.focus({ preventScroll: true });
          document.getElementById(`comment-${targetId}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
        });
      })
      .catch(() => setError("That linked comment is no longer available."));
  }, [open, page, submissionId]);

  async function reconcileThread() {
    const snapshot = latestState.current;
    if (
      reconciliationBusy.current ||
      !snapshot.open ||
      !snapshot.page ||
      document.visibilityState !== "visible"
    ) return null;

    reconciliationBusy.current = true;
    const controller = new AbortController();
    reconciliationController.current = controller;
    const scrollAnchor = captureScrollAnchor(sectionRef.current);
    try {
      const nextPage = await fetchRootWindow({
        submissionId,
        sort: snapshot.sort,
        pageCount: Math.max(1, snapshot.loadedRootPages),
        signal: controller.signal,
      });

      const batchIds = new Set<string>();
      if (snapshot.ownNewRoot) batchIds.add(snapshot.ownNewRoot.publicCommentId);
      if (snapshot.replyTarget) {
        batchIds.add(snapshot.replyTarget.root.publicCommentId);
        batchIds.add(snapshot.replyTarget.target.publicCommentId);
      }
      for (const branch of Object.values(snapshot.branches)) {
        if (!branch.expanded) {
          for (const item of branch.items) batchIds.add(item.publicCommentId);
        }
      }
      const batches = [...batchIds].reduce<string[][]>((items, publicCommentId, index) => {
        if (index % 100 === 0) items.push([]);
        items.at(-1)!.push(publicCommentId);
        return items;
      }, []);
      const [batchPages, replyPages] = await Promise.all([
        Promise.all(batches.map((ids) => fetchCommunityCommentsBatch(ids, controller.signal))),
        Promise.all(Object.entries(snapshot.branches)
          .filter(([, branch]) => branch.expanded)
          .map(async ([rootPublicCommentId, branch]) => {
            try {
              const replyPage = await fetchReplyWindow({
                submissionId,
                rootPublicCommentId,
                pageCount: Math.max(1, Math.ceil(branch.items.length / COMMENT_PAGE_SIZE)),
                signal: controller.signal,
              });
              return [rootPublicCommentId, replyPage] as const;
            } catch (reason) {
              if (controller.signal.aborted) throw reason;
              return [rootPublicCommentId, null] as const;
            }
          })),
      ]);

      const currentById = new Map<string, CommunityCommentPublicDto>();
      for (const root of nextPage.items) {
        currentById.set(root.publicCommentId, root);
        for (const reply of root.replyPreview) currentById.set(reply.publicCommentId, reply);
      }
      for (const item of batchPages.flat()) currentById.set(item.publicCommentId, item);
      for (const [, replyPage] of replyPages) {
        for (const item of replyPage?.items ?? []) currentById.set(item.publicCommentId, item);
      }
      const replyPageByRoot = new Map(replyPages);

      const pinnedRoot = snapshot.replyTarget
        ? currentById.get(snapshot.replyTarget.root.publicCommentId)
        : null;
      const nextRoots = [...nextPage.items];
      if (
        pinnedRoot?.rootPublicCommentId === null &&
        !nextRoots.some((root) => root.publicCommentId === pinnedRoot.publicCommentId)
      ) {
        nextRoots.push({
          ...pinnedRoot,
          replyPreview: snapshot.replyTarget?.root.replyPreview ?? [],
          replyPreviewHasMore: snapshot.replyTarget?.root.replyPreviewHasMore ?? false,
        });
      }

      const refreshedOwnRoot = snapshot.ownNewRoot
        ? currentById.get(snapshot.ownNewRoot.publicCommentId)
        : null;
      const rootsForBranches = [...nextRoots];
      if (
        refreshedOwnRoot?.rootPublicCommentId === null &&
        !rootsForBranches.some((root) => root.publicCommentId === refreshedOwnRoot.publicCommentId)
      ) {
        rootsForBranches.push({
          ...refreshedOwnRoot,
          replyPreview: snapshot.ownNewRoot?.replyPreview ?? [],
          replyPreviewHasMore: snapshot.ownNewRoot?.replyPreviewHasMore ?? false,
        });
      }

      const nextBranches: Record<string, ReplyBranch> = {};
      for (const root of rootsForBranches) {
        const current = snapshot.branches[root.publicCommentId] ?? initialBranch(root);
        const refreshedReplies = replyPageByRoot.get(root.publicCommentId);
        if (refreshedReplies) {
          nextBranches[root.publicCommentId] = {
            ...current,
            items: refreshedReplies.items,
            rootVersion: refreshedReplies.rootVersion,
            branchOpen: refreshedReplies.branchOpen,
            hasMore: refreshedReplies.hasMore,
            nextCursor: refreshedReplies.nextCursor,
            initialized: true,
            loading: false,
            error: null,
          };
          continue;
        }
        const currentItems = current.items.flatMap((item) => {
          const refreshed = currentById.get(item.publicCommentId);
          return refreshed ? [refreshed] : [];
        });
        const items = mergeCommunityComments(currentItems, root.replyPreview);
        nextBranches[root.publicCommentId] = {
          ...current,
          items,
          rootVersion: root.version,
          branchOpen: root.tombstone === null,
          hasMore: root.replyCount > items.length,
          nextCursor: null,
          initialized: false,
          loading: false,
          error: current.expanded ? "Could not refresh replies. Trying again shortly." : null,
        };
      }

      setPage(nextPage);
      setReleaseState(nextPage.releaseState);
      setRoots(nextRoots);
      setBranches(nextBranches);
      setOwnNewRoot(
        refreshedOwnRoot?.rootPublicCommentId === null
          ? {
              ...refreshedOwnRoot,
              replyPreview: snapshot.ownNewRoot?.replyPreview ?? [],
              replyPreviewHasMore: snapshot.ownNewRoot?.replyPreviewHasMore ?? false,
            }
          : null,
      );

      if (snapshot.replyTarget) {
        const root = rootsForBranches.find((item) =>
          item.publicCommentId === snapshot.replyTarget?.root.publicCommentId
        );
        const target = currentById.get(snapshot.replyTarget.target.publicCommentId);
        const branch = root ? nextBranches[root.publicCommentId] : null;
        if (!root || !target || root.tombstone !== null || target.tombstone !== null || !branch?.branchOpen) {
          setReplyConflict("This reply target is no longer available. Your draft is still here.");
        } else {
          setReplyTarget({ root, target });
          setReplyConflict(null);
        }
      } else {
        setReplyConflict(null);
      }

      if (snapshot.account.kind === "authenticated" && nextPage.releaseState === "open") {
        const voteIds = new Set<string>();
        for (const root of rootsForBranches) {
          if (root.tombstone === null) voteIds.add(root.publicCommentId);
          for (const reply of nextBranches[root.publicCommentId]?.items ?? []) {
            if (reply.tombstone === null) voteIds.add(reply.publicCommentId);
          }
        }
        const voteBatches = [...voteIds].reduce<string[][]>((items, publicCommentId, index) => {
          if (index % 100 === 0) items.push([]);
          items.at(-1)!.push(publicCommentId);
          return items;
        }, []);
        void Promise.all(voteBatches.map((ids) =>
          fetchCommunityCommentVoteViewerState(ids, controller.signal)
        )).then((pages) => {
          if (controller.signal.aborted) return;
          const refreshed = new Map(pages.flat().map((item) => [item.publicCommentId, item]));
          setVoteViewerById((current) => {
            const next = { ...current };
            for (const publicCommentId of voteIds) {
              const item = refreshed.get(publicCommentId);
              if (item) {
                next[publicCommentId] = {
                  state: item.state,
                  version: item.version,
                  loading: false,
                  error: null,
                };
              }
            }
            return next;
          });
        }).catch(() => {
          // Public reconciliation remains valid if private viewer state briefly fails.
        });
      }
      restoreScrollAnchor(scrollAnchor);
      return nextPage;
    } catch (reason) {
      if (controller.signal.aborted || (reason instanceof Error && reason.name === "AbortError")) {
        return null;
      }
      if (
        reason instanceof CommunityCommentClientError &&
        reason.status === 404 &&
        reason.code === "COMMENTS_UNAVAILABLE"
      ) {
        setHidden(true);
      }
      return null;
    } finally {
      if (reconciliationController.current === controller) {
        reconciliationController.current = null;
      }
      reconciliationBusy.current = false;
    }
  }

  const reconcileThreadRef = useRef(reconcileThread);
  reconcileThreadRef.current = reconcileThread;

  useEffect(() => {
    const justOpened = open && !previousOpen.current;
    const navigated = pathname !== previousPathname.current;
    previousOpen.current = open;
    previousPathname.current = pathname;
    if (open && hasPage && (justOpened || navigated)) {
      void reconcileThreadRef.current();
    }
  }, [hasPage, open, pathname]);

  useEffect(() => {
    if (!open || !hasPage) return;
    const check = () => {
      if (document.visibilityState !== "visible") {
        reconciliationController.current?.abort();
        return;
      }
      void reconcileThreadRef.current();
    };
    const onPageShow = () => check();
    const interval = window.setInterval(check, COMMENT_RECONCILIATION_INTERVAL_MS);
    window.addEventListener("focus", check);
    window.addEventListener("pageshow", onPageShow);
    document.addEventListener("visibilitychange", check);
    return () => {
      reconciliationController.current?.abort();
      window.clearInterval(interval);
      window.removeEventListener("focus", check);
      window.removeEventListener("pageshow", onPageShow);
      document.removeEventListener("visibilitychange", check);
    };
  }, [hasPage, open, submissionId]);

  async function loadMoreRoots() {
    if (!page?.nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      applyPage(await fetchCommunityCommentRootPage({ submissionId, sort, cursor: page.nextCursor }), false);
      setLoadedRootPages((current) => current + 1);
    } catch {
      setError("Could not load more comments. Please try again.");
    } finally {
      setLoadingMore(false);
    }
  }

  async function loadEarlierReplies(root: CommunityCommentRootItem) {
    const branch = branches[root.publicCommentId] ?? initialBranch(root);
    if (branch.loading) return;
    setBranches((current) => ({ ...current, [root.publicCommentId]: { ...branch, loading: true, error: null } }));
    try {
      const replyPage = await fetchCommunityCommentReplyPage({
        submissionId,
        rootPublicCommentId: root.publicCommentId,
        cursor: branch.initialized ? branch.nextCursor : null,
      });
      setBranches((current) => ({
        ...current,
        [root.publicCommentId]: {
          items: mergeCommunityComments(branch.items, replyPage.items),
          rootVersion: replyPage.rootVersion,
          branchOpen: replyPage.branchOpen,
          expanded: true,
          hasMore: replyPage.hasMore,
          nextCursor: replyPage.nextCursor,
          initialized: true,
          loading: false,
          error: null,
        },
      }));
    } catch {
      setBranches((current) => ({ ...current, [root.publicCommentId]: { ...branch, loading: false, error: "Could not load earlier replies." } }));
    }
  }

  function replaceCommentDto(updated: CommunityCommentPublicDto) {
    if (updated.rootPublicCommentId === null) {
      setRoots((current) => current.map((root) => root.publicCommentId === updated.publicCommentId ? { ...root, ...updated } : root));
      setOwnNewRoot((current) => current?.publicCommentId === updated.publicCommentId ? { ...current, ...updated } : current);
    } else {
      setBranches((current) => {
        const branch = current[updated.rootPublicCommentId!];
        if (!branch) return current;
        return { ...current, [updated.rootPublicCommentId!]: { ...branch, items: branch.items.map((reply) => reply.publicCommentId === updated.publicCommentId ? updated : reply) } };
      });
    }
  }

  function replaceComment(receipt: CommunityCommentMutationReceipt) {
    const updated = receipt.comment;
    replaceCommentDto(updated);
    if (receipt.branchClosed && updated.rootPublicCommentId === null) {
      setBranches((current) => ({ ...current, [updated.publicCommentId]: { ...(current[updated.publicCommentId] ?? { items: [], rootVersion: updated.version, expanded: false, hasMore: false, nextCursor: null, initialized: true, loading: false, error: null }), branchOpen: false } }));
    }
    setPage((current) => current ? { ...current, threadVersion: receipt.threadVersion } : current);
  }

  async function voteOnComment(
    comment: CommunityCommentPublicDto,
    desiredState: CommunityCommentVoteState,
  ) {
    if (account.kind === "anonymous") {
      login();
      return;
    }
    if (account.kind !== "authenticated" || voteBusyIds.current.has(comment.publicCommentId)) {
      return;
    }
    const current = voteViewerById[comment.publicCommentId];
    if (!current || current.loading) return;

    voteBusyIds.current.add(comment.publicCommentId);
    setVoteViewerById((items) => ({
      ...items,
      [comment.publicCommentId]: { ...current, loading: true, error: null },
    }));
    try {
      const receipt = await sendCommunityCommentVote({
        publicCommentId: comment.publicCommentId,
        desiredState,
        expectedVersion: current.version,
        requestId: crypto.randomUUID(),
      });
      replaceCommentDto({
        ...comment,
        voteCounts: receipt.projection.voteCounts,
      });
      setVoteViewerById((items) => ({
        ...items,
        [comment.publicCommentId]: {
          state: receipt.projection.viewerState,
          version: receipt.projection.viewerVersion,
          loading: false,
          error: null,
        },
      }));
    } catch (reason) {
      if (reason instanceof CommunityCommentClientError && reason.status === 401) {
        login();
        return;
      }
      if (reason instanceof CommunityCommentClientError && reason.code === "STALE_VOTE") {
        try {
          const [comments, viewerItems] = await Promise.all([
            fetchCommunityCommentsBatch([comment.publicCommentId]),
            fetchCommunityCommentVoteViewerState([comment.publicCommentId]),
          ]);
          if (comments[0]) replaceCommentDto(comments[0]);
          const viewer = viewerItems[0];
          setVoteViewerById((items) => ({
            ...items,
            [comment.publicCommentId]: viewer
              ? { state: viewer.state, version: viewer.version, loading: false, error: null }
              : { state: null, version: 0, loading: false, error: "This comment is no longer available." },
          }));
          return;
        } catch {
          // Fall through to the local affected-Comment error state.
        }
      }
      if (reason instanceof CommunityCommentClientError && reason.code === "READ_ONLY") {
        setReleaseState("read_only");
      }
      setVoteViewerById((items) => ({
        ...items,
        [comment.publicCommentId]: {
          ...current,
          loading: false,
          error: "Your vote could not be saved. Please try again.",
        },
      }));
    } finally {
      voteBusyIds.current.delete(comment.publicCommentId);
    }
  }

  function acceptReply(
    root: CommunityCommentRootItem,
    branch: ReplyBranch,
    receipt: CommunityCommentMutationReceipt,
  ) {
    setBranches((current) => ({
      ...current,
      [root.publicCommentId]: {
        ...(current[root.publicCommentId] ?? branch),
        items: mergeCommunityComments(
          (current[root.publicCommentId] ?? branch).items,
          [receipt.comment],
        ),
        rootVersion: receipt.rootVersion ?? branch.rootVersion,
        expanded: true,
      },
    }));
    setRoots((current) => current.map((item) =>
      item.publicCommentId === root.publicCommentId
        ? {
            ...item,
            version: receipt.rootVersion ?? item.version,
            replyCount: item.replyCount + 1,
          }
        : item,
    ));
    setOwnNewRoot((current) =>
      current?.publicCommentId === root.publicCommentId
        ? {
            ...current,
            version: receipt.rootVersion ?? current.version,
            replyCount: current.replyCount + 1,
          }
        : current,
    );
    setPage((current) => current
      ? {
          ...current,
          threadVersion: receipt.threadVersion,
          totalCount: current.totalCount + 1,
        }
      : current);
    queueCommunityCommentCountRefresh(submissionId);
    setReplyTarget(null);
    setReplyConflict(null);
  }

  async function guardedMutation(
    input: Parameters<typeof sendCommunityCommentMutation>[0],
  ) {
    try {
      return await sendCommunityCommentMutation(input);
    } catch (reason) {
      if (reason instanceof CommunityCommentClientError) {
        if (reason.code === "READ_ONLY") setReleaseState("read_only");
        if (reason.status === 404 && reason.code === "COMMENTS_UNAVAILABLE") {
          setHidden(true);
        }
        if ([
          "STALE_THREAD",
          "STALE_COMMENT",
          "ROOT_UNAVAILABLE",
          "TARGET_UNAVAILABLE",
          "BRANCH_CLOSED",
          "COMMENT_UNAVAILABLE",
          "AUTHOR_DELETED",
        ].includes(reason.code)) {
          const refreshed = await reconcileThreadRef.current();
          const rootAppend =
            reason.code === "STALE_THREAD" &&
            input.method === "POST" &&
            input.url === `/api/comments/submissions/${submissionId}`;
          if (rootAppend && refreshed) {
            return sendCommunityCommentMutation({
              ...input,
              body: {
                ...input.body,
                expectedThreadVersion: refreshed.threadVersion,
              },
            });
          }
        }
      }
      throw reason;
    }
  }

  function beginReply(
    root: CommunityCommentRootItem,
    target: CommunityCommentPublicDto,
  ) {
    setBranches((current) => {
      const branch = current[root.publicCommentId] ?? initialBranch(root);
      return {
        ...current,
        [root.publicCommentId]: { ...branch, expanded: true },
      };
    });
    setReplyTarget({ root, target });
    setReplyConflict(null);
  }

  function toggleReplies(root: CommunityCommentRootItem) {
    const branch = branches[root.publicCommentId] ?? initialBranch(root);
    const expanded = !branch.expanded;
    setBranches((current) => ({
      ...current,
      [root.publicCommentId]: {
        ...(current[root.publicCommentId] ?? branch),
        expanded,
      },
    }));
    if (!expanded && replyTarget?.root.publicCommentId === root.publicCommentId) {
      setReplyTarget(null);
      setReplyConflict(null);
    }
  }

  if (hidden || (!releaseState && !error)) return null;
  const visibleReleaseState = releaseState ?? "read_only";
  const ownNewBranch = ownNewRoot
    ? branches[ownNewRoot.publicCommentId] ?? initialBranch(ownNewRoot)
    : null;
  const voteViewerFor = (publicCommentId: string): VoteViewerProjection =>
    voteViewerById[publicCommentId] ?? {
      state: null,
      version: 0,
      loading: account.kind === "authenticated",
      error: null,
    };

  return (
    <section ref={sectionRef} data-comment-thread data-comment-submission-id={submissionId} className="min-w-0 border-t border-orange-500/20 bg-neutral-950/70 [&_a]:cursor-pointer [&_button:not(:disabled)]:cursor-pointer">
      <details open={open} onToggle={handleDisclosureToggle}>
        <summary onClick={suppressDisclosureScrollAnchoring} className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-orange-400 sm:px-5">
          <span className="flex items-center gap-2">
            <span>Comments</span>
            {totalCount !== null ? (
              <span
                aria-label={`${totalCount} total ${totalCount === 1 ? "comment" : "comments"}`}
                className="inline-flex min-w-6 items-center justify-center rounded-full border border-orange-300/30 bg-orange-500/10 px-1.5 py-0.5 text-xs font-bold tabular-nums text-orange-100"
              >
                {totalCount}
              </span>
            ) : null}
          </span>
          <span aria-hidden="true" className="text-orange-200">{open ? "−" : "+"}</span>
        </summary>
        <div className="border-t border-white/10 px-3 py-4 sm:px-5 sm:py-5">
          {error && !page ? (
            <div className="rounded-xl border border-red-400/25 bg-red-950/20 p-4 text-sm text-red-100" role="alert">
              <p>{error}</p>
              <button type="button" onClick={() => void loadInitial(sort, true)} className="mt-3 min-h-11 rounded-full border border-red-300/30 px-4 py-2 font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white">Retry</button>
            </div>
          ) : loading && !page ? (
            <p className="py-6 text-center text-sm text-white/60" role="status">Loading comments…</p>
          ) : page ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="inline-flex rounded-full border border-white/10 bg-black/40 p-1" aria-label="Comment sorting">
                  {(["top", "newest"] as const).map((option) => (
                    <button key={option} type="button" aria-pressed={sort === option} onClick={() => void loadInitial(option, true)} disabled={loading} className={`min-h-11 rounded-full px-4 py-2 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 ${sort === option ? "bg-orange-500 text-black" : "text-white/70 hover:text-white"}`}>
                      {option === "top" ? "Top" : "Newest"}
                    </button>
                  ))}
                </div>
                <button type="button" onClick={() => void loadInitial(sort, true)} disabled={loading} className="min-h-11 rounded-full border border-white/15 px-4 py-2 text-sm font-semibold text-white/75 hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 disabled:opacity-50">Refresh</button>
              </div>

              {releaseState === "read_only" ? (
                <p className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/65" role="status">Comments are currently read-only.</p>
              ) : account.kind === "authenticated" ? (
                <CommunityCommentComposer
                  key={`root:${composerKey}`}
                  label="Add a comment"
                  submitLabel="Post comment"
                  turnstileSiteKey={turnstileSiteKey}
                  onSubmit={({ body, mentions, requestId, turnstileToken }) =>
                    guardedMutation({
                      url: `/api/comments/submissions/${submissionId}`,
                      method: "POST",
                      body: { body, mentions, requestId, expectedThreadVersion: page.threadVersion },
                      turnstileToken,
                    })
                  }
                  onSuccess={(receipt) => {
                    const root: CommunityCommentRootItem = { ...receipt.comment, replyPreview: [], replyPreviewHasMore: false };
                    setOwnNewRoot(root);
                    setBranches((current) => ({ ...current, [root.publicCommentId]: initialBranch(root) }));
                    setPage((current) => current ? {
                      ...current,
                      threadVersion: receipt.threadVersion,
                      totalCount: current.totalCount + 1,
                    } : current);
                    queueCommunityCommentCountRefresh(submissionId);
                    setComposerKey((current) => current + 1);
                  }}
                />
              ) : account.kind === "loading" ? (
                <p className="text-sm text-white/55" role="status">Checking your session…</p>
              ) : account.kind === "anonymous" ? (
                <div className="rounded-xl border border-orange-500/25 bg-orange-500/10 p-4 text-sm text-orange-50">
                  <p>Sign in with your CancerCulture website session to join the conversation.</p>
                  <button type="button" onClick={login} className="mt-3 min-h-11 rounded-full bg-[var(--orange-main)] px-4 py-2 font-bold text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white">Sign in to comment</button>
                </div>
              ) : (
                <p className="rounded-xl border border-red-400/20 bg-red-950/20 px-3 py-2 text-sm text-red-100" role="alert">Your account state is temporarily unavailable.</p>
              )}

              {ownNewRoot ? (
                <div className="rounded-2xl border-2 border-orange-400/60 bg-orange-500/10 p-2">
                  <p className="px-2 pb-2 text-sm font-bold text-orange-100">Your new comment</p>
                  <CommentItem account={account} branchOpen comment={ownNewRoot} isReply={false} releaseState={visibleReleaseState} turnstileSiteKey={turnstileSiteKey} sendMutation={guardedMutation} voteLayout={voteLayout} onVoteLayoutChange={updateVoteLayout} voteViewer={voteViewerFor(ownNewRoot.publicCommentId)} onVote={(desiredState) => void voteOnComment(ownNewRoot, desiredState)} onReply={() => beginReply(ownNewRoot, ownNewRoot)} onEdit={replaceComment} onDelete={replaceComment} />
                  {replyTarget?.root.publicCommentId === ownNewRoot.publicCommentId &&
                  account.kind === "authenticated" && ownNewBranch ? (
                    <div className="mt-3">
                      <p className="mb-2 text-sm text-white/60">Replying to @{replyTarget.target.author.displayName}</p>
                      {replyConflict ? <p className="mb-2 text-sm text-red-200" role="alert">{replyConflict}</p> : null}
                      <CommunityCommentComposer
                        key={`reply:${replyTarget.target.publicCommentId}`}
                        autoFocus
                        label="Write a reply"
                        submitLabel="Post reply"
                        turnstileSiteKey={turnstileSiteKey}
                        onCancel={() => { setReplyTarget(null); setReplyConflict(null); }}
                        onSubmit={({ body, mentions, requestId, turnstileToken }) => {
                          if (replyConflict) {
                            return Promise.reject(new CommunityCommentClientError(409, "TARGET_UNAVAILABLE"));
                          }
                          return guardedMutation({
                            url: `/api/comments/submissions/${submissionId}/${encodeURIComponent(ownNewRoot.publicCommentId)}/replies`,
                            method: "POST",
                            body: {
                              body,
                              mentions,
                              requestId,
                              targetPublicCommentId: replyTarget.target.publicCommentId,
                              expectedRootVersion: ownNewBranch.rootVersion,
                              expectedTargetVersion: replyTarget.target.version,
                            },
                            turnstileToken,
                          });
                        }}
                        onSuccess={(receipt) =>
                          acceptReply(ownNewRoot, ownNewBranch, receipt)
                        }
                      />
                    </div>
                  ) : null}
                </div>
              ) : null}

              {roots.length === 0 && !ownNewRoot ? <p className="py-6 text-center text-sm text-white/55">No comments yet. Start the conversation.</p> : null}

              <div className="space-y-4">
                {roots.filter((root) => root.publicCommentId !== ownNewRoot?.publicCommentId).map((root) => {
                  const branch = branches[root.publicCommentId] ?? initialBranch(root);
                  const remainingReplies = Math.max(0, root.replyCount - branch.items.length);
                  const names = new Map<string, string>([[root.publicCommentId, root.author.displayName], ...branch.items.map((reply) => [reply.publicCommentId, reply.author.displayName] as [string, string])]);
                  return (
                    <div key={root.publicCommentId} className="space-y-3">
                      <CommentItem account={account} branchOpen={branch.branchOpen} comment={root} isReply={false} releaseState={visibleReleaseState} repliesExpanded={branch.expanded} onToggleReplies={() => toggleReplies(root)} turnstileSiteKey={turnstileSiteKey} sendMutation={guardedMutation} voteLayout={voteLayout} onVoteLayoutChange={updateVoteLayout} voteViewer={voteViewerFor(root.publicCommentId)} onVote={(desiredState) => void voteOnComment(root, desiredState)} onReply={() => beginReply(root, root)} onEdit={replaceComment} onDelete={replaceComment} />
                      {branch.expanded && (branch.items.length > 0 || branch.hasMore) ? (
                        <div className="ml-3 space-y-3 border-l border-orange-500/20 pl-3 sm:ml-6 sm:pl-4">
                          {branch.error ? <p className="text-sm text-red-200" role="alert">{branch.error}</p> : null}
                          {branch.items.map((reply) => (
                            <CommentItem key={reply.publicCommentId} account={account} branchOpen={branch.branchOpen && reply.tombstone === null} comment={reply} isReply releaseState={visibleReleaseState} replyTargetName={reply.replyTargetPublicCommentId && reply.replyTargetPublicCommentId !== root.publicCommentId ? names.get(reply.replyTargetPublicCommentId) ?? null : null} turnstileSiteKey={turnstileSiteKey} sendMutation={guardedMutation} voteLayout={voteLayout} onVoteLayoutChange={updateVoteLayout} voteViewer={voteViewerFor(reply.publicCommentId)} onVote={(desiredState) => void voteOnComment(reply, desiredState)} onReply={() => beginReply(root, reply)} onEdit={replaceComment} onDelete={replaceComment} />
                          ))}
                          {branch.hasMore ? (
                            <button type="button" onClick={() => void loadEarlierReplies(root)} disabled={branch.loading} className="min-h-9 cursor-pointer rounded px-1 py-1.5 text-sm font-semibold text-orange-300 hover:text-orange-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 disabled:opacity-50">
                              {branch.loading
                                ? "Loading replies…"
                                : remainingReplies > 0
                                  ? `View ${remainingReplies} more ${remainingReplies === 1 ? "reply" : "replies"}`
                                  : "View more replies"}
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                      {replyTarget?.root.publicCommentId === root.publicCommentId ? (
                        account.kind === "authenticated" ? (
                          <div className="ml-3 sm:ml-6">
                            <p className="mb-2 text-sm text-white/60">Replying to @{replyTarget.target.author.displayName}</p>
                            {replyConflict ? <p className="mb-2 text-sm text-red-200" role="alert">{replyConflict}</p> : null}
                            <CommunityCommentComposer
                              key={`reply:${replyTarget.target.publicCommentId}`}
                              autoFocus
                              label="Write a reply"
                              submitLabel="Post reply"
                              turnstileSiteKey={turnstileSiteKey}
                              onCancel={() => { setReplyTarget(null); setReplyConflict(null); }}
                              onSubmit={({ body, mentions, requestId, turnstileToken }) => {
                                if (replyConflict) {
                                  return Promise.reject(new CommunityCommentClientError(409, "TARGET_UNAVAILABLE"));
                                }
                                return guardedMutation({
                                  url: `/api/comments/submissions/${submissionId}/${encodeURIComponent(root.publicCommentId)}/replies`,
                                  method: "POST",
                                  body: {
                                    body,
                                    mentions,
                                    requestId,
                                    targetPublicCommentId: replyTarget.target.publicCommentId,
                                    expectedRootVersion: branch.rootVersion,
                                    expectedTargetVersion: replyTarget.target.version,
                                  },
                                  turnstileToken,
                                });
                              }}
                              onSuccess={(receipt) => acceptReply(root, branch, receipt)}
                            />
                          </div>
                        ) : null
                      ) : null}
                    </div>
                  );
                })}
              </div>

              {page.hasMore ? (
                <button type="button" onClick={() => void loadMoreRoots()} disabled={loadingMore} className="mx-auto block min-h-11 rounded-full border border-orange-400/30 px-5 py-2 text-sm font-semibold text-orange-100 hover:bg-orange-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 disabled:opacity-50">{loadingMore ? "Loading…" : "Load more comments"}</button>
              ) : null}
              {error ? <p className="text-center text-sm text-red-200" role="alert">{error}</p> : null}
            </div>
          ) : null}
        </div>
      </details>
    </section>
  );
}
