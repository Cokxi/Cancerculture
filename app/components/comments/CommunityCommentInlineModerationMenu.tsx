"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import CommunityCommentModerationReviewContextView from "@/app/components/comments/CommunityCommentModerationReviewContext";
import {
  CommunityCommentClientError,
  fetchCommunityCommentModerationTarget,
  fetchCommunityCommentsBatch,
  sendCommunityCommentModeration,
  type CommunityCommentModerationTarget,
} from "@/lib/comments/commentClient";
import type { CommunityCommentPublicDto } from "@/lib/comments/commentDto";

type ModerationAction = "remove" | "restore";
type TeamActionView = "menu" | "moderate";

function ModerationConfirmation({
  action,
  busy,
  onCancel,
  onConfirm,
}: {
  action: ModerationAction;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useEffect(() => confirmRef.current?.focus(), []);
  const verb = action === "remove" ? "Remove" : "Restore";
  return (
    <div
      className="mt-3 rounded-xl border border-orange-300/25 bg-black/70 p-3"
      role="alertdialog"
      aria-labelledby={titleId}
    >
      <p id={titleId} className="font-semibold text-white">{verb} this Comment?</p>
      <p className="mt-1 text-xs text-white/60">
        This writes an audited moderation event and does not change Report or Spam cases.
      </p>
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="min-h-10 rounded-full border border-white/15 px-3 py-2 font-semibold text-white/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          ref={confirmRef}
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className={`min-h-10 rounded-full px-3 py-2 font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-50 ${
            action === "remove" ? "bg-red-500 text-white" : "bg-orange-500 text-black"
          }`}
        >
          {busy ? `${verb}…` : `Confirm ${verb.toLowerCase()}`}
        </button>
      </div>
    </div>
  );
}

export default function CommunityCommentInlineModerationMenu({
  publicCommentId,
  onAccessUnavailable,
  onProjection,
}: {
  publicCommentId: string;
  onAccessUnavailable: () => void;
  onProjection: (comment: CommunityCommentPublicDto) => void;
}) {
  const panelId = useId();
  const panelTitleId = useId();
  const reasonId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const requestEpochRef = useRef(0);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<TeamActionView>("menu");
  const [target, setTarget] = useState<CommunityCommentModerationTarget | null>(null);
  const [reason, setReason] = useState("");
  const [pendingAction, setPendingAction] = useState<ModerationAction | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);

  const closeMenu = useCallback((returnFocus: boolean) => {
    requestEpochRef.current += 1;
    setOpen(false);
    setView("menu");
    setTarget(null);
    setReason("");
    setPendingAction(null);
    setLoading(false);
    setStatus(null);
    if (returnFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!busy && !rootRef.current?.contains(event.target as Node)) closeMenu(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        closeMenu(true);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [busy, closeMenu, open]);

  useEffect(() => () => {
    requestEpochRef.current += 1;
  }, []);

  async function loadTarget() {
    if (loading || busy) return;
    const requestEpoch = requestEpochRef.current + 1;
    requestEpochRef.current = requestEpoch;
    setLoading(true);
    setStatus(null);
    setPendingAction(null);
    try {
      const nextTarget = await fetchCommunityCommentModerationTarget(publicCommentId);
      if (requestEpochRef.current !== requestEpoch) return;
      setTarget(nextTarget);
    } catch (error) {
      if (requestEpochRef.current !== requestEpoch) return;
      setTarget(null);
      if (
        error instanceof CommunityCommentClientError &&
        (error.status === 401 || error.status === 403)
      ) {
        setHidden(true);
        onAccessUnavailable();
        return;
      }
      setStatus(
        error instanceof CommunityCommentClientError && error.status === 503
          ? "Comment moderation is temporarily unavailable. Try again."
          : "This moderation action is no longer available.",
      );
    } finally {
      if (requestEpochRef.current === requestEpoch) setLoading(false);
    }
  }

  async function moderate(action: ModerationAction) {
    if (!target || target.claimedForReview || busy || reason.trim().length < 3) return;
    setBusy(true);
    setStatus(null);
    try {
      await sendCommunityCommentModeration({
        publicCommentId,
        action,
        expectedObjectVersion: target.objectVersion,
        expectedModerationVersion: target.moderationVersion,
        reason: reason.trim(),
        requestId: crypto.randomUUID(),
      });
      let projection: CommunityCommentPublicDto | undefined;
      try {
        [projection] = await fetchCommunityCommentsBatch([publicCommentId]);
      } catch {
        // The normal thread reconciliation remains the fallback after a saved action.
      }
      if (!projection) {
        setTarget(null);
        setReason("");
        setPendingAction(null);
        setStatus("The moderation action succeeded. The public Comment will refresh automatically.");
        return;
      }
      onProjection(projection);
      closeMenu(true);
    } catch (error) {
      if (
        error instanceof CommunityCommentClientError &&
        (error.status === 401 || error.status === 403)
      ) {
        setHidden(true);
        onAccessUnavailable();
        return;
      }
      if (
        error instanceof CommunityCommentClientError &&
        ["COMMENT_MODERATION_STALE", "COMMENT_MODERATION_UNAVAILABLE"].includes(error.code)
      ) {
        setTarget(null);
      }
      setPendingAction(null);
      if (
        error instanceof CommunityCommentClientError &&
        error.code === "COMMENT_MODERATION_CLAIMED"
      ) {
        setTarget((current) => current ? { ...current, claimedForReview: true } : current);
        setStatus(null);
        return;
      }
      setStatus(
        error instanceof CommunityCommentClientError && error.code === "COMMENT_MODERATION_STALE"
          ? "This Comment changed. Reload the moderation target and review the current state."
          : "The action is unavailable. The visible Comment was not changed.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (hidden) return null;
  const unavailable = target?.authorDeleted === true || target?.submissionEligible !== true;
  const action: ModerationAction | null = target && !unavailable && !target.claimedForReview
    ? target.removed ? "restore" : "remove"
    : null;

  return (
    <div ref={rootRef} className="relative ml-auto">
      <button
        ref={triggerRef}
        type="button"
        aria-label="Team actions"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title="Team actions"
        onClick={() => {
          if (open) closeMenu(false);
          else {
            setOpen(true);
            setView("menu");
          }
        }}
        className="inline-flex min-h-8 min-w-8 items-center justify-center rounded-full text-xl font-bold leading-none text-orange-200/80 hover:bg-orange-500/10 hover:text-orange-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400"
      >
        <span aria-hidden="true">⋮</span>
      </button>
      {open ? (
        <div
          id={panelId}
          role="dialog"
          aria-labelledby={panelTitleId}
          className="absolute right-0 z-30 mt-2 w-[min(20rem,calc(100vw-2rem))] rounded-xl border border-orange-300/20 bg-neutral-950 p-3 text-sm shadow-xl"
        >
          <div className="flex items-center justify-between gap-3">
            <p id={panelTitleId} className="font-semibold text-orange-100">
              {view === "menu" ? "Team actions" : "Moderate Comment"}
            </p>
            <button
              type="button"
              aria-label="Close Team actions"
              disabled={busy}
              onClick={() => closeMenu(true)}
              className="inline-flex min-h-8 min-w-8 items-center justify-center rounded-full text-lg text-white/60 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 disabled:opacity-50"
            >
              <span aria-hidden="true">×</span>
            </button>
          </div>

          {view === "menu" ? (
            <button
              type="button"
              onClick={() => {
                setView("moderate");
                void loadTarget();
              }}
              className="mt-3 flex min-h-11 w-full items-center rounded-lg border border-white/10 px-3 py-2 text-left font-semibold text-white/80 hover:border-orange-300/35 hover:bg-orange-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400"
            >
              Moderate Comment
            </button>
          ) : (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  requestEpochRef.current += 1;
                  setView("menu");
                  setTarget(null);
                  setReason("");
                  setPendingAction(null);
                  setLoading(false);
                  setStatus(null);
                }}
                className="mt-2 min-h-9 rounded px-1 py-1 text-sm font-semibold text-white/60 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 disabled:opacity-50"
              >
                ← Team actions
              </button>
              {loading ? <p role="status" className="mt-3 text-white/60">Loading moderation target…</p> : null}
              {target?.claimedForReview ? (
                <div
                  className="mt-3 rounded-xl border border-orange-300/25 bg-orange-500/10 p-3"
                  role="status"
                >
                  <p className="font-semibold text-orange-100">Already being reviewed</p>
                  <p className="mt-1 text-xs text-white/65">
                    This Comment is being handled in a claimed Team Inbox case. Direct moderation is available again after the case is returned or solved.
                  </p>
                </div>
              ) : target && action ? (
                <>
                  {target.reviewContext ? (
                    <CommunityCommentModerationReviewContextView context={target.reviewContext} />
                  ) : null}
                  <label htmlFor={reasonId} className="mt-3 block font-semibold text-white/75">
                    Internal reason (required)
                  </label>
                  <textarea
                    id={reasonId}
                    value={reason}
                    onChange={(event) => setReason(event.target.value.slice(0, 1000))}
                    disabled={busy || pendingAction !== null}
                    className="mt-2 min-h-20 w-full rounded-lg border border-white/15 bg-black p-2 text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 disabled:opacity-50"
                  />
                  {pendingAction === null ? (
                    <div className="mt-3 flex justify-end">
                      <button
                        type="button"
                        disabled={busy || reason.trim().length < 3}
                        onClick={() => setPendingAction(action)}
                        className={`min-h-10 rounded-full px-3 py-2 font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-40 ${
                          action === "remove" ? "bg-red-500 text-white" : "bg-orange-500 text-black"
                        }`}
                      >
                        {action === "remove" ? "Review removal" : "Review restore"}
                      </button>
                    </div>
                  ) : (
                    <ModerationConfirmation
                      action={pendingAction}
                      busy={busy}
                      onCancel={() => setPendingAction(null)}
                      onConfirm={() => void moderate(pendingAction)}
                    />
                  )}
                </>
              ) : target && unavailable ? (
                <p className="mt-3 text-white/60" role="status">This Comment cannot be removed or restored.</p>
              ) : null}
              {status ? (
                <p
                  className="mt-3 text-white/70"
                  role={status.includes("changed") || status.includes("unavailable") ? "alert" : "status"}
                >
                  {status}
                </p>
              ) : null}
              {!loading && !target ? (
                <button
                  type="button"
                  onClick={() => void loadTarget()}
                  className="mt-3 min-h-10 rounded-full border border-white/15 px-3 py-2 font-semibold text-white/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400"
                >
                  Reload target
                </button>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
