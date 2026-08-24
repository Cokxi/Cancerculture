"use client";

import { useId, useState } from "react";
import TurnstileWidget from "@/app/components/TurnstileWidget";
import {
  COMMUNITY_COMMENT_REPORT_CATEGORIES,
  COMMUNITY_COMMENT_REPORT_LABELS,
  type CommunityCommentReportCategory,
} from "@/lib/comments/commentReportContract";
import {
  TURNSTILE_ACTIONS,
  TURNSTILE_TOKEN_HEADER,
} from "@/lib/turnstile/shared";

export default function CommunityCommentReportDialog({
  publicCommentId,
  siteKey,
  onClose,
}: {
  publicCommentId: string;
  siteKey: string | null;
  onClose: () => void;
}) {
  const titleId = useId();
  const [category, setCategory] = useState<CommunityCommentReportCategory>(
    "hate_discriminatory",
  );
  const [explanation, setExplanation] = useState("");
  const [rulesAffirmed, setRulesAffirmed] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const explanationValid = category === "other"
    ? explanation.trim().length >= 20 && explanation.trim().length <= 500
    : explanation.trim().length === 0 ||
      (explanation.trim().length >= 10 && explanation.trim().length <= 500);

  async function submit() {
    if (busy || !turnstileToken || !rulesAffirmed || !explanationValid) return;
    setBusy(true);
    setStatus(null);
    try {
      const response = await fetch(
        `/api/comments/${encodeURIComponent(publicCommentId)}/report`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [TURNSTILE_TOKEN_HEADER]: turnstileToken,
          },
          body: JSON.stringify({
            category,
            explanation: explanation.trim() || null,
            requestId: crypto.randomUUID(),
            rulesAffirmed,
          }),
        },
      );
      const result = await response.json() as Record<string, unknown>;
      if (!response.ok) {
        setStatus(
          result.error === "COMMENT_REPORT_SELF_FORBIDDEN"
            ? "You cannot report your own comment."
            : result.error === "COMMENT_NOT_FOUND"
              ? "This comment is no longer available."
              : "The report could not be submitted. Please try again.",
        );
        return;
      }
      setStatus(
        result.outcome === "already_reported"
          ? "You already reported this comment."
          : "Report received. Thank you for helping keep the community safe.",
      );
    } catch {
      setStatus("The report could not be submitted. Please try again.");
    } finally {
      setTurnstileToken(null);
      setTurnstileResetKey((value) => value + 1);
      setBusy(false);
    }
  }

  const complete = status?.startsWith("Report received") || status?.startsWith("You already");
  return (
    <div className="mt-3 rounded-2xl border border-orange-300/30 bg-neutral-950 p-4" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 id={titleId} className="font-semibold text-orange-100">Report comment</h3>
          <p className="mt-1 text-sm text-white/65">Reports are private and cannot be withdrawn. The author will not see who reported them.</p>
        </div>
        <button type="button" onClick={onClose} className="min-h-11 rounded-lg px-3 text-white/65 hover:text-white">Close</button>
      </div>
      {!complete ? (
        <div className="mt-4 space-y-4">
          <label className="block text-sm font-semibold text-white/80">
            Reason
            <select value={category} onChange={(event) => setCategory(event.target.value as CommunityCommentReportCategory)} className="mt-2 min-h-11 w-full rounded-lg border border-white/15 bg-black px-3">
              {COMMUNITY_COMMENT_REPORT_CATEGORIES.map((value) => (
                <option key={value} value={value}>{COMMUNITY_COMMENT_REPORT_LABELS[value]}</option>
              ))}
            </select>
          </label>
          <label className="block text-sm font-semibold text-white/80">
            Context {category === "other" ? "(required)" : "(optional)"}
            <textarea value={explanation} onChange={(event) => setExplanation(event.target.value)} maxLength={500} rows={4} className="mt-2 w-full rounded-lg border border-white/15 bg-black p-3 font-normal" />
          </label>
          {!explanationValid ? <p className="text-sm text-red-200">Use {category === "other" ? "20–500" : "10–500"} characters.</p> : null}
          <label className="flex items-start gap-3 text-sm text-white/75">
            <input type="checkbox" checked={rulesAffirmed} onChange={(event) => setRulesAffirmed(event.target.checked)} className="mt-1" />
            <span>I confirm this report is accurate under the current Rules. Knowingly false or spam reports may lead to account action.</span>
          </label>
          <TurnstileWidget action={TURNSTILE_ACTIONS.communityCommentReport} siteKey={siteKey} resetKey={turnstileResetKey} onTokenChange={setTurnstileToken} />
          <button type="button" onClick={() => void submit()} disabled={busy || !turnstileToken || !rulesAffirmed || !explanationValid} className="min-h-11 rounded-full bg-orange-500 px-5 font-bold text-black disabled:opacity-45">
            {busy ? "Submitting…" : "Submit report"}
          </button>
        </div>
      ) : null}
      {status ? <p className="mt-4 text-sm text-white/80" role="status">{status}</p> : null}
    </div>
  );
}
