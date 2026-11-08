// Pure path helpers. Vault paths are "/"-separated, NFC, relative to the vault
// root. The root is "".

export function norm(p: string): string {
  return p
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s !== "" && s !== ".")
    .join("/")
    .normalize("NFC");
}

export function parentOf(p: string): string {
  const n = norm(p);
  const i = n.lastIndexOf("/");
  return i < 0 ? "" : n.slice(0, i);
}

// The folders that contain p, shallowest first. The entry itself is not included.
export function ancestors(p: string): string[] {
  const n = norm(p);
  if (n === "") return [];
  const parts = n.split("/");
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

export function isInside(p: string, root: string): boolean {
  return root === "" || p === root || p.startsWith(root + "/");
}

// The shortest ancestor-or-self of p that is in the set, or null.
export function topSkipped(p: string, set: { has(k: string): boolean }): string | null {
  for (const a of [...ancestors(p), norm(p)]) {
    if (a !== "" && set.has(a)) return a;
  }
  return null;
}

// Like topSkipped, but matches case-insensitively, as the default macOS filesystem does.
// Returns the key as it is spelled in `keys`.
export function topSkippedFold(p: string, keys: Iterable<string>): string | null {
  const q = norm(p).toLowerCase();
  let best: string | null = null;
  for (const k of keys) {
    const kl = norm(k).toLowerCase();
    if (kl === "") continue;
    if ((q === kl || q.startsWith(kl + "/")) && (best === null || k.length < best.length)) best = k;
  }
  return best;
}

// UTC epoch day.
export function epochDay(ms: number): number {
  return Math.floor(ms / 86400000);
}
