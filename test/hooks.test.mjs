import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeFake, plainScan, diskFiles, writeTree, tmpVault } from "./fake.mjs";
import { HOOKS, newState, checkHooks, installHooks, loadFolder, loadFor, loadAll } from "../.testbuild/hooks.mjs";
import { indexSkipped } from "../.testbuild/walk.mjs";
import { DEFAULT_SETTINGS } from "../.testbuild/data.mjs";

const TODAY = 20000;
const TREE = [
  "Home.md",
  "Notes/x.md",
  "Proj/.git/HEAD",
  "Proj/a.md",
  "Proj2/.git/HEAD",
  "Proj2/open.md",
  "node_modules/m.js",
  "Sub/.git/HEAD",
  "Sub/.obsidian/app.json",
  "Sub/s.md",
  "Cold/old.md",
  "Cold/Inner/.git/HEAD",
  "Cold/Inner/deep.md",
];

// Cold is 40 days untouched; everything else was touched today.
const history = (base) => ({
  vaultBase: base,
  firstSeenDay: TODAY - 60,
  lastActive: { Notes: TODAY, Proj: TODAY, Proj2: TODAY, Sub: TODAY, node_modules: TODAY, Cold: TODAY - 40 },
  startups: [],
});

const ctxFor = (base, over = {}) => ({
  settings: { ...DEFAULT_SETTINGS },
  history: history(base),
  today: TODAY,
  startup: true,
  protect: ["Proj2/open.md"],
  ...over,
});

async function setup() {
  const base = tmpVault();
  writeTree(base, TREE);
  const fake = makeFake(base);
  const s = newState(base, ctxFor(base));
  s.changed = () => {};
  const { problems, restore } = installHooks(fake.targets, s, fake.deps);
  assert.deepEqual(problems, []);
  await fake.adapter.listAll();
  s.ctx.startup = false;
  s.indexing = indexSkipped(s);
  await s.indexing;
  return { base, fake, s, restore };
}

const withTimeout = (p, ms) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timed out")), ms))]);

test("checkHooks is empty on a healthy adapter", () => {
  const f = makeFake(tmpVault());
  assert.deepEqual(checkHooks(f.targets), []);
});

for (const [target, method, arity] of HOOKS) {
  test(`fail-open when ${target}.${method} is missing: nothing wrapped, nothing skipped`, async () => {
    const base = tmpVault();
    writeTree(base, TREE);
    const f = makeFake(base);
    delete f.targets[target][method];
    assert.ok(checkHooks(f.targets).some((p) => p.includes(method)));
    const s = newState(base, ctxFor(base));
    const before = HOOKS.map(([t, m]) => f.targets[t][m]);
    const { problems } = installHooks(f.targets, s, f.deps);
    assert.ok(problems.some((p) => p.includes(method)));
    assert.equal(s.active, false);
    HOOKS.forEach(([t, m], i) => assert.ok(f.targets[t][m] === before[i], `${t}.${m} was wrapped`));
    // listRecursiveChild is the scan itself, so without it no scan can run at all.
    if (method !== "listRecursiveChild") {
      await f.adapter.listAll();
      assert.deepEqual(Object.keys(f.adapter.files).sort(), await plainScan(base));
      assert.equal(s.skipped.size, 0);
    }
  });

  test(`fail-open when ${target}.${method} has the wrong arity`, async () => {
    const base = tmpVault();
    writeTree(base, TREE);
    const f = makeFake(base);
    const obj = f.targets[target];
    const orig = obj[method];
    const wrong = function (...a) {
      return orig.apply(this, a);
    };
    Object.defineProperty(wrong, "length", { value: arity + 1 });
    obj[method] = wrong;
    assert.ok(checkHooks(f.targets).some((p) => p.includes(method)));
    const s = newState(base, ctxFor(base));
    const before = HOOKS.map(([t, m]) => f.targets[t][m]);
    const { problems } = installHooks(f.targets, s, f.deps);
    assert.ok(problems.some((p) => p.includes(method)));
    HOOKS.forEach(([t, m], i) => assert.ok(f.targets[t][m] === before[i], `${t}.${m} was wrapped`));
    assert.equal(s.skipped.size, 0);
  });
}

test("the scan skips repos, build output and cold folders, and loads the rest", async () => {
  const { fake, s } = await setup();
  assert.deepEqual([...s.skipped.entries()].sort(), [
    ["Cold", "cold"],
    ["Proj", "repo"],
    ["node_modules", "build"],
  ]);
  for (const p of ["Home.md", "Notes/x.md", "Proj2/open.md", "Sub/s.md"]) {
    assert.ok(fake.adapter.files[p], `${p} should be loaded`);
  }
  assert.equal(fake.adapter.files["Proj/a.md"], undefined);
  assert.equal(fake.adapter.files["Cold/old.md"], undefined);
});

test("a watcher event inside a skipped repo is dropped", async () => {
  const { base, fake, s } = await setup();
  writeFileSync(join(base, "Proj/new.md"), "x");
  await fake.adapter.reconcileFile("Proj/new.md", "Proj/new.md");
  assert.equal(s.skipped.get("Proj"), "repo");
  assert.equal(fake.adapter.files["Proj/new.md"], undefined);
});

test("a watcher event for the skip root itself is dropped", async () => {
  const { fake, s } = await setup();
  await fake.adapter.reconcileFile("Proj", "Proj");
  assert.equal(fake.adapter.files["Proj"], undefined);
  assert.equal(s.skipped.get("Proj"), "repo");
});

test("a build storm inside node_modules never loads it", async () => {
  const { base, fake, s } = await setup();
  for (let i = 0; i < 50; i++) {
    writeFileSync(join(base, `node_modules/f${i}.js`), "x");
    await fake.adapter.reconcileFile(`node_modules/f${i}.js`, `node_modules/f${i}.js`);
  }
  assert.equal(s.skipped.get("node_modules"), "build");
  assert.equal(Object.keys(fake.adapter.files).filter((k) => k.startsWith("node_modules/")).length, 0);
});

test("vault.create in a cold folder loads it, and the nested repo stays skipped", async () => {
  const { base, fake, s } = await setup();
  await fake.vault.create("Cold/new.md", "hi");
  assert.ok(fake.adapter.files["Cold/old.md"]);
  assert.ok(fake.adapter.files["Cold/new.md"]);
  assert.ok(s.loaded.has("Cold"));
  assert.equal(s.skipped.get("Cold/Inner"), "repo");
  assert.equal(readFileSync(join(base, "Cold/new.md"), "utf8"), "hi");
});

test("vault.create on an existing skipped note throws and never overwrites", async () => {
  const { base, fake } = await setup();
  const before = readFileSync(join(base, "Cold/old.md"), "utf8");
  await assert.rejects(fake.vault.create("Cold/old.md", "zz"), /File already exists/);
  assert.equal(readFileSync(join(base, "Cold/old.md"), "utf8"), before);
});

test("adapter.write into a skipped folder loads it without deadlocking", async () => {
  const { fake } = await setup();
  await withTimeout(fake.adapter.write("Cold/w.md", "x"), 2000);
  assert.ok(fake.adapter.files["Cold/w.md"]);
  assert.ok(fake.adapter.files["Cold/old.md"]);
});

test("adapter.rename into a skipped repo loads the repo first", async () => {
  const { fake, s } = await setup();
  await fake.adapter.rename("Notes/x.md", "Proj/x.md");
  assert.ok(s.loaded.has("Proj"));
  assert.ok(fake.adapter.files["Proj/x.md"]);
});

test("fileManager.renameFile of a note loads cold folders but not repos", async () => {
  const { fake, s } = await setup();
  await fake.fileManager.renameFile({ path: "Notes/x.md" }, "Notes/y.md");
  assert.ok(s.loaded.has("Cold"));
  assert.equal(s.skipped.get("Proj"), "repo");
});

test("a link click opens the skipped note and creates nothing on disk", async () => {
  const { base, fake } = await setup();
  const leaf = Object.create(fake.leafProto);
  await leaf.openLinkText("old", "Home.md", {});
  assert.deepEqual(fake.opened, ["Cold/old.md"]);
  assert.equal(existsSync(join(base, "old.md")), false);
  assert.deepEqual(diskFiles(base).filter((p) => p.endsWith("old.md")), ["Cold/old.md"]);
});

test("a link click to a note in a nested repo inside a cold folder loads both", async () => {
  const { fake, s } = await setup();
  const leaf = Object.create(fake.leafProto);
  await leaf.openLinkText("deep", "Home.md", {});
  assert.deepEqual(fake.opened, ["Cold/Inner/deep.md"]);
  assert.ok(s.loaded.has("Cold"));
  assert.ok(s.loaded.has("Cold/Inner"));
});

test("a link click to a name that exists nowhere creates it (pass-through)", async () => {
  const { base, fake } = await setup();
  const leaf = Object.create(fake.leafProto);
  await leaf.openLinkText("nothere", "Home.md", {});
  assert.deepEqual(fake.opened, ["nothere.md"]);
  assert.equal(existsSync(join(base, "nothere.md")), true);
});

test("a link click waits for an index that is still pending", async () => {
  const { fake, s } = await setup();
  s.index.clear();
  s.indexing = indexSkipped(s);
  const leaf = Object.create(fake.leafProto);
  await leaf.openLinkText("old", "Home.md", {});
  assert.deepEqual(fake.opened, ["Cold/old.md"]);
});

test("a throwing probe falls through to the original scan and logs an error", async () => {
  const base = tmpVault();
  writeTree(base, TREE);
  const f = makeFake(base);
  f.adapter.getFullRealPath = (p) => {
    throw new Error("boom " + p);
  };
  const s = newState(base, ctxFor(base));
  s.changed = () => {};
  const { problems } = installHooks(f.targets, s, f.deps);
  assert.deepEqual(problems, []);
  await f.adapter.listAll();
  assert.ok(s.errors.length > 0);
  assert.equal(s.skipped.size, 0);
  assert.deepEqual(Object.keys(f.adapter.files).sort(), await plainScan(base));
});

test("loadFolder and loadFor load a skipped folder through the public helpers", async () => {
  const { fake, s } = await setup();
  await loadFolder(fake.targets, s, "Cold");
  assert.ok(fake.adapter.files["Cold/old.md"]);
  await loadFor(fake.targets, s, "Proj/a.md");
  assert.ok(fake.adapter.files["Proj/a.md"]);
});

test("restore() puts every original back", async () => {
  const base = tmpVault();
  writeTree(base, TREE);
  const f = makeFake(base);
  const originals = HOOKS.map(([t, m]) => f.targets[t][m]);
  const s = newState(base, ctxFor(base));
  s.changed = () => {};
  const { restore } = installHooks(f.targets, s, f.deps);
  assert.ok(HOOKS.some(([t, m], i) => f.targets[t][m] !== originals[i]));
  restore();
  HOOKS.forEach(([t, m], i) => assert.ok(f.targets[t][m] === originals[i], `${t}.${m} not restored`));
});

test("loadAll loads every skipped folder, and the result matches a plain scan", async () => {
  const { fake, s } = await setup();
  await loadAll(fake.targets, s);
  assert.equal(s.skipped.size, 0);
  assert.deepEqual(Object.keys(fake.adapter.files).sort(), await plainScan(fake.base));
});
