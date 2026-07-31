"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { reviewUserFlagCase } from "@/app/admin/actions/reviewUserFlagCase";

export default function FlagCaseReviewActions({
  caseId,
  rowVersion,
}: {
  caseId: string;
  rowVersion: number;
}) {
  const router = useRouter();
  const [reviewReason, setReviewReason] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  async function submit(status: "resolved" | "dismissed") {
    if (
      !window.confirm(
        `Confirm that this case should be marked ${status}?`
      )
    ) {
      return;
    }

    setPending(true);
    setMessage(null);
    setStale(false);

    try {
      const result = await reviewUserFlagCase({
        caseId,
        expectedRowVersion: rowVersion,
        status,
        reviewReason,
        idempotencyKey: crypto.randomUUID(),
      });

      if (!result.success) {
        setMessage(result.message);
        setStale(true);
        return;
      }

      setMessage(`Case marked ${result.status}.`);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <section style={{ marginTop: 20, maxWidth: 640 }}>
      <h2>Review decision</h2>
      <label style={{ display: "block", marginTop: 8 }}>
        Required decision reason
        <textarea
          value={reviewReason}
          maxLength={1000}
          disabled={pending}
          onChange={(event) => setReviewReason(event.target.value)}
          style={{ display: "block", width: "100%", marginTop: 4 }}
        />
      </label>
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button
          disabled={pending || reviewReason.trim().length < 3}
          onClick={() => submit("resolved")}
        >
          {pending ? "Saving..." : "Resolve case"}
        </button>
        <button
          disabled={pending || reviewReason.trim().length < 3}
          onClick={() => submit("dismissed")}
        >
          {pending ? "Saving..." : "Dismiss case"}
        </button>
      </div>
      {message ? <p role="status">{message}</p> : null}
      {stale ? (
        <button onClick={() => router.refresh()}>Refresh case</button>
      ) : null}
    </section>
  );
}
