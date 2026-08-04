"use client";

import { useActionState, useMemo, useState } from "react";
import FaqDocumentView from "@/app/components/content/FaqDocumentView";
import type {
  AdminFaqContentState,
  FaqContentDocument,
  FaqContentSection,
} from "@/lib/content/faq/types";
import { FAQ_CONTENT_LIMITS } from "@/lib/content/faq/validation";
import {
  saveAndPublishFaqAction,
  type FaqContentActionState,
} from "./actions";

const inputClassName =
  "rounded border border-white/15 bg-black/40 px-3 py-2 text-white outline-none transition-colors focus:border-orange-400 focus-visible:ring-2 focus-visible:ring-orange-300";
const primaryButtonClassName =
  "cursor-pointer rounded bg-orange-600 px-4 py-2 font-semibold text-white outline-none transition-colors hover:bg-orange-500 focus-visible:ring-2 focus-visible:ring-orange-300 active:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-50";
const secondaryButtonClassName =
  "cursor-pointer rounded bg-white/10 px-3 py-2 text-sm font-semibold outline-none transition-colors hover:bg-white/20 focus-visible:ring-2 focus-visible:ring-orange-300 active:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50";
const initialActionState: FaqContentActionState = Object.freeze({
  status: "idle",
  message: "",
});

function paragraphEditorLines(value: string) {
  return value.replace(/\r\n?/g, "\n").split("\n\n");
}

function bulletEditorLines(value: string) {
  return value.replace(/\r\n?/g, "\n").split("\n");
}

function normalizedEditorDocument(
  document: FaqContentDocument
): FaqContentDocument {
  return {
    ...document,
    sections: document.sections.map((section) => ({
      ...section,
      paragraphs: section.paragraphs
        .map((paragraph) => paragraph.trim())
        .filter(Boolean),
      bullets: section.bullets
        .map((bullet) => bullet.trim())
        .filter(Boolean),
    })),
  };
}

function nextSectionId(sections: readonly FaqContentSection[]) {
  let suffix = sections.length + 1;

  while (sections.some((section) => section.id === `section-${suffix}`)) {
    suffix += 1;
  }

  return `section-${suffix}`;
}

export default function FaqEditor({
  state,
  requestId,
}: {
  state: AdminFaqContentState;
  requestId: string;
}) {
  const [document, setDocument] = useState<FaqContentDocument>(
    state.published.content
  );
  const [actionState, action, pending] = useActionState(
    saveAndPublishFaqAction,
    initialActionState
  );
  const previewDocument = useMemo(
    () => normalizedEditorDocument(document),
    [document]
  );
  const serializedDocument = useMemo(
    () => JSON.stringify(previewDocument),
    [previewDocument]
  );

  function updateDocument(
    key: "eyebrow" | "heading" | "introduction",
    value: string
  ) {
    setDocument((current) => ({ ...current, [key]: value }));
  }

  function updateSection(
    index: number,
    update: (section: FaqContentSection) => FaqContentSection
  ) {
    setDocument((current) => ({
      ...current,
      sections: current.sections.map((section, sectionIndex) =>
        sectionIndex === index ? update(section) : section
      ),
    }));
  }

  function moveSection(index: number, direction: -1 | 1) {
    setDocument((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.sections.length) return current;
      const sections = [...current.sections];
      [sections[index], sections[target]] = [
        sections[target],
        sections[index],
      ];
      return { ...current, sections };
    });
  }

  function removeSection(index: number) {
    setDocument((current) => ({
      ...current,
      sections: current.sections.filter(
        (_section, sectionIndex) => sectionIndex !== index
      ),
    }));
  }

  function addSection() {
    setDocument((current) => ({
      ...current,
      sections: [
        ...current.sections,
        {
          id: nextSectionId(current.sections),
          title: "New FAQ Section",
          paragraphs: ["Add the answer here."],
          bullets: [],
        },
      ],
    }));
  }

  return (
    <div className="space-y-10">
      <section className="grid gap-3 rounded-xl border border-white/10 bg-white/[0.04] p-5 text-sm sm:grid-cols-2">
        <div>
          <p className="text-white/50">Published revision</p>
          <p className="mt-1 font-semibold">
            #{state.published.revisionNumber}
          </p>
        </div>
        <div>
          <p className="text-white/50">State version</p>
          <p className="mt-1 font-semibold">{state.stateVersion}</p>
        </div>
      </section>

      <form action={action} className="space-y-8">
        <input
          name="expected_state_version"
          type="hidden"
          value={state.stateVersion}
        />
        <input name="request_id" type="hidden" value={requestId} />
        <input name="content_json" type="hidden" value={serializedDocument} />

        <section className="grid gap-4 rounded-xl border border-orange-500/25 bg-white/5 p-5 md:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            Eyebrow
            <input
              className={inputClassName}
              value={document.eyebrow}
              maxLength={FAQ_CONTENT_LIMITS.eyebrow}
              onChange={(event) =>
                updateDocument("eyebrow", event.target.value)
              }
              required
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Heading
            <input
              className={inputClassName}
              value={document.heading}
              maxLength={FAQ_CONTENT_LIMITS.heading}
              onChange={(event) =>
                updateDocument("heading", event.target.value)
              }
              required
            />
          </label>
          <label className="flex flex-col gap-1 text-sm md:col-span-2">
            Introduction
            <textarea
              className={`${inputClassName} min-h-28 resize-y`}
              value={document.introduction}
              maxLength={FAQ_CONTENT_LIMITS.introduction}
              onChange={(event) =>
                updateDocument("introduction", event.target.value)
              }
              required
            />
          </label>
        </section>

        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">FAQ Sections</h2>
              <p className="mt-1 text-sm text-white/55">
                Paragraphs are separated by a blank line. Bullets use one line
                per item. Complete HTTPS URLs become safe external links.
              </p>
            </div>
            <button
              type="button"
              className={secondaryButtonClassName}
              onClick={addSection}
              disabled={document.sections.length >= FAQ_CONTENT_LIMITS.sections}
            >
              Add Section
            </button>
          </div>

          {document.sections.map((section, index) => (
            <details
              key={`section-editor-${index}`}
              className="rounded-xl border border-white/10 bg-white/[0.04] p-5"
              open={index === 0}
            >
              <summary className="cursor-pointer rounded-sm font-semibold text-orange-300 outline-none focus-visible:ring-2 focus-visible:ring-orange-300">
                {index + 1}. {section.title || "Untitled section"}
              </summary>

              <div className="mt-5 grid gap-4 md:grid-cols-2">
                <label className="flex flex-col gap-1 text-sm">
                  Stable section ID
                  <input
                    className={inputClassName}
                    value={section.id}
                    maxLength={FAQ_CONTENT_LIMITS.sectionId}
                    pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                    onChange={(event) =>
                      updateSection(index, (current) => ({
                        ...current,
                        id: event.target.value,
                      }))
                    }
                    required
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  Section title
                  <input
                    className={inputClassName}
                    value={section.title}
                    maxLength={FAQ_CONTENT_LIMITS.sectionTitle}
                    onChange={(event) =>
                      updateSection(index, (current) => ({
                        ...current,
                        title: event.target.value,
                      }))
                    }
                    required
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm md:col-span-2">
                  Paragraphs
                  <textarea
                    className={`${inputClassName} min-h-40 resize-y`}
                    value={section.paragraphs.join("\n\n")}
                    onChange={(event) =>
                      updateSection(index, (current) => ({
                        ...current,
                        paragraphs: paragraphEditorLines(event.target.value),
                      }))
                    }
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm md:col-span-2">
                  Bullets
                  <textarea
                    className={`${inputClassName} min-h-32 resize-y`}
                    value={section.bullets.join("\n")}
                    onChange={(event) =>
                      updateSection(index, (current) => ({
                        ...current,
                        bullets: bulletEditorLines(event.target.value),
                      }))
                    }
                  />
                </label>

                <div className="flex flex-wrap gap-2 md:col-span-2">
                  <button
                    type="button"
                    className={secondaryButtonClassName}
                    onClick={() => moveSection(index, -1)}
                    disabled={index === 0}
                  >
                    Move Up
                  </button>
                  <button
                    type="button"
                    className={secondaryButtonClassName}
                    onClick={() => moveSection(index, 1)}
                    disabled={index === document.sections.length - 1}
                  >
                    Move Down
                  </button>
                  <button
                    type="button"
                    className="cursor-pointer rounded bg-red-950/70 px-3 py-2 text-sm font-semibold text-red-100 outline-none transition hover:bg-red-900 focus-visible:ring-2 focus-visible:ring-red-300 disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={() => removeSection(index)}
                    disabled={document.sections.length === 1}
                  >
                    Remove Section
                  </button>
                </div>
              </div>
            </details>
          ))}
        </section>

        <section className="rounded-xl border border-orange-500/25 bg-orange-950/20 p-5">
          <h2 className="text-lg font-semibold text-orange-300">
            Save &amp; Publish
          </h2>
          <p className="mt-2 text-sm leading-6 text-white/60">
            This creates one immutable revision and publishes it immediately.
            Nothing is stored on the server before this action.
          </p>
          <button
            type="submit"
            className={`${primaryButtonClassName} mt-4`}
            disabled={pending}
          >
            {pending ? "Saving & Publishing..." : "Save & Publish"}
          </button>
          <p
            className={
              actionState.status === "error"
                ? "mt-3 text-sm text-red-300"
                : "mt-3 text-sm text-emerald-300"
            }
            aria-live="polite"
          >
            {actionState.message}
          </p>
        </section>
      </form>

      <section className="space-y-5 border-t border-white/10 pt-8">
        <header>
          <h2 className="text-lg font-semibold">Local Editor Preview</h2>
          <p className="mt-1 text-sm text-white/55">
            This uses the same safe renderer as the public FAQ. Editing the
            fields does not save a server draft.
          </p>
        </header>
        <div className="mx-auto max-w-5xl">
          <FaqDocumentView document={previewDocument} />
        </div>
      </section>
    </div>
  );
}
