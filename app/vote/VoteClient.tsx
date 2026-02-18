"use client";

import { useState, useRef } from "react";

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

  const [showOriginalSize, setShowOriginalSize] = useState(false);
const lastTapRef = useRef(0);

function handleToggleSize() {
  setShowOriginalSize(prev => !prev);
}

function handleTouchStart() {
  const now = Date.now();
  if (now - lastTapRef.current < 300) {
  handleToggleSize();
}
lastTapRef.current = now;

}

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
      <div className="min-h-screen pt-20 px-6 pb-6 grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-3 content-start">



        {submissions.map(s => {
  const url = new URL(s.image_url);

  const thumbSrc =
    `${url.origin}/cdn-cgi/image/w=400,q=75${url.pathname}`;

  return (
    <button
  key={s.id}
  onClick={() => {
    setShowOriginalSize(false);
    setActive(s);
  }}
  className="group relative aspect-square overflow-hidden rounded-lg border"
>

      <img
        src={thumbSrc}
        alt=""
        loading="lazy"
        decoding="async"
        fetchPriority="low"
        className="absolute inset-0 h-full w-full object-cover transition-transform group-hover:scale-105"
      />


      <div className="absolute bottom-0 w-full bg-black/60 text-white text-sm p-2">
        Votes: {localVotes[s.id]}
        {s.discord_user_id === discordUserId && (
          <span className="ml-2 opacity-70">(you)</span>
        )}
      </div>
    </button>
  );
})}

      </div>

      {/* MODAL */}
      {active && (
  <div
  className="fixed inset-0 z-50 bg-black/90 overflow-y-auto overscroll-contain p-6"
    onClick={() => setActive(null)}
  >
    <button
  onClick={() => setActive(null)}
  className="fixed top-4 right-4 z-[60] text-white text-2xl bg-black/60 rounded-full w-10 h-10 flex items-center justify-center hover:bg-black/80"
>
  x
</button>

    <div
  className="relative mx-auto w-fit bg-black rounded-lg"
  onClick={(e) => e.stopPropagation()}
>





            <img
  src={active.image_url}
  alt=""
  onDoubleClick={handleToggleSize}
  onTouchStart={handleTouchStart}
  className={
    showOriginalSize
      ? "w-auto h-auto max-w-none mx-auto"
      : "w-auto h-auto max-w-[75vw] max-h-[75vh] object-contain mx-auto"
  }
/>

<div className="flex justify-center py-2">
  <button
    onClick={handleToggleSize}
    className="text-xs bg-black/50 text-white px-3 py-1 rounded-full hover:bg-black/70"
  >
    {showOriginalSize ? "Fit to Screen" : "Tap to Zoom"}
  </button>
</div>


            <div className="p-4 flex items-center text-white">
  <span>Votes: {localVotes[active.id]}</span>

  <div className="ml-auto flex items-center gap-3">


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
        </div>
      )}
    </>
  );
}
