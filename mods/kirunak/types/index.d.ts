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

declare module 'claude-code' {
  interface PluginState {
    kirunak: { board: KirunakBoard | null };
  }
}
