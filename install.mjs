// Copies the built plugin (main.js, manifest.json, styles.css) into registered
// Obsidian vaults. Writes nothing else: no community-plugins.json, no data.json.
import { copyFileSync, existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { homedir } from "node:os";

// sha256 of the lowercased name of the one folder this installer must never write to.
// The name itself is never written in this repo.
export const DENY_HASHES = ["6a62362c11e91c9f8205c47bbb30833a257c979f663b9a73d3c814ce228fe3dd"];

const FILES = ["main.js", "manifest.json", "styles.css"];
const DEFAULT_VAULTS = ["", "Citadel", "BlackRock", "Berkshire", "State Street", "Goldman", "Fidelity", "Mirae"];

const sha = (s) => createHash("sha256").update(s).digest("hex");

function segments(p) {
  return p.split("/").filter(Boolean);
}

// True if any folder segment of the path (or of its real path, when it exists) is denied.
export function forbidden(path, hashes = DENY_HASHES) {
  const candidates = [resolve(path)];
  try {
    candidates.push(realpathSync(path));
  } catch {
    // Path does not exist yet: the lexical check is all there is.
  }
  for (const c of candidates) {
    for (const seg of segments(c)) {
      if (hashes.includes(sha(seg.normalize("NFC").toLowerCase()))) return true;
    }
  }
  return false;
}

// The vault list: OBSIDIAN_VAULTS (colon-separated) if set, else the eight registered vaults.
export function targets(env, home) {
  const raw = env.OBSIDIAN_VAULTS;
  if (raw !== undefined) return raw.split(":").filter((s) => s !== "");
  const docs = join(home, "Documents");
  return DEFAULT_VAULTS.map((name) => (name === "" ? docs : join(docs, name)));
}

// Forbidden is checked first, always, whatever OBSIDIAN_VAULTS says.
// A path that is itself a symbolic link. Missing paths are not links.
const isLink = (p) => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

// Refuses any link in .obsidian, plugins or lazy-vault, and any destination whose real path is
// outside the vault's real path or inside a denied folder. Nothing is written when refused.
export function installInto(vault, srcDir, hashes = DENY_HASHES) {
  if (forbidden(vault, hashes)) return "forbidden";
  const obs = join(vault, ".obsidian");
  if (!existsSync(obs)) return "no-obsidian";
  const dest = join(obs, "plugins", "lazy-vault");
  if (isLink(obs) || isLink(join(obs, "plugins")) || isLink(dest)) return "unsafe";
  mkdirSync(dest, { recursive: true });
  const realVault = realpathSync(vault);
  const rel = relative(realVault, realpathSync(dest));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || forbidden(realpathSync(dest), hashes)) return "unsafe";
  for (const f of FILES) copyFileSync(join(srcDir, f), join(dest, f));
  return "installed";
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  if (!existsSync(join(here, "main.js"))) {
    console.error("main.js is missing: run `npm run build` first.");
    process.exitCode = 1;
    return;
  }
  for (const vault of targets(process.env, homedir())) {
    // One broken vault must not stop the others.
    try {
      const result = installInto(vault, here);
      console.log(`${result}\t${vault}`);
      if (result === "forbidden" || result === "unsafe") process.exitCode = 1;
    } catch (err) {
      console.error(`error\t${vault}\t${String(err)}`);
      process.exitCode = 1;
    }
  }
}

// realpath, so the check also holds when this file is run through a symlink.
const invokedDirectly = (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();
if (invokedDirectly) main();
