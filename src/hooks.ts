// Patches the adapter, vault, file-manager and leaf seams so skipped folders are
// never scanned, and loads a folder when a write, rename or link click asks for it.
// Imports only node builtins and the pure modules, never `obsidian`.
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { norm, topSkipped } from "./paths";
import { decide } from "./rules";
import type { Ctx, Probe, Reason } from "./rules";
import { resolveSkipped } from "./resolve";
import { indexSkipped, indexedFiles } from "./walk";

export interface Targets {
  adapter: any;
  vault: any;
  fileManager: any;
  leafProto: any;
}

export interface Deps {
  parseLinktext(t: string): { path: string; subpath: string };
  getFirstLinkpathDest(lp: string, src: string): unknown | null;
  getFile(path: string): unknown | null;
  notice(msg: string): void;
}

export interface State {
  base: string;
  ctx: Ctx;
  active: boolean;
  skipped: Map<string, Reason>;
  loaded: Map<string, Reason>;
  index: Map<string, string[]>;
  indexing: Promise<void>;
  problems: string[];
  errors: string[];
  scanCalls: number;
  changed: () => void;
}

// Every method the plugin relies on, with the arity it was verified at in Obsidian 1.14.5.
// getRealPath and getFullRealPath are checked but never wrapped.
export const HOOKS: ReadonlyArray<readonly [keyof Targets, string, number]> = [
  ["adapter", "listRecursiveChild", 2],
  ["adapter", "reconcileFile", 2],
  ["adapter", "getRealPath", 1],
  ["adapter", "getFullRealPath", 1],
  ["adapter", "write", 3],
  ["adapter", "writeBinary", 3],
  ["adapter", "append", 3],
  ["adapter", "appendBinary", 3],
  ["adapter", "process", 3],
  ["adapter", "mkdir", 1],
  ["adapter", "remove", 1],
  ["adapter", "trashSystem", 1],
  ["adapter", "trashLocal", 1],
  ["adapter", "rmdir", 2],
  ["adapter", "copy", 2],
  ["adapter", "rename", 2],
  ["vault", "create", 3],
  ["vault", "createBinary", 3],
  ["vault", "createFolder", 1],
  ["fileManager", "renameFile", 2],
  ["leafProto", "openLinkText", 3],
];

const CHECK_ONLY = new Set(["adapter.getRealPath", "adapter.getFullRealPath"]);

// Argument positions holding a vault path, for the load-first write guards.
const GUARDED: Record<string, number[]> = {
  "adapter.write": [0],
  "adapter.writeBinary": [0],
  "adapter.append": [0],
  "adapter.appendBinary": [0],
  "adapter.process": [0],
  "adapter.mkdir": [0],
  "adapter.remove": [0],
  "adapter.trashSystem": [0],
  "adapter.trashLocal": [0],
  "adapter.rmdir": [0],
  "adapter.copy": [0, 1],
  "adapter.rename": [0, 1],
  "vault.create": [0],
  "vault.createBinary": [0],
  "vault.createFolder": [0],
};

export function newState(base: string, ctx: Ctx): State {
  return {
    base,
    ctx,
    active: false,
    skipped: new Map(),
    loaded: new Map(),
    index: new Map(),
    indexing: Promise.resolve(),
    problems: [],
    errors: [],
    scanCalls: 0,
    changed: () => {},
  };
}

// Empty when every hooked method exists with the verified arity.
export function checkHooks(t: Targets): string[] {
  const problems: string[] = [];
  if (typeof t.adapter?.files !== "object" || t.adapter.files === null) problems.push("adapter.files missing");
  for (const [target, method, arity] of HOOKS) {
    const name = `${target}.${method}`;
    const fn = t[target]?.[method];
    if (typeof fn !== "function") problems.push(`${name} missing`);
    else if (fn.length !== arity) problems.push(`${name} takes ${fn.length} args, expected ${arity}`);
  }
  return problems;
}

async function probeOf(full: string): Promise<Probe> {
  const st = await lstat(full);
  if (!st.isDirectory()) return { isDir: false, hasGit: false, hasObsidian: false };
  const has = (name: string) => lstat(join(full, name)).then(
    () => true,
    () => false,
  );
  return { isDir: true, hasGit: await has(".git"), hasObsidian: await has(".obsidian") };
}

// Wraps every row or none. Returns the problems found; when there are any, nothing is wrapped.
export function installHooks(t: Targets, s: State, d: Deps): { problems: string[]; restore: () => void } {
  const problems = checkHooks(t);
  if (problems.length) {
    s.problems.push(...problems);
    return { problems, restore: () => {} };
  }

  const loadIfSkipped = async (path: unknown) => {
    if (typeof path !== "string") return;
    try {
      if (topSkipped(norm(path), s.skipped) !== null) await loadFor(t, s, path);
    } catch (err) {
      s.errors.push(`load ${path}: ${String(err)}`);
    }
  };

  // Scan: a skipped folder never reaches adapter.files.
  const scan = (orig: Function) =>
    async function (this: any, ...args: any[]): Promise<unknown> {
      const [parent, name] = args;
      if (!s.active || typeof name !== "string" || name.startsWith(".")) return orig.apply(this, args);
      s.scanCalls++;
      const raw = typeof parent === "string" && parent !== "" ? parent + "/" + name : name;
      const p = norm(raw);
      let reason: Reason | null;
      try {
        if (s.loaded.has(p)) return orig.apply(this, args);
        const probe = await probeOf(t.adapter.getFullRealPath(raw));
        reason = decide(p, probe, s.ctx);
      } catch (err) {
        s.errors.push(`scan ${p}: ${String(err)}`);
        return orig.apply(this, args);
      }
      if (reason === null) return orig.apply(this, args);
      s.skipped.set(p, reason);
      s.changed();
      if (!s.ctx.startup) s.indexing = s.indexing.then(() => indexSkipped(s));
      return undefined;
    };

  // Watcher events: anything inside (or equal to) a skipped root is dropped.
  const event = (orig: Function) =>
    function (this: any, ...args: any[]): unknown {
      if (s.active) {
        const p = args[1];
        try {
          if (typeof p === "string" && topSkipped(norm(p), s.skipped) !== null) return Promise.resolve();
        } catch (err) {
          s.errors.push(`event ${String(p)}: ${String(err)}`);
        }
      }
      return orig.apply(this, args);
    };

  // Write guards: load the skipped folder first, then run the original.
  const guard = (orig: Function, pathArgs: number[]) =>
    async function (this: any, ...args: any[]): Promise<unknown> {
      if (s.active) for (const i of pathArgs) await loadIfSkipped(args[i]);
      return orig.apply(this, args);
    };

  // Renames of notes load cold and listed folders so link updates reach them. Repos stay skipped.
  const renameFile = (orig: Function) =>
    async function (this: any, ...args: any[]): Promise<unknown> {
      if (s.active) {
        const fp = args[0]?.path;
        if (typeof fp === "string" && /\.(md|canvas)$/.test(fp)) {
          for (const [root, reason] of [...s.skipped]) {
            if (!s.skipped.has(root) || (reason !== "cold" && reason !== "listed")) continue;
            try {
              await loadFolder(t, s, root);
            } catch (err) {
              s.errors.push(`load ${root}: ${String(err)}`);
            }
          }
        }
        await loadIfSkipped(args[1]);
      }
      return orig.apply(this, args);
    };

  // Link clicks: resolve against the skipped index, load, open. Never create a note that exists.
  const openLinkText = (orig: Function) =>
    async function (this: any, ...args: any[]): Promise<unknown> {
      const [linktext, sourcePath, openState] = args;
      if (!s.active || s.skipped.size === 0 || typeof linktext !== "string" || typeof sourcePath !== "string") {
        return orig.apply(this, args);
      }
      let hit: string | null = null;
      let lp = "";
      let subpath = "";
      try {
        const parsed = d.parseLinktext(linktext);
        lp = parsed.path;
        subpath = parsed.subpath;
        if (d.getFirstLinkpathDest(lp, sourcePath)) return orig.apply(this, args);
        await s.indexing;
        hit = resolveSkipped(lp, sourcePath, indexedFiles(s));
      } catch (err) {
        s.errors.push(`link ${linktext}: ${String(err)}`);
        return orig.apply(this, args);
      }
      if (hit === null) return orig.apply(this, args);
      const where = topSkipped(norm(hit), s.skipped) ?? hit;
      try {
        await loadFor(t, s, hit);
      } catch (err) {
        s.errors.push(`load ${where}: ${String(err)}`);
        d.notice(`Lazy Vault: couldn't load ${where}`);
        return undefined;
      }
      if (d.getFirstLinkpathDest(lp, sourcePath)) return orig.apply(this, args);
      const f = d.getFile(hit);
      if (f) return this.openFile(f, { ...openState, eState: { ...openState?.eState, subpath } });
      return orig.apply(this, args);
    };

  const wrapperFor = (key: string, orig: Function): Function => {
    if (key === "adapter.listRecursiveChild") return scan(orig);
    if (key === "adapter.reconcileFile") return event(orig);
    if (key === "fileManager.renameFile") return renameFile(orig);
    if (key === "leafProto.openLinkText") return openLinkText(orig);
    return guard(orig, GUARDED[key]);
  };

  const installed: { obj: any; method: string; orig: Function; wrapper: Function }[] = [];
  for (const [target, method, arity] of HOOKS) {
    const key = `${target}.${method}`;
    if (CHECK_ONLY.has(key)) continue;
    const obj = t[target];
    const orig: Function = obj[method];
    const wrapper = wrapperFor(key, orig);
    Object.defineProperty(wrapper, "length", { value: arity });
    installed.push({ obj, method, orig, wrapper });
  }
  for (const w of installed) w.obj[w.method] = w.wrapper;
  s.active = true;

  const restore = () => {
    s.active = false;
    for (const w of installed) if (w.obj[w.method] === w.wrapper) w.obj[w.method] = w.orig;
  };
  return { problems, restore };
}

// Loads one skipped folder: it moves to `loaded`, then Obsidian's own new-folder path lists it.
// Deliberately not run through adapter.queue, since a write guard can already be inside it.
export async function loadFolder(t: Targets, s: State, root: string): Promise<void> {
  const r = norm(root);
  const reason = s.skipped.get(r);
  if (reason === undefined) return;
  s.skipped.delete(r);
  s.loaded.set(r, reason);
  s.index.delete(r);
  s.changed();
  await t.adapter.reconcileFile(t.adapter.getRealPath(r), r);
}

// Loads the top-most skipped ancestor-or-self of `path` until none is left.
export async function loadFor(t: Targets, s: State, path: string): Promise<void> {
  for (let i = 0; i < 64; i++) {
    const root = topSkipped(norm(path), s.skipped);
    if (root === null) return;
    await loadFolder(t, s, root);
  }
}

// Loads every skipped folder for this session. Each load removes its root first, so this terminates.
export async function loadAll(t: Targets, s: State): Promise<void> {
  for (let i = 0; i < 100000; i++) {
    const first = s.skipped.keys().next();
    if (first.done) return;
    try {
      await loadFolder(t, s, first.value);
    } catch (err) {
      s.errors.push(`load ${first.value}: ${String(err)}`);
    }
  }
}
