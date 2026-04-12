"use client";

import { useState } from "react";

type Submission = {
  id: number;
  cycle_id: number;
  image_url: string;
  is_disqualified: boolean;
  vote_count: number;
  discord_user_id: string | null;
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
}: {
  submissions: Submission[];
}) {
  const [openFor, setOpenFor] = useState<number | null>(null);
  const [disqualificationType, setDisqualificationType] =
    useState<"rule_violation" | "illegal_content">(
      "rule_violation"
    );
  const [reasonCode, setReasonCode] = useState("");
  const [reasonText, setReasonText] = useState("");

  async function handleDisqualify(id: number) {
    if (!reasonCode) {
      alert("Please select a reason");
      return;
    }

    const res = await fetch(
  "/api/admin/disqualify",
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      submissionId: id,
      disqualificationType,
      reasonCode,
      reasonText: reasonText || null,
    }),
  }
);


    if (!res.ok) {
      alert("Disqualify failed");
      return;
    }

    
    setOpenFor(null);
    setReasonCode("");
    setReasonText("");

    location.reload();
  }

  async function handleReinstate(id: number) {
    const confirmed = confirm(
      "Are you sure you want to reinstate this submission?"
    );
    if (!confirmed) return;

    const res = await fetch(
  "/api/admin/reinstate",
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      submissionId: id,
    }),
  }
);


    if (!res.ok) {
      alert("Reinstate failed");
      return;
    }

    location.reload();
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
      {submissions.map((s) => (
        <div
  key={s.id}
  style={{
    border: "1px solid #222",
    padding: 12,
    borderRadius: 8,
    background: "#0b0b0b",
    color: "#fff",
  }}
>

          <a
  href={s.image_url ?? undefined}
  target="_blank"
  rel="noopener noreferrer"
  style={{ display: "block" }}
>
  <img
    src={s.image_url ?? undefined}
    alt=""
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
  Cycle #{s.cycle_id}
</div>


<div style={{ fontSize: 11, opacity: 0.6 }}>
  Discord ID:{" "}
  {s.discord_user_id ? (
    <a
      href={`/admin/users?focus=${s.discord_user_id}`}
      style={{
        color: "#ff9800",
        textDecoration: "underline",
        cursor: "pointer",
        fontFamily: "monospace",
      }}
    >
      {s.discord_user_id}
    </a>
  ) : (
    "—"
  )}
</div>


<div style={{ fontSize: 12, marginBottom: 6 }}>
  Votes: {s.vote_count}
</div>

<div
  style={{
    fontWeight: "bold",
    color: s.is_disqualified ? "red" : "green",
    marginBottom: 8,
  }}
>
  {s.is_disqualified ? "Disqualified" : "Active"}
</div>



          
          {!s.is_disqualified ? (
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
                    openFor === s.id ? null : s.id
                  )
                }
              >
                Disqualify
              </button>

              {openFor === s.id && (
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
      onChange={(e) =>
        setDisqualificationType(
          e.target.value as any
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
      onChange={(e) =>
        setReasonCode(e.target.value)
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
      {(disqualificationType ===
      "rule_violation"
        ? RULE_VIOLATION_REASONS
        : ILLEGAL_CONTENT_REASONS
      ).map((r) => (
        <option key={r} value={r}>
          {r}
        </option>
      ))}
    </select>

    <label style={{ fontSize: 12, color: "#111" }}>
      Details (optional)
    </label>
    <textarea
      rows={2}
      value={reasonText}
      onChange={(e) =>
        setReasonText(e.target.value)
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
      style={{
        marginTop: 6,
        padding: "6px 10px",
        background: "#111",
        color: "#fff",
        border: "none",
        borderRadius: 4,
        cursor: "pointer",
        fontSize: 13,
      }}
      onClick={() => handleDisqualify(s.id)}
    >
      Confirm Disqualify
    </button>
  </div>
)}

            </>
          ) : (
            <button
              style={{
                padding: "6px 10px",
                background: "#df2323",
                color: "#ffffff",
                border: "1px solid #d3430b",
                borderRadius: 4,
                cursor: "pointer",
                fontSize: 13,
              }}
              onClick={() => handleReinstate(s.id)}
            >
              Reinstate
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
