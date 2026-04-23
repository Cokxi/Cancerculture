export type FaqSection = {
  title: string;
  paragraphs?: string[];
  bullets?: string[];
};

export const faqSections: FaqSection[] = [
  {
    title: "How It Works",
    paragraphs: [
      "CancerCulture is an ongoing, community-driven meme competition.",
      "The platform runs in repeating cycles.",
      "Each cycle is independent and represents its own competition.",
    ],
    bullets: [
      "submit one (1) meme",
      "cast one (1) vote",
      "Voting for your own submission is not allowed",
    ],
  },
  {
    title: "Participation & Access",
    paragraphs: [
      "To participate, you must sign in via Discord and be present on the Discord server for a short period before your first submission.",
      "This helps reduce spam and bot activity while keeping the platform accessible.",
    ],
  },
  {
    title: "Submissions & Voting",
    paragraphs: [
      "Submissions should be original or meaningfully transformed.",
      "Votes determine the ranking within each cycle.",
    ],
    bullets: [
      "Only one submission per user per cycle is allowed",
      "Only one vote per user per cycle is allowed",
    ],
  },
  {
    title: "Identity & Privacy",
    paragraphs: [
      "Participation is tied to your Discord account for moderation purposes.",
      "Identity is not part of the competition.",
    ],
    bullets: [
      "no public profiles are shown",
      "no personal data is displayed",
      "submissions are presented anonymously",
    ],
  },
  {
    title: "Cycles & Timing",
    paragraphs: [
      "CancerCulture runs in continuous cycles.",
    ],
    bullets: [
      "There is always one active cycle",
      "Cycle duration may vary",
      "New cycles begin after the previous one ends",
    ],
  },
  {
    title: "Winners & Results",
    paragraphs: [
      "At the end of each cycle, votes are counted, rankings are calculated, and winners are revealed.",
      "The submission or submissions with the highest number of votes win.",
    ],
  },
  {
    title: "Ties",
    paragraphs: [
      "If multiple submissions share the highest vote count, multiple winners can exist and results are not forced or adjusted.",
      "If rewards are part of a cycle, prizes will be split fairly among all tied winners.",
    ],
  },
  {
    title: "Where To Find Details",
    paragraphs: [
      "If a cycle includes special conditions, key information will be shown on the platform and additional details may be shared via official channels such as Discord.",
    ],
  },
  {
    title: "Moderation",
    paragraphs: [
      "To keep the competition fair, submissions may be removed, participants may be disqualified, and access may be restricted if rules are violated or the system is abused.",
    ],
  },
  {
    title: "Important Notes",
    bullets: [
      "Participation is voluntary",
      "There is no guarantee of rewards",
      "Not every cycle includes prizes",
      "Outcomes depend entirely on community voting",
    ],
  },
  {
    title: "Final Note",
    paragraphs: [
      "If you made it this far, you already understand the culture.",
    ],
  },
];
