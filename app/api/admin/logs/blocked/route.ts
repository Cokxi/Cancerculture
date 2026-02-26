export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { requireModOrAdmin } from "@/lib/auth/guards";
import { supabaseAdmin } from "@/lib/db/admin";

export async function GET(req: Request) {
  try {
    // 🔐 Guard
    await requireModOrAdmin();

    // 🔎 Sort Mode lesen
    const { searchParams } = new URL(req.url);
    const sortMode = searchParams.get("sort") === "general" ? "general" : "latest";

    // 1️⃣ Block Events laden
    const { data: events, error: eventsError } = await supabaseAdmin
      .from("blocked_cycle_events")
      .select("discord_user_id, cycle_id, created_at");

    if (eventsError || !events) {
      return NextResponse.json(
        { error: "Failed to load blocked cycle events" },
        { status: 500 }
      );
    }

    // 2️⃣ Meta laden (handled flag)
    const { data: meta } = await supabaseAdmin
      .from("blocked_user_meta")
      .select("discord_user_id, admin_handled");

    const metaMap: Record<string, boolean> = {};
    for (const m of meta ?? []) {
      metaMap[m.discord_user_id] = !!m.admin_handled;
    }

    // 3️⃣ Aggregation pro User
    const users: Record<
      string,
      {
        discord_user_id: string;
        blocked_cycles: number[];
        block_count: number;
        latest_cycle: number;
        latest_created_at: string | null;
        admin_handled: boolean;
      }
    > = {};

    for (const e of events) {
      if (!users[e.discord_user_id]) {
        users[e.discord_user_id] = {
          discord_user_id: e.discord_user_id,
          blocked_cycles: [],
          block_count: 0,
          latest_cycle: e.cycle_id,
          latest_created_at: e.created_at ?? null,
          admin_handled: metaMap[e.discord_user_id] ?? false,
        };
      }

      const u = users[e.discord_user_id];

      u.blocked_cycles.push(e.cycle_id);
      u.block_count++;

      // latest bestimmen
      if (e.created_at && (!u.latest_created_at || e.created_at > u.latest_created_at)) {
        u.latest_created_at = e.created_at;
        u.latest_cycle = e.cycle_id;
      }
    }

    // 4️⃣ Array bauen
    let result = Object.values(users);

    // 5️⃣ Sortierung
    if (sortMode === "general") {
      // meist geblockt zuerst
      result.sort((a, b) => b.block_count - a.block_count);
    } else {
      // latest zuerst
      result.sort((a, b) => {
        if (!a.latest_created_at) return 1;
        if (!b.latest_created_at) return -1;
        return b.latest_created_at.localeCompare(a.latest_created_at);
      });
    }

    return NextResponse.json({ users: result });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message ?? "Forbidden" },
      { status: err.status ?? 403 }
    );
  }
}