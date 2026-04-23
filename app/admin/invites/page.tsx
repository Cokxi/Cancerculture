import { requireAdminPage } from "@/lib/auth/pageAccess";

export const dynamic = "force-dynamic";

export default async function AdminInvitesPage() {
  await requireAdminPage("/admin/invites");

  return (
    <div style={{ padding: 24 }}>
      <h1>Admin - Invites</h1>
      <p style={{ marginTop: 16, opacity: 0.8 }}>
        Invite-based mod onboarding has been retired.
      </p>
      <p style={{ marginTop: 8, opacity: 0.7 }}>
        Use the User Logs page and assign mods directly there as
        admin.
      </p>
    </div>
  );
}
