"use client";

import { ReactNode, useCallback, useEffect, useRef, useState } from "react";

export default function BaseOverlay({
  children,
  onClose,
  size = "full",
  blocking = false,
}: {
  children: ReactNode;
  onClose: () => void;
  size?: "full" | "compact";
  blocking?: boolean;
}) {
  const [isVisible, setIsVisible] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const startX = useRef<number | null>(null);
  const [dragX, setDragX] = useState(0);

  const handleClose = useCallback(() => {
    if (isClosing) return;

    setIsClosing(true);

    setTimeout(() => {
      onClose();
    }, 1000);
  }, [isClosing, onClose]);

  useEffect(() => {
    requestAnimationFrame(() => {
      setIsVisible(true);
    });

    const handleKey = (e: KeyboardEvent) => {
      if (!blocking && e.key === "Escape") {
        handleClose();
      }
    };

    window.addEventListener("keydown", handleKey);

    return () => {
      window.removeEventListener("keydown", handleKey);
    };
  }, [blocking, handleClose]);

  return (
    <div
      className="fixed inset-0 z-[999] overflow-x-hidden"
      onClick={blocking ? undefined : handleClose}
    >
      <div
        className={`
          absolute inset-0
          bg-black/50 backdrop-blur-sm
          transition-opacity duration-400
          ${isVisible && !isClosing ? "opacity-100" : "opacity-0"}
        `}
      />

      <div
        className={`
          relative
          w-[94%] md:w-[600px] xl:w-[700px]
          ${
            size === "full"
              ? "h-[94vh] my-[3vh]"
              : "h-auto mt-[40vh] mb-[5vh] max-h-[55vh]"
          }
          mx-auto
          bg-orange-background
          shadow-[0_20px_60px_rgba(0,0,0,0.35)]
          rounded-2xl
          ${blocking ? "overflow-hidden" : "overflow-y-auto overscroll-contain"}
          overflow-x-hidden
          transition-transform duration-1000 ease-[cubic-bezier(0.22,1,0.36,1)]
        `}
        style={{
          transform:
            isVisible && !isClosing
              ? `translateX(${dragX}px)`
              : `translateX(calc(100vw + 80px))`,
        }}
        onClick={(e) => e.stopPropagation()}
        onTouchStart={(e) => {
          startX.current = e.touches[0].clientX;
        }}
        onTouchMove={(e) => {
          if (startX.current === null) return;

          const diff = e.touches[0].clientX - startX.current;

          if (diff > 0) {
            setDragX(diff);
          }
        }}
        onTouchEnd={() => {
          if (!blocking && dragX > 120) {
            handleClose();
          }

          setDragX(0);
          startX.current = null;
        }}
      >
        <div className="sticky top-0 z-10 flex justify-center py-3 relative">
          <div className="w-12 h-1.5 rounded-full bg-black/20" />

          {!blocking && (
            <button
              onClick={handleClose}
              aria-label="Close overlay"
              className="
                absolute right-3 top-2
                text-2xl leading-none
                px-3 py-1
                rounded-xl
                bg-black/10 backdrop-blur-sm
                text-[var(--orange-main)]
                hover:bg-black/20
                active:scale-95
                transition
                cursor-pointer
              "
            >
              <span className="block -translate-y-[1px]">x</span>
            </button>
          )}
        </div>

        {children}
      </div>
    </div>
  );
}
