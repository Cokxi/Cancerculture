"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { SponsoredCycleDraft } from "@/lib/cycles/sponsoredCycle";

function useFilePreview(file: File | null) {
  const url = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => {
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [url]);
  return url;
}

function BannerPicker({
  title,
  guidance,
  file,
  currentUrl,
  ratioClass,
  inputRef,
  onChange,
}: {
  title: string;
  guidance: string;
  file: File | null;
  currentUrl: string | null;
  ratioClass: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onChange: (file: File | null) => void;
}) {
  const previewUrl = useFilePreview(file);
  const imageUrl = previewUrl ?? currentUrl;
  return (
    <section className="rounded-xl border border-white/15 bg-black/25 p-4">
      <div className="mb-3">
        <h3 className="font-['Permanent_Marker'] text-sm tracking-wide">
          {title}
        </h3>
        <p className="mt-1 text-xs text-white/65">{guidance}</p>
      </div>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="flex min-h-28 w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-white/35 bg-white/10 px-4 py-5 text-center transition hover:bg-white/15"
      >
        <span className="font-['Permanent_Marker'] text-xs tracking-wide">
          SELECT REPLACEMENT
        </span>
        <span className="text-xs text-white/70">
          PNG, JPEG or WebP · max 4 MiB
        </span>
        {file ? (
          <span className="break-all text-xs text-orange-200">{file.name}</span>
        ) : null}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        onChange={(event) => onChange(event.target.files?.[0] ?? null)}
      />
      {imageUrl ? (
        <div
          className={`relative mt-3 overflow-hidden rounded-lg border border-white/10 bg-black/40 ${ratioClass}`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- protected same-origin Admin preview or local object URL */}
          <img
            src={imageUrl}
            alt=""
            className="absolute inset-0 h-full w-full object-contain"
          />
        </div>
      ) : (
        <p className="mt-3 text-xs text-amber-200">No valid banner stored.</p>
      )}
    </section>
  );
}

export default function SponsoredCycleDraftPanel({
  initialDraft,
}: {
  initialDraft: SponsoredCycleDraft;
}) {
  const [draft, setDraft] = useState(initialDraft);
  const [enabled, setEnabled] = useState(initialDraft.enabled);
  const [companyName, setCompanyName] = useState(initialDraft.companyName);
  const [sponsorLink, setSponsorLink] = useState("");
  const [detailFile, setDetailFile] = useState<File | null>(null);
  const [feedFile, setFeedFile] = useState<File | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const detailInputRef = useRef<HTMLInputElement>(null);
  const feedInputRef = useRef<HTMLInputElement>(null);

  async function handleSave() {
    setIsSaving(true);
    setMessage(null);
    try {
      const formData = new FormData();
      formData.append("idempotencyKey", crypto.randomUUID());
      formData.append("revision", String(draft.revision));
      formData.append("enabled", enabled ? "true" : "false");
      formData.append("companyName", companyName);
      formData.append("sponsorLink", sponsorLink);
      if (detailFile) formData.append("detailBanner", detailFile);
      if (feedFile) formData.append("feedBanner", feedFile);

      const response = await fetch("/api/admin/cycles/sponsored-draft", {
        method: "POST",
        body: formData,
      });
      const value: unknown = await response.json().catch(() => null);
      const body =
        value && typeof value === "object"
          ? (value as { error?: string; draft?: SponsoredCycleDraft })
          : null;
      if (!response.ok || !body?.draft) {
        throw new Error(body?.error ?? "Failed to save sponsored cycle");
      }

      setDraft(body.draft);
      setEnabled(body.draft.enabled);
      setCompanyName(body.draft.companyName);
      setSponsorLink("");
      setDetailFile(null);
      setFeedFile(null);
      if (detailInputRef.current) detailInputRef.current.value = "";
      if (feedInputRef.current) feedInputRef.current.value = "";
      setMessage("Sponsored cycle draft saved atomically.");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Failed to save sponsored cycle"
      );
    } finally {
      setIsSaving(false);
    }
  }

  const detailReady = Boolean(detailFile) || draft.detailBanner.ready;
  const feedReady = Boolean(feedFile) || draft.feedBanner.ready;
  const linkReady = sponsorLink.trim().length > 0 || draft.hasSponsorLink;
  const complete =
    companyName.trim().length > 0 && linkReady && detailReady && feedReady;

  return (
    <div className="mt-4 rounded-xl border border-white/15 bg-black/25 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <div className="font-['Permanent_Marker'] text-sm tracking-wide">
            SPONSORED CYCLE
          </div>
          <p className="max-w-2xl text-xs text-white/75">
            Detail and Feed banners are separate media roles. Saving metadata
            and any selected replacements is one revision-checked action.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm text-white/90">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            className="h-4 w-4 accent-black"
          />
          Enable sponsored cycle
        </label>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <label className="flex flex-col gap-2 text-sm">
          <span className="text-white/85">Company name</span>
          <input
            value={companyName}
            maxLength={120}
            onChange={(event) => setCompanyName(event.target.value)}
            placeholder="Example: Acme Labs"
            className="rounded-md bg-white/90 px-3 py-2 text-black"
          />
        </label>
        <label className="flex flex-col gap-2 text-sm">
          <span className="text-white/85">
            New sponsor link{" "}
            {draft.hasSponsorLink ? "(leave empty to keep stored link)" : ""}
          </span>
          <input
            value={sponsorLink}
            onChange={(event) => setSponsorLink(event.target.value)}
            placeholder={
              draft.hasSponsorLink ? "Stored HTTPS link remains active" : "https://example.com"
            }
            className="rounded-md bg-white/90 px-3 py-2 text-black"
          />
        </label>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <BannerPicker
          title="DETAIL BANNER · 2:1"
          guidance="Exactly 2:1, at least 1200 × 600. Existing detail placement remains unchanged."
          file={detailFile}
          currentUrl={draft.detailBanner.url}
          ratioClass="aspect-[2/1]"
          inputRef={detailInputRef}
          onChange={setDetailFile}
        />
        <BannerPicker
          title="THE SPREAD STRIP · 6:1"
          guidance="Exactly 6:1, at least 1800 × 300. Used only for Feed placements."
          file={feedFile}
          currentUrl={draft.feedBanner.url}
          ratioClass="aspect-[6/1]"
          inputRef={feedInputRef}
          onChange={setFeedFile}
        />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={isSaving || (enabled && !complete)}
          className="min-h-11 rounded-md bg-black/70 px-4 py-2 text-sm font-['Permanent_Marker'] transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSaving ? "SAVING..." : "SAVE SPONSORED CYCLE"}
        </button>
        <span className={`text-xs ${complete ? "text-green-300" : "text-amber-200"}`}>
          {complete
            ? "Complete: metadata, 2:1 detail banner and 6:1 Feed banner."
            : "Activation requires company, HTTPS link and both banner formats."}
        </span>
      </div>
      {message ? (
        <div role="status" className="mt-3 text-xs text-white/75">
          {message}
        </div>
      ) : null}
    </div>
  );
}
