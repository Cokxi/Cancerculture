"use client";

type Props = {
  mode?: "success" | "already";
};

const SUCCESS_VIDEO =
  "https://cdn.cancerculture.fun/webm/sub.received/SubRcvd.webm";

const ALREADY_VIDEO =
  "https://cdn.cancerculture.fun/webm/already/SubAlrdy.webm";

export default function HomeBlinkCell({ mode = "success" }: Props) {
  const src = mode === "already" ? ALREADY_VIDEO : SUCCESS_VIDEO;

  return (
    <video
      key={src}
      src={src}
      autoPlay
      loop
      muted
      playsInline
      draggable={false}
      className="block w-full h-full object-contain scale-[0.6]"
    />
  );
}