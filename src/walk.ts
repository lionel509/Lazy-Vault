// Names-only index of skipped folders, so a link click can find a skipped note without loading it.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { norm } from "./paths";
import type { State } from "./hooks";

// Iterative readdir. Reads names only, never contents. Skips dot-entries, symlinks and
// directories named in skipNames. Returns sorted vault-relative file paths.
export async function walkNames(base: string, root: string, skipNames: string[]): Promise<string[]> {
  const skip = new Set(skipNames);
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop() as string;
    const entries = await readdir(join(base, dir), { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith(".") || e.isSymbolicLink()) continue;
      const rel = dir === "" ? e.name : dir + "/" + e.name;
      if (e.isDirectory()) {
        if (!skip.has(e.name)) stack.push(rel);
      } else if (e.isFile()) {
        out.push(norm(rel));
      }
    }
  }
  return out.sort();
}

// Walks every skipped root that has no index yet. A walk error stores an empty list and logs.
export async function indexSkipped(s: State): Promise<void> {
  for (;;) {
    let missing: string | undefined;
    for (const r of s.skipped.keys()) {
      if (!s.index.has(r)) {
        missing = r;
        break;
      }
    }
    if (missing === undefined) break;
    const root = missing;
    let files: string[] = [];
    try {
      files = await walkNames(s.base, root, s.ctx.settings.buildNames);
    } catch (err) {
      s.errors.push(`index ${root}: ${String(err)}`);
    }
    // The folder may have been loaded while the walk ran; a loaded folder gets no index.
    if (s.skipped.has(root)) s.index.set(root, files);
  }
  s.changed();
}

// Every indexed path, deduplicated. A nested repo shows up under its parent and under itself.
export function indexedFiles(s: State): string[] {
  const all = new Set<string>();
  for (const files of s.index.values()) for (const f of files) all.add(f);
  return [...all];
}
