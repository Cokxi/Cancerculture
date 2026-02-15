"use client";

import HomeBlinkCell from "@/app/components/HomeBlinkCell";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";

/* ================= TYPES ================= */
type ScannerState = "idle" | "uploading" | "done";
type PayoutChoice = "keep" | "donate" | "split";
type SubmitState = "idle" | "partial" | "ready";

const CHARITY_OPTIONS = [
  { value: "Animal Haven", label: "Animal Haven" },
  { value: "Animal Rescue Corps, Inc.", label: "Animal Rescue Corps, Inc." },
  { value: "Doctors Without Borders U.S.A., Inc.", label: "Doctors Without Borders U.S.A., Inc." },
  { value: "Feeding Pets of the Homeless", label: "Feeding Pets of the Homeless" },
  { value: "Institute for Justice", label: "Institute for Justice" },
  { value: "No Kid Hungry", label: "No Kid Hungry" },
  { value: "Save the Children", label: "Save the Children" },
  { value: "Sea Shepherd Conservation Society", label: "Sea Shepherd Conservation Society" },
  { value: "St. Jude Children's Research Hospital", label: "St. Jude Children's Research Hospital" },
  { value: "Young Lives vs Cancer", label: "Young Lives vs Cancer" },
];

/* ================= COMPONENT ================= */
export default function DesktopUpload({

  
  showSupportLink,
  forceSuccessState = false,
}: {
  showSupportLink: boolean;
  forceSuccessState?: boolean;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [uploadDone, setUploadDone] = useState(forceSuccessState);
  const [scannerState, setScannerState] = useState<ScannerState>(
    forceSuccessState ? "done" : "idle"
  );
  const [blink, setBlink] = useState(false);

  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const [xUsername, setXUsername] = useState("");
  const [walletAddress, setWalletAddress] = useState("");
  const [payoutChoice, setPayoutChoice] = useState<PayoutChoice | null>(null);
  const [splitPercent, setSplitPercent] = useState(50);
  const [charity, setCharity] = useState<string | null>(null);
  const [customCharity, setCustomCharity] = useState("");
  const [successMode, setSuccessMode] = useState<"success" | "already">("success");
  const [isSubmitting, setIsSubmitting] = useState(false);

  /* ---------- BLINK ---------- */
  /* ---------- BLINK ---------- */
useEffect(() => {
  const interval = setInterval(
    () => setBlink((b) => !b),
    scannerState === "uploading" ? 300 : 900
  );
  return () => clearInterval(interval);
}, [scannerState]);

/* ---------- SUCCESS MODE SWITCH ---------- */
useEffect(() => {
  if (forceSuccessState) {
    setSuccessMode("already");
  }
}, [forceSuccessState]);


  const getScannerImage = () => {
    if (scannerState === "done") return "/scanner-v4.png";
    return blink ? "/scanner-v1.png" : "/scanner-v2.png";
  };

  const hasImage = !!file;
  const hasMeta =
    xUsername.trim() &&
    walletAddress.trim() &&
    payoutChoice &&
    (payoutChoice !== "split" || splitPercent > 0) &&
    (payoutChoice === "keep" || charity);

  const submitState: SubmitState =
    hasImage && hasMeta ? "ready" : hasImage || hasMeta ? "partial" : "idle";

  const submitImage =
    submitState === "ready"
      ? "/submit-v4.png"
      : submitState === "partial"
      ? "/submit-v3.png"
      : "/submit-v2.png";

  /* ---------- EVENTS ---------- */
  const handleScannerClick = () => fileInputRef.current?.click();

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f || !f.type.startsWith("image/")) return;
    setFile(f);
    setPreviewUrl(URL.createObjectURL(f));
  };

  const handleSubmit = async () => {
    if (submitState !== "ready" || isSubmitting) return;

    setIsSubmitting(true);
    setScannerState("uploading");

    try {
      const formData = new FormData();
      formData.append("file", file!);
      const normalizedX = xUsername.trim().replace(/^@+/, "");
formData.append("xUsername", normalizedX);
      formData.append("walletAddress", walletAddress);
      formData.append("payoutChoice", payoutChoice!);
      formData.append("splitPercent", splitPercent.toString());
      if (charity === "other") formData.append("charity", customCharity);
      else if (charity) formData.append("charity", charity);

      const res = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();

      if (!res.ok) {
        alert(data.error ?? "Upload not possible right now");
        setScannerState("idle");
        return;
      }

      setSuccessMode("success");
      setUploadDone(true);
      setScannerState("done");
    } catch {
      setScannerState("idle");
    } finally {
      setIsSubmitting(false);
    }
  };

  /* ================= RENDER ================= */
  return (
    <div className="min-h-screen bg-orange-background py-24">
      <div className="max-w-6xl mx-auto px-6 flex flex-col gap-14">

        {/* ===== SCANNER + FORM BLOCK ===== */}
        {!uploadDone && (
          <>
            {/* ===== SCANNER + TITLE ===== */}
            <div className="flex flex-col items-center gap-4">
              <span className="upload-hint animate-soft-hint">
                Choose your cancer
              </span>
              

              <div className="bg-yellow-star rounded-3xl p-10">
                <div
                  onClick={handleScannerClick}
                  className="cursor-pointer active:scale-95 transition"
                >
                  <Image
                    src={getScannerImage()}
                    alt="Upload scanner"
                    width={420}
                    height={420}
                    priority
                  />
                </div>
              </div>
            </div>
{/* ===== CHARITY INFO SLOT (absolute, no gap) ===== */}
<div className="relative flex justify-center">
  {(payoutChoice === "donate" || payoutChoice === "split") && (
    <Link
      href="/charities"
      className="
        absolute
        -bottom-5
        text-sm
        text-[var(--orange-main)]
        font-['Permanent_Marker']
        opacity-80
        hover:opacity-100
        underline
        underline-offset-4
        transition
        z-10
      "
    >
      Not sure? Learn more about the charities
    </Link>
  )}
</div>

            {/* ===== PREVIEW ===== */}
            {previewUrl && (
              <div className="mx-auto bg-white rounded-xl p-2 shadow-xl">
                <Image
                  src={previewUrl}
                  alt="Preview"
                  width={260}
                  height={260}
                  className="rounded-lg object-contain"
                />
              </div>
            )}



            {/* ===== FORM ===== */}
            <div className="mx-auto w-full max-w-xl bg-yellow-star rounded-3xl p-8 flex flex-col gap-5">
              <input
                placeholder="@username"
                value={xUsername}
                onChange={(e) => setXUsername(e.target.value)}
                className="rounded-xl px-4 py-2 bg-white"
              />

              <input
                placeholder="Wallet address"
                value={walletAddress}
                onChange={(e) => setWalletAddress(e.target.value)}
                className="rounded-xl px-4 py-2 bg-white"
              />

              <div className="flex gap-3">
                {["keep", "donate", "split"].map((o) => (
                  <button
                    key={o}
                    onClick={() => setPayoutChoice(o as PayoutChoice)}
                    className={`flex-1 py-2 rounded-xl cursor-pointer transition ${
                      payoutChoice === o
                        ? "bg-black text-yellow-300"
                        : "bg-white"
                    }`}
                  >
                    {o}
                  </button>
                ))}
              </div>

              {payoutChoice === "split" && (
            <div className="flex flex-col gap-2">
              <input
                type="range"
                min={1}
                max={99}
                value={splitPercent}
                onChange={(e) => setSplitPercent(Number(e.target.value))}
              />
              <div className="flex justify-between text-sm text-[var(--orange-main)]">
                <span>You: {splitPercent}%</span>
                <span>Charity: {100 - splitPercent}%</span>
              </div>
            </div>
          )}

              {(payoutChoice === "donate" || payoutChoice === "split") && (
                <>
                  <select
                    value={charity ?? ""}
                    onChange={(e) => setCharity(e.target.value)}
                    className="rounded-xl px-4 py-2 bg-white"
                  >
                    <option value="" disabled>
                      Select charity
                    </option>
                    {CHARITY_OPTIONS.map((org) => (
                      <option key={org.value} value={org.value}>
                        {org.label}
                      </option>
                    ))}
                    <option value="other">Other</option>
                  </select>

                  {charity === "other" && (
                    <input
                      placeholder="Custom charity"
                      value={customCharity}
                      onChange={(e) =>
                        setCustomCharity(e.target.value)
                      }
                      className="rounded-xl px-4 py-2 bg-white"
                    />
                  )}
                </>
              )}
            </div>

            {/* ===== HIT IT ===== */}
            {submitState === "ready" && (
              <div className="text-center mt-4">
                <span className="upload-hint animate-soft-hint">
                  Hit it
                </span>
                <div className="upload-hint animate-soft-hint leading-none">
      ↓
    </div>
              </div>
            )}
          </>
        )}

        {/* ===== SUBMIT / HOME ===== */}
        {!uploadDone ? (
          <div
            onClick={handleSubmit}
            className={`mx-auto ${
              submitState === "ready"
                ? "cursor-pointer"
                : "opacity-60"
            }`}
          >
            <Image
              src={submitImage}
              alt="Submit"
              width={260}
              height={260}
            />
          </div>
        ) : (
          <div
            className="mx-auto cursor-pointer"
            onClick={() => (location.href = "/")}
          >
            <HomeBlinkCell mode={successMode} />

          </div>
        )}

        {/* ===== SUPPORT ===== */}
        {showSupportLink && (
          <div className="mt-10 flex flex-col items-center gap-1">
            <span className="upload-hint animate-soft-hint text-xs">
              Problem?
            </span>
            <a
              href="https://tally.so/r/7RLXOZ"
              target="_blank"
              rel="noopener noreferrer"
              className="px-4 py-2 rounded-full bg-black/70 text-white text-xs"
            >
              Wallet / Participation Issue?
            </a>
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          hidden
          onChange={handleFileChange}
        />
      </div>
    </div>
  );
}
