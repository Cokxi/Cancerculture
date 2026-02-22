import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { getTeamMember } from "@/lib/auth/guards";
import BackButton from "@/app/components/ui/BackButton";

export default async function AdminLayout({
  children,
}: {
  children: ReactNode;
}) {
  let member;

  try {
    member = await getTeamMember();
  } catch {
    redirect("/403");
  }

  const isAdmin = member.role === "admin";

  return (
    <div className="min-h-screen flex bg-neutral-950 text-white/90">
      {/* SIDEBAR */}
      <nav className="w-[220px] shrink-0 border-r border-white/10 p-4 text-sm">
        <BackButton />

        <ul className="space-y-2">
          {isAdmin && (
            <li>
              <Link
                href="/admin/cycles"
                className="block px-2 py-1 rounded hover:bg-white/10"
              >
                Cycles
              </Link>
            </li>
          )}

          <li>
            <Link
              href="/admin/moderation/submissions"
              className="block px-2 py-1 rounded hover:bg-white/10"
            >
              Moderation
            </Link>
          </li>
          <li className="ml-3">
  <Link
    href="/admin/moderation/disqualified"
    className="block px-2 py-1 rounded hover:bg-white/10 text-yellow-300"
  >
    ⚠️ Disqualified Submissions
  </Link>
</li>

          <li className="mt-4 text-white/50 uppercase text-xs">
            Logs
          </li>

          {isAdmin && (
  <li className="ml-3">
    <Link
      href="/admin/flags"
      className="block px-2 py-1 rounded hover:bg-white/10"
    >
      🚩 Flagged Users
    </Link>
  </li>
)}


          {/* 🆕 USER LOGS */}
          <li className="ml-3">
            <Link
              href="/admin/users"
              className="block px-2 py-1 rounded hover:bg-white/10"
            >
              User Logs
            </Link>
          </li>

          <li className="ml-3">
            <Link
              href="/admin/logs/cycles"
              className="block px-2 py-1 rounded hover:bg-white/10"
            >
              Cycle Logs
            </Link>
          </li>

          <li className="ml-3">
            <Link
              href="/admin/logs/uploads"
              className="block px-2 py-1 rounded hover:bg-white/10"
            >
              Upload Logs
            </Link>
          </li>

          <li className="ml-3">
            <Link
              href="/admin/logs/votes"
              className="block px-2 py-1 rounded hover:bg-white/10"
            >
              Vote Logs
            </Link>
          </li>

          {isAdmin && (
  <li className="ml-3">
    <Link
      href="/admin/logs/moderation"
      className="block px-2 py-1 rounded hover:bg-white/10"
    >
      Moderation Logs
    </Link>
  </li>
)}


          {isAdmin && (
            <>

              <li>
  <Link
    href="/admin/bans"
    className="block px-2 py-1 rounded hover:bg-white/10 text-red-400"
  >
    ⛔ Banned Users
  </Link>
</li>


              <li className="mt-4">
                <Link
                  href="/admin/invites"
                  className="block px-2 py-1 rounded hover:bg-white/10"
                >
                  📨 Invites
                </Link>
              </li>

              <li>
                <Link
                  href="/admin/mods"
                  className="block px-2 py-1 rounded hover:bg-white/10"
                >
                  🛡️ Mods
                </Link>
              </li>
            </>
          )}
        </ul>
      </nav>

      {/* CONTENT */}
      <main className="flex-1 p-6 overflow-y-auto">
        {children}
      </main>
    </div>
  );
}
