export type RuleSection = {
  title: string;
  paragraphs?: string[];
  bullets?: string[];
};

export const standardRulesSections: RuleSection[] = [
  {
    title: "Content & Submissions",
    paragraphs: [
      "All submitted content must be original or meaningfully transformed by the uploader.",
      "Submissions that violate these rules may be removed or disqualified.",
      "To maintain a fair competition, all submissions are linked to your verified Discord account. This is used solely for moderation, abuse prevention, and platform integrity.",
    ],
    bullets: [
      "stolen or reposted content without modification",
      "illegal content",
      "copyrighted material you do not have rights to",
    ],
  },
  {
    title: "Participation Rules",
    paragraphs: [
      "Attempting to bypass these limits using multiple accounts or other methods may result in disqualification or exclusion.",
      "Some cycles may include additional rules or special conditions. If so, these will be clearly presented before participation and must be accepted to continue.",
    ],
    bullets: [
      "Each user may submit one (1) meme per cycle",
      "Each user may cast one (1) vote per cycle",
    ],
  },
  {
    title: "Behavior & Conduct",
    paragraphs: [
      "CancerCulture is built around creativity, humor, and self-awareness.",
      "Disagreeing with results is fine. Attacking people because of them is not.",
    ],
    bullets: [
      "harassment or targeted attacks",
      "hate speech or threats",
      "doxxing or sharing private information",
      "organizing harassment against other users",
    ],
  },
  {
    title: "Fair Play",
    paragraphs: [
      "The platform is designed to reward creativity and participation.",
      "Any behavior that harms the integrity of the competition may lead to removal or permanent exclusion.",
    ],
    bullets: [
      "manipulate votes",
      "abuse systems or loopholes",
      "artificially influence outcomes",
    ],
  },
  {
    title: "Cycles & Results",
    paragraphs: [
      "Each cycle represents a standalone competition.",
    ],
    bullets: [
      "votes are counted",
      "rankings are determined",
      "winners are displayed publicly",
    ],
  },
  {
    title: "Moderation",
    paragraphs: [
      "CancerCulture reserves the right to remove submissions, disqualify participants, or restrict and revoke access if rules are violated or platform integrity is at risk.",
      "Moderation actions are logged and may be reviewed internally.",
      "If a copyright claim or similar rights issue is reported, a submission may be hidden while the case is being reviewed.",
    ],
  },
  {
    title: "Disclaimer",
    paragraphs: [
      "CancerCulture is an experimental, community-driven platform.",
      "Participation is voluntary and at your own responsibility.",
      "The platform may evolve over time.",
    ],
    bullets: [
      "no guarantee of rewards",
      "no guarantee of outcomes",
      "no entitlement to winning",
    ],
  },
  {
    title: "Final Note",
    paragraphs: [
      "If you made it this far, you already understand the culture.",
    ],
  },
];
