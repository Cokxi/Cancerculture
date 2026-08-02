"use client";

import {
  useCallback,
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
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

  const openOverlay = useCallback((node: ReactNode) => {
    setOverlay(node);
  }, []);

  const closeOverlay = useCallback(() => {
    setOverlay(null);
  }, []);

  const contextValue = useMemo(
    () => ({ openOverlay, closeOverlay }),
    [closeOverlay, openOverlay]
  );

  return (
    <OverlayContext.Provider
      value={contextValue}
    >
      {children}

      
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
