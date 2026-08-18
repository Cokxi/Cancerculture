"use client";

import { useState } from "react";

export default function CopyReportedWalletButton({
  walletAddress,
}: {
  walletAddress: string;
}) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");

  async function copyReportedWallet() {
    try {
      await navigator.clipboard.writeText(walletAddress);
      setStatus("copied");
      window.setTimeout(() => setStatus("idle"), 2500);
    } catch {
      setStatus("failed");
    }
  }

  return (
    <button
      type="button"
      onClick={copyReportedWallet}
      className="min-h-11 cursor-pointer rounded-md border border-orange-300/40 bg-orange-500/10 px-3 py-2 text-xs font-semibold text-orange-100 transition hover:bg-orange-500/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-300"
      aria-label="Copy the new Wallet reported by the user"
    >
      {status === "copied"
        ? "Copied"
        : status === "failed"
          ? "Copy failed"
          : "Copy reported Wallet"}
    </button>
  );
}
