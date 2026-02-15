"use client";

import { useEffect, useState } from "react";

export default function HomeBlinkCell({
  mode = "success",
}: {
  mode?: "success" | "already";
}) {

  const [frame, setFrame] = useState<"v1" | "v2">("v1");

  useEffect(() => {
  let timeouts: NodeJS.Timeout[] = [];

  const runBlinkCycle = () => {
    setFrame("v1");

    timeouts.push(setTimeout(() => setFrame("v2"), 120));
    timeouts.push(setTimeout(() => setFrame("v1"), 240));

    timeouts.push(setTimeout(() => setFrame("v2"), 360));
    timeouts.push(setTimeout(() => setFrame("v1"), 480));

    timeouts.push(setTimeout(() => setFrame("v2"), 600));
    timeouts.push(setTimeout(() => setFrame("v1"), 720));

    timeouts.push(setTimeout(runBlinkCycle, 720 + 4000));
  };

  runBlinkCycle();

  return () => {
    timeouts.forEach(clearTimeout);
  };
}, []);


  return (
    <img
  src={
  mode === "already"
    ? frame === "v1"
      ? "/already-V1.png"
      : "/already-V2.png"
    : frame === "v1"
    ? "/sub-v1.png"
    : "/sub-v2.png"
}

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
