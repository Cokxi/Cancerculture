"use client";

import { useState } from "react";

function Section({ title, children }: any) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border-2 border-[var(--orange-dark)]/60 rounded-lg bg-black/30">
      <button
        onClick={() => setOpen(!open)}
        className="w-full text-left px-4 py-3 flex justify-between items-center font-[var(--font-marker)] text-[var(--orange-dark)] tracking-wide hover:bg-[var(--orange-dark)]/10 transition"
      >
        {title}
        <span className="text-lg">{open ? "−" : "+"}</span>
      </button>

      {open && <div className="p-4">{children}</div>}
    </div>
  );
}

export default function ProfileSections({ submissions, votes, submissionMap }: any) {
  return (
    <div className="space-y-4">
      
      <Section title="My Submissions">
        <div className="space-y-4">
          {submissions.map((s: any, i: number) => (
            <div
              key={s.id}
              className="border-2 border-[var(--orange-dark)]/40 bg-black/40 p-4 rounded-lg text-white"
            >
              {s.image_url ? (
                <img
                  src={s.image_url}
                  className="w-40 h-40 object-cover mb-2 rounded"
                />
              ) : (
                <div className="w-40 h-40 bg-orange-200 flex items-center justify-center mb-2 rounded">
                  🚫
                </div>
              )}

              <p className="text-sm text-gray-300">
                Cycle: {s.cycle_id}
              </p>

              <p className="text-sm text-gray-300">
                Votes: {s.vote_count}
              </p>

              <p className="text-sm text-gray-300">
  Rank:{" "}
  <span className="font-[var(--font-marker)] text-[var(--orange-dark)]">
  Rank:{" "}
  {s.rank === 1 && "🥇 "}
  {s.rank === 2 && "🥈 "}
  {s.rank === 3 && "🥉 "}
  {s.rank
    ? `${s.rank} / ${s.total}${
        s.tie_count > 1 ? ` (${s.tie_count} tied)` : ""
      }`
    : "-"}
</span>
</p>
<div className="mt-2 text-xs">
  {s.is_disqualified ? (
    <div className="text-red-400">
      🔴 Disqualified

      {s.disqualification_reason_code && (
  <div className="text-red-300 text-[11px] mt-1">
    {s.disqualification_reason_code.replace("_", " ")}
  </div>
)}
      
      {s.disqualification_reason_text && (
        <div className="text-red-300 text-[11px] mt-1">
          {s.disqualification_reason_text}
        </div>
      )}

      {s.disqualified_by_discord_username && (
        <div className="text-red-300 text-[11px]">
          by {s.disqualified_by_discord_username}
        </div>
      )}
    </div>
  ) : (
    <div className="text-green-400">
      🟢 Active
    </div>
  )}
</div>
            </div>
          ))}
        </div>
      </Section>

    
      <Section title="My Votes">

  {votes && votes.length > 0 ? (
    <div className="space-y-3">
      
      {votes.map((vote: any) => {
  const submission = submissionMap.get(String(vote.submission_id));

  return (
    <div
      key={`${vote.cycle_id}-${vote.submission_id}`}
      className="border border-[#222] bg-[#0b0b0b] p-3 rounded text-sm"
    >
      <div>
        <strong>Cycle #{vote.cycle_id}</strong>
      </div>

     
      {(() => {
  const imageUrl =
    submission?.image_url ||
    (submission?.r2_key
      ? `${process.env.NEXT_PUBLIC_R2_PUBLIC_URL}/${submission.r2_key}`
      : null);

  return imageUrl ? (
    <img
      src={imageUrl}
      className="w-24 h-24 object-cover rounded border border-[#222] mt-2"
    />
  ) : (
    <div className="w-24 h-24 bg-orange-200/20 flex items-center justify-center rounded mt-2">
      🚫
    </div>
  );
})()}

      <div className="text-gray-500 text-xs mt-2">
        {vote.created_at
          ? new Date(vote.created_at).toLocaleString()
          : ""}
      </div>
    </div>
  );
})}
    </div>
  ) : (
    <div className="text-gray-500 text-sm">
      No votes yet
    </div>
  )}
</Section>

      
      <Section title="My Comments">
        <p className="text-sm text-gray-400">
          Coming soon...
        </p>
      </Section>
    </div>
  );
}