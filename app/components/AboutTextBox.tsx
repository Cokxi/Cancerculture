type Props = {
  title: string;
  text: string;
  variant?: "default" | "wide";
};

export default function AboutTextBox({
  title,
  text,
  variant = "default",
}: Props) {
  const maxWidth =
    variant === "wide" ? "max-w-[520px]" : "max-w-[380px]";

  return (
    <div
      className={`
        orange-info-box
        w-full
        ${maxWidth}
        mx-auto
      `}
    >
      <h2 className="orange-box-title text-center">
        {title}
      </h2>

      <div className="whitespace-pre-line">
        {text}
      </div>
    </div>
  );
}
