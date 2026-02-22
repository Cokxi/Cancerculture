"use client";

// 👉 HIER später einfach mehrere WebM/WebP Slideshows eintragen
const CENTER_ANIMATIONS: string[] = [
  
];

export default function CenterAnimation() {
  // solange leer → nichts anzeigen
  if (!CENTER_ANIMATIONS.length) return null;

  return (
    <div className="flex flex-col items-center gap-6">
      {CENTER_ANIMATIONS.map((src, i) => (
        <div
          key={i}
          className="
            w-[clamp(120px,14vw,200px)]
            aspect-square
          "
        >
          <video
            autoPlay
            loop
            muted
            playsInline
            preload="metadata"
            className="
              w-full
              h-full
              object-contain
              pointer-events-none
            "
          >
            <source src={src} type="video/webm" />
          </video>
        </div>
      ))}
    </div>
  );
}