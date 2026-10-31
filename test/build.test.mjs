import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

const HOME_DIR = "/" + "Users" + "/";
const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

test("main.js is built and carries no personal path", () => {
  assert.equal(existsSync(new URL("../main.js", import.meta.url)), true);
  assert.equal(read("main.js").includes(HOME_DIR), false);
});

test("manifest is the lazy-vault desktop plugin at the package version", () => {
  const m = JSON.parse(read("manifest.json"));
  const pkg = JSON.parse(read("package.json"));
  assert.equal(m.id, "lazy-vault");
  assert.equal(m.isDesktopOnly, true);
  assert.equal(m.version, pkg.version);
});
