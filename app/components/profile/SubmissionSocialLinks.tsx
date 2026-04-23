import { SocialLinkRow } from "@/app/components/profile/SocialUi";
import type { SubmissionSocialLink } from "@/lib/socials/getSubmissionSocialLinks";

export default function SubmissionSocialLinks({
  socials,
  title = "Socials",
  className = "",
}: {
  socials: SubmissionSocialLink[];
  title?: string;
  className?: string;
}) {
  if (!socials.length) {
    return null;
  }

  return (
    <div className={`rounded-lg bg-white/5 p-3 ${className}`}>
      <div className="font-semibold text-[var(--orange-dark)]">
        {title}
      </div>

      <div className="mt-3 space-y-2">
        {socials.map((social) => (
          <SocialLinkRow
            key={social.id}
            social={{
              id: social.id,
              platform: social.platform,
              handle: social.display_label,
              profile_url: social.profile_url,
              is_verified: social.is_verified_snapshot,
            }}
          />
        ))}
      </div>
    </div>
  );
}
