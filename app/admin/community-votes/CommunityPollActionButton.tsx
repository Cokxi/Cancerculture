"use client";

import { useFormStatus } from "react-dom";

export default function CommunityPollActionButton({
  children,
  pendingLabel,
  confirmation,
  className,
  disabled = false,
}: {
  children: React.ReactNode;
  pendingLabel: string;
  confirmation?: string;
  className: string;
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={disabled || pending}
      aria-disabled={disabled || pending}
      className={className}
      onClick={(event) => {
        if (confirmation && !window.confirm(confirmation)) {
          event.preventDefault();
        }
      }}
    >
      {pending ? pendingLabel : children}
    </button>
  );
}
