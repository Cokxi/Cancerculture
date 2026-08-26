"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  CommunityCommentClientError,
  fetchCommunityCommentWarningTarget,
  sendCommunityCommentWarning,
  type CommunityCommentWarningCategory,
  type CommunityCommentWarningReceipt,
  type CommunityCommentWarningTarget,
} from "@/lib/comments/commentClient";

const categoryLabels: Readonly<
  Record<CommunityCommentWarningCategory, string>
> = {
  spam: "Spam",
  hate_speech: "Hate speech",
  other: "Other",
};

function WarningConfirmation({
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
    <div
      className="mt-3 rounded-xl border border-orange-300/25 bg-black/70 p-3"
      role="alertdialog"
      aria-labelledby={titleId}
    >
      <p id={titleId} className="font-semibold text-white">
        Issue this Warning?
      </p>
      <p className="mt-1 text-xs leading-relaxed text-white/60">
        This creates one audited Warning permanently bound to this exact Comment.
        The database assigns its duration automatically. It does not remove the
        Comment or create an automatic ban or participation hold.
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
          className="min-h-10 rounded-full bg-orange-500 px-3 py-2 font-bold text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-50"
        >
          {busy ? "Issuing…" : "Confirm Warning"}
        </button>
      </div>
    </div>
  );
}

function successCopy(receipt: CommunityCommentWarningReceipt) {
  const unit = receipt.tierDays === 1 ? "day" : "days";
  const expiry = new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(receipt.expiresAt));
  return `Warning issued for ${receipt.tierDays} ${unit}. Expires ${expiry} UTC.`;
}

export default function CommunityCommentWarningPanel({
  publicCommentId,
  onAccessUnavailable,
  onBusyChange,
}: {
  publicCommentId: string;
  onAccessUnavailable: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const categoryId = useId();
  const reasonId = useId();
  const accessUnavailableRef = useRef(onAccessUnavailable);
  const busyChangeRef = useRef(onBusyChange);
  const requestEpochRef = useRef(0);
  const [target, setTarget] = useState<CommunityCommentWarningTarget | null>(null);
  const [category, setCategory] = useState<CommunityCommentWarningCategory | "">("");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<CommunityCommentWarningReceipt | null>(null);

  accessUnavailableRef.current = onAccessUnavailable;
  busyChangeRef.current = onBusyChange;

  useEffect(() => {
    busyChangeRef.current(busy);
  }, [busy]);

  useEffect(() => () => {
    busyChangeRef.current(false);
  }, []);

  const loadTarget = useCallback(async () => {
    const requestEpoch = requestEpochRef.current + 1;
    requestEpochRef.current = requestEpoch;
    setLoading(true);
    setStatus(null);
    setTarget(null);
    setPending(false);
    try {
      const nextTarget = await fetchCommunityCommentWarningTarget(publicCommentId);
      if (requestEpochRef.current !== requestEpoch) return;
      setTarget(nextTarget);
    } catch (error) {
      if (requestEpochRef.current !== requestEpoch) return;
      if (
        error instanceof CommunityCommentClientError &&
        (error.status === 401 || error.status === 403)
      ) {
        accessUnavailableRef.current();
        return;
      }
      setStatus(
        error instanceof CommunityCommentClientError && error.status === 503
          ? "Warning review is temporarily unavailable. Try again."
          : "This Comment is no longer available for a Warning.",
      );
    } finally {
      if (requestEpochRef.current === requestEpoch) setLoading(false);
    }
  }, [publicCommentId]);

  useEffect(() => {
    void loadTarget();
    return () => {
      requestEpochRef.current += 1;
    };
  }, [loadTarget]);

  async function issueWarning() {
    if (
      !target || !target.available || target.alreadyWarned ||
      busy || !category || reason.trim().length < 3
    ) return;
    setBusy(true);
    setStatus(null);
    try {
      const nextReceipt = await sendCommunityCommentWarning({
        publicCommentId,
        expectedObjectVersion: target.objectVersion,
        expectedTextVersion: target.textVersion,
        category,
        reason: reason.trim(),
        requestId: crypto.randomUUID(),
      });
      setReceipt(nextReceipt);
      setTarget((current) => current
        ? { ...current, alreadyWarned: true }
        : current);
      setCategory("");
      setReason("");
      setPending(false);
    } catch (error) {
      if (
        error instanceof CommunityCommentClientError &&
        (error.status === 401 || error.status === 403)
      ) {
        accessUnavailableRef.current();
        return;
      }
      if (
        error instanceof CommunityCommentClientError &&
        error.code === "COMMENT_WARNING_ALREADY_ISSUED"
      ) {
        setTarget((current) => current
          ? { ...current, alreadyWarned: true }
          : current);
        setStatus("A Warning has already been issued for this Comment.");
      } else if (
        error instanceof CommunityCommentClientError &&
        error.code === "COMMENT_WARNING_STALE"
      ) {
        setTarget(null);
        setStatus("This Comment changed. Reload it and review the exact current text.");
      } else {
        setStatus("The Warning was not issued. Review the current Comment and try again.");
      }
      setPending(false);
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <p role="status" className="mt-3 text-white/60">Loading Warning target…</p>;
  }

  if (receipt) {
    return (
      <div className="mt-3 rounded-xl border border-green-300/25 bg-green-500/10 p-3" role="status">
        <p className="font-semibold text-green-100">Warning issued</p>
        <p className="mt-1 text-xs text-white/70">{successCopy(receipt)}</p>
      </div>
    );
  }

  return (
    <>
      {target?.alreadyWarned ? (
        <div className="mt-3 rounded-xl border border-white/15 bg-white/5 p-3" role="status">
          <p className="font-semibold text-white/85">Warning already issued</p>
          <p className="mt-1 text-xs text-white/60">
            This Comment is permanently linked to an existing Warning and cannot
            be used for another one.
          </p>
        </div>
      ) : target && !target.available ? (
        <p className="mt-3 text-white/60" role="status">
          This Comment cannot receive a Warning.
        </p>
      ) : target ? (
        <>
          <section className="mt-3 rounded-xl border border-white/10 bg-black/45 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-white/45">
              Exact Comment evidence · Object v{target.objectVersion} · Text v{target.textVersion}
            </p>
            <p className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-white/80">
              {target.text}
            </p>
          </section>
          <label htmlFor={categoryId} className="mt-3 block font-semibold text-white/75">
            Category (required)
          </label>
          <select
            id={categoryId}
            value={category}
            onChange={(event) => setCategory(event.target.value as CommunityCommentWarningCategory | "")}
            disabled={busy || pending}
            className="mt-2 min-h-11 w-full rounded-lg border border-white/15 bg-black px-3 text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 disabled:opacity-50"
          >
            <option value="">Choose a category</option>
            {Object.entries(categoryLabels).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          <label htmlFor={reasonId} className="mt-3 block font-semibold text-white/75">
            Warning message (required)
          </label>
          <textarea
            id={reasonId}
            value={reason}
            onChange={(event) => setReason(event.target.value.slice(0, 1000))}
            disabled={busy || pending}
            placeholder="Explain clearly why this Comment crosses the line."
            className="mt-2 min-h-24 w-full rounded-lg border border-white/15 bg-black p-2 text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 disabled:opacity-50"
          />
          <p className="mt-1 text-xs text-white/45">
            The duration is assigned automatically. This action does not remove the Comment.
          </p>
          {!pending ? (
            <div className="mt-3 flex justify-end">
              <button
                type="button"
                disabled={busy || !category || reason.trim().length < 3}
                onClick={() => setPending(true)}
                className="min-h-10 rounded-full bg-orange-500 px-3 py-2 font-bold text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-40"
              >
                Review Warning
              </button>
            </div>
          ) : (
            <WarningConfirmation
              busy={busy}
              onCancel={() => setPending(false)}
              onConfirm={() => void issueWarning()}
            />
          )}
        </>
      ) : null}
      {status ? (
        <p className="mt-3 text-white/70" role="alert">{status}</p>
      ) : null}
      {!target && !loading ? (
        <button
          type="button"
          onClick={() => void loadTarget()}
          className="mt-3 min-h-10 rounded-full border border-white/15 px-3 py-2 font-semibold text-white/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400"
        >
          Reload Warning target
        </button>
      ) : null}
    </>
  );
}
