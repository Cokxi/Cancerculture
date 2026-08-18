import PushNotificationSettings from "@/app/components/notifications/PushNotificationSettings";

export default function NotificationSettingsPage() {
  return (
    <section aria-labelledby="notification-settings-title">
      <h1 id="notification-settings-title" className="font-['Permanent_Marker'] text-3xl text-[var(--orange-main)]">
        Notifications
      </h1>
      <p className="mt-3 max-w-3xl text-sm leading-relaxed text-white/65">
        Choose optional in-app updates and activate privacy-preserving Web Push separately for this browser.
      </p>
      <div className="mt-6"><PushNotificationSettings /></div>
    </section>
  );
}
