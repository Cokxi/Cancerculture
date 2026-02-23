"use client";

import {
  createContext,
  useContext,
  useState,
  ReactNode,
} from "react";

type OverlayContextType = {
  openOverlay: (node: ReactNode) => void;
  closeOverlay: () => void;
};

const OverlayContext = createContext<OverlayContextType | null>(null);

export function OverlayProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [overlay, setOverlay] = useState<ReactNode>(null);

  const openOverlay = (node: ReactNode) => {
    setOverlay(node);
  };

  const closeOverlay = () => {
    setOverlay(null);
  };

  return (
    <OverlayContext.Provider
      value={{ openOverlay, closeOverlay }}
    >
      {children}

      {/* GLOBAL OVERLAY ROOT */}
      {overlay && (
        <div className="fixed inset-0 z-[999]">
          {overlay}
        </div>
      )}
    </OverlayContext.Provider>
  );
}

export function useOverlay() {
  const ctx = useContext(OverlayContext);
  if (!ctx) {
    throw new Error("useOverlay must be inside OverlayProvider");
  }
  return ctx;
}