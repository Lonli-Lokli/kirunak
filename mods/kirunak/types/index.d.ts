// What the pane and the band draw from: `k list --json --all` and `k status --json --session <id>` (boards.md §4).

export type KirunakItem = { id: string; text: string; verdict: string | null };

export type KirunakRow = {
  id: string;
  repo: string;
  title: string;
  state: string;
  queue: number | null;
  step: string | null;
  lock: string | null;
  review: { file: string; verdict: string | null } | null;
  checklist: { open: number; ticked: number } | null;
  ac: KirunakItem[];
  e: KirunakItem[];
};

export type KirunakStatus = {
  home: string;
  lock: { what?: string; session?: string; since?: string } | null;
  queue: { what?: string; session?: string; line?: string }[];
  running: { task?: string; step?: string; since?: string }[];
  maxAgents: number;
  session: { id: string; task: string | null; step: string | null; since: string | null } | null;
};

// The last read: the rows and the status, when it was taken, and why it failed if it did (the rows kept from before).
export type KirunakBoard = { rows: KirunakRow[]; status: KirunakStatus | null; at: number; error: string | null };

// A dialog's look on the phone and the desktop app (gulnya/mobile-dialogs D-1, D-2): what the `ui.render` hook on
// AskUserQuestion draws above the engine's own card (look.tsx), from looks.ts's parts. `stage` names one of looks.ts's
// stages, which gives the chip its colour and icon; `word` stands beside the icon (AC-9).
export type KirunakChip = { stage: string; word: string };
// A list's row as the progress rows draw (AC-1): its chip, its id in bold, its short words.
export type KirunakLookRow = { chip: KirunakChip; id: string; words: string };
// A Quad Damage line as a row (AC-11 to AC-13): its time, null for a line with none (the summary's, the run's status);
// its stage's chip; its bug's id, null for a line of the run itself; its words as written.
export type KirunakProgressRow = { time: string | null; chip: KirunakChip; id: string | null; words: string };
// A part of the text under a heading (AC-4); `lines` are the lines as drawn, '' a blank line between paragraphs.
export type KirunakSection = { heading: string | null; lines: string[] };
// The head (AC-1): the title large, the chip, the dim line with the repo and the dates; `first`, the first lines
// shown under it (AC-10); `rows`, a list's; `fold`, what Show all unfolds (AC-3, AC-10), null when nothing is folded;
// `run`, Quad Damage's line as a row of the head while a run lives (AC-12), none for a look of no run.
export type KirunakLook = {
  title: string;
  chip: KirunakChip | null;
  line: string | null;
  run?: KirunakProgressRow | null;
  first: KirunakSection[];
  rows: KirunakLookRow[];
  fold: KirunakSection[] | null;
};
// The dialog open now, as talk() asked it (owner.ts): `question`, exactly the question passed to $.ui.ask, which the
// hook draws a look for and no other; `ask`, its last line, the question the engine's card shows under the look;
// `id`, a new one each time a dialog is shown, so a fold left open belongs to that showing alone; `described`, each
// choice's line by its label, which the `tool.call` hook writes into the call (AC-14); `look`, null for a dialog with
// none, which every surface draws as the engine draws it.
export type KirunakDialog = { id: number; question: string; ask: string; described: Record<string, string>; look: KirunakLook | null };
// Where the fold is (E-1): the dialog's `id` it was opened in, and the part shown (0 the first); written by the fold's
// buttons alone, never while drawing.
export type KirunakFold = { dialog: number; part: number } | null;

declare module 'claude-code' {
  interface PluginState {
    kirunak: { board: KirunakBoard | null; dialog: KirunakDialog | null; fold: KirunakFold };
  }
}
