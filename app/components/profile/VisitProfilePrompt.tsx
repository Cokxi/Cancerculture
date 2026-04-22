"use client";

import Link from "next/link";
import { useOverlay } from "@/app/components/overlay/OverlayProvider";

export default function VisitProfilePrompt({
  currentUsername,
  profileId,
}: {
  currentUsername: string;
  profileId: string;
}) {
  const { closeOverlay } = useOverlay();

  return (
    <div
      className="fixed inset-0 flex items-center justify-center bg-black/70 p-4"
      onClick={closeOverlay}
    >
      <div
        className="w-full max-w-sm rounded-2xl border border-white/10 bg-neutral-950 p-6 text-white"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="text-xl font-[Permanent_Marker] text-[var(--orange-dark)]">
          Visit Profile
        </h2>

        <p className="mt-3 text-sm text-white/80">
          Open the profile for {currentUsername}?
        </p>

        <div className="mt-5 flex gap-3">
          <button
            type="button"
            onClick={closeOverlay}
            className="flex-1 rounded-full bg-white/10 px-4 py-2 text-sm hover:bg-white/20"
          >
            Cancel
          </button>

          <Link
            href={`/profile/${profileId}`}
            onClick={closeOverlay}
            className="flex-1 rounded-full bg-[var(--orange-dark)] px-4 py-2 text-center text-sm font-semibold text-black hover:opacity-90"
          >
            Visit Profile
          </Link>
        </div>
      </div>
    </div>
  );
}
