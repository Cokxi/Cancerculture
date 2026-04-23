"use client";

import { useState } from "react";
import type { PublicSocialLink } from "@/lib/socials/types";
import { SocialLinkRow } from "./SocialUi";

export default function PublicProfileSocialsSection({
  socials,
  showSocials,
  canModerate,
}: {
  socials: PublicSocialLink[];
  showSocials: boolean;
  canModerate: boolean;
}) {
  const [loadingId, setLoadingId] = useState<number | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);

  async function runModerationAction(
    socialId: number,
    action: "verify" | "unverify"
  ) {
    setLoadingId(socialId);
    setError(null);

    try {
      const response = await fetch(
        `/api/admin/socials/${socialId}/${action}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({}),
        }
      );
      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.error ??
            `Failed to ${action} social link.`
        );
      }

      window.location.reload();
    } catch (actionError) {
      setError(
        actionError instanceof Error
          ? actionError.message
          : `Failed to ${action} social link.`
      );
    } finally {
      setLoadingId(null);
    }
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-black/40 p-6">
      <h2 className="mb-4 text-xl font-[Permanent_Marker] text-[var(--orange-dark)]">
        Socials
      </h2>

      {!showSocials ? (
        <p className="text-sm text-gray-400">
          This user is currently not showing socials on their
          profile.
        </p>
      ) : socials.length === 0 ? (
        <p className="text-sm text-gray-400">
          No socials added yet.
        </p>
      ) : (
        <div className="space-y-3">
          {socials.map((social) => (
            <div
              key={social.id}
              className="rounded-xl border border-white/10 bg-black/25 p-3"
            >
              <SocialLinkRow social={social} />

              {canModerate ? (
                <div className="mt-3 flex gap-2">
                  {!social.is_verified ? (
                    <button
                      type="button"
                      onClick={() =>
                        runModerationAction(
                          social.id,
                          "verify"
                        )
                      }
                      disabled={loadingId === social.id}
                      className="rounded-full border border-emerald-400/30 px-3 py-1.5 text-xs uppercase tracking-[0.16em] text-emerald-200 transition hover:bg-emerald-500/10 disabled:opacity-60"
                    >
                      {loadingId === social.id
                        ? "Saving..."
                        : "Verify"}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() =>
                        runModerationAction(
                          social.id,
                          "unverify"
                        )
                      }
                      disabled={loadingId === social.id}
                      className="rounded-full border border-yellow-400/30 px-3 py-1.5 text-xs uppercase tracking-[0.16em] text-yellow-200 transition hover:bg-yellow-500/10 disabled:opacity-60"
                    >
                      {loadingId === social.id
                        ? "Saving..."
                        : "Unverify"}
                    </button>
                  )}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {error ? (
        <div className="mt-4 text-sm text-red-300">
          {error}
        </div>
      ) : null}
    </div>
  );
}
