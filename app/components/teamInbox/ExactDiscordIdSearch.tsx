"use client";

import Link from "next/link";
import { useState } from "react";

export default function ExactDiscordIdSearch({ topicKey }: { topicKey: string }) {
  const [value, setValue] = useState("");
  const [items, setItems] = useState<Record<string, unknown>[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [searchedId, setSearchedId] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  const runSearch = async (exactDiscordId: string, cursor: string | null) => {
    setStatus("Searching…");
    try {
      const response = await fetch("/api/admin/team-inbox/search-exact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topicKey, exactDiscordId, cursor }),
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Search unavailable");
      const result = await response.json() as Record<string, unknown>;
      const nextItems = Array.isArray(result.items) ? result.items as Record<string, unknown>[] : [];
      setItems((current) => cursor ? [...current, ...nextItems] : nextItems);
      setSearchedId(exactDiscordId);
      setNextCursor(typeof result.nextCursor === "string" ? result.nextCursor : null);
      setValue("");
      setStatus(`${nextItems.length} matching case${nextItems.length === 1 ? "" : "s"}.`);
    } catch {
      setItems([]);
      setNextCursor(null);
      setStatus("Exact search is temporarily unavailable.");
    }
  };

  const search = async (event: React.FormEvent) => {
    event.preventDefault();
    await runSearch(value.trim(), null);
  };

  return (
    <section className="rounded-2xl border border-white/10 bg-black/35 p-5" aria-labelledby="exact-search-title">
      <h2 id="exact-search-title" className="font-semibold">Protected exact Discord ID search</h2>
      <p className="mt-1 text-xs text-white/50">The ID is sent only in this protected request body and is never added to the URL.</p>
      <form onSubmit={(event) => void search(event)} className="mt-3 flex flex-wrap gap-3">
        <label className="sr-only" htmlFor="exact-discord-id">Exact Discord ID</label>
        <input
          id="exact-discord-id"
          value={value}
          onChange={(event) => setValue(event.target.value.replace(/\D/gu, "").slice(0, 100))}
          inputMode="numeric"
          autoComplete="off"
          required
          className="min-h-11 flex-1 rounded-lg border border-white/15 bg-black px-3 text-white"
          placeholder="Exact Discord ID"
        />
        <button className="min-h-11 cursor-pointer rounded-lg border border-orange-400/50 px-4 py-2 text-orange-100">Search</button>
      </form>
      {status ? <p className="mt-3 text-sm text-white/65" role="status">{status}</p> : null}
      {items.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {items.map((item) => typeof item.id === "string" ? (
            <li key={item.id}>
              <Link prefetch={false} href={`/admin/inbox/${topicKey}/${item.id}`} className="block rounded-lg border border-white/10 px-3 py-2 hover:border-orange-400/40">
                {typeof item.username === "string" ? item.username : "Account"} · {typeof item.status === "string" ? item.status : "case"}
              </Link>
            </li>
          ) : null)}
        </ul>
      ) : null}
      {nextCursor && searchedId ? (
        <button
          type="button"
          onClick={() => void runSearch(searchedId, nextCursor)}
          className="mt-3 min-h-11 rounded-lg border border-white/15 px-4"
        >
          More exact matches
        </button>
      ) : null}
    </section>
  );
}
