"use client";

import { useState } from "react";

type Submission = {
  id: number;
  image_url: string;
  vote_count: number;
  discord_user_id: string;
};

export default function VoteClient({
  submissions,
  hasVoted,
  discordUserId,
  isBanned,
}: {
  submissions: Submission[];
  hasVoted: boolean;
  discordUserId: string;
  isBanned: boolean;
}) {


  const [active, setActive] = useState<Submission | null>(null);
  const [voted, setVoted] = useState(hasVoted);
  const [localVotes, setLocalVotes] = useState(
    Object.fromEntries(submissions.map(s => [s.id, s.vote_count]))
  );


  async function vote(submissionId: number) {
  if (isBanned) return;

  const fd = new FormData();
  fd.append("submissionId", String(submissionId));

  const res = await fetch("/api/vote", {
    method: "POST",
    body: fd,
  });

  if (!res.ok) return;

  setVoted(true);
  setLocalVotes(v => ({
    ...v,
    [submissionId]: v[submissionId] + 1,
  }));
  setActive(null);
}


  return (
    <>

    <a
  href="/"
  className="fixed top-4 left-4 z-40 bg-black/70 text-orange-500 px-3 py-2 rounded-full text-sm font-[Permanent_Marker] hover:bg-black"

>
  ← Home
</a>

      {/* GRID */}
      <div className="min-h-screen pt-20 px-6 pb-6 grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-3">


        {submissions.map(s => (
          <button
            key={s.id}
            onClick={() => setActive(s)}
            className="group relative aspect-square overflow-hidden rounded-lg border"
          >
            <img
              src={s.image_url}
              alt=""
              className="absolute inset-0 h-full w-full object-cover transition-transform group-hover:scale-105"
            />
            <div className="absolute bottom-0 w-full bg-black/60 text-white text-sm p-2">
              Votes: {localVotes[s.id]}
              {s.discord_user_id === discordUserId && (
                <span className="ml-2 opacity-70">(you)</span>
              )}
            </div>
          </button>
        ))}
      </div>

      {/* MODAL */}
      {active && (
  <div
    className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-6"
    onClick={() => setActive(null)}
  >
    <div
      className="relative max-w-3xl w-full bg-black rounded-lg overflow-hidden"
      onClick={(e) => e.stopPropagation()}
    >

            <button
              onClick={() => setActive(null)}
              className="absolute top-3 right-3 text-white text-xl"
            >
              ×
            </button>

            <img
              src={active.image_url}
              alt=""
              className="w-full object-contain max-h-[80vh]"
            />

            <div className="p-4 flex justify-between items-center text-white">
              <span>Votes: {localVotes[active.id]}</span>

              {/* OWN SUBMISSION */}
{active.discord_user_id === discordUserId && (
  <span className="opacity-70">
    You cannot vote for your own submission
  </span>
)}

{/* BANNED USER */}
{active.discord_user_id !== discordUserId && isBanned && (
  <span className="opacity-70 text-red-400">
    You’re banned from voting
  </span>
)}

{/* NORMAL VOTE */}
{active.discord_user_id !== discordUserId && !isBanned && !voted && (
  <button
    onClick={() => vote(active.id)}
    className="px-4 py-2 bg-orange-500 rounded hover:bg-orange-600 transition cursor-pointer"

  >
    Vote
  </button>
)}

{/* ALREADY VOTED */}
{active.discord_user_id !== discordUserId && !isBanned && voted && (
  <span className="opacity-70">You already voted</span>
)}


            </div>
          </div>
        </div>
      )}
    </>
  );
}
