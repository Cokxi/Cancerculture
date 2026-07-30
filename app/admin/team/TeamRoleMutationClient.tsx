"use client";

import { useRouter } from "next/navigation";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { TeamCapabilitySyncStatus } from "@/lib/auth/teamRoleAdminReadModel";

export type MutationOperation = {
  title: string;
  summary: ReactNode;
  warning?: string;
  successMessage: string;
  payload: Record<string, unknown>;
  requiresAdminWord?: boolean;
};

type MutationContextValue = {
  review: (operation: MutationOperation) => void;
};

const MutationContext = createContext<MutationContextValue | null>(
  null
);

export const inputClass =
  "w-full rounded border border-white/20 bg-black/40 px-3 py-2 text-sm text-white outline-none focus-visible:ring-2 focus-visible:ring-orange-300 disabled:opacity-50";
export const buttonClass =
  "cursor-pointer rounded border border-white/20 bg-white/5 px-3 py-2 text-sm font-medium text-white outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-orange-300 disabled:cursor-not-allowed disabled:opacity-40";

export const syncLabels: Readonly<
  Record<TeamCapabilitySyncStatus, string>
> = {
  synchronized: "Synchronized",
  code_missing: "Missing from code registry",
  catalog_missing: "Missing from database catalog",
  definition_mismatch: "Definition mismatch",
  version_mismatch: "Version mismatch",
  inactive: "Inactive",
  not_assignable: "Not assignable",
};

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="grid gap-1 text-sm">
      <span className="font-medium text-white/90">{label}</span>
      {children}
      {hint ? (
        <span className="text-xs text-white/50">{hint}</span>
      ) : null}
    </label>
  );
}

function MutationDialog({
  operation,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  operation: MutationOperation;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (reason: string, adminWord: string) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState("");
  const [adminWord, setAdminWord] = useState("");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
    }
  }, []);

  const valid =
    reason.trim().length >= 3 &&
    (!operation.requiresAdminWord || adminWord === "ADMIN");

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="team-mutation-title"
      aria-describedby="team-mutation-description"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
      className="m-auto w-[min(620px,calc(100%-2rem))] rounded-xl border border-white/20 bg-neutral-950 p-0 text-white shadow-2xl backdrop:bg-black/80"
    >
      <form
        method="dialog"
        className="grid gap-5 p-5 sm:p-6"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid && !busy) {
            onConfirm(reason.trim(), adminWord);
          }
        }}
      >
        <div>
          <h2
            id="team-mutation-title"
            className="text-xl font-semibold text-orange-300"
          >
            {operation.title}
          </h2>
          <div
            id="team-mutation-description"
            className="mt-3 rounded-lg border border-white/10 bg-white/5 p-4 text-sm text-white/80"
          >
            {operation.summary}
          </div>
        </div>

        {operation.warning ? (
          <div
            role="note"
            className="rounded-lg border border-amber-500/50 bg-amber-950/30 p-3 text-sm text-amber-200"
          >
            <strong>Important:</strong> {operation.warning}
          </div>
        ) : null}

        <Field
          label="Reason"
          hint="Required. Stored in the append-only authorization audit."
        >
          <textarea
            autoFocus
            className={`${inputClass} min-h-24`}
            value={reason}
            disabled={busy}
            maxLength={1000}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Explain why this authorization change is required"
          />
        </Field>

        {operation.requiresAdminWord ? (
          <Field
            label='Type "ADMIN" to confirm'
            hint="Owner access is independent from capability grants."
          >
            <input
              className={inputClass}
              value={adminWord}
              disabled={busy}
              autoComplete="off"
              onChange={(event) => setAdminWord(event.target.value)}
            />
          </Field>
        ) : null}

        {error ? (
          <p role="alert" className="text-sm text-red-300">
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap justify-end gap-3">
          <button
            type="button"
            className={buttonClass}
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="submit"
            className={`${buttonClass} border-orange-400/60 bg-orange-500/15 text-orange-200`}
            disabled={busy || !valid}
          >
            {busy ? "Applying…" : "Confirm change"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

export function useTeamRoleMutation() {
  const value = useContext(MutationContext);
  if (!value) {
    throw new Error("Team role mutation context is unavailable");
  }
  return value;
}

export default function TeamRoleMutationProvider({
  children,
}: {
  children: ReactNode;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<MutationOperation | null>(
    null
  );
  const [idempotencyKey, setIdempotencyKey] = useState<
    string | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(
    null
  );
  const [successMessage, setSuccessMessage] = useState<
    string | null
  >(null);

  function review(operation: MutationOperation) {
    setPending(operation);
    setIdempotencyKey(crypto.randomUUID());
    setDialogError(null);
    setSuccessMessage(null);
  }

  async function confirm(reason: string, adminWord: string) {
    if (!pending || !idempotencyKey) return;
    setBusy(true);
    setDialogError(null);

    try {
      const response = await fetch("/api/admin/team/roles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...pending.payload,
          reason,
          idempotencyKey,
          ...(pending.requiresAdminWord
            ? { confirmationWord: adminWord }
            : {}),
        }),
      });
      const body = await response.json().catch(() => null);

      if (!response.ok) {
        setDialogError(
          typeof body?.error === "string"
            ? body.error
            : "The authorization change could not be applied."
        );
        if (
          response.status === 403 ||
          response.status === 409 ||
          response.status === 503
        ) {
          router.refresh();
        }
        return;
      }

      const createdKey =
        typeof body?.result?.role?.key === "string"
          ? ` Technical key: ${body.result.role.key}.`
          : "";
      setSuccessMessage(`${pending.successMessage}${createdKey}`);
      setPending(null);
      setIdempotencyKey(null);
      router.refresh();
    } catch {
      setDialogError(
        "The authorization service could not be reached. Retry keeps the same idempotency key."
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <MutationContext.Provider value={{ review }}>
      {successMessage ? (
        <div
          role="status"
          className="mb-5 rounded-lg border border-green-500/40 bg-green-950/20 p-4 text-sm text-green-200"
        >
          {successMessage}
        </div>
      ) : null}
      {children}
      {pending ? (
        <MutationDialog
          key={idempotencyKey}
          operation={pending}
          busy={busy}
          error={dialogError}
          onCancel={() => {
            if (!busy) {
              setPending(null);
              setIdempotencyKey(null);
              setDialogError(null);
            }
          }}
          onConfirm={confirm}
        />
      ) : null}
    </MutationContext.Provider>
  );
}
