'use client'

import { useState } from 'react'

type Props = {
  address: string
}

export default function ContractAddress({ address }: Props) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(address)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  return (
    <>
      {/* =========================
          DESKTOP VERSION (md+)
         ========================= */}
      <div
        className="
          group fixed bottom-4 left-4 z-50
          hidden md:flex
          items-center
          cursor-pointer
          select-none
        "
        onClick={handleCopy}
        title="Click to copy contract address"
      >
        {/* CA BADGE */}
        <span
          className="
            inline-flex items-center justify-center
            w-9 h-9
            mr-2
            rounded-full
            border border-black
            text-[14px]
            font-semibold
            animate-ca-pulse
          "
        >
          CA
        </span>

        {/* ROLLING CONTRACT ADDRESS */}
        <span
          className="
            overflow-hidden
            max-w-0
            group-hover:max-w-screen-sm
            transition-[max-width]
            duration-700
            ease-out
            whitespace-nowrap
            font-mono
            text-white
            text-[20px]
            tracking-wide
            [text-shadow:
              -1px_0_0_rgba(0,0,0,0.9),
               1px_0_0_rgba(0,0,0,0.9),
               0_-1px_0_rgba(0,0,0,0.9),
               0_1px_0_rgba(0,0,0,0.9),
               0_2px_0_rgba(0,0,0,0.4)
            ]
          "
        >
          <span className="pl-1">
            {copied ? 'copied' : address}
          </span>
        </span>
      </div>

      {/* =========================
    MOBILE VERSION (< md)
   ========================= */}
<div
  className="
    fixed bottom-10 left-1/2 -translate-x-1/2 z-50
    flex md:hidden
    flex-col items-center
    cursor-pointer
    select-none
    gap-1
  "
  onClick={handleCopy}
  title="Tap to copy contract address"
>
  {/* Glow Button */}
  <span
    className="
      px-4 py-2
      rounded-full
      border border-black
      bg-black/70
      text-white
      text-sm
      font-mono
      animate-ca-pulse
      backdrop-blur
    "
  >
    {copied ? "copied" : "Contract Address"}
  </span>

  {/* Visible shortened CA */}
  <span
    className="
      text-[11px]
      font-mono
      text-white/80
      tracking-wide
      select-text
    "
  >
    {address.slice(0, 6)}…{address.slice(-6)}
  </span>
</div>

    </>
  )
}
