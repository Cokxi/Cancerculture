"use client";

import { useEffect, useState } from "react";
import { navigationTriggerBaseClassName } from "@/app/components/navigation/navigationButtonStyles";

const SHOW_AFTER_PX = 480;

export default function BackToTopButton() {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    let animationFrame: number | null = null;

    const updateVisibility = () => {
      animationFrame = null;
      const nextVisibility = window.scrollY >= SHOW_AFTER_PX;

      setIsVisible((currentVisibility) =>
        currentVisibility === nextVisibility
          ? currentVisibility
          : nextVisibility
      );
    };

    const handleScroll = () => {
      if (animationFrame === null) {
        animationFrame = window.requestAnimationFrame(updateVisibility);
      }
    };

    updateVisibility();
    window.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      window.removeEventListener("scroll", handleScroll);

      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
      }
    };
  }, []);

  if (!isVisible) return null;

  const handleBackToTop = () => {
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;

    window.scrollTo({
      top: 0,
      behavior: reduceMotion ? "instant" : "smooth",
    });
  };

  return (
    <button
      type="button"
      onClick={handleBackToTop}
      aria-label="Back to top"
      className={`${navigationTriggerBaseClassName} fixed right-4 bottom-[calc(env(safe-area-inset-bottom)+1rem)] z-40 h-11 w-11 p-0 sm:bottom-6 sm:right-6`}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 20 20"
        className="h-5 w-5"
        fill="none"
      >
        <path
          d="M4.5 12.5 10 7l5.5 5.5"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
