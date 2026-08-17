"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

let refreshScheduled = false;

function formatRemaining(remainingMs: number) {
  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
}

export default function ClaimCountdown({
  deadlineAt,
  databaseTime,
  className = "",
}: {
  deadlineAt: string;
  databaseTime: string | null;
  className?: string;
}) {
  return (
    <CountdownRuntime
      key={`${deadlineAt}:${databaseTime ?? "missing"}`}
      deadlineAt={deadlineAt}
      databaseTime={databaseTime}
      className={className}
    />
  );
}

function CountdownRuntime({
  deadlineAt,
  databaseTime,
  className,
}: {
  deadlineAt: string;
  databaseTime: string | null;
  className: string;
}) {
  const router = useRouter();
  const initialDatabaseNow = useMemo(() => {
    const parsed = databaseTime ? Date.parse(databaseTime) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : Date.parse(deadlineAt);
  }, [databaseTime, deadlineAt]);
  const deadlineMs = useMemo(() => Date.parse(deadlineAt), [deadlineAt]);
  const [nowMs, setNowMs] = useState(initialDatabaseNow);
  const requestedRefresh = useRef(false);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowMs((current) => current + 1_000);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const remainingMs = Number.isFinite(deadlineMs)
    ? Math.max(0, deadlineMs - nowMs)
    : 0;

  useEffect(() => {
    if (remainingMs > 0 || requestedRefresh.current) return;
    requestedRefresh.current = true;
    if (refreshScheduled) return;
    refreshScheduled = true;
    router.refresh();
    window.setTimeout(() => {
      refreshScheduled = false;
    }, 1_500);
  }, [remainingMs, router]);

  return (
    <span data-winner-claim-countdown role="timer" className={className}>
      {formatRemaining(remainingMs)}
    </span>
  );
}
