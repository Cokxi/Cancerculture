export type RuleSection = {
  title: string;
  paragraphs?: string[];
  bullets?: string[];
};

export const standardRulesSections: RuleSection[] = [
  {
    title: "Participation",
    paragraphs: [
      "Participation is voluntary. Each cycle is a standalone competition.",
      "Each user may submit one (1) meme and cast one (1) vote per cycle.",
      "Votes are anonymous during an active cycle to ensure fair play.",
      "Self-voting is not allowed and will be blocked by the system.",
          ],
  },
  {
    title: "Submissions",
    paragraphs: [
      "This platform is about memes. Low-effort uploads, such as simple screenshots from social media, may be disqualified.",
      "If a submission is disqualified, any votes cast for it are removed and cannot be reused in that cycle.",
      "Content does not need to be fully original, but originality increases your chances of winning.",
      "By submitting content, you confirm that you have the right to use it and allow us to display it on the platform.",
      "Submissions may be disqualified if they violate these rules.",
            
    ],
    bullets: [
      "illegal content (including extreme violence or sexual abuse)",
      "content you do not have rights to",
      "spam or attempts to bypass upload limits",
    ],
  },
  {
    title: "Fair Play",
  paragraphs: [
    "The goal is to reward creativity, not external influence.",
    "Promoting your submission during an active cycle or encouraging others to vote for you is not allowed.",
    "This includes sharing your submission with the intent of influencing votes through Discord, social media, or other platforms.",
    "If such behavior is detected, it may result in disqualification for the current cycle.",
    "Repeated violations may lead to permanent exclusion from the platform.",
    "Submissions are anonymous during active cycles to support this principle."
  ],
  },
  {
    title: "Behavior",
  paragraphs: [
    "Respect other participants and their decisions.",
    "Harassment or abusive behavior will lead to disqualification and may result in a permanent ban.",
  ],
  bullets: [
    "insults, harassment, or targeted attacks",
    "hate speech or threats",
    "doxxing or sharing private information",
  ],
  },
  {
    title: "Rewards",
  paragraphs: [
    "Winners are determined by community voting.",
    "Ties are possible. In such cases, rewards are split equally between winners.",
    "The prize pool varies per cycle and is not guaranteed.",
    "Rewards are paid out in Solana. You are responsible for providing a valid wallet address.",
    "If a winner has an open support request (e.g. wallet issue), payout may be delayed until the issue is resolved.",
    "If a winner does not respond within 24 hours after being contacted regarding an issue, they may be excluded from the payout for that cycle.",
    "If multiple winners exist, the reward may be redistributed among the remaining eligible winners.",
    "If there is a single winner who does not respond, the reward may be carried over to the next cycle.",
  ],

  },

  {
  title: "Charity & Public Profiles",
  paragraphs: [
    "Winners can decide how to handle their reward. Donating is optional.",
    "You may choose to keep 100% of your reward, donate all, or split it.",
    "If you donate at least 1% of your reward and you win, you will be listed on the Wall of Fame.",
    "If you keep 100% of your reward, you will be listed on the Wall of Shame.",
    "These labels are part of the platform’s culture and are not meant as real judgment or harassment.",
    "All choices must be respected. Harassment or attacks based on someone’s decision are not allowed.",
  ],
},
  {
    title: "Moderation",
    paragraphs: [
      "We reserve the right to remove submissions, disqualify participants, or restrict access to protect platform integrity.",
      "Moderation decisions are made at our discretion and may not always include a detailed explanation.",
      "Repeated rule violations may result in a permanent ban.",
      "Moderation and system actions are logged for transparency and abuse prevention.",
    ],
  },

  {
    title: "Technical & Limits",
    paragraphs: [
      "The current maximum file size is 4MB.",
      "Repeated failed upload attempts or attempts to bypass system limits may result in temporary blocks or further restrictions.",
      "This block is automatically lifted in the next cycle and does not require support.",
      "We do not guarantee uninterrupted availability of the platform.",
    ],
  },
  {
    title: "Disclaimer",
    paragraphs: [
      "This is not a game of chance. Outcomes are determined by community voting.",
      "Participation is at your own risk.",
      "We are not liable for technical issues, incorrect wallet details, or lost funds.",
      "The platform and its rules may evolve over time.",
    ],
  },
  {
    title: "Final Note",
    paragraphs: [
      "Keep it creative. Keep it fair. Don't be an idiot.",
    ],
  },
];