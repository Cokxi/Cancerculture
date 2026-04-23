"use client";

import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SponsoredCycleDraft } from "@/lib/cycles/sponsoredCycle";

export default function SponsoredCycleDraftPanel({
  initialDraft,
}: {
  initialDraft: SponsoredCycleDraft;
}) {
  const [enabled, setEnabled] = useState(initialDraft.enabled);
  const [companyName, setCompanyName] = useState(
    initialDraft.companyName
  );
  const [sponsorLink, setSponsorLink] = useState(
    initialDraft.sponsorLink
  );
  const [selectedFile, setSelectedFile] = useState<File | null>(
    null
  );
  const [currentBannerR2Key, setCurrentBannerR2Key] = useState(
    initialDraft.bannerR2Key
  );
  const [currentBannerUrl, setCurrentBannerUrl] = useState(
    initialDraft.bannerUrl
  );
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const previewUrl = useMemo(() => {
    if (!selectedFile) {
      return null;
    }

    return URL.createObjectURL(selectedFile);
  }, [selectedFile]);

  useEffect(() => {
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  const sponsorLabel =
    companyName.trim().length > 0
      ? companyName.trim()
      : "Company name";
  const previewImageUrl = previewUrl ?? currentBannerUrl;

  async function handleSave() {
    setIsSaving(true);
    setMessage(null);

    try {
      const formData = new FormData();
      formData.append("enabled", enabled ? "true" : "false");
      formData.append("companyName", companyName);
      formData.append("sponsorLink", sponsorLink);
      formData.append("currentBannerR2Key", currentBannerR2Key);

      if (selectedFile) {
        formData.append("banner", selectedFile);
      }

      const response = await fetch(
        "/api/admin/cycles/sponsored-draft",
        {
          method: "POST",
          body: formData,
        }
      );
      const data = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(
          data?.error ?? "Failed to save sponsored cycle"
        );
      }

      const draft = data?.draft as SponsoredCycleDraft | undefined;

      if (draft) {
        setEnabled(draft.enabled);
        setCompanyName(draft.companyName);
        setSponsorLink(draft.sponsorLink);
        setCurrentBannerR2Key(draft.bannerR2Key);
        setCurrentBannerUrl(draft.bannerUrl);
      }

      setSelectedFile(null);
      setMessage("Sponsored cycle draft saved");
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

  return (
    <div
      className="
        mt-4
        rounded-xl
        border border-white/15
        bg-black/25
        p-4
      "
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <div className="font-['Permanent_Marker'] text-sm tracking-wide">
            SPONSORED CYCLE
          </div>
          <p className="max-w-xl text-xs text-white/75">
            Optional cycle add-on. This stays hidden unless you
            enable it.
          </p>
        </div>

        <label className="flex items-center gap-2 text-sm text-white/90">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) =>
              setEnabled(event.target.checked)
            }
            className="h-4 w-4 accent-black"
          />
          Enable sponsored cycle
        </label>
      </div>

      {enabled ? (
        <div className="mt-4 grid gap-4">
          <div className="grid gap-3 md:grid-cols-2">
            <label className="flex flex-col gap-2 text-sm">
              <span className="text-white/85">Company name</span>
              <input
                value={companyName}
                onChange={(event) =>
                  setCompanyName(event.target.value)
                }
                placeholder="Example: Acme Labs"
                className="rounded-md bg-white/90 px-3 py-2 text-black"
              />
            </label>

            <label className="flex flex-col gap-2 text-sm">
              <span className="text-white/85">Sponsor link</span>
              <input
                value={sponsorLink}
                onChange={(event) =>
                  setSponsorLink(event.target.value)
                }
                placeholder="https://example.com"
                className="rounded-md bg-white/90 px-3 py-2 text-black"
              />
            </label>
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(280px,0.8fr)]">
            <div className="space-y-2">
              <span className="block text-sm text-white/85">
                Sponsor banner
              </span>

              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="
                  flex min-h-40 w-full flex-col items-center justify-center gap-2
                  rounded-xl border border-dashed border-white/35 bg-white/10 px-4 py-6
                  text-center transition hover:bg-white/15
                "
              >
                <span className="font-['Permanent_Marker'] text-sm tracking-wide">
                  DROP OR SELECT BANNER
                </span>
                <span className="text-xs text-white/70">
                  Use a 2:1 banner. This will be saved with the sponsored draft.
                </span>
                {selectedFile ? (
                  <span className="text-xs text-orange-200">
                    {selectedFile.name}
                  </span>
                ) : null}
              </button>

              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                hidden
                onChange={(event) => {
                  const file =
                    event.target.files?.[0] ?? null;
                  setSelectedFile(file);
                }}
              />

              <button
                type="button"
                onClick={handleSave}
                disabled={isSaving}
                className="
                  rounded-md bg-black/70 px-4 py-2 text-sm
                  font-['Permanent_Marker'] transition hover:bg-black
                  disabled:cursor-not-allowed disabled:opacity-60
                "
              >
                {isSaving ? "SAVING..." : "SAVE SPONSORED CYCLE"}
              </button>

              {message ? (
                <div className="text-xs text-white/75">
                  {message}
                </div>
              ) : null}
            </div>

            <div className="rounded-xl border border-white/15 bg-black/30 p-4">
              <div className="mb-3 font-['Permanent_Marker'] text-xs tracking-wide text-white/80">
                HUD PREVIEW
              </div>

              <div className="space-y-1 font-['Permanent_Marker'] leading-tight">
                <div className="border-b border-white/10 pb-1 text-[1.1rem] text-[var(--orange-main)]">
                  Sponsored Cycle
                </div>
                <div>
                  <span className="text-[var(--orange-main)]">
                    Cycle:{" "}
                  </span>
                  <span className="text-green-400">XY</span>
                </div>
                <div>
                  <span className="text-[var(--orange-main)]">
                    Status:{" "}
                  </span>
                  <span className="text-green-400">ACTIVE</span>
                </div>
                <div className="text-xs text-white/90">
                  <span className="text-[var(--orange-main)]">
                    Presented by:{" "}
                  </span>
                  {sponsorLink.trim().length > 0 ? (
                    <a
                      href={sponsorLink}
                      target="_blank"
                      rel="noreferrer"
                      className="pointer-events-auto text-orange-200 underline underline-offset-4"
                    >
                      {sponsorLabel}
                    </a>
                  ) : (
                    <span className="text-orange-200">
                      {sponsorLabel}
                    </span>
                  )}
                </div>
              </div>

              <div className="mt-4 overflow-hidden rounded-lg border border-white/10 bg-black/20">
                {previewImageUrl ? (
                  <div className="relative h-36 w-full">
                    <Image
                      src={previewImageUrl}
                      alt="Sponsor banner preview"
                      fill
                      unoptimized
                      className="object-cover"
                    />
                  </div>
                ) : (
                  <div className="flex h-36 items-center justify-center px-4 text-center text-xs text-white/55">
                    Banner preview appears here after selecting an image.
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
