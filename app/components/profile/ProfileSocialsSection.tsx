"use client";

import { useState } from "react";
import { getSocialDisplayLabel } from "@/lib/socials/normalize";
import { SOCIAL_PLATFORM_META } from "@/lib/socials/platforms";
import type {
  SocialPlatform,
  UserSocialLink,
} from "@/lib/socials/types";
import {
  SocialLinkRow,
  SocialPlatformBadge,
  SocialVerificationBadge,
} from "./SocialUi";

const PLATFORM_OPTIONS: {
  value: SocialPlatform;
  label: string;
  placeholder: string;
}[] = [
  {
    value: "x",
    label: "X",
    placeholder: "@username or https://x.com/username",
  },
  {
    value: "instagram",
    label: "Instagram",
    placeholder:
      "@username or https://instagram.com/username",
  },
  {
    value: "tiktok",
    label: "TikTok",
    placeholder:
      "@username or https://tiktok.com/@username",
  },
  {
    value: "facebook",
    label: "Facebook",
    placeholder:
      "Profile URL or page/profile handle",
  },
];

export default function ProfileSocialsSection({
  initialSocialLinks,
  initialShowSocialsOnProfile,
  initialShowSocialsOnSubmissions,
}: {
  initialSocialLinks: UserSocialLink[];
  initialShowSocialsOnProfile: boolean;
  initialShowSocialsOnSubmissions: boolean;
}) {
  const [showSocialsOnProfile, setShowSocialsOnProfile] =
    useState(initialShowSocialsOnProfile);
  const [
    showSocialsOnSubmissions,
    setShowSocialsOnSubmissions,
  ] = useState(
    initialShowSocialsOnSubmissions
  );
  const [savingVisibility, setSavingVisibility] =
    useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(
    null
  );
  const [platform, setPlatform] =
    useState<SocialPlatform>("x");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const verifiedSocialCount = initialSocialLinks.filter(
    (social) => social.is_verified
  ).length;

  const currentPlaceholder =
    PLATFORM_OPTIONS.find(
      (option) => option.value === platform
    )?.placeholder ?? "";

  async function updateVisibility({
    scope,
    value,
  }: {
    scope: "profile" | "submissions";
    value: boolean;
  }) {
    setSavingVisibility(true);
    setError(null);

    try {
      const response = await fetch(
        "/api/profile/social-visibility",
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            scope,
            value,
          }),
        }
      );
      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.error ?? "Failed to update social visibility."
        );
      }

      if (scope === "profile") {
        setShowSocialsOnProfile(value);
      } else {
        setShowSocialsOnSubmissions(value);
      }
    } catch (actionError) {
      setError(
        actionError instanceof Error
          ? actionError.message
          : "Failed to update social visibility."
      );
    } finally {
      setSavingVisibility(false);
    }
  }

  async function submitForm() {
    if (!value.trim()) {
      setError("Please enter a social handle or URL.");
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch(
        editingId
          ? `/api/profile/socials/${editingId}`
          : "/api/profile/socials",
        {
          method: editingId ? "PATCH" : "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            platform,
            value,
          }),
        }
      );
      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.error ?? "Failed to save social link."
        );
      }

      window.location.reload();
    } catch (actionError) {
      setError(
        actionError instanceof Error
          ? actionError.message
          : "Failed to save social link."
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function deleteSocial(socialId: number) {
    const shouldDelete = window.confirm(
      "Remove this social link from your profile?"
    );

    if (!shouldDelete) {
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/profile/socials/${socialId}`,
        {
          method: "DELETE",
        }
      );
      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.error ?? "Failed to remove social link."
        );
      }

      window.location.reload();
    } catch (actionError) {
      setError(
        actionError instanceof Error
          ? actionError.message
          : "Failed to remove social link."
      );
    } finally {
      setSubmitting(false);
    }
  }

  function startEdit(social: UserSocialLink) {
    setEditingId(social.id);
    setPlatform(social.platform);
    setValue(social.handle ?? social.profile_url);
    setError(null);
  }

  function resetForm() {
    setEditingId(null);
    setPlatform("x");
    setValue("");
    setError(null);
  }

  return (
    <section className="space-y-4 rounded-2xl border border-[var(--orange-dark)]/40 bg-black/35 p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-[Permanent_Marker] text-[var(--orange-dark)]">
            My Socials
          </h2>
          <p className="mt-1 text-sm text-gray-400">
            Add the social accounts you want people to see when
            your profile or future submissions are revealed.
          </p>
        </div>

        <div className="flex flex-col items-start gap-2">
          <label className="inline-flex items-center gap-3 rounded-full border border-[var(--orange-dark)]/30 bg-black/40 px-4 py-2 text-sm text-white">
            <input
              type="checkbox"
              checked={showSocialsOnProfile}
              disabled={savingVisibility}
              onChange={(event) =>
                updateVisibility({
                  scope: "profile",
                  value: event.target.checked,
                })
              }
              className="h-4 w-4 accent-[var(--orange-dark)]"
            />
            <span>
              Show socials on profile
              {savingVisibility ? "..." : ""}
            </span>
          </label>

          <label className="inline-flex items-center gap-3 rounded-full border border-[var(--orange-dark)]/30 bg-black/40 px-4 py-2 text-sm text-white">
            <input
              type="checkbox"
              checked={showSocialsOnSubmissions}
              disabled={savingVisibility}
              onChange={(event) =>
                updateVisibility({
                  scope: "submissions",
                  value: event.target.checked,
                })
              }
              className="h-4 w-4 accent-[var(--orange-dark)]"
            />
            <span>
              Show verified socials on submissions
              {savingVisibility ? "..." : ""}
            </span>
          </label>
        </div>
      </div>

      <div className="rounded-xl border border-yellow-400/20 bg-yellow-500/10 p-3 text-sm text-yellow-100">
        Verified badges are visible to everyone. If you change a
        saved social handle or URL later, that social will
        automatically go back to unverified until a mod or admin
        confirms it again.
      </div>

      <div className="rounded-xl border border-[var(--orange-dark)]/20 bg-[var(--orange-dark)]/10 p-3 text-sm text-orange-100">
        Submission socials are snapshotted at upload time and stay
        attached to that submission even if you disable them later.
        Only verified socials are included in submissions.
        {verifiedSocialCount === 0 ? (
          <div className="mt-2 text-xs text-orange-200/90">
            You currently have no verified socials available for
            submissions.
          </div>
        ) : null}
      </div>

      {initialSocialLinks.length > 0 ? (
        <div className="space-y-3">
          {initialSocialLinks.map((social) => (
            <div
              key={social.id}
              className="rounded-xl border border-white/10 bg-black/25 p-3"
            >
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-3">
                    <SocialPlatformBadge
                      platform={social.platform}
                    />
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-white">
                        {getSocialDisplayLabel(social)}
                      </div>
                      <div className="truncate text-xs text-gray-400">
                        {
                          SOCIAL_PLATFORM_META[social.platform]
                            .label
                        }
                      </div>
                    </div>
                    <SocialVerificationBadge
                      isVerified={social.is_verified}
                    />
                  </div>

                  <div className="mt-3">
                    <SocialLinkRow
                      social={social}
                      showStatus={false}
                    />
                  </div>
                </div>

                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => startEdit(social)}
                    className="cursor-pointer rounded-full border border-white/20 px-3 py-1.5 text-xs uppercase tracking-[0.16em] text-white transition hover:border-[var(--orange-dark)]/40 hover:bg-white/5"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteSocial(social.id)}
                    disabled={submitting}
                    className="cursor-pointer rounded-full border border-red-400/30 px-3 py-1.5 text-xs uppercase tracking-[0.16em] text-red-200 transition hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-white/10 bg-black/25 p-4 text-sm text-gray-400">
          No socials added yet.
        </div>
      )}

      <div className="rounded-xl border border-[var(--orange-dark)]/25 bg-[linear-gradient(180deg,rgba(255,149,0,0.12),rgba(255,149,0,0.04))] p-4">
        <div className="mb-3 text-sm font-semibold uppercase tracking-[0.2em] text-[var(--orange-dark)]">
          {editingId ? "Edit social" : "Add social"}
        </div>

        <div className="grid gap-3 md:grid-cols-[180px_minmax(0,1fr)]">
          <select
            value={platform}
            onChange={(event) =>
              setPlatform(event.target.value as SocialPlatform)
            }
            className="rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-white"
          >
            {PLATFORM_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          <input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={currentPlaceholder}
            className="rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-white placeholder:text-gray-500"
          />
        </div>

        {error ? (
          <div className="mt-3 text-sm text-red-300">
            {error}
          </div>
        ) : null}

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={submitForm}
            disabled={submitting}
            className="cursor-pointer rounded-full bg-[var(--orange-dark)] px-4 py-2 text-sm font-semibold text-black transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {editingId
              ? submitting
                ? "Saving..."
                : "Save social"
              : submitting
                ? "Adding..."
                : "Add social"}
          </button>

          {(editingId || value) && (
            <button
              type="button"
              onClick={resetForm}
              disabled={submitting}
              className="cursor-pointer rounded-full border border-white/20 px-4 py-2 text-sm text-white transition hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Cancel
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
