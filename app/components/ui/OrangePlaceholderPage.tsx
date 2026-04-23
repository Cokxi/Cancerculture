"use client";

import BackButton from "@/app/components/ui/BackButton";

export default function OrangePlaceholderPage({
  title,
}: {
  title: string;
}) {
  return (
    <>
      <BackButton href="/" label="Back" />

      <div className="mx-auto flex min-h-screen max-w-5xl items-start justify-center px-4 py-20 text-white">
        <div className="w-full max-w-3xl">
          <div className="orange-info-box orange-info-box--compact min-h-[420px]">
            <h1 className="orange-box-title text-center">
              {title}
            </h1>
          </div>
        </div>
      </div>
    </>
  );
}
