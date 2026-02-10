"use client";

import AboutTextBox from "./AboutTextBox";
import AboutCenterCell from "./AboutCenterCell";

/* === ABOUT TEXT CONTENT (Slide 1) === */

const LEFT_TEXT = `
CancerCulture was born out of a simple but uncomfortable truth:
The memecoin space sometimes feels like cancer.

The idea behind it is simple.
I wanted to create a community-driven charity coin, where the community itself shows how selfless it can be, especially when it comes to everybody’s own wallet.

There is an ongoing competition, as long as this project exists.
And it is up to the community, to keep it alive.
50% of the Creator rewards will go to the Community across multiple rounds.

And just to be absolutely clear:

The name CancerCulture is not meant to make fun of sick people,
and it has nothing to do with cancer as a disease.

It refers only to a cancerous space,
and to everyone’s personal cancer.
`;

const RIGHT_TEXT = `
Everyone is encouraged to upload a picture of their personal cancer.

Your personal cancer does not mean an illness.
It means something unhealthy, irrational, or unnecessary
that you still keep doing, buying, or spending money on.

This can be:

- a bad habit
- an addiction to something pointless
- or just something you know is stupid,
  but you do it anyway.

Before you upload, keep this in mind:

Step 1: Think.
Step 2: Be creative.
Step 3: Upload it.
Step 4: Vote on other submissions.
Step 5: Chill and shill.
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


