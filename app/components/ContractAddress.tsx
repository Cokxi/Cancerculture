'use client'

import { useState } from 'react'

type Props = {
  address: string
  desktopVariant?: 'corner' | 'centered'
}

export default function ContractAddress({
  address,
  desktopVariant = 'corner',
}: Props) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(address)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  return (
    <>
      <div
        className={`
          group z-50 hidden select-none md:flex
          ${desktopVariant === 'corner' ? 'fixed bottom-4 left-4 w-auto' : 'relative w-full justify-center'}
        `}
      >
        <div
          className="relative flex cursor-pointer items-center justify-center"
          onClick={handleCopy}
          title="Click to copy contract address"
        >
          <span
            className={`
              overflow-hidden whitespace-nowrap font-mono text-white tracking-wide
              transition-[max-width,padding] duration-700 ease-out
              [text-shadow:
                -1px_0_0_rgba(0,0,0,0.9),
                 1px_0_0_rgba(0,0,0,0.9),
                 0_-1px_0_rgba(0,0,0,0.9),
                 0_1px_0_rgba(0,0,0,0.9),
                 0_2px_0_rgba(0,0,0,0.4)
              ]
              ${
                desktopVariant === 'corner'
                  ? 'max-w-0 pl-0 text-[20px] group-hover:max-w-screen-sm'
                  : 'max-w-0 px-0 py-2 text-center text-[18px] opacity-90 group-hover:max-w-[min(72vw,820px)] group-hover:px-16'
              }
            `}
          >
            <span className={desktopVariant === 'corner' ? 'pl-1' : ''}>
              {copied ? 'copied' : address}
            </span>
          </span>

          <span
            className={`
              inline-flex h-9 w-9 items-center justify-center rounded-full border border-black text-[14px] font-semibold animate-ca-pulse transition-opacity duration-300
              ${
                desktopVariant === 'corner'
                  ? 'ml-2'
                  : 'absolute left-1/2 -translate-x-1/2 bg-black/45 opacity-100 backdrop-blur-[2px] group-hover:opacity-0'
              }
            `}
          >
            CA
          </span>
        </div>
      </div>

      <div
        className="
          fixed bottom-20 left-1/2 -translate-x-1/2 z-50
          flex flex-col items-center gap-1
          cursor-pointer select-none md:hidden
        "
        onClick={handleCopy}
        title="Tap to copy contract address"
      >
        <span
          className="
            rounded-full border border-black bg-black/70 px-4 py-2
            font-mono text-sm text-white backdrop-blur animate-ca-pulse
          "
        >
          {copied ? 'copied' : 'Contract Address'}
        </span>

        <span
          className="
            select-text font-mono text-[11px] tracking-wide text-white/80
          "
        >
          {address.slice(0, 6)}...{address.slice(-6)}
        </span>
      </div>
    </>
  )
}
