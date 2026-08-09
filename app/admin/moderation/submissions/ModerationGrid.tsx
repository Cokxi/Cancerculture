"use client";

import {
  createModerationIdempotencyKey,
  finishModerationRequest,
  performModerationClientRequest,
  tryBeginModerationRequest,
  waitForModerationPendingPaint,
} from "@/lib/moderation/moderationClientRequest";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";

type Submission = {
  id: number;
  cycle_id: number;
  image_url: string;
  thumb_url: string;
  is_disqualified: boolean;
  discord_user_id: string | null;
  vote_refund_id: string | null;
  vote_refunded_at: string | null;
};

const RULE_VIOLATION_REASONS = [
  "spam",
  "nudity",
  "hate",
  "harassment",
  "low_effort",
  "off_topic",
];

const ILLEGAL_CONTENT_REASONS = [
  "child_abuse",
  "terrorism",
  "extreme_violence",
  "illegal_drugs",
  "copyright_violation",
];

export default function ModerationGrid({
  submissions,
  phase,
  canDisqualify,
  canReinstate,
  focusedSubmissionId = null,
}: {
  submissions: Submission[];
  phase: "submission_open" | "voting_open" | "voting_closed";
  canDisqualify: boolean;
  canReinstate: boolean;
  focusedSubmissionId?: number | null;
}) {
  const [openFor, setOpenFor] = useState<number | null>(null);
  const [disqualificationType, setDisqualificationType] =
    useState<"rule_violation" | "illegal_content">(
      "rule_violation"
    );
  const [reasonCode, setReasonCode] = useState("");
  const [reasonText, setReasonText] = useState("");
  const requestPendingRef = useRef(false);
  const [pendingAction, setPendingAction] = useState<string | null>(
    null
  );

  useEffect(() => {
    if (focusedSubmissionId === null) return;
    const target = document.getElementById(
      `moderation-submission-${focusedSubmissionId}`
    );
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
    target?.focus({ preventScroll: true });
  }, [focusedSubmissionId, submissions]);

  async function handleDisqualify(id: number) {
    if (!tryBeginModerationRequest(requestPendingRef)) return;

    if (!reasonCode) {
      alert("Please select a reason");
      finishModerationRequest(requestPendingRef);
      return;
    }

    setPendingAction(`disqualify:${id}`);
    let outcome: Awaited<
      ReturnType<typeof performModerationClientRequest>
    >;
    try {
      outcome = await performModerationClientRequest({
        endpoint: "/api/admin/disqualify",
        body: {
          cycleId: submissions.find(
            (submission) => submission.id === id
          )?.cycle_id,
          submissionId: id,
          expectedPhase: phase,
          expectedIsDisqualified: false,
          disqualificationType,
          reasonCode,
          reasonText: reasonText || null,
          idempotencyKey: createModerationIdempotencyKey(),
        },
        finishPending: async () => {
          finishModerationRequest(requestPendingRef);
          setPendingAction(null);
          await waitForModerationPendingPaint();
        },
      });
    } finally {
      if (requestPendingRef.current) {
        finishModerationRequest(requestPendingRef);
        setPendingAction(null);
      }
    }

    if (outcome === "changed") {
      setOpenFor(null);
      setReasonCode("");
      setReasonText("");
    }
  }

  async function handleReinstate(id: number) {
    if (!tryBeginModerationRequest(requestPendingRef)) return;

    const reason = prompt(
      "Reason for reinstating this submission:"
    );
    if (!reason?.trim() || reason.trim().length < 3) {
      finishModerationRequest(requestPendingRef);
      return;
    }

    setPendingAction(`reinstate:${id}`);
    try {
      await performModerationClientRequest({
        endpoint: "/api/admin/reinstate",
        body: {
          cycleId: submissions.find(
            (submission) => submission.id === id
          )?.cycle_id,
          submissionId: id,
          expectedPhase: phase,
          expectedIsDisqualified: true,
          disqualificationType: null,
          reasonCode: "manual_review",
          reasonText: reason.trim(),
          idempotencyKey: createModerationIdempotencyKey(),
        },
        finishPending: async () => {
          finishModerationRequest(requestPendingRef);
          setPendingAction(null);
          await waitForModerationPendingPaint();
        },
      });
    } finally {
      if (requestPendingRef.current) {
        finishModerationRequest(requestPendingRef);
        setPendingAction(null);
      }
    }
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns:
          "repeat(auto-fill, minmax(240px, 1fr))",
        gap: 16,
        marginTop: 24,
      }}
    >
      {submissions.map((submission) => {
        const isFocused = submission.id === focusedSubmissionId;
        return (
        <div
          key={submission.id}
          id={`moderation-submission-${submission.id}`}
          tabIndex={isFocused ? -1 : undefined}
          style={{
            border: isFocused ? "2px solid #ff6a00" : "1px solid #222",
            padding: 12,
            borderRadius: 8,
            background: "#0b0b0b",
            color: "#fff",
            boxShadow: isFocused
              ? "0 0 24px rgba(255, 106, 0, 0.35)"
              : undefined,
            scrollMarginTop: 96,
            outline: "none",
          }}
        >
          <a
            href={submission.image_url}
            target="_blank"
            rel="noopener noreferrer"
            style={{ display: "block" }}
          >
            <Image
              src={submission.thumb_url || submission.image_url}
              alt=""
              width={400}
              height={150}
              unoptimized
              style={{
                width: "100%",
                height: 150,
                objectFit: "cover",
                marginBottom: 8,
                cursor: "pointer",
              }}
            />
          </a>

          <div style={{ fontSize: 12 }}>
            Cycle #{submission.cycle_id}
          </div>

          <div style={{ fontSize: 11, opacity: 0.6 }}>
            Discord ID:{" "}
            {submission.discord_user_id ? (
              <a
                href={`/admin/users?focus=${submission.discord_user_id}`}
                style={{
                  color: "#ff9800",
                  textDecoration: "underline",
                  cursor: "pointer",
                  fontFamily: "monospace",
                }}
              >
                {submission.discord_user_id}
              </a>
            ) : (
              "—"
            )}
          </div>

          <div
            style={{
              fontWeight: "bold",
              color: submission.is_disqualified ? "red" : "green",
              marginTop: 8,
              marginBottom: 8,
            }}
          >
            {submission.is_disqualified ? "Disqualified" : "Active"}
          </div>

          {!submission.is_disqualified && canDisqualify ? (
            <>
              <button
                style={{
                  padding: "6px 10px",
                  background: "#ff4d4f",
                  color: "#fff",
                  border: "none",
                  borderRadius: 4,
                  cursor: "pointer",
                  fontSize: 13,
                }}
                onClick={() =>
                  setOpenFor(
                    openFor === submission.id ? null : submission.id
                  )
                }
              >
                Disqualify
              </button>

              {openFor === submission.id && (
                <div
                  style={{
                    marginTop: 10,
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                    background: "#fff",
                    padding: 8,
                    borderRadius: 4,
                  }}
                >
                  <label style={{ fontSize: 12, color: "#111" }}>
                    Type
                  </label>
                  <select
                    value={disqualificationType}
                    onChange={(event) =>
                      setDisqualificationType(
                        event.target.value as
                          | "rule_violation"
                          | "illegal_content"
                      )
                    }
                    style={{
                      padding: "6px",
                      fontSize: 13,
                      color: "#111",
                      background: "#fff",
                      border: "1px solid #ccc",
                      borderRadius: 4,
                    }}
                  >
                    <option value="rule_violation">
                      Rule violation
                    </option>
                    <option value="illegal_content">
                      Illegal content
                    </option>
                  </select>

                  <label style={{ fontSize: 12, color: "#111" }}>
                    Reason
                  </label>
                  <select
                    value={reasonCode}
                    onChange={(event) =>
                      setReasonCode(event.target.value)
                    }
                    style={{
                      padding: "6px",
                      fontSize: 13,
                      color: "#111",
                      background: "#fff",
                      border: "1px solid #ccc",
                      borderRadius: 4,
                    }}
                  >
                    <option value="">-- select --</option>
                    {(disqualificationType === "rule_violation"
                      ? RULE_VIOLATION_REASONS
                      : ILLEGAL_CONTENT_REASONS
                    ).map((reason) => (
                      <option key={reason} value={reason}>
                        {reason}
                      </option>
                    ))}
                  </select>

                  <label style={{ fontSize: 12, color: "#111" }}>
                    Details (optional)
                  </label>
                  <textarea
                    rows={2}
                    value={reasonText}
                    onChange={(event) =>
                      setReasonText(event.target.value)
                    }
                    style={{
                      padding: "6px",
                      fontSize: 13,
                      color: "#111",
                      background: "#fff",
                      border: "1px solid #ccc",
                      borderRadius: 4,
                      resize: "vertical",
                    }}
                  />

                  <button
                    disabled={pendingAction === `disqualify:${submission.id}`}
                    style={{
                      marginTop: 6,
                      padding: "6px 10px",
                      background: "#111",
                      color: "#fff",
                      border: "none",
                      borderRadius: 4,
                      cursor:
                        pendingAction === `disqualify:${submission.id}`
                          ? "not-allowed"
                          : "pointer",
                      fontSize: 13,
                    }}
                    onClick={() =>
                      handleDisqualify(submission.id)
                    }
                  >
                    {pendingAction === `disqualify:${submission.id}`
                      ? "Disqualifying..."
                      : "Confirm Disqualify"}
                  </button>
                </div>
              )}
            </>
          ) : submission.is_disqualified && submission.vote_refund_id ? (
            <div
              style={{
                padding: "6px 10px",
                border: "1px solid #a16207",
                borderRadius: 4,
                color: "#fcd34d",
                fontSize: 12,
              }}
            >
              Votes refunded · reinstatement unavailable
            </div>
          ) : submission.is_disqualified && canReinstate ? (
            <button
              disabled={pendingAction === `reinstate:${submission.id}`}
              style={{
                padding: "6px 10px",
                background: "#df2323",
                color: "#ffffff",
                border: "1px solid #d3430b",
                borderRadius: 4,
                cursor:
                  pendingAction === `reinstate:${submission.id}`
                    ? "not-allowed"
                    : "pointer",
                fontSize: 13,
              }}
              onClick={() =>
                handleReinstate(submission.id)
              }
            >
              {pendingAction === `reinstate:${submission.id}`
                ? "Reinstating..."
                : "Reinstate"}
            </button>
          ) : null}
        </div>
        );
      })}
    </div>
  );
}
