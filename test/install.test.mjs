import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { forbidden, targets, installInto, DENY_HASHES } from "../install.mjs";
import { tmpVault, allFiles } from "./fake.mjs";

const hash = (s) => createHash("sha256").update(s).digest("hex");
// Made-up name only. The real denied name is never written in this repo.
const PRIVATE = [hash("private")];

test("forbidden matches a denied folder segment, case-insensitively", () => {
  assert.equal(forbidden("/x/Private", PRIVATE), true);
  assert.equal(forbidden("/x/private/", PRIVATE), true);
  assert.equal(forbidden("/x/Private/sub", PRIVATE), true);
  assert.equal(forbidden("/x/Privateer", PRIVATE), false);
});

test("DENY_HASHES holds exactly one sha256 hex digest", () => {
  assert.equal(DENY_HASHES.length, 1);
  assert.match(DENY_HASHES[0], /^[0-9a-f]{64}$/);
});

test("targets defaults to the eight registered vaults, in order, without the private one", () => {
  const docs = "/h/Documents";
  assert.deepEqual(targets({}, "/h"), [
    docs,
    `${docs}/Citadel`,
    `${docs}/BlackRock`,
    `${docs}/Berkshire`,
    `${docs}/State Street`,
    `${docs}/Goldman`,
    `${docs}/Fidelity`,
    `${docs}/Mirae`,
  ]);
});

test("targets honours OBSIDIAN_VAULTS and drops empty entries", () => {
  assert.deepEqual(targets({ OBSIDIAN_VAULTS: "/a::/b" }, "/h"), ["/a", "/b"]);
});

test("installInto adds exactly the three plugin files", () => {
  const vault = tmpVault();
  const src = tmpVault();
  mkdirSync(join(vault, ".obsidian"));
  for (const f of ["main.js", "manifest.json", "styles.css", "extra.txt"]) writeFileSync(join(src, f), "x");
  const before = allFiles(vault);
  assert.equal(installInto(vault, src), "installed");
  const added = allFiles(vault).filter((f) => !before.includes(f));
  assert.deepEqual(added, [
    ".obsidian/plugins/lazy-vault/main.js",
    ".obsidian/plugins/lazy-vault/manifest.json",
    ".obsidian/plugins/lazy-vault/styles.css",
  ]);
});

test("installInto without .obsidian reports no-obsidian and writes nothing", () => {
  const vault = tmpVault();
  const src = tmpVault();
  writeFileSync(join(src, "main.js"), "x");
  const before = allFiles(vault);
  assert.equal(installInto(vault, src), "no-obsidian");
  assert.deepEqual(allFiles(vault), before);
  assert.equal(existsSync(join(vault, ".obsidian")), false);
});

test("installInto on a denied vault reports forbidden and writes nothing", () => {
  // Third argument: the hash list to check against. Defaults to DENY_HASHES.
  const root = tmpVault();
  const vault = join(root, "Private");
  mkdirSync(join(vault, ".obsidian"), { recursive: true });
  const src = tmpVault();
  writeFileSync(join(src, "main.js"), "x");
  const before = allFiles(vault);
  assert.equal(installInto(vault, src, PRIVATE), "forbidden");
  assert.deepEqual(allFiles(vault), before);
});
