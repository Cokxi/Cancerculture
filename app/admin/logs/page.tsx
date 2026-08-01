import Link from "next/link";
import { requireAdminPage } from "@/lib/auth/pageAccess";

export default async function AdminLogsPage() {
  await requireAdminPage("/admin/logs");

  return (
    <div style={{ padding: 24 }}>
      <h1>Admin - Logs</h1>

      <p style={{ marginTop: 8, opacity: 0.7 }}>
        Select a log category:
      </p>

      <ul style={{ marginTop: 24, lineHeight: 2 }}>
        <li>
          <Link href="/admin/logs/cycles">Cycle Logs</Link>
        </li>

        <li>
          <Link href="/admin/logs/uploads">Upload Logs</Link>
        </li>

        <li>
          <Link href="/admin/logs/avatar-uploads">
            Avatar Upload Logs
          </Link>
        </li>

        <li>
          <Link href="/admin/logs/votes">Vote Logs</Link>
        </li>

        <li>
          <Link href="/admin/logs/winners">Winner Payouts</Link>
        </li>

        <li>
          <Link href="/admin/logs/discord-sync">
            Discord Sync Health
          </Link>
        </li>

        <li>
          <Link href="/admin/logs/moderation">
            Moderation Logs
          </Link>
        </li>

        <li>
          <Link href="/admin/logs/sponsors">
            Sponsor Reports
          </Link>
        </li>
      </ul>
    </div>
  );
}
