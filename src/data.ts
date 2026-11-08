// Parsers for the files the plugin reads. Every parser takes unknown input and
// never throws: a bad field falls back to its default and adds an error string.
import { createHash } from "node:crypto";
import { norm, parentOf } from "./paths";
import type { History, Settings, Startup } from "./rules";

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  coldDays: 30,
  buildNames: ["node_modules", "__pycache__", "target", "dist", "build", "venv"],
  pins: [],
  skipList: [],
  allowWithSync: false,
  pausedAfterSlowStart: false,
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// Keeps strings only, normalises, drops "" and duplicates.
function cleanList(a: unknown[]): string[] {
  const out: string[] = [];
  for (const v of a) {
    if (typeof v !== "string") continue;
    const p = norm(v);
    if (p !== "" && !out.includes(p)) out.push(p);
  }
  return out;
}

export function parseSettings(raw: unknown): { settings: Settings; errors: string[] } {
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    buildNames: [...DEFAULT_SETTINGS.buildNames],
    pins: [],
    skipList: [],
  };
  const errors: string[] = [];
  if (raw === undefined || raw === null) return { settings, errors };
  if (!isObj(raw)) return { settings, errors: ["settings: not an object, using defaults"] };

  if (raw.enabled !== undefined) {
    if (typeof raw.enabled === "boolean") settings.enabled = raw.enabled;
    else errors.push("settings.enabled: not a boolean, using default");
  }
  if (raw.coldDays !== undefined) {
    const d = raw.coldDays;
    if (typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 3650) settings.coldDays = d;
    else errors.push("settings.coldDays: must be an integer from 0 to 3650, using default");
  }
  for (const k of ["buildNames", "pins", "skipList"] as const) {
    const v = raw[k];
    if (v === undefined) continue;
    if (Array.isArray(v)) settings[k] = cleanList(v);
    else errors.push(`settings.${k}: not a list, using default`);
  }
  if (raw.allowWithSync !== undefined) {
    if (typeof raw.allowWithSync === "boolean") settings.allowWithSync = raw.allowWithSync;
    else errors.push("settings.allowWithSync: not a boolean, using default");
  }
  if (raw.pausedAfterSlowStart !== undefined) {
    if (typeof raw.pausedAfterSlowStart === "boolean") settings.pausedAfterSlowStart = raw.pausedAfterSlowStart;
    else errors.push("settings.pausedAfterSlowStart: not a boolean, using default");
  }
  return { settings, errors };
}

export function parseHistory(
  raw: unknown,
  vaultBase: string,
  today: number,
): { history: History; errors: string[] } {
  const fresh = (): History => ({ vaultBase, firstSeenDay: today, lastActive: {}, startups: [] });
  if (raw === undefined || raw === null) return { history: fresh(), errors: [] };
  if (!isObj(raw)) return { history: fresh(), errors: ["history: not an object, restarted"] };
  if (raw.vaultBase !== vaultBase) {
    return { history: fresh(), errors: ["history: belongs to another vault path, restarted"] };
  }

  const errors: string[] = [];
  // A day that is not an integer, or is later than today, becomes today.
  const day = (v: unknown, name: string): number => {
    if (typeof v === "number" && Number.isInteger(v) && v <= today) return v;
    errors.push(`history.${name}: invalid or in the future, set to today`);
    return today;
  };

  const firstSeenDay = day(raw.firstSeenDay, "firstSeenDay");
  const lastActive: Record<string, number> = {};
  if (raw.lastActive !== undefined) {
    if (isObj(raw.lastActive)) {
      for (const [k, v] of Object.entries(raw.lastActive)) {
        const key = norm(k);
        if (key === "") continue;
        const d = day(v, `lastActive.${k}`);
        // Two spellings of one folder ("Proj/" and "Proj"): the most recent activity wins.
        lastActive[key] = Object.hasOwn(lastActive, key) ? Math.max(lastActive[key], d) : d;
      }
    } else {
      errors.push("history.lastActive: not an object, reset");
    }
  }
  const startups = Array.isArray(raw.startups)
    ? (raw.startups.filter((x) => isObj(x) && typeof x.at === "number") as Startup[]).slice(-20)
    : [];
  return { history: { vaultBase, firstSeenDay, lastActive, startups }, errors };
}

// Files open in the restored layout. Walks the leaves of main, left and right
// only, so lastOpenFiles is ignored.
export function openFilesFromWorkspace(raw: unknown): string[] {
  const out: string[] = [];
  if (!isObj(raw)) return out;
  // Iterative, so a deeply nested layout cannot overflow the stack. Same order as a recursive walk.
  const stack: unknown[] = ["right", "left", "main"].map((k) => raw[k]);
  while (stack.length) {
    const node = stack.pop();
    if (!isObj(node)) continue;
    if (node.type === "leaf" && isObj(node.state) && isObj(node.state.state)) {
      const file = node.state.state.file;
      if (typeof file === "string") {
        const f = norm(file);
        if (f !== "" && !out.includes(f)) out.push(f);
      }
    }
    if (Array.isArray(node.children)) for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
  }
  return out;
}

// Folders the config files point at: attachments, new notes, daily notes,
// their template's folder, templates and Templater's templates folder.
export function configPins(readJson: (relToConfigDir: string) => unknown): string[] {
  const out: string[] = [];
  const add = (v: unknown): void => {
    if (typeof v !== "string") return;
    const p = norm(v);
    if (p !== "" && !out.includes(p)) out.push(p);
  };
  const app = readJson("app.json");
  if (isObj(app)) {
    add(app.attachmentFolderPath);
    add(app.newFileFolderPath);
  }
  const daily = readJson("daily-notes.json");
  if (isObj(daily)) {
    add(daily.folder);
    if (typeof daily.template === "string") add(parentOf(daily.template));
  }
  const templates = readJson("templates.json");
  if (isObj(templates)) add(templates.folder);
  const templater = readJson("plugins/templater-obsidian/data.json");
  if (isObj(templater)) add(templater.templates_folder);
  return out;
}

// core-plugins.json is an object of booleans or a list of enabled ids.
export function syncOn(corePlugins: unknown): boolean {
  if (Array.isArray(corePlugins)) return corePlugins.includes("sync");
  return isObj(corePlugins) && corePlugins.sync === true;
}

// History lives outside the vault, keyed by a hash of the vault path.
export function historyFileName(vaultBase: string): string {
  return createHash("sha256").update(vaultBase).digest("hex").slice(0, 16) + ".json";
}
