"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import type {
  ProfileSubmission,
  ProfileVote,
} from "@/lib/profile/getUserProfileData";
import type { ProfileWinSummary } from "@/lib/profile/profileWinSummary";
import {
  ProfileSubmissionList,
  ProfileVotesList,
  ProfileWinsList,
} from "./ProfileHistoryLists";

export const PROFILE_PREVIEW_LIMIT = 5;

function Section({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-lg border-2 border-[var(--orange-dark)]/60 bg-black/30">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex w-full cursor-pointer items-center justify-between px-4 py-3 text-left font-['Permanent_Marker'] text-lg tracking-wide text-[var(--orange-dark)] transition hover:bg-[var(--orange-dark)]/10"
      >
        {title}
        <span aria-hidden="true" className="text-lg">
          {open ? "−" : "+"}
        </span>
      </button>
      {open ? <div className="p-4">{children}</div> : null}
    </div>
  );
}

function OverviewLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="mt-4 inline-flex min-h-11 items-center rounded-full border border-[var(--orange-dark)]/40 px-4 py-2 text-sm text-[var(--orange-dark)] transition hover:bg-[var(--orange-dark)]/10"
    >
      {children}
    </Link>
  );
}

export default function ProfileSections({
  submissions,
  votes,
  winnings,
  commentsPreview,
  mentionsPreview,
  savedMemesPreview,
  reportsPreview,
  moderationHistoryPreview,
}: {
  submissions: ProfileSubmission[];
  votes: ProfileVote[];
  winnings: ProfileWinSummary[] | null;
  commentsPreview: ReactNode;
  mentionsPreview: ReactNode;
  savedMemesPreview: ReactNode;
  reportsPreview: ReactNode;
  moderationHistoryPreview: ReactNode;
}) {
  const completedWins = winnings?.filter(
    (claim) => claim.status !== "unclaimed",
  ) ?? null;

  return (
    <div className="space-y-4">
      <Section title="My Submissions">
        <ProfileSubmissionList
          submissions={submissions.slice(0, PROFILE_PREVIEW_LIMIT)}
        />
        <OverviewLink href="/my-profile/submissions">
          Open My Submissions to see all submissions
        </OverviewLink>
      </Section>

      <Section title="My Wins">
        <ProfileWinsList
          winnings={
            completedWins === null
              ? null
              : completedWins.slice(0, PROFILE_PREVIEW_LIMIT)
          }
        />
        <OverviewLink href="/my-profile/winnings">
          Open My Wins to see all wins
        </OverviewLink>
      </Section>

      <Section title="My Saved Memes">
        <div>{savedMemesPreview}</div>
        <OverviewLink href="/my-profile/saved-memes">
          Open My Saved Memes to see all saved memes
        </OverviewLink>
      </Section>

      <Section title="My Comments">
        <div>{commentsPreview}</div>
        <OverviewLink href="/my-profile/comments">
          Open My Comments to see all comments
        </OverviewLink>
      </Section>

      <Section title="My Mentions">
        <div>{mentionsPreview}</div>
        <OverviewLink href="/my-profile/mentions">
          Open My Mentions to see all mentions
        </OverviewLink>
      </Section>

      <Section title="My Reports">
        <div>{reportsPreview}</div>
        <OverviewLink href="/my-reports">
          Open My Reports to see all reports
        </OverviewLink>
      </Section>

      <Section title="My Moderation History">
        <div>{moderationHistoryPreview}</div>
        <OverviewLink href="/my-profile/disqualifications">
          Open My Moderation History to see all history
        </OverviewLink>
      </Section>

      <Section title="My Votes">
        <ProfileVotesList votes={votes.slice(0, PROFILE_PREVIEW_LIMIT)} />
        <OverviewLink href="/my-profile/votes">
          Open My Votes to see all votes
        </OverviewLink>
      </Section>
    </div>
  );
}
