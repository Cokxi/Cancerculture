"use client";

import Link from "next/link";

export default function AdminLogsPage() {
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
