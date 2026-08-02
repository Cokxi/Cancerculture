"use client";

import { useOverlay } from "./OverlayProvider";
import BaseOverlay from "./BaseOverlay";
import { useEffect, useState } from "react";
import { DISCORD_INVITE_URL } from "@/lib/discordInvite";

type Props = {
  type: "not_in_discord" | "cooldown";
  joinedAt?: string;
};

const COOLDOWN_MS = 10 * 60 * 1000;
const COMPLETION_LINES = [
  "You did your time.",
  "Thank you for your patience.",
  "Make it count.",
];

export default function DiscordGateOverlay({
  type,
  joinedAt,
}: Props) {
  const { closeOverlay, openOverlay } = useOverlay();

  const [remaining, setRemaining] = useState(() => {
  if (!joinedAt) return 0;

  const now = Date.now();
  const joined = new Date(joinedAt).getTime();

  return Math.max(0, COOLDOWN_MS - (now - joined));
});

  const [isDone, setIsDone] = useState(false);
  const [displayText, setDisplayText] = useState("");

  useEffect(() => {
  if (type !== "cooldown") return;
  if (joinedAt) return;

  const fetchData = async () => {
    try {
      const res = await fetch("/api/discord/check");
      const data = await res.json();

      if (data.status === "COOLDOWN") {
        openOverlay(
          <DiscordGateOverlay
            type="cooldown"
            joinedAt={data.joinedAt}
          />
        );
      }

      if (data.status === "OK") {
        setIsDone(true);
      }
    } catch {}
  };

  fetchData();
}, [type, joinedAt, openOverlay]);

  useEffect(() => {
    if (type !== "cooldown" || !joinedAt) return;

    const interval = setInterval(() => {
      const now = Date.now();
      const joined = new Date(joinedAt).getTime();

      const diff = COOLDOWN_MS - (now - joined);

      if (diff <= 0) {
  setRemaining(0);
  setIsDone(true);
        clearInterval(interval);
      } else {
        setRemaining(diff);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [type, joinedAt]);

  
useEffect(() => {
  if (!isDone) return;

  let lineIndex = 0;
  let charIndex = 0;
  let currentText = "";

  const typeNextChar = () => {
    if (lineIndex >= COMPLETION_LINES.length) {
      setTimeout(() => {
        closeOverlay();
      }, 3000);
      return;
    }

    const currentLine = COMPLETION_LINES[lineIndex];

    if (charIndex < currentLine.length) {
      currentText += currentLine[charIndex];
      setDisplayText(currentText);
      charIndex++;

      setTimeout(typeNextChar, 65);
    } else {
      currentText += "\n";
      setDisplayText(currentText);

      lineIndex++;
      charIndex = 0;

      setTimeout(typeNextChar, 1000); 
    }
  };

  typeNextChar();
}, [closeOverlay, isDone]);

  
  useEffect(() => {
    if (type !== "not_in_discord") return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch("/api/discord/check");
        const data = await res.json();

        if (data.status === "COOLDOWN") {
          closeOverlay();

          setTimeout(() => {
            openOverlay(
              <DiscordGateOverlay
                type="cooldown"
                joinedAt={data.joinedAt}
              />
            );
          }, 100);

          return;
        }

        if (data.status === "OK") {
          setIsDone(true);
          return;
        }
      } catch {}
    }, 8000);

    return () => clearInterval(interval);
  }, [closeOverlay, openOverlay, type]);

  const minutes = Math.floor(remaining / 60000);
  const seconds = Math.floor((remaining % 60000) / 1000);

if (type === "cooldown" && !joinedAt) {
  return (
    <BaseOverlay onClose={closeOverlay} size="compact" blocking>
      <div className="flex items-center justify-center h-32 text-[var(--orange-main)] font-['Permanent_Marker']">
        Checking access...
      </div>
    </BaseOverlay>
  );
}


  return (
    <BaseOverlay onClose={closeOverlay} size="compact" blocking>
      <div className="flex flex-col gap-6 px-6 pb-10 pt-4 items-center text-center">

        {type === "not_in_discord" && (
          <>
            <h2 className="text-2xl font-['Permanent_Marker'] text-[var(--orange-main)]">
              Join the Community
            </h2>

            <p className="text-sm text-[var(--orange-main)] leading-relaxed font-['Permanent_Marker']">
              You need to join our Discord server to submit your entry.
            </p>

            <a
              href={DISCORD_INVITE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="py-3 px-6 rounded-xl bg-black text-yellow-300 cursor-pointer"
            >
              Join Discord
            </a>
          </>
        )}

        {type === "cooldown" && (
          <>
            <h2 className="text-2xl font-['Permanent_Marker'] text-[var(--orange-main)]">
              You&apos;re almost in
            </h2>

            <div className="text-sm text-[var(--orange-main)] opacity-80 max-w-xs text-center">
              Please wait a few minutes before submitting.
            </div>

            <div className="text-xs text-[var(--orange-main)] opacity-70 max-w-xs text-center">
              This helps prevent spam and keeps the competition fair.
            </div>

            <div className="h-16 flex items-center justify-center mt-2">
              {!isDone ? (
  !joinedAt ? (
    <div className="text-sm text-[var(--orange-main)] opacity-80">
      Checking access...
    </div>
  ) : (
    <div className="text-3xl font-bold text-[var(--orange-main)]">
      {minutes}:{seconds.toString().padStart(2, "0")}
    </div>
  )
) : (
                <div className="text-sm whitespace-pre-line text-center text-white">
                  {displayText}
                  <span className="animate-pulse text-white">|</span>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </BaseOverlay>
  );
}
