"use client";

import { useState } from "react";

export default function AvatarUpload() {
  const [loading, setLoading] = useState(false);

  async function handleChange(
    e: React.ChangeEvent<HTMLInputElement>
  ) {
    const file = e.target.files?.[0];
    if (!file) return;

    setLoading(true);

    try {
      const formData = new FormData();
      formData.append("file", file);

      await fetch("/api/upload-avatar", {
        method: "POST",
        body: formData,
      });

      window.location.reload();
    } catch (err) {
      console.error("Upload failed", err);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mt-2">
      <input
        type="file"
        accept="image/*"
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
    </div>
  );
}