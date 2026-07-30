/**
 * A status, always as text.
 *
 * `docs/UX_FLOWS.md` sections 12 and 19 forbid colour as the only means of
 * identification, so the colour here is decoration on top of a word that
 * already says the same thing, and the shape carries a text prefix as well.
 */

import type { ReactElement } from "react";

export type Tone = "live" | "waiting" | "warning" | "failed" | "neutral";

const TONE_CLASS: Readonly<Record<Tone, string>> = {
  live: "border-emerald-600 text-emerald-800 dark:text-emerald-300",
  waiting: "border-sky-600 text-sky-800 dark:text-sky-300",
  warning: "border-amber-600 text-amber-800 dark:text-amber-300",
  failed: "border-red-600 text-red-800 dark:text-red-300",
  neutral: "border-slate-400 text-slate-700 dark:text-slate-300",
};

const TONE_MARK: Readonly<Record<Tone, string>> = {
  live: "●",
  waiting: "◐",
  warning: "▲",
  failed: "■",
  neutral: "○",
};

export function StatusBadge({
  tone,
  label,
  detail,
}: {
  readonly tone: Tone;
  readonly label: string;
  readonly detail?: string | undefined;
}): ReactElement {
  return (
    <span
      className={`inline-flex items-center gap-2 rounded border px-2 py-1 text-sm font-medium ${TONE_CLASS[tone]}`}
    >
      <span aria-hidden="true">{TONE_MARK[tone]}</span>
      <span>{label}</span>
      {detail === undefined ? null : (
        <span className="font-normal text-slate-600 dark:text-slate-400">{detail}</span>
      )}
    </span>
  );
}
