"use client";

import { useEffect, useState } from "react";

const COOLDOWN_MS = 10 * 60 * 1000;

function getRemainingMs(joinedAt: string | null) {
  if (!joinedAt) return 0;

  const joinedAtMs = new Date(joinedAt).getTime();

  if (!Number.isFinite(joinedAtMs)) {
    return COOLDOWN_MS;
  }

  return Math.max(0, COOLDOWN_MS - (Date.now() - joinedAtMs));
}

export function formatCooldownTime(ms: number) {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);

  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export default function DiscordCooldownTimer({
  joinedAt,
  className = "",
  onComplete,
}: {
  joinedAt: string | null;
  className?: string;
  onComplete?: () => void;
}) {
  const [remainingMs, setRemainingMs] = useState(() =>
    getRemainingMs(joinedAt)
  );

  useEffect(() => {
    const interval = setInterval(() => {
      const nextRemainingMs = getRemainingMs(joinedAt);
      setRemainingMs(nextRemainingMs);

      if (nextRemainingMs <= 0) {
        clearInterval(interval);
        onComplete?.();
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [joinedAt, onComplete]);

  if (!joinedAt || remainingMs <= 0) {
    return null;
  }

  return (
    <span className={className}>
      {formatCooldownTime(remainingMs)}
    </span>
  );
}
