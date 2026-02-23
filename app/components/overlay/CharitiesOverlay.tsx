"use client";

import BaseOverlay from "./BaseOverlay";
import { useOverlay } from "./OverlayProvider";
import CharitiesContent from "@/app/components/charities/CharitiesContent";

export default function CharitiesOverlay() {
  const { closeOverlay } = useOverlay();

  return (
    <BaseOverlay onClose={closeOverlay}>
      <CharitiesContent />
    </BaseOverlay>
  );
}