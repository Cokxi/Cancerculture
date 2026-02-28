"use client";

import AboutTextBox from "./AboutTextBox";
import AboutCenterCell from "./AboutCenterCell";

/* === ABOUT TEXT CONTENT (Slide 1) === */

const LEFT_TEXT = `
CancerCulture is a community driven charity meme competition inspired by the chaotic nature of the memecoin space.

The name does not refer to cancer as a disease.
It represents the fast spreading, irrational culture of memes, narratives, hype cycles, and degenerate humor that defines the ecosystem.

Instead of pretending to be serious, CancerCulture turns that chaos into a creative arena.

Memes are the language of this culture and here they compete!

Participants create original memes that reflect the absurdity, creativity, and energy of memecoin culture itself. The community decides what survives through voting, shaping the narrative round by round.

50% of creator rewards are continuously redistributed back to the community across multiple rounds.
The project only stays alive through participation, creativity is the fuel.

CancerCulture isn’t trying to “fix” the space.
It mirrors it, exaggerates it, and turns it into a game.

Create. Upload. Vote. Chill + shill.
`;

const RIGHT_TEXT = `
How It Works:

CancerCulture runs as an ongoing meme competition across continuous rounds.

Submissions:

Each participant can upload one original meme per round.
Submissions must be creative and made by the participant — reposted or stolen content may be disqualified.

Voting:

Every participant receives one vote per round.
Voting for your own submission is not allowed.

All uploads and votes remain anonymous during an active round to reduce bias and encourage honest participation.

Verification:

No wallet connection is required.

To reduce bots and fake votes, users verify through Discord before uploading or voting.
Discord identity is used only for round limits, not for public profiles.

Rewards:

When a round ends, 100% of that round’s rewards are claimed immediately.

50% goes to the winning meme creator.

The remaining 50% belongs to the Dev.

Winners choose whether to keep, donate, or split their prize.

Those who donate at least 1% appear on the Wall of Fame.
Others appear on the Wall of Shame.

Whatever the winner decides, the Dev mirrors the exact same decision for their remaining share, including donation percentage and charity.
`;

export default function AboutLayout() {
  return (
    <div className="relative max-w-6xl mx-auto px-6 pt-24 pb-64">
      
      {/* TEXT COLUMNS */}
      <div
  className="
    grid
    grid-cols-1
    lg:grid-cols-[minmax(340px,420px)_180px_minmax(340px,420px)]
    gap-20
    items-start
    justify-center
  "
>

        <AboutTextBox
          title="What is CancerCulture?"
          text={LEFT_TEXT}
        />

<div aria-hidden />

        <AboutTextBox
          title="The name is the narrative."
          text={RIGHT_TEXT}
        />
      </div>

      {/* CENTER CELL – overlay, not layout */}
      <AboutCenterCell />
    </div>
  );
}


