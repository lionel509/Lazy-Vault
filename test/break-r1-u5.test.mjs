// Breaker round 1, unit U5 (install.mjs, demo/snapshot.mjs). Every test here is meant to FAIL on head 24a5a44.
// Only made-up names are used. The denied name is never written in this file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readdirSync, copyFileSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { forbidden, targets, installInto } from "../install.mjs";
import { snapshot } from "../demo/snapshot.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const hash = (s) => createHash("sha256").update(s).digest("hex");
const mk = () => mkdtempSync(join(tmpdir(), "brk-u5-"));
const listAll = (dir) => {
  const out = [];
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out;
};
const srcDir = () => {
  const s = mk();
  for (const f of ["main.js", "manifest.json", "styles.css"]) writeFileSync(join(s, f), "x");
  return s;
};

// 1. A denied name in NFD form (e.g. copied from macOS Finder or a path with decomposed accents)
//    hashes differently from NFC, so the lexical check misses it. Made-up name "Café".
test("NFD spelling of a denied folder name is still forbidden", () => {
  const nfc = "café";
  const nfd = "café";
  assert.equal(forbidden(`/x/${nfd}/Vault`, [hash(nfc)]), true);
});

// 2. vault/.obsidian is a symlink into a denied folder. forbidden() only checks the vault path
//    and its realpath, not the .obsidian or plugin destination, so the copy lands in the denied folder.
test("a .obsidian symlink into a denied folder writes nothing there", () => {
  const root = mk();
  const vault = join(root, "Vault");
  const denied = join(root, "Secret");
  mkdirSync(vault);
  mkdirSync(denied);
  symlinkSync(denied, join(vault, ".obsidian"));
  const r = installInto(vault, srcDir(), [hash("secret")]);
  assert.notEqual(r, "installed");
  assert.deepEqual(listAll(denied), []);
});

// 3. The plugin folder itself is a symlink into a denied folder. Only the vault path is checked.
test("a lazy-vault symlink pointing into a denied folder writes nothing there", () => {
  const root = mk();
  const vault = join(root, "Vault");
  const denied = join(root, "Secret");
  mkdirSync(join(vault, ".obsidian", "plugins"), { recursive: true });
  mkdirSync(denied);
  symlinkSync(denied, join(vault, ".obsidian", "plugins", "lazy-vault"));
  installInto(vault, srcDir(), [hash("secret")]);
  assert.deepEqual(listAll(denied), []);
});

// 4. The plugin folder is a symlink to an ordinary folder outside every vault. The spec says
//    nothing may be written outside the listed vaults' .obsidian/plugins/lazy-vault/.
test("a lazy-vault symlink pointing outside the vault writes nothing outside", () => {
  const root = mk();
  const vault = join(root, "Vault");
  const elsewhere = join(root, "Elsewhere");
  mkdirSync(join(vault, ".obsidian", "plugins"), { recursive: true });
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, join(vault, ".obsidian", "plugins", "lazy-vault"));
  installInto(vault, srcDir());
  assert.deepEqual(listAll(elsewhere), []);
});

// 5. Run as a symlink (e.g. ~/bin/lazy-install -> repo/install.mjs). import.meta.url is the real path,
//    argv[1] is the link, so main() never runs: exit 0, nothing installed, no message.
test("install.mjs invoked through a symlink still installs", () => {
  const repoCopy = mk();
  copyFileSync(join(REPO, "install.mjs"), join(repoCopy, "install.mjs"));
  for (const f of ["main.js", "manifest.json", "styles.css"]) writeFileSync(join(repoCopy, f), "x");
  const binDir = mk();
  const link = join(binDir, "lazy-install.mjs");
  symlinkSync(join(repoCopy, "install.mjs"), link);
  const home = mk();
  const vault = join(mk(), "Vault");
  mkdirSync(join(vault, ".obsidian"), { recursive: true });
  const r = spawnSync(process.execPath, [link], {
    env: { PATH: process.env.PATH, HOME: home, OBSIDIAN_VAULTS: vault },
    timeout: 30000,
    encoding: "utf8",
  });
  assert.equal(existsSync(join(vault, ".obsidian", "plugins", "lazy-vault", "main.js")), true, `stdout=${r.stdout} stderr=${r.stderr}`);
});

// 6. One vault whose .obsidian is a plain file makes mkdirSync throw; main() has no try/catch,
//    so every vault after it in OBSIDIAN_VAULTS is silently never installed.
test("a broken vault does not stop the other vaults from installing", () => {
  const repoCopy = mk();
  copyFileSync(join(REPO, "install.mjs"), join(repoCopy, "install.mjs"));
  for (const f of ["main.js", "manifest.json", "styles.css"]) writeFileSync(join(repoCopy, f), "x");
  const parent = mk();
  const bad = join(parent, "Bad");
  const good = join(parent, "Good");
  mkdirSync(bad);
  writeFileSync(join(bad, ".obsidian"), "not a folder");
  mkdirSync(join(good, ".obsidian"), { recursive: true });
  const r = spawnSync(process.execPath, [join(repoCopy, "install.mjs")], {
    env: { PATH: process.env.PATH, HOME: mk(), OBSIDIAN_VAULTS: `${bad}:${good}` },
    timeout: 30000,
    encoding: "utf8",
  });
  assert.equal(existsSync(join(good, ".obsidian", "plugins", "lazy-vault", "main.js")), true, `stderr=${r.stderr}`);
});

