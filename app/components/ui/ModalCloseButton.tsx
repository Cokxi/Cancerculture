type ModalCloseButtonProps = {
  onClick: () => void;
};

export default function ModalCloseButton({
  onClick,
}: ModalCloseButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Close modal"
      className="absolute right-2 top-2 z-10 inline-flex h-10 w-10 cursor-pointer items-center justify-center rounded-full border border-white/20 bg-black/70 text-white shadow-md transition hover:bg-black/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 focus-visible:ring-offset-2 focus-visible:ring-offset-black active:scale-95 active:bg-black"
    >
      <span aria-hidden="true" className="-translate-y-px text-xl leading-none">
        ×
      </span>
    </button>
  );
}
