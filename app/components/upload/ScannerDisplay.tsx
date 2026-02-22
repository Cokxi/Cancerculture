"use client";

type ScannerDisplayProps = {
  hasPreview: boolean;
  onClick?: () => void;
};

const SCANNER_IDLE =
  "https://cdn.cancerculture.fun/webm/scanner/scan.idle.webm";

const SCANNER_READY =
  "https://cdn.cancerculture.fun/webm/scanner/scan.rdy.webm";

export default function ScannerDisplay({
  hasPreview,
  onClick,
}: ScannerDisplayProps) {
  const src = hasPreview ? SCANNER_READY : SCANNER_IDLE;

  return (
    <div
      onClick={onClick}
      className="cursor-pointer active:scale-95 transition"
    >
      <video
        key={src} // wichtig: zwingt React zum reload beim Wechsel
        src={src}
        autoPlay
        loop
        muted
        playsInline
        className="w-[420px] max-w-[80vw] h-auto"
      />
    </div>
  );
}