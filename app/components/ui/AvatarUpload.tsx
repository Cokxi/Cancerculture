"use client";

import { useState } from "react";
import {
  AVATAR_MEDIA_PROFILE,
  MEDIA_VALIDATION_MESSAGES,
  preflightBrowserImage,
} from "@/lib/media/profiles";

export default function AvatarUpload() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleChange(
    e: React.ChangeEvent<HTMLInputElement>
  ) {
    const file = e.target.files?.[0];
    if (!file) return;

    const validationError = await preflightBrowserImage(
      file,
      AVATAR_MEDIA_PROFILE
    );
    if (validationError) {
      setError(MEDIA_VALIDATION_MESSAGES[validationError]);
      e.target.value = "";
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch("/api/upload-avatar", {
        method: "POST",
        body: formData,
      });
      const data = await response.json();

      if (!response.ok) {
        const message =
          typeof data.error === "string" &&
          data.error in MEDIA_VALIDATION_MESSAGES
            ? MEDIA_VALIDATION_MESSAGES[
                data.error as keyof typeof MEDIA_VALIDATION_MESSAGES
              ]
            : data.error;
        throw new Error(message || "Upload failed");
      }

      window.location.reload();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Upload failed"
      );
    } finally {
      setLoading(false);
      e.target.value = "";
    }
  }

  return (
    <div className="mt-2">
      <input
        type="file"
        accept={AVATAR_MEDIA_PROFILE.allowedBrowserMimeTypes.join(",")}
        onChange={handleChange}
        className="hidden"
        id="avatarUpload"
      />

      <label
  htmlFor="avatarUpload"
  className={`
    mt-2
    px-3
    py-1.5
    rounded-full
    text-xs
    font-semibold
    transition
    ${
      loading
        ? "bg-gray-600 text-gray-300 cursor-not-allowed"
        : "bg-[var(--orange-dark)] text-black hover:opacity-90 cursor-pointer"
    }
  `}
>
  {loading ? "Uploading..." : "Change Avatar"}
</label>

      {error && (
        <p className="mt-2 text-center text-xs text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}
