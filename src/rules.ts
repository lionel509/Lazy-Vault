// Pure skip rules. No I/O: the hooks gather a Probe and pass it in.
import { ancestors, isInside } from "./paths";

export type Reason = "repo" | "build" | "cold" | "listed";

export interface Settings {
  enabled: boolean;
  coldDays: number;
  buildNames: string[];
  pins: string[];
  skipList: string[];
  allowWithSync: boolean;
}

export interface Startup {
  at: number;
  mode: "on" | "off" | "failopen" | "late";
  apiVersion: string;
  onloadMs: number;
  layoutReadyMs: number | null;
  vaultFiles: number | null;
  vaultEntries: number | null;
  skippedFolders: number;
  skipped: { path: string; reason: Reason }[];
  skippedFiles: number | null;
  problems: string[];
  selftest?: { link: string; source: string; opened: string | null };
}

export interface History {
  vaultBase: string;
  firstSeenDay: number;
  lastActive: Record<string, number>;
  startups: Startup[];
}

export interface Probe {
  isDir: boolean;
  hasGit: boolean;
  hasObsidian: boolean;
}

export interface Ctx {
  settings: Settings;
  history: History;
  today: number;
  startup: boolean;
  protect: string[];
}

// True when a protect entry is inside the path, or the path is inside one.
export function isProtected(path: string, protect: string[]): boolean {
  return protect.some((e) => isInside(e, path) || isInside(path, e));
}

// Cold: at least coldDays of history, and untouched for at least coldDays.
export function isCold(path: string, h: History, today: number, coldDays: number): boolean {
  if (coldDays <= 0) return false;
  if (today - h.firstSeenDay < coldDays) return false;
  const last = h.lastActive[path];
  return last === undefined || today - last >= coldDays;
}

// Checks in the order fixed by the plan. Null means load.
export function decide(path: string, probe: Probe, ctx: Ctx): Reason | null {
  if (!probe.isDir) return null;
  if (isProtected(path, ctx.protect)) return null;
  if (ctx.settings.skipList.includes(path)) return "listed";
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (ctx.settings.buildNames.includes(base)) return "build";
  if (probe.hasGit && !probe.hasObsidian) return "repo";
  if (ctx.startup && isCold(path, ctx.history, ctx.today, ctx.settings.coldDays)) return "cold";
  return null;
}

// Marks the folder of filePath and every ancestor as active today.
// Returns true when any value changed.
export function touch(h: History, filePath: string, today: number): boolean {
  let changed = false;
  for (const a of ancestors(filePath)) {
    if (h.lastActive[a] !== today) {
      h.lastActive[a] = today;
      changed = true;
    }
  }
  return changed;
}
