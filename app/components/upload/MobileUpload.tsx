"use client";

import HomeBlinkCell from "@/app/components/HomeBlinkCell";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";


/* ================= TYPES ================= */
type ScannerState = "idle" | "hover" | "uploading" | "done";
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
export default function MobileUpload({
  showSupportLink,
  forceSuccessState = false,
}: {
  showSupportLink: boolean;
  forceSuccessState?: boolean;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  /* ---------- STATE ---------- */
  const [uploadDone, setUploadDone] = useState(forceSuccessState);
  const [scannerState, setScannerState] = useState<ScannerState>(
    forceSuccessState ? "done" : "idle"
  );
  const [blink, setBlink] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [successMode, setSuccessMode] = useState<"success" | "already">("success");
  const [xUsername, setXUsername] = useState("");
  const [walletAddress, setWalletAddress] = useState("");
  const [payoutChoice, setPayoutChoice] = useState<PayoutChoice | null>(null);
  const [splitPercent, setSplitPercent] = useState(50);
  const [charity, setCharity] = useState<string | null>(null);
  const [customCharity, setCustomCharity] = useState("");

  /* ---------- BLINK ---------- */
  useEffect(() => {
    const interval = setInterval(
      () => setBlink((b) => !b),
      scannerState === "uploading" ? 300 : 900
    );
    return () => clearInterval(interval);
  }, [scannerState]);

  useEffect(() => {
  if (forceSuccessState) {
    setSuccessMode("already");
  }
}, [forceSuccessState]);


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
  const handleScannerClick = () => {
    if (!uploadDone) fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f || !f.type.startsWith("image/")) return;
    setFile(f);
    setPreviewUrl(URL.createObjectURL(f));
  };

  const handleSubmit = async () => {
    if (submitState !== "ready" || isSubmitting) return;

    try {
      setIsSubmitting(true);
      setScannerState("uploading");

      const formData = new FormData();
      formData.append("file", file!);
      const normalizedX = xUsername.trim().replace(/^@+/, "");
formData.append("xUsername", normalizedX);
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
        alert(data.error || "Upload failed");
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
    <div className="w-full min-h-screen bg-orange-background relative">
      <div className="max-w-sm mx-auto px-4 py-6 flex flex-col gap-6">

        {/* ===== UPLOAD FLOW ===== */}
        {!uploadDone && (
          <>
            {/* SCANNER */}
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

            {/* PREVIEW */}
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

            {(payoutChoice === "donate" || payoutChoice === "split") && (
  <div className="mx-auto -mt-1">
    <Link
      href="/charities"
      className="
        text-xs
        text-[var(--orange-main)]
        font-['Permanent_Marker']
        opacity-80
        hover:opacity-100
        underline
        underline-offset-4
        transition
      "
    >
      Not sure? Learn more about the charities
    </Link>
  </div>
)}


            {/* FORM */}
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
                    className={`flex-1 py-2 rounded-xl ${
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
                <>
                  <select
                    value={charity ?? ""}
                    onChange={(e) => {
                      setCharity(e.target.value);
                      if (e.target.value !== "other") setCustomCharity("");
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
                      placeholder="Enter charity"
                      value={customCharity}
                      onChange={(e) => setCustomCharity(e.target.value)}
                      className="rounded-xl px-4 py-2 bg-white outline-none"
                    />
                  )}
                </>
              )}
            </div>

            {/* SUBMIT */}
            <div
              onClick={handleSubmit}
              className={`mx-auto ${
                submitState === "ready"
                  ? "cursor-pointer active:scale-95"
                  : "opacity-60"
              }`}
            >
              <Image src={submitImage} alt="Submit" width={220} height={220} />
            </div>
          </>
        )}

        {/* ===== SUCCESS ===== */}
        {uploadDone && (
          <div
            className="mx-auto cursor-pointer active:scale-95"
            onClick={() => (window.location.href = "/")}
          >
            <HomeBlinkCell mode={successMode} />

          </div>
        )}

        {/* ===== SUPPORT ===== */}
        {showSupportLink && (
          <div className="mx-auto mt-6">
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
