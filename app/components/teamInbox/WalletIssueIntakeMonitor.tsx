"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type Item = Record<string, unknown>;

export default function WalletIssueIntakeMonitor() {
  const [items, setItems] = useState<Item[]>([]);
  const [status, setStatus] = useState("Loading Wallet Issue intakes…");

  const load = useCallback(async () => {
    const response = await fetch("/api/admin/team-inbox/wallet-issues/intake-monitor", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
    });
    const result = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error("unavailable");
    setItems(Array.isArray(result.items) ? result.items as Item[] : []);
    setStatus("");
  }, []);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void load().catch(() => setStatus("The Intake Monitor is unavailable."));
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [load]);

  return (
    <div className="space-y-4">
      <p className="text-sm text-white/65">
        Shadow view of all retained submissions. Non-winning intakes and their screenshots are permanently deleted 14 days after Cycle finalization.
      </p>
      {status ? <p role="status">{status}</p> : null}
      <ul className="space-y-4">
        {items.map((item) => (
          <li key={String(item.intakeId)} className="rounded-2xl border border-white/10 bg-black/35 p-5">
            <div className="flex flex-wrap justify-between gap-3">
              <p className="font-semibold">{String(item.username ?? "Account")} · Cycle #{String(item.cycleNumber ?? "-")} · Submission #{String(item.submissionId ?? "-")}</p>
              <span className="text-xs uppercase text-white/55">{String(item.status ?? "intake").replaceAll("_", " ")}</span>
            </div>
            <p className="mt-3 whitespace-pre-wrap text-sm text-white/75">{String(item.description ?? "")}</p>
            <code className="mt-3 block overflow-x-auto rounded bg-black/50 p-2 text-xs">{String(item.desiredRecipient ?? "")}</code>
            <div className="mt-4 flex flex-wrap gap-3 text-sm">
              {item.screenshotAvailable === true ? (
                <a href={`/api/admin/team-inbox/wallet-issues/intakes/${String(item.intakeId)}/screenshot`} target="_blank" rel="noreferrer" className="text-orange-200 underline">View private screenshot</a>
              ) : null}
              {typeof item.caseId === "string" ? (
                <Link href={`/admin/inbox/wallet_issues/${item.caseId}`} className="text-orange-200 underline">Open promoted case</Link>
              ) : null}
            </div>
            {typeof item.deleteAfter === "string" ? <p className="mt-3 text-xs text-white/45">Permanent deletion after {new Date(item.deleteAfter).toLocaleString()}</p> : null}
          </li>
        ))}
      </ul>
      {!status && items.length === 0 ? <p className="rounded-xl border border-white/10 p-6 text-center text-white/60">No retained Wallet Issue intakes.</p> : null}
    </div>
  );
}
