"use client";

import { useState } from "react";

type Props = {
  label: string;
  address: string;
};

export default function WalletAddressBox({ label, address }: Props) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="w-full max-w-[420px] mx-auto space-y-3">


      {/* SMALL BLACK LABEL BOX */}
      <div
        className="
          w-full
          bg-black/30
          border
          border-orange-400/40
          rounded-md
          py-2
          text-center
        "
      >
        <span
          className="text-orange-400 text-sm tracking-wide"
          style={{ fontFamily: 'Permanent Marker, cursive' }}
        >
          {label}
        </span>
      </div>

      {/* ORANGE ADDRESS BOX (UNCHANGED) */}
      <button
        onClick={handleCopy}
        className="
          w-full
          bg-orange-500
          text-black
          rounded-md
          px-4
          py-3
          font-mono
          text-sm
          break-all
          transition
          hover:bg-orange-400
          active:scale-[0.98]
        "
        title="Click to copy wallet address"
      >
        {copied ? "COPIED ✓" : address}
      </button>
    </div>
  );
}
