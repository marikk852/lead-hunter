"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";

/** Copies the draft to the clipboard so the owner can paste it into the source platform. */
export function CopyButton({ text, label = "Copy response" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          setCopied(false);
        }
      }}
      className="border border-ink-700 px-3 py-1.5 text-xs font-medium text-ink-100 transition-colors hover:border-ink-400 hover:text-ink-50"
    >
      {copied ? "Copied" : label}
    </button>
  );
}

/** Submit button that reflects the pending state of its surrounding form. */
export function SubmitButton({
  children,
  variant = "primary",
  pendingLabel,
  title,
}: {
  children: React.ReactNode;
  variant?: "primary" | "quiet";
  pendingLabel?: string;
  title?: string;
}) {
  const { pending } = useFormStatus();

  const className =
    variant === "primary"
      ? "border border-hot bg-hot text-ink-950 hover:bg-ink-50 hover:border-ink-50"
      : "border border-ink-700 text-ink-100 hover:border-ink-400 hover:text-ink-50";

  return (
    <button
      type="submit"
      disabled={pending}
      title={title}
      className={`px-3 py-1.5 text-xs font-semibold transition-colors disabled:cursor-wait disabled:opacity-50 ${className}`}
    >
      {pending ? (pendingLabel ?? "Working…") : children}
    </button>
  );
}
