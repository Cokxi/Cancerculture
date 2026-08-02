"use client";

import { useState } from "react";

export default function CopyWalletButton({
  walletAddress,
}: {
  walletAddress: string;
}) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">(
    "idle"
  );

  async function copyWalletAddress() {
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
      onClick={copyWalletAddress}
      className="cursor-pointer rounded-md border border-green-400/40 bg-green-500/10 px-3 py-2 text-xs font-semibold text-green-200 transition hover:bg-green-500/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-green-300"
      aria-label="Copy payout wallet address"
    >
      {status === "copied"
        ? "Copied"
        : status === "failed"
          ? "Copy failed"
          : "Copy wallet"}
    </button>
  );
}
