"use client";

import type { CoinLaunch } from "@/lib/coinLaunches/getActiveCoinLaunches";
import { useState } from "react";

function shorten(value: string) {
  if (value.length <= 18) {
    return value;
  }

  return `${value.slice(0, 7)}...${value.slice(-7)}`;
}

export default function CoinLaunchDisplay({
  launch,
}: {
  launch: CoinLaunch;
}) {
  const [copied, setCopied] = useState(false);

  async function copyContract() {
    if (!launch.contractAddress) {
      return;
    }

    await navigator.clipboard.writeText(launch.contractAddress);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  const identity = [launch.platform, launch.chain]
    .filter(Boolean)
    .join(" - ");

  return (
    <div className="fixed bottom-16 left-1/2 z-40 w-[min(92vw,760px)] -translate-x-1/2 md:relative md:bottom-auto md:left-auto md:w-auto md:translate-x-0">
      <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 rounded-xl border border-orange-500/30 bg-black/80 px-3 py-2 shadow-lg shadow-black/40 backdrop-blur-sm">
        {launch.tokenSymbol || identity ? (
          <div className="whitespace-nowrap text-xs tracking-wide text-white/65">
            {launch.tokenSymbol ? (
              <span className="font-semibold text-orange-400">
                {launch.tokenSymbol}
              </span>
            ) : null}
            {launch.tokenSymbol && identity ? " - " : ""}
            {identity}
          </div>
        ) : null}

        {launch.contractAddress ? (
          <button
            type="button"
            onClick={copyContract}
            className="group/contract flex min-w-0 items-center rounded-full border border-white/20 bg-black/70 px-3 py-1.5 font-mono text-xs text-white transition hover:border-orange-400/70"
            title="Copy contract address"
          >
            <span className="mr-2 font-sans font-semibold text-orange-400">
              Contract
            </span>
            <span className="md:hidden">
              {copied ? "Copied" : shorten(launch.contractAddress)}
            </span>
            <span className="hidden max-w-0 overflow-hidden whitespace-nowrap opacity-0 transition-all duration-700 ease-out group-hover/contract:max-w-[min(50vw,560px)] group-hover/contract:opacity-100 md:inline">
              {copied ? "Copied" : launch.contractAddress}
            </span>
            <span className="hidden group-hover/contract:hidden md:inline">
              CA
            </span>
          </button>
        ) : null}

        {launch.launchUrl ? (
          <a
            href={launch.launchUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-full border border-orange-500/40 px-3 py-1.5 text-xs font-semibold text-orange-300 transition hover:bg-orange-500/15"
          >
            Launch
          </a>
        ) : null}

        {launch.explorerUrl ? (
          <a
            href={launch.explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-full border border-white/20 px-3 py-1.5 text-xs font-semibold text-white/75 transition hover:bg-white/10"
          >
            Explorer
          </a>
        ) : null}
      </div>
    </div>
  );
}
