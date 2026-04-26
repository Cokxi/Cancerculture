import { ReactNode } from "react";

export type FaqSection = {
  id: string;
  title: string;
  paragraphs?: (string | React.ReactNode)[];
  bullets?: string[];
};

export const faqSections: FaqSection[] = [
  {
    id: "wallet",
  title: "I entered the wrong wallet address",
  paragraphs: [
    
  "If you entered the wrong wallet address, lost access to your wallet, or your wallet was compromised, submit the recovery form as soon as possible.",
  "Submit your request here:",
  "There is no need to contact the team directly. All cases are handled through this form.",
  "Requests are reviewed at the end of each cycle. If your request is linked to a winning submission, we will contact you via Discord to resolve the issue.",
  "Requests from non-winning submissions are not ignored, but no action is required. You can simply provide your correct wallet details again in the next cycle.",
  "Important: This must be done before the cycle ends. Once the cycle is finalized and no request is found, the payout will be sent to the provided wallet address and cannot be reversed.",
  "You can check which wallet address you submitted in your profile under your current submission."

  ],
  },
  {
    id: "payout",
  title: "When do I receive my payout?",
  paragraphs: [
    "First of all, you actually need to win.",
    "Payouts are processed after a cycle has ended and results are finalized.",
    "Before sending any rewards, we manually review if there are any open support requests (for example wallet issues) from the winner.",
    "If there are multiple winners and one of them has an open request, we will wait until the issue is resolved before processing the payout.",
    "If we contact a winner regarding an issue and receive no response within 24 hours, that winner is considered unavailable for this cycle.",
    "If there are other winners, the prize will be split between the remaining available winners.",
    "If there is only a single winner and they do not respond within 24 hours, the prize will be held and added to the next cycle.",
    "Payouts are handled as quickly as possible, but small delays can happen due to manual review and processing.",
  ],
  },
  {
    id: "disqualified",
  title: "Why was my submission disqualified?",
  paragraphs: [
    "Submissions may be disqualified if they violate platform rules or harm fair competition.",
    "This platform is focused on memes. Low-effort uploads such as simple social media screenshots, reposts without meaningful changes, or obvious trolling may be disqualified.",
    "Any attempt to abuse the system or bypass intended limits can also lead to disqualification.",
    "If a submission is disqualified, all votes cast for it are removed and cannot be used again in that cycle.",
    "If you believe this was a mistake, you can contact support via Discord.",
    ],
  },
  {
    id: "block",
  title: "Why am I blocked from uploading?",
  paragraphs: [
    "To protect the platform from spam and abuse, uploads are currently limited to a maximum file size of 4MB.",
    "Repeated failed upload attempts (for example exceeding the file size limit) or attempts to bypass submission or voting limits can trigger an automatic block.",
    "After 5 failed attempts, you will be temporarily blocked from uploading for the current cycle.",
    "This block is automatically lifted in the next cycle. There is no need to contact support.",
    "We understand that mistakes can happen, but repeated blocks may be interpreted as attempts to abuse or bypass the system.",
    "If such behavior occurs frequently, it may lead to further restrictions or a permanent ban.",
  ],
  },
  {
    id: "vote",
  title: "Why can’t I vote for myself?",
  paragraphs: [
    "If your meme needs your own vote to survive… it might not be that strong.",
    "Self-voting is disabled to keep the competition fair.",
    "Votes should reflect actual community preference, not self-promotion.",
    "We know the internet has a long history of people liking their own posts… but this isn’t Facebook.",
    "If your meme is good, the votes will come naturally.",
    ],
  },
  {
    id: "anonymous",
  title: "Why are submissions anonymous?",
  paragraphs: [
    "During an active cycle, submissions are anonymous to reduce bias.",
    "This ensures votes are based on the meme itself, not the creator.",
    "Creators are revealed after the cycle ends.",
    "Of course, we can’t stop anyone from sharing their submission with friends… but at the end of the day, the best memes tend to win anyway",
  ],
  },
  {
    id: "ties",
    title: "What happens if there is a tie?",
    paragraphs: [
      "Ties are allowed and not artificially resolved.",
      "If multiple submissions have the highest vote count, they all win.",
      "Any rewards are split equally between tied winners.",
    ],
  },
  {
    id: "rewards",
  title: "How are rewards determined?",
  paragraphs: [
    "Rewards depend on the specific cycle and are not guaranteed.",
    "The prize pool can vary and may be higher or lower depending on participation and overall activity.",
    "Rewards are funded through the platform and its ecosystem.",
    "Winning is based entirely on community voting.",
    "All rewards are distributed after the cycle has ended and results are finalized.",
  ],
  },
  {
  id: "charity",
  title: "How do charity, Wall of Fame & Wall of Shame work?",
  paragraphs: [
    "Winning is great. What you do with your reward is up to you.",
    "You can keep everything, donate a portion, or split it however you like. Donations are completely optional.",
    "If you donate at least 1% of your reward, you will be listed on the Wall of Fame.",
    "If you keep 100% of your reward, you will be listed on the Wall of Shame.",
    "Before you panic, this is part of the platform’s culture and not meant as serious judgment",
    "It’s a bit of fun and a small social experiment: everyone loves to talk about generosity… until it’s their own money.",
    "No matter what you choose, your decision should be respected by others.",
  ],
},
  {
    id: "content",
  title: "Do I need to create original content?",
  paragraphs: [
    "Content does not have to be fully original.",
    "However, original and creative submissions usually perform better and stand out more.",
    "Low effort reposts, simple screenshots, or unmodified content may be disqualified.",
    "We do our best to keep the competition fair, but we cannot guarantee that every non original submission will be detected immediately.",
    "If your meme has been seen a hundred times before, chances are people won’t be impressed the 101st time.",
      ],
  },
  {
    id: "socials",
  title: "How do I verify my social media?",
  paragraphs: [
    "Adding social media profiles is completely optional, but you can use it to promote your work and creativity.",
    "You can add your social media accounts (X, Facebook, Instagram, TikTok) directly in your user profile.",
    "By default, these profiles are marked as unverified and are only visible on your profile page.",
    "This helps prevent abuse, such as linking someone else’s account to a submission.",
    "If you want your profiles to be verified, you can submit a request in the Discord 'verify my socials' channel with the required information.",
    "Once verified, you can choose to display your socials alongside your submissions.",
    "This does not affect voting, but your socials may be shown in cycle history or winner showcases.",
  ],
  },
  {
    id: "privacy",
  title: "What data is stored?",
  paragraphs: [
    "We use your Discord ID for participation, moderation, and abuse prevention.",
    "Your Discord ID is used internally but is not publicly displayed on the platform.",
    "We do not store IP addresses or track your activity outside the platform.",
    "Basic actions such as submissions, votes, and moderation events are logged to ensure fairness and platform integrity.",
    "Other users can only see your public profile information, such as your Discord name, avatar, and submission history.",
    "Private data (such as wallet details or Discord ID) is only used for payouts or display purposes and is not shared publicly without your consent.",
  ],
  },
  {
    id: "rules",
    title: "Can the rules change?",
    paragraphs: [
      "Yes. The platform may evolve over time.",
      "If rules change, you will be notified before participating in a new cycle.",
      "You must accept updated rules before submitting again.",
    ],
  },
];