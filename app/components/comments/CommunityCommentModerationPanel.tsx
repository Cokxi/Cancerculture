"use client";

import { useState } from "react";

type Detail = Record<string, unknown>;

export default function CommunityCommentModerationPanel() {
  const [publicCommentId, setPublicCommentId] = useState("");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [reason, setReason] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true);
    setStatus(null);
    try {
      const response = await fetch(`/api/admin/comments/moderation?comment=${encodeURIComponent(publicCommentId.trim())}`, { cache: "no-store" });
      const result = await response.json() as Detail;
      if (!response.ok || result.outcome !== "found") throw new Error("unavailable");
      setDetail(result);
    } catch {
      setDetail(null);
      setStatus("Comment not found or unavailable.");
    } finally {
      setBusy(false);
    }
  }

  async function moderate(action: "remove" | "restore") {
    if (!detail || reason.trim().length < 3) return;
    setBusy(true);
    setStatus(null);
    try {
      const response = await fetch("/api/admin/comments/moderation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          publicCommentId: publicCommentId.trim(),
          action,
          expectedObjectVersion: detail.objectVersion,
          expectedModerationVersion: detail.moderationVersion,
          reason: reason.trim(),
          requestId: crypto.randomUUID(),
        }),
      });
      const result = await response.json() as Detail;
      if (!response.ok || !["removed", "restored"].includes(String(result.outcome))) {
        throw new Error("unavailable");
      }
      setStatus(action === "remove" ? "Comment removed." : "Comment restored.");
      setReason("");
      await load();
    } catch {
      setStatus("The Comment changed or the action is unavailable. Reload it and review the current state.");
    } finally {
      setBusy(false);
    }
  }

  const comment = detail?.comment && typeof detail.comment === "object"
    ? detail.comment as Record<string, unknown>
    : null;
  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row">
        <input value={publicCommentId} onChange={(event) => setPublicCommentId(event.target.value)} placeholder="Public Comment ID" className="min-h-11 flex-1 rounded-lg border border-white/15 bg-black px-3" />
        <button type="button" disabled={busy} onClick={() => void load()} className="min-h-11 rounded-lg bg-orange-500 px-5 font-semibold text-black disabled:opacity-50">Load Comment</button>
      </div>
      {comment ? (
        <section className="rounded-2xl border border-white/10 bg-black/35 p-5">
          <p className="text-xs text-white/50">Submission #{String(comment.submissionId ?? "-")} · Object v{String(detail?.objectVersion ?? "-")} · Moderation v{String(detail?.moderationVersion ?? "-")}</p>
          <p className="mt-3 whitespace-pre-wrap text-white/85">{comment.tombstone === "team_removed" ? "Deleted by admin/mod" : comment.tombstone === "author_deleted" ? "Comment deleted by its author" : String(comment.body ?? "")}</p>
          <label className="mt-5 block text-sm text-white/70">
            Internal reason (required)
            <textarea value={reason} onChange={(event) => setReason(event.target.value.slice(0, 1000))} className="mt-2 min-h-24 w-full rounded-lg border border-white/15 bg-black p-3" />
          </label>
          <div className="mt-4 flex flex-wrap gap-3">
            {detail?.removed === true ? (
              <button type="button" disabled={busy || reason.trim().length < 3 || detail?.authorDeleted === true || detail?.submissionEligible !== true} onClick={() => void moderate("restore")} className="min-h-11 rounded-lg bg-orange-500 px-5 font-semibold text-black disabled:opacity-40">Restore Comment</button>
            ) : (
              <button type="button" disabled={busy || reason.trim().length < 3 || detail?.authorDeleted === true || detail?.submissionEligible !== true} onClick={() => void moderate("remove")} className="min-h-11 rounded-lg bg-red-500 px-5 font-semibold text-white disabled:opacity-40">Remove Comment</button>
            )}
          </div>
        </section>
      ) : null}
      {status ? <p role="status" className="text-sm text-white/70">{status}</p> : null}
    </div>
  );
}
