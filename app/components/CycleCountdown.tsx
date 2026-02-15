"use client";

import { useEffect, useState } from "react";

export default function CycleCountdown({ endAt }: { endAt: string }) {
  const [timeLeft, setTimeLeft] = useState("");

  useEffect(() => {
    const update = () => {
      const end = new Date(endAt).getTime();
      const now = Date.now();
      const diff = end - now;

      if (diff <= 0) {
  setTimeLeft("");
  return;
}


      const hours = Math.floor(diff / 1000 / 60 / 60);
      const minutes = Math.floor((diff / 1000 / 60) % 60);
      const seconds = Math.floor((diff / 1000) % 60);

      const formatted =
        String(hours).padStart(2, "0") +
        ":" +
        String(minutes).padStart(2, "0") +
        ":" +
        String(seconds).padStart(2, "0");

      setTimeLeft(formatted);
    };

    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [endAt]);

  if (!timeLeft) return null;

  return (
    <span className="text-green-400">
      {timeLeft}
    </span>
  );
}
