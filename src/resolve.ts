// Resolves a wikilink to a note that is still skipped on disk. Pure: the caller
// passes the indexed file list. Matching is case-insensitive.
import { norm, parentOf } from "./paths";

const key = (s: string): string => norm(s).toLowerCase();

// Candidate keys for a link: the link itself, and with ".md" if it has no .md.
const candidates = (p: string): string[] =>
  (p.toLowerCase().endsWith(".md") ? [p] : [p, p + ".md"]).map(key);

// Joins a relative link onto a folder. Null when ".." climbs out of the vault.
function joinRel(folder: string, link: string): string | null {
  const stack = folder === "" ? [] : folder.split("/");
  for (const seg of link.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (stack.length === 0) return null;
      stack.pop();
    } else {
      stack.push(seg);
    }
  }
  return stack.join("/");
}

export function resolveSkipped(linkpath: string, sourcePath: string, files: string[]): string | null {
  const lp = norm(linkpath);
  if (lp === "") return null;
  const src = norm(sourcePath);
  const indexed = files.map((f) => ({ f, k: key(f) }));
  const exact = (cands: string[]): string | null => {
    for (const c of cands) {
      const hit = indexed.find((e) => e.k === c);
      if (hit) return hit.f;
    }
    return null;
  };

  // (a) an exact vault path
  const a = exact(candidates(lp));
  if (a) return a;

  // (b) a relative link, resolved against the source note's folder
  const rel = lp.includes("/") || /^\.\.?\//.test(linkpath.replace(/\\/g, "/"));
  if (rel) {
    const r = joinRel(parentOf(src), lp);
    if (r) {
      const b = exact(candidates(r));
      if (b) return b;
    }
  }

  // (c) a file whose path is the link or ends in "/" + link. Same folder first,
  // then the shortest path, then the lexically first.
  const cs = candidates(lp);
  const matches = indexed.filter((e) => cs.some((c) => e.k === c || e.k.endsWith("/" + c)));
  if (matches.length === 0) return null;
  const srcFolder = key(parentOf(src));
  matches.sort((x, y) => {
    const xs = key(parentOf(x.f)) === srcFolder ? 0 : 1;
    const ys = key(parentOf(y.f)) === srcFolder ? 0 : 1;
    if (xs !== ys) return xs - ys;
    if (x.f.length !== y.f.length) return x.f.length - y.f.length;
    return x.f < y.f ? -1 : x.f > y.f ? 1 : 0;
  });
  return matches[0].f;
}
