"use client";

import { useOverlay } from "@/app/components/overlay/OverlayProvider";
import VisitProfilePrompt from "./VisitProfilePrompt";

export default function ProfileLinkButton({
  currentUsername,
  profileId,
}: {
  currentUsername: string;
  profileId: string | null;
}) {
  const { openOverlay } = useOverlay();

  if (!profileId) {
    return (
      <span className="text-white/90">
        {currentUsername}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() =>
        openOverlay(
          <VisitProfilePrompt
            currentUsername={currentUsername}
            profileId={profileId}
          />
        )
      }
      className="cursor-pointer text-[var(--orange-dark)] underline underline-offset-4 hover:opacity-90"
    >
      {currentUsername}
    </button>
  );
}
