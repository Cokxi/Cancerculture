import Image from "next/image";
import PageWrapper from "@/app/components/ui/PageWrapper";

export default function CharitiesPage() {
  return (
    <PageWrapper showBackButton={false}>
     
      {/* ===== CONTENT ===== */}
      <div className="max-w-3xl mx-auto px-6 py-24 flex flex-col gap-8">
        <h1 className="text-center font-['Permanent_Marker'] text-5xl mb-12 text-[var(--orange-main)]">
  Charities
</h1>


        {/* ===== CHARITY ITEM ===== 1*/}
<div className="bg-yellow-star rounded-3xl p-6 flex flex-col items-center gap-8">
  {/* NAME */}
  <h2 className="font-['Permanent_Marker'] text-2xl text-[var(--orange-main)] text-center">
    Animal Heaven
  </h2>

  <div className="flex gap-6 items-center">
    {/* THUMBNAIL */}
    <div className="
      w-48
      aspect-[5/4]
      rounded-2xl
      border-2
      border-[var(--orange-main)]
      flex
      items-center
      justify-center
      overflow-hidden
      shrink-0
      bg-black
    ">
      <Image
        src="https://cdn.cancerculture.fun/webp/charity/animal-heaven.webp"
        alt="Animal Haven charity logo"
        width={500}
        height={400}
        className="object-contain"
      />
    </div>

    {/* LINKS */}
    <div className="flex flex-col gap-6 text-lg font-['Permanent_Marker']">
      <a
        href="https://animalhaven.org/"
        target="_blank"
        rel="noopener noreferrer"
        className="text-[var(--orange-main)] underline underline-offset-4"
      >
        Official website
      </a>

      <a
        href="https://thegivingblock.com/donate/animal-haven"
        target="_blank"
        rel="noopener noreferrer"
        className="text-[var(--orange-main)] underline underline-offset-4"
      >
        The Giving Block
      </a>

      <a
        href="https://x.com/AnimalHaven"
        target="_blank"
        rel="noopener noreferrer"
        className="text-[var(--orange-main)] underline underline-offset-4"
      >
        Official X (Twitter)
      </a>
    </div>
  </div>
</div>
{/* ===== END CHARITY ITEM ===== */}

       {/* ===== CHARITY ITEM ===== 2*/}
<div className="bg-yellow-star rounded-3xl p-6 flex flex-col items-center gap-8">
  {/* NAME */}
  <h2 className="font-['Permanent_Marker'] text-2xl text-[var(--orange-main)] text-center">
    Animal Rescue Corps, Inc.
  </h2>

  <div className="flex gap-6 items-center">
    {/* THUMBNAIL */}
    <div className="
      w-48
      aspect-[5/4]
      rounded-2xl
      border-2
      border-[var(--orange-main)]
      flex
      items-center
      justify-center
      overflow-hidden
      shrink-0
      bg-black
    ">
      <Image
        src="https://cdn.cancerculture.fun/webp/charity/animal-rescue.webp"
        alt="Animal Rescue Corps, Inc."
        width={500}
        height={400}
        className="object-contain"
      />
    </div>

    {/* LINKS */}
    <div className="flex flex-col gap-6 text-lg font-['Permanent_Marker']">
      <a
        href="https://animalrescuecorps.org/"
        target="_blank"
        rel="noopener noreferrer"
        className="text-[var(--orange-main)] underline underline-offset-4"
      >
        Official website
      </a>

      <a
        href="https://thegivingblock.com/donate/animal-rescue-corps-inc"
        target="_blank"
        rel="noopener noreferrer"
        className="text-[var(--orange-main)] underline underline-offset-4"
      >
        The Giving Block
      </a>

      <a
        href="https://x.com/ARCorps"
        target="_blank"
        rel="noopener noreferrer"
        className="text-[var(--orange-main)] underline underline-offset-4"
      >
        Official X (Twitter)
      </a>
    </div>
  </div>
</div>
{/* ===== END CHARITY ITEM ===== */}

{/* ===== CHARITY ITEM ===== 3*/}
<div className="bg-yellow-star rounded-3xl p-6 flex flex-col items-center gap-8">
  {/* NAME */}
  <h2 className="font-['Permanent_Marker'] text-2xl text-[var(--orange-main)] text-center">
    Doctors Without Borders U.S.A., Inc.
  </h2>

  <div className="flex gap-6 items-center">
    {/* THUMBNAIL */}
    <div className="
      w-48
      aspect-[5/4]
      rounded-2xl
      border-2
      border-[var(--orange-main)]
      flex
      items-center
      justify-center
      overflow-hidden
      shrink-0
      bg-black
    ">
      <Image
        src="https://cdn.cancerculture.fun/webp/charity/doctor-boarder.webp"
        alt="Doctors Without Borders U.S.A., Inc."
        width={500}
        height={400}
        className="object-contain"
      />
    </div>

    {/* LINKS */}
    <div className="flex flex-col gap-6 text-lg font-['Permanent_Marker']">
      <a
        href="https://www.doctorswithoutborders.org/"
        target="_blank"
        rel="noopener noreferrer"
        className="text-[var(--orange-main)] underline underline-offset-4"
      >
        Official website
      </a>

      <a
        href="https://thegivingblock.com/donate/doctors-without-borders-u-s-a-inc"
        target="_blank"
        rel="noopener noreferrer"
        className="text-[var(--orange-main)] underline underline-offset-4"
      >
        The Giving Block
      </a>

      <a
        href="https://x.com/MSF_USA"
        target="_blank"
        rel="noopener noreferrer"
        className="text-[var(--orange-main)] underline underline-offset-4"
      >
        Official X (Twitter)
      </a>
    </div>
  </div>
</div>
{/* ===== END CHARITY ITEM ===== */}

       {/* ===== CHARITY ITEM ===== 4*/}
<div className="bg-yellow-star rounded-3xl p-6 flex flex-col items-center gap-8">
  {/* NAME */}
  <h2 className="font-['Permanent_Marker'] text-2xl text-[var(--orange-main)] text-center">
    Feeding Pets of the Homeless
  </h2>

  <div className="flex gap-6 items-center">
    {/* THUMBNAIL */}
    <div className="
      w-48
      aspect-[5/4]
      rounded-2xl
      border-2
      border-[var(--orange-main)]
      flex
      items-center
      justify-center
      overflow-hidden
      shrink-0
      bg-black
    ">
      <Image
        src="https://cdn.cancerculture.fun/webp/charity/homeless-pets.webp"
        alt="Feeding Pets of the Homeless"
        width={500}
        height={400}
        className="object-contain"
      />
    </div>

    {/* LINKS */}
    <div className="flex flex-col gap-6 text-lg font-['Permanent_Marker']">
      <a
        href="https://petsofthehomeless.org/"
        target="_blank"
        rel="noopener noreferrer"
        className="text-[var(--orange-main)] underline underline-offset-4"
      >
        Official website
      </a>

      <a
        href="https://thegivingblock.com/donate/feeding-pets-of-the-homeless"
        target="_blank"
        rel="noopener noreferrer"
        className="text-[var(--orange-main)] underline underline-offset-4"
      >
        The Giving Block
      </a>

      <a
        href="https://x.com/PetsofHomeless"
        target="_blank"
        rel="noopener noreferrer"
        className="text-[var(--orange-main)] underline underline-offset-4"
      >
        Official X (Twitter)
      </a>
    </div>
  </div>
</div>
{/* ===== END CHARITY ITEM ===== */}

{/* ===== CHARITY ITEM ===== 5*/}
<div className="bg-yellow-star rounded-3xl p-6 flex flex-col items-center gap-8">
  {/* NAME */}
  <h2 className="font-['Permanent_Marker'] text-2xl text-[var(--orange-main)] text-center">
    Institute for Justice
  </h2>

  <div className="flex gap-6 items-center">
    {/* THUMBNAIL */}
    <div className="
      w-48
      aspect-[5/4]
      rounded-2xl
      border-2
      border-[var(--orange-main)]
      flex
      items-center
      justify-center
      overflow-hidden
      shrink-0
      bg-black
    ">
      <Image
        src="https://cdn.cancerculture.fun/webp/charity/justicia.webp"
        alt="Institute for Justice"
        width={500}
        height={400}
        className="object-contain"
      />
    </div>

    {/* LINKS */}
    <div className="flex flex-col gap-6 text-lg font-['Permanent_Marker']">
      <a
        href="https://ij.org/"
        target="_blank"
        rel="noopener noreferrer"
        className="text-[var(--orange-main)] underline underline-offset-4"
      >
        Official website
      </a>

      <a
        href="https://thegivingblock.com/donate/institute-for-justice"
        target="_blank"
        rel="noopener noreferrer"
        className="text-[var(--orange-main)] underline underline-offset-4"
      >
        The Giving Block
      </a>

      <a
        href="https://x.com/IJ"
        target="_blank"
        rel="noopener noreferrer"
        className="text-[var(--orange-main)] underline underline-offset-4"
      >
        Official X (Twitter)
      </a>
    </div>
  </div>
</div>
{/* ===== END CHARITY ITEM ===== */}

       {/* ===== CHARITY ITEM ===== 6*/}
<div className="bg-yellow-star rounded-3xl p-6 flex flex-col items-center gap-8">
  {/* NAME */}
  <h2 className="font-['Permanent_Marker'] text-2xl text-[var(--orange-main)] text-center">
    No Kid Hungry
  </h2>

  <div className="flex gap-6 items-center">
    {/* THUMBNAIL */}
    <div className="
      w-48
      aspect-[5/4]
      rounded-2xl
      border-2
      border-[var(--orange-main)]
      flex
      items-center
      justify-center
      overflow-hidden
      shrink-0
      bg-black
    ">
      <Image
        src="https://cdn.cancerculture.fun/webp/charity/no-kid.webp"
        alt="No Kid Hungry"
        width={500}
        height={400}
        className="object-contain"
      />
    </div>

    {/* LINKS */}
    <div className="flex flex-col gap-6 text-lg font-['Permanent_Marker']">
      <a
        href="https://www.nokidhungry.org/"
        target="_blank"
        rel="noopener noreferrer"
        className="text-[var(--orange-main)] underline underline-offset-4"
      >
        Official website
      </a>

      <a
        href="https://thegivingblock.com/donate/no-kid-hungry"
        target="_blank"
        rel="noopener noreferrer"
        className="text-[var(--orange-main)] underline underline-offset-4"
      >
        The Giving Block
      </a>

      <a
        href="https://x.com/nokidhungry"
        target="_blank"
        rel="noopener noreferrer"
        className="text-[var(--orange-main)] underline underline-offset-4"
      >
        Official X (Twitter)
      </a>
    </div>
  </div>
</div>
{/* ===== END CHARITY ITEM ===== */}

{/* ===== CHARITY ITEM ===== 7*/}
<div className="bg-yellow-star rounded-3xl p-6 flex flex-col items-center gap-8">
  {/* NAME */}
  <h2 className="font-['Permanent_Marker'] text-2xl text-[var(--orange-main)] text-center">
    Save the Children®
  </h2>

  <div className="flex gap-6 items-center">
    {/* THUMBNAIL */}
    <div className="
      w-48
      aspect-[5/4]
      rounded-2xl
      border-2
      border-[var(--orange-main)]
      flex
      items-center
      justify-center
      overflow-hidden
      shrink-0
      bg-black
    ">
      <Image
        src="https://cdn.cancerculture.fun/webp/charity/save-children.webp"
        alt="Save the Children®"
        width={500}
        height={400}
        className="object-contain"
      />
    </div>

    {/* LINKS */}
    <div className="flex flex-col gap-6 text-lg font-['Permanent_Marker']">
      <a
        href="https://www.savethechildren.org/"
        target="_blank"
        rel="noopener noreferrer"
        className="text-[var(--orange-main)] underline underline-offset-4"
      >
        Official website
      </a>

      <a
        href="https://thegivingblock.com/donate/save-the-children"
        target="_blank"
        rel="noopener noreferrer"
        className="text-[var(--orange-main)] underline underline-offset-4"
      >
        The Giving Block
      </a>

      <a
        href="https://x.com/SavetheChildren"
        target="_blank"
        rel="noopener noreferrer"
        className="text-[var(--orange-main)] underline underline-offset-4"
      >
        Official X (Twitter)
      </a>
    </div>
  </div>
</div>
{/* ===== END CHARITY ITEM ===== */}

       {/* ===== CHARITY ITEM ===== 8*/}
<div className="bg-yellow-star rounded-3xl p-6 flex flex-col items-center gap-8">
  {/* NAME */}
  <h2 className="font-['Permanent_Marker'] text-2xl text-[var(--orange-main)] text-center">
    Sea Shepherd Conservation Society
  </h2>

  <div className="flex gap-6 items-center">
    {/* THUMBNAIL */}
    <div className="
      w-48
      aspect-[5/4]
      rounded-2xl
      border-2
      border-[var(--orange-main)]
      flex
      items-center
      justify-center
      overflow-hidden
      shrink-0
      bg-black
    ">
      <Image
        src="https://cdn.cancerculture.fun/webp/charity/sea.webp"
        alt="Sea Shepherd Conservation Society"
        width={500}
        height={400}
        className="object-contain"
      />
    </div>

    {/* LINKS */}
    <div className="flex flex-col gap-6 text-lg font-['Permanent_Marker']">
      <a
        href="https://seashepherd.org/"
        target="_blank"
        rel="noopener noreferrer"
        className="text-[var(--orange-main)] underline underline-offset-4"
      >
        Official website
      </a>

      <a
        href="https://thegivingblock.com/donate/sea-shepherd-conservation-society"
        target="_blank"
        rel="noopener noreferrer"
        className="text-[var(--orange-main)] underline underline-offset-4"
      >
        The Giving Block
      </a>

      <a
        href="https://x.com/SeaShepherdSSCS"
        target="_blank"
        rel="noopener noreferrer"
        className="text-[var(--orange-main)] underline underline-offset-4"
      >
        Official X (Twitter)
      </a>
    </div>
  </div>
</div>
{/* ===== END CHARITY ITEM ===== */}

{/* ===== CHARITY ITEM ===== 9*/}
<div className="bg-yellow-star rounded-3xl p-6 flex flex-col items-center gap-8">
  {/* NAME */}
  <h2 className="font-['Permanent_Marker'] text-2xl text-[var(--orange-main)] text-center">
    St. Jude Children's Research Hospital
  </h2>

  <div className="flex gap-6 items-center">
    {/* THUMBNAIL */}
    <div className="
      w-48
      aspect-[5/4]
      rounded-2xl
      border-2
      border-[var(--orange-main)]
      flex
      items-center
      justify-center
      overflow-hidden
      shrink-0
      bg-black
    ">
      <Image
        src="https://cdn.cancerculture.fun/webp/charity/st-jude.webp"
        alt="St. Jude Children's Research Hospital"
        width={500}
        height={400}
        className="object-contain"
      />
    </div>

    {/* LINKS */}
    <div className="flex flex-col gap-6 text-lg font-['Permanent_Marker']">
      <a
        href="https://www.stjude.org/"
        target="_blank"
        rel="noopener noreferrer"
        className="text-[var(--orange-main)] underline underline-offset-4"
      >
        Official website
      </a>

      <a
        href="https://thegivingblock.com/donate/st-jude-childrens-research-hospital"
        target="_blank"
        rel="noopener noreferrer"
        className="text-[var(--orange-main)] underline underline-offset-4"
      >
        The Giving Block
      </a>

      <a
        href="https://x.com/StJude"
        target="_blank"
        rel="noopener noreferrer"
        className="text-[var(--orange-main)] underline underline-offset-4"
      >
        Official X (Twitter)
      </a>
    </div>
  </div>
</div>
{/* ===== END CHARITY ITEM ===== */}

       {/* ===== CHARITY ITEM ===== 10*/}
<div className="bg-yellow-star rounded-3xl p-6 flex flex-col items-center gap-8">
  {/* NAME */}
  <h2 className="font-['Permanent_Marker'] text-2xl text-[var(--orange-main)] text-center">
    Young Lives vs Cancer
  </h2>

  <div className="flex gap-6 items-center">
    {/* THUMBNAIL */}
    <div className="
      w-48
      aspect-[5/4]
      rounded-2xl
      border-2
      border-[var(--orange-main)]
      flex
      items-center
      justify-center
      overflow-hidden
      shrink-0
      bg-black
    ">
      <Image
        src="https://cdn.cancerculture.fun/webp/charity/young-lives.webp"
        alt="Young Lives vs Cancer"
        width={500}
        height={400}
        className="object-contain"
      />
    </div>

    {/* LINKS */}
    <div className="flex flex-col gap-6 text-lg font-['Permanent_Marker']">
      <a
        href="https://www.younglivesvscancer.org.uk/"
        target="_blank"
        rel="noopener noreferrer"
        className="text-[var(--orange-main)] underline underline-offset-4"
      >
        Official website
      </a>

      <a
        href="https://thegivingblock.com/donate/young-lives-vs-cancer"
        target="_blank"
        rel="noopener noreferrer"
        className="text-[var(--orange-main)] underline underline-offset-4"
      >
        The Giving Block
      </a>

      <a
        href="https://x.com/YLvsCancer"
        target="_blank"
        rel="noopener noreferrer"
        className="text-[var(--orange-main)] underline underline-offset-4"
      >
        Official X (Twitter)
      </a>
    </div>
  </div>
</div>
{/* ===== END CHARITY ITEM ===== */}
      </div>
    
  </PageWrapper>
  );
}
