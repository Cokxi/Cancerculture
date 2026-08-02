"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

export default function CycleCountdown({
  endAt,
  timerLabel,
  expiredLabel,
}: {
  endAt: string;
  timerLabel: string;
  expiredLabel: string;
}) {
  const router = useRouter();
  const [timeLeft, setTimeLeft] = useState("");
  const [expired, setExpired] = useState(false);
  const [delayed, setDelayed] = useState(false);

  useEffect(() => {
    const end = new Date(endAt).getTime();
    let refreshInterval: ReturnType<typeof setInterval> | null = null;
    let delayedTimeout: ReturnType<typeof setTimeout> | null = null;

    const beginTransitionRefresh = () => {
      if (refreshInterval) return;
      setExpired(true);
      setTimeLeft("");
      router.refresh();
      refreshInterval = setInterval(() => router.refresh(), 3000);
      delayedTimeout = setTimeout(() => setDelayed(true), 90000);
    };

    const update = () => {
      const now = Date.now();
      const diff = end - now;

      if (diff <= 0) {
        beginTransitionRefresh();
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
    return () => {
      clearInterval(interval);
      if (refreshInterval) clearInterval(refreshInterval);
      if (delayedTimeout) clearTimeout(delayedTimeout);
    };
  }, [endAt, router]);

  if (expired) {
    return (
      <span
        role="status"
        aria-live="polite"
        className={delayed ? "text-red-400" : "text-green-400"}
      >
        {delayed
          ? "Phase transition is taking longer than expected."
          : expiredLabel}
      </span>
    );
  }

  if (!timeLeft) return null;

  return (
    <>
      <span className="text-[var(--orange-main)]">{timerLabel} </span>
      <span className="text-green-400">{timeLeft}</span>
    </>
  );
}
