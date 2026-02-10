"use client";

import { useEffect, useState } from "react";

export default function HomeBlinkCell() {
  const [frame, setFrame] = useState<"v1" | "v2">("v1");

  useEffect(() => {
    let timeout: NodeJS.Timeout;

    const runBlinkCycle = () => {
      setFrame("v1");

      setTimeout(() => setFrame("v2"), 120);
      setTimeout(() => setFrame("v1"), 240);

      setTimeout(() => setFrame("v2"), 360);
      setTimeout(() => setFrame("v1"), 480);

      setTimeout(() => setFrame("v2"), 600);
      setTimeout(() => setFrame("v1"), 720);

      timeout = setTimeout(runBlinkCycle, 720 + 4000);
    };

    runBlinkCycle();

    return () => clearTimeout(timeout);
  }, []);

  return (
    <img
  src={frame === "v1" ? "/sub-v1.png" : "/sub-v2.png"}
  alt="Home cell"
  draggable={false}
  style={{
    width: "100%",
    height: "100%",
    display: "block",
    objectFit: "contain",
    transform: "scale(0.6)",
  }}
/>


  );
}
