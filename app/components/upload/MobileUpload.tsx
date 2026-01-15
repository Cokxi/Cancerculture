"use client";

import HomeBlinkCell from "@/app/components/HomeBlinkCell";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";

/* ================= TYPES ================= */
type ScannerState = "idle" | "hover" | "uploading" | "done";
type PayoutChoice = "keep" | "donate" | "split";
type SubmitState = "idle" | "partial" | "ready";

const CHARITY_OPTIONS = [
  { value: "save_the_children", label: "Save the Children" },
  { value: "dogs_for_better_lives", label: "Dogs for Better Lives" },
  { value: "love_justice_international", label: "Love Justice International" },
  { value: "habitat_for_humanity", label: "Habitat for Humanity International" },
  { value: "convoy_of_hope", label: "Convoy of Hope" },
  { value: "sea_shepherd", label: "Sea Shepherd Conservation Society" },
  { value: "animals_asia", label: "Animals Asia Foundation" },
  { value: "all_gods_children", label: "All God's Children International" },
];



/* ================= COMPONENT ================= */
export default function MobileUpload({
  showSupportLink,
}: {
  showSupportLink: boolean;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  /* ---------- STATE ---------- */
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [uploadDone, setUploadDone] = useState(false);

  const [scannerState, setScannerState] = useState<ScannerState>("idle");
  const [blink, setBlink] = useState(false);

  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const [xUsername, setXUsername] = useState("");
  const [walletAddress, setWalletAddress] = useState("");
  const [payoutChoice, setPayoutChoice] = useState<PayoutChoice | null>(null);
  const [splitPercent, setSplitPercent] = useState(50);
  const [charity, setCharity] = useState<string | null>(null);
  const [customCharity, setCustomCharity] = useState("");


  /* ---------- BLINK ---------- */
  useEffect(() => {
    let interval: NodeJS.Timeout | null = null;

    interval = setInterval(
      () => setBlink((b) => !b),
      scannerState === "uploading" ? 300 : 900
    );

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [scannerState]);

  /* ---------- SCANNER IMAGE ---------- */
  const getScannerImage = () => {
    if (scannerState === "hover") return "/scanner-v3.png";
    if (scannerState === "done") return "/scanner-v4.png";
    return blink ? "/scanner-v1.png" : "/scanner-v2.png";
  };

  /* ---------- SUBMIT STATE ---------- */
  const hasImage = !!file;

  const hasMeta =
    xUsername.trim().length > 0 &&
    walletAddress.trim().length > 0 &&
    payoutChoice !== null &&
    (payoutChoice !== "split" || splitPercent > 0) &&
    (payoutChoice === "keep" || charity !== null);

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
    if (!f) return;

    if (!f.type.startsWith("image/")) {
      alert("Only image files allowed");
      return;
    }

    if (f.size > 10 * 1024 * 1024) {
      alert("Max file size is 10MB");
      return;
    }

    setFile(f);
    setPreviewUrl(URL.createObjectURL(f));
  };

  /* ---------- SUBMIT ---------- */
  const handleSubmit = async () => {
    if (submitState !== "ready" || isSubmitting) return;

    try {
      setIsSubmitting(true);
      setScannerState("uploading");

      const formData = new FormData();
      formData.append("file", file!);
      formData.append("xUsername", xUsername);
      formData.append("walletAddress", walletAddress);
      formData.append("payoutChoice", payoutChoice!);
      formData.append("splitPercent", splitPercent.toString());
      if (charity === "other") {
  formData.append("charity", customCharity);
} else if (charity) {
  formData.append("charity", charity);
}


      const res = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      });

      const data = await res.json();

      if (!res.ok) {
        if (res.status === 401) {
          window.location.href = "/api/auth/discord/login";
          return;
        }

        alert(data.error || "Upload failed");
        setScannerState("idle");
        return;
      }

      setUploadDone(true);
      setScannerState("done");
    } catch (err) {
      console.error(err);
      alert("Upload failed. Please try again.");
      setScannerState("idle");
    } finally {
      setIsSubmitting(false);
    }
  };

  /* ================= RENDER ================= */
  return (
    <div className="w-full min-h-screen bg-orange-background relative">
      <div className="max-w-sm mx-auto px-4 py-6 flex flex-col gap-6">

        {/* ===== SCANNER ===== */}
        <div className="bg-yellow-star rounded-3xl p-6 flex justify-center">
          <div
            onClick={handleScannerClick}
            className="cursor-pointer active:scale-95 transition"
          >
            <Image
              src={getScannerImage()}
              alt="Upload scanner"
              width={260}
              height={260}
              priority
            />
          </div>
                </div>

        {/* ===== PREVIEW ===== */}
        {previewUrl && (
          <div className="mx-auto bg-white rounded-xl p-2 shadow-lg">
            <Image
              src={previewUrl}
              alt="Preview"
              width={220}
              height={220}
              className="rounded-lg object-contain"
            />
          </div>
        )}

        {/* ===== META PANEL ===== */}
        <div className="bg-yellow-star rounded-3xl p-6 flex flex-col gap-4">
          <input
            placeholder="@username"
            value={xUsername}
            onChange={(e) => setXUsername(e.target.value)}
            className="rounded-xl px-4 py-2 bg-white outline-none"
          />

          <input
            placeholder="Wallet address"
            value={walletAddress}
            onChange={(e) => setWalletAddress(e.target.value)}
            className="rounded-xl px-4 py-2 bg-white outline-none"
          />

          <div className="flex gap-2">
            {["keep", "donate", "split"].map((o) => (
              <button
                key={o}
                onClick={() => setPayoutChoice(o as PayoutChoice)}
                className={`flex-1 py-2 rounded-xl transition ${
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

    <div className="flex justify-between text-xs text-[var(--orange-main)] px-1">
      <span>
        You: <strong>{splitPercent}%</strong>
      </span>
      <span>
        Charity: <strong>{100 - splitPercent}%</strong>
      </span>
    </div>
  </div>
)}


          {(payoutChoice === "donate" || payoutChoice === "split") && (
  <div className="flex flex-col gap-2">
    <select
      value={charity ?? ""}
      onChange={(e) => {
        setCharity(e.target.value);
        if (e.target.value !== "other") {
          setCustomCharity("");
        }
      }}
      className="rounded-xl px-4 py-2 bg-white outline-none"
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
        type="text"
        placeholder="Enter charity / organization"
        value={customCharity}
        onChange={(e) => setCustomCharity(e.target.value)}
        className="rounded-xl px-4 py-2 bg-white outline-none"
      />
    )}
  </div>
)}

        </div>

        {/* ===== SUCCESS MESSAGE ===== */}
        {uploadDone && (
          <div className="mx-auto bg-white/80 backdrop-blur rounded-xl px-5 py-6 shadow-lg text-center flex flex-col items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-green-500 flex items-center justify-center text-white text-xl font-bold">
              ✓
            </div>

            <p className="text-sm text-black/80">
              <strong>Submission received!</strong>
              <br />
              We’re happy you shared your creativity with CancerCulture.
            </p>
          </div>
        )}

        {/* ===== SUBMIT / HOME ===== */}
        {!uploadDone ? (
          <div
            onClick={handleSubmit}
            className={`mx-auto transition ${
              submitState === "ready"
                ? "cursor-pointer active:scale-95"
                : "opacity-60"
            }`}
          >
            <Image
              src={submitImage}
              alt="Submit"
              width={220}
              height={220}
            />
          </div>
        ) : (
          <div
            className="mx-auto cursor-pointer active:scale-95"
            onClick={() => (window.location.href = "/")}
          >
            <HomeBlinkCell />
          </div>
        )}

        {/* ===== SUPPORT LINK (BOTTOM, SCROLL END) ===== */}
{showSupportLink && (
  <div className="mx-auto mt-6">
    <a
      href="https://tally.so/r/7RLXOZ"
      target="_blank"
      rel="noopener noreferrer"
      className="
        inline-block
        px-4
        py-2
        rounded-full

        bg-black/70
        text-white
        text-xs
        font-medium

        backdrop-blur
        border
        border-white/20

        active:scale-95
        transition
      "
    >
      Wallet / Participation Issue?
    </a>
  </div>
)}

        {/* FILE INPUT */}
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
