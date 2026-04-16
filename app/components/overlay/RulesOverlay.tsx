"use client";

import { useState } from "react";
import { useOverlay } from "./OverlayProvider";
import BaseOverlay from "./BaseOverlay";

export default function RulesOverlay({
  isFirstAccept,
  updatedAt,
  onConfirm,
  onCancel,
}: {
  isFirstAccept: boolean;
  updatedAt: string;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}){
  const handleClose = () => {
  onCancel();
  closeOverlay();
};  
  const { closeOverlay } = useOverlay();
  const [checked, setChecked] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const formattedDate = new Date(updatedAt).toLocaleDateString("en-GB");

  const handleConfirm = async () => {
    if (!checked || isSaving) return;

    setIsSaving(true);
    await onConfirm();
    closeOverlay();
  };

  return (
    <BaseOverlay onClose={handleClose} size="compact" blocking>
  <div className="flex flex-col gap-6 px-6 pb-10 pt-4 items-center text-center">

        
        <h2 className="text-2xl font-['Permanent_Marker'] text-[var(--orange-main)] text-center">
          {isFirstAccept ? "Before submitting" : "⚠️ Rules updated"}
        </h2>

        
        <div className="text-sm text-[var(--orange-main)] leading-relaxed font-['Permanent_Marker']">
          {isFirstAccept ? (
            <>
              Please review and accept the{" "}
              <a
                href="/faq"
                target="_blank"
                rel="noopener noreferrer"
                className="underline font-semibold cursor-pointer"
              >
                Rules
              </a>{" "}
              before continuing.
            </>
          ) : (
            <>
              We updated our{" "}
              <a
                href="/faq"
                target="_blank"
                rel="noopener noreferrer"
                className="underline font-semibold cursor-pointer"
              >
                Rules
              </a>
              . Please review and confirm again.
              <div className="text-xs opacity-70 mt-2">
                Updated on: {formattedDate}
              </div>
            </>
          )}
        </div>

        
<label className="
  flex items-center justify-center
  gap-3
  text-sm
  cursor-pointer
  text-[var(--orange-main)]
  leading-relaxed
  font-['Permanent_Marker']
">
  <input
    type="checkbox"
    checked={checked}
    onChange={() => setChecked(!checked)}
    className="w-4 h-4 accent-[var(--orange-main)]"
  />
  <span>I have read and accept the Rules</span>
</label>

        
        <button
          onClick={handleConfirm}
          disabled={!checked || isSaving}
          className={`py-3 rounded-xl transition ${
            checked
              ? "bg-black text-yellow-300 cursor-pointer"
              : "bg-gray-300 text-gray-500 cursor-not-allowed"
          }`}
        >
          Confirm
        </button>

      </div>
    </BaseOverlay>
  );
}