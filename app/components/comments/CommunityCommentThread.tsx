"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import CommunityCommentComposer from "@/app/components/comments/CommunityCommentComposer";
import CommunityCommentReportDialog from "@/app/components/comments/CommunityCommentReportDialog";
import {
  CommunityCommentClientError,
  fetchCommunityCommentAccount,
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

type CommentVoteLayout = "thumbs" | "expressive";

let releaseProbe: Promise<CommunityCommentReleaseState | null> | null = null;
let accountProbe: Promise<CommunityCommentAccountState> | null = null;
const probedPages = new Map<string, CommunityCommentRootPage>();

function pageKey(submissionId: number, sort: CommunityCommentSort) {
  return `${submissionId}:${sort}`;
}

async function probeReleaseState(submissionId: number) {
  if (!releaseProbe) {
    releaseProbe = fetchCommunityCommentRootPage({ submissionId, sort: "top" })
      .then((page) => {
        probedPages.set(pageKey(submissionId, "top"), page);
        return page.releaseState;
      })
      .catch((error) => {
        if (
          error instanceof CommunityCommentClientError &&
          error.status === 404 &&
          error.code === "COMMENTS_UNAVAILABLE"
        ) return null;
        releaseProbe = null;
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
  const [confirmingDelete, setConfirmingDelete] = useState(false);
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
          expectedVersion: comment.version,
          requestId: crypto.randomUUID(),
          confirmed: true,
        },
      });
      setConfirmingDelete(false);
      onDelete(receipt);
    } catch (error) {
      if (error instanceof CommunityCommentClientError && error.status === 401) {
        login();
        return;
      }
      setDeleteError(
        error instanceof CommunityCommentClientError && error.status === 409
          ? "This comment changed. Refresh comments before trying again."
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
            onCancel={() => setEditing(false)}
            onSubmit={({ body, mentions, requestId, turnstileToken }) =>
              sendMutation({
                url: `/api/comments/${encodeURIComponent(comment.publicCommentId)}`,
                method: "PATCH",
                body: { body, mentions, requestId, expectedVersion: comment.version },
                turnstileToken,
              })
            }
            onSuccess={(receipt) => {
              setEditing(false);
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
                <button type="button" onClick={() => setEditing(true)} className="min-h-8 cursor-pointer rounded px-1 py-1.5 font-semibold text-white/55 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400">Edit</button>
              ) : null}
              <button type="button" onClick={() => setConfirmingDelete(true)} className="min-h-8 cursor-pointer rounded px-1 py-1.5 font-semibold text-red-300/80 hover:text-red-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300">Delete</button>
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
      {confirmingDelete ? <DeleteConfirmation busy={deleteBusy} onCancel={() => setConfirmingDelete(false)} onConfirm={() => void deleteComment()} /> : null}
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
  const [releaseState, setReleaseState] = useState<CommunityCommentReleaseState | null>(null);
  const [hidden, setHidden] = useState(false);
  const [open, setOpen] = useState(defaultOpen);
  const [sort, setSort] = useState<CommunityCommentSort>("top");
  const [page, setPage] = useState<CommunityCommentRootPage | null>(null);
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
  const [refreshAvailable, setRefreshAvailable] = useState(false);
  const [composerKey, setComposerKey] = useState(0);
  const deepLinkHandled = useRef(false);
  const voteBusyIds = useRef(new Set<string>());
  const voteViewerAccountGeneration = useRef(0);
  const voteViewerAccountKey =
    account.kind === "authenticated"
      ? `authenticated:${account.publicProfileId ?? account.displayName}`
      : account.kind;

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
    probeReleaseState(submissionId)
      .then((state) => {
        if (disposed) return;
        if (!state) {
          setHidden(true);
          return;
        }
        setReleaseState(state);
        const probed = probedPages.get(pageKey(submissionId, "top"));
        if (probed) applyPage(probed, true);
        if (state === "open") {
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
    return () => { disposed = true; };
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
    void Promise.all(batches.map(fetchCommunityCommentVoteViewerState))
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
    if (loading || (!force && page?.sort === nextSort)) return;
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setError("You appear to be offline. Reconnect and try again.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const next = await fetchCommunityCommentRootPage({ submissionId, sort: nextSort });
      setSort(nextSort);
      applyPage(next, true);
      setOwnNewRoot(null);
      setRefreshAvailable(false);
    } catch (reason) {
      if (reason instanceof CommunityCommentClientError && reason.status === 404) {
        setHidden(true);
      } else {
        setError("Comments are temporarily unavailable. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  }

  const loadInitialRef = useRef(loadInitial);
  loadInitialRef.current = loadInitial;

  useEffect(() => {
    if (open && releaseState && !page) void loadInitialRef.current();
  }, [open, page, releaseState]);

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

  useEffect(() => {
    if (!open || !page) return;
    let lastChecked = 0;
    const check = () => {
      const now = Date.now();
      if (now - lastChecked < 15_000 || document.visibilityState !== "visible") return;
      lastChecked = now;
      fetchCommunityCommentRootPage({ submissionId, sort })
        .then((fresh) => {
          if (fresh.threadVersion > page.threadVersion) setRefreshAvailable(true);
        })
        .catch((reason) => {
          if (
            reason instanceof CommunityCommentClientError &&
            reason.status === 404 &&
            reason.code === "COMMENTS_UNAVAILABLE"
          ) {
            setHidden(true);
          }
        });
    };
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [open, page, sort, submissionId]);

  async function loadMoreRoots() {
    if (!page?.nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      applyPage(await fetchCommunityCommentRootPage({ submissionId, sort, cursor: page.nextCursor }), false);
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
      ? { ...current, threadVersion: receipt.threadVersion }
      : current);
    setReplyTarget(null);
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
    <section data-comment-thread data-comment-submission-id={submissionId} className="min-w-0 border-t border-orange-500/20 bg-neutral-950/70 [&_a]:cursor-pointer [&_button:not(:disabled)]:cursor-pointer">
      <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-orange-400 sm:px-5">
          <span>Comments</span>
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

              {refreshAvailable ? (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-orange-400/25 bg-orange-500/10 px-3 py-2 text-sm text-orange-100" role="status">
                  <span>New comments or replies may be available.</span>
                  <button type="button" onClick={() => void loadInitial(sort, true)} className="min-h-11 rounded-full px-3 py-2 font-semibold underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-300">Refresh comments</button>
                </div>
              ) : null}

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
                    setPage((current) => current ? { ...current, threadVersion: receipt.threadVersion } : current);
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
                      <CommunityCommentComposer
                        key={`reply:${replyTarget.target.publicCommentId}:${replyTarget.target.version}`}
                        autoFocus
                        label="Write a reply"
                        submitLabel="Post reply"
                        turnstileSiteKey={turnstileSiteKey}
                        onCancel={() => setReplyTarget(null)}
                        onSubmit={({ body, mentions, requestId, turnstileToken }) =>
                          guardedMutation({
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
                          })
                        }
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
                            <CommunityCommentComposer
                              key={`reply:${replyTarget.target.publicCommentId}:${replyTarget.target.version}`}
                              autoFocus
                              label="Write a reply"
                              submitLabel="Post reply"
                              turnstileSiteKey={turnstileSiteKey}
                              onCancel={() => setReplyTarget(null)}
                              onSubmit={({ body, mentions, requestId, turnstileToken }) =>
                                guardedMutation({
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
                                })
                              }
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
