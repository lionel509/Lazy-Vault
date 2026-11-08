// Breaker round 2 against 88f8444: installer symlink and privacy-guard attacks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installInto } from "../install.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha = (s) => createHash("sha256").update(s).digest("hex");

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "lv-breaker-r2-"));
  const src = join(root, "src");
  mkdirSync(src);
  for (const f of ["main.js", "manifest.json", "styles.css"]) writeFileSync(join(src, f), `NEW-${f}\n`);
  return { root, src };
}

// A vault whose plugin folder already holds main.js as a symlink to `target`.
function vaultWithLinkedMain(root, target) {
  const vault = join(root, "Vault");
  const plugin = join(vault, ".obsidian", "plugins", "lazy-vault");
  mkdirSync(plugin, { recursive: true });
  symlinkSync(target, join(plugin, "main.js"));
  return vault;
}

// A file whose folder name is denied: the test passes its own hash, so no real name is needed.
test("installer refuses a plugin file that is a symlink into a denied folder", () => {
  const { root, src } = sandbox();
  const denied = join(root, "Denied");
  mkdirSync(denied);
  const victim = join(denied, "victim.js");
  writeFileSync(victim, "ORIGINAL\n");
  const vault = vaultWithLinkedMain(root, victim);
  const result = installInto(vault, src, [sha("denied")]);
  assert.equal(readFileSync(victim, "utf8"), "ORIGINAL\n", `installer returned ${result} and wrote through the link`);
  assert.equal(result, "unsafe");
});

test("installer refuses a plugin file that is a symlink to a file outside the vault", () => {
  const { root, src } = sandbox();
  const outside = join(root, "elsewhere", "notes.txt");
  mkdirSync(dirname(outside));
  writeFileSync(outside, "KEEP ME\n");
  const vault = vaultWithLinkedMain(root, outside);
  const result = installInto(vault, src);
  assert.equal(readFileSync(outside, "utf8"), "KEEP ME\n", `installer returned ${result} and overwrote a file outside the vault`);
  assert.equal(result, "unsafe");
});
