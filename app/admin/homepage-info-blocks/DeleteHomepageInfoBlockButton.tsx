"use client";

import { deleteHomepageInfoBlockAction } from "./actions";

export default function DeleteHomepageInfoBlockButton({
  blockId,
}: {
  blockId: number;
}) {
  return (
    <form
      action={deleteHomepageInfoBlockAction}
      onSubmit={(event) => {
        const confirmed = window.confirm(
          "Delete this Info Box permanently?\nIts content cannot be recovered."
        );

        if (!confirmed) {
          event.preventDefault();
        }
      }}
    >
      <input name="id" type="hidden" value={blockId} />
      <button
        type="submit"
        className="cursor-pointer rounded bg-red-700 px-4 py-2 font-semibold text-white outline-none transition-colors hover:bg-red-600 focus-visible:ring-2 focus-visible:ring-red-300 active:bg-red-800"
      >
        Delete permanently
      </button>
    </form>
  );
}
