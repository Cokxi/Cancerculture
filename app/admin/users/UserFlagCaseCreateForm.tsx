"use client";

import { useState } from "react";
import {
  checkUserFlagStatus,
  flagUser,
} from "@/app/admin/actions/flagUser";

type FlagCategory =
  | "trolling_low_effort"
  | "suspicious_behavior"
  | "other";

export default function UserFlagCaseCreateForm() {
  const [targetDiscordUserId, setTargetDiscordUserId] = useState("");
  const [category, setCategory] = useState<FlagCategory>(
    "trolling_low_effort"
  );
  const [reason, setReason] = useState("");
  const [comment, setComment] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [activeStatus, setActiveStatus] = useState<
    "open" | "escalated" | null
  >(null);

  async function refreshActiveStatus() {
    const target = targetDiscordUserId.trim();
    if (!target) return;
    try {
      const result = await checkUserFlagStatus(target);
      setActiveStatus(result.active ? result.status : null);
    } catch {
      setActiveStatus(null);
    }
  }

  async function submit() {
    setPending(true);
    setMessage(null);

    try {
      const result = await flagUser({
        targetDiscordUserId,
        category,
        reason,
        comment: comment.trim() || undefined,
        idempotencyKey: crypto.randomUUID(),
      });

      if (!result.success) {
        setMessage(result.message);
        return;
      }

      setMessage("Flag case created successfully.");
      setActiveStatus(null);
      setTargetDiscordUserId("");
      setReason("");
      setComment("");
    } finally {
      setPending(false);
    }
  }

  return (
    <section style={{ marginTop: 16, maxWidth: 560 }}>
      <p>
        Create a case for a known Discord user ID. This permission does not
        expose the user directory or any existing flag history.
      </p>
      <label style={{ display: "block", marginTop: 12 }}>
        Discord user ID
        <input
          value={targetDiscordUserId}
          disabled={pending}
          onBlur={refreshActiveStatus}
          onChange={(event) => {
            setTargetDiscordUserId(event.target.value);
            setActiveStatus(null);
          }}
          style={{ display: "block", width: "100%", marginTop: 4 }}
        />
      </label>
      {activeStatus ? (
        <p
          role="status"
          style={{ marginTop: 8, color: "#ff6b6b", fontWeight: 700 }}
        >
          🚩 Active flag case: {activeStatus}
        </p>
      ) : null}
      <label style={{ display: "block", marginTop: 12 }}>
        Category
        <select
          value={category}
          disabled={pending}
          onChange={(event) =>
            setCategory(event.target.value as FlagCategory)
          }
          style={{ display: "block", width: "100%", marginTop: 4 }}
        >
          <option value="trolling_low_effort">Trolling / low effort</option>
          <option value="suspicious_behavior">Suspicious behavior</option>
          <option value="other">Other</option>
        </select>
      </label>
      <label style={{ display: "block", marginTop: 12 }}>
        Reason
        <textarea
          value={reason}
          maxLength={1000}
          disabled={pending}
          onChange={(event) => setReason(event.target.value)}
          style={{ display: "block", width: "100%", marginTop: 4 }}
        />
      </label>
      <label style={{ display: "block", marginTop: 12 }}>
        Optional comment
        <textarea
          value={comment}
          maxLength={2000}
          disabled={pending}
          onChange={(event) => setComment(event.target.value)}
          style={{ display: "block", width: "100%", marginTop: 4 }}
        />
      </label>
      <button
        onClick={submit}
        disabled={
          pending ||
          activeStatus !== null ||
          targetDiscordUserId.trim().length === 0 ||
          reason.trim().length < 3
        }
        style={{ marginTop: 12 }}
      >
        {pending ? "Creating..." : "Create flag case"}
      </button>
      {message ? (
        <p role="status" style={{ marginTop: 8 }}>
          {message}
        </p>
      ) : null}
    </section>
  );
}
