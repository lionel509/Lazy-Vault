// Breaker round 1 against unit U3 (src/hooks.ts, src/walk.ts). Each test is an attack.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeFake, writeTree, tmpVault } from "./fake.mjs";
import { newState, installHooks } from "../.testbuild/hooks.mjs";
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

const ctxFor = (base) => ({
  settings: { ...DEFAULT_SETTINGS },
  history: {
    vaultBase: base,
    firstSeenDay: TODAY - 60,
    lastActive: { Notes: TODAY, Proj: TODAY, Proj2: TODAY, Sub: TODAY, node_modules: TODAY, Cold: TODAY - 40 },
    startups: [],
  },
  today: TODAY,
  startup: true,
  protect: ["Proj2/open.md"],
});

async function setup({ before, extra = [] } = {}) {
  const base = tmpVault();
  writeTree(base, [...TREE, ...extra]);
  const fake = makeFake(base);
  if (before) before(fake);
  const s = newState(base, ctxFor(base));
  s.changed = () => {};
  const { problems } = installHooks(fake.targets, s, fake.deps);
  assert.deepEqual(problems, []);
  await fake.adapter.listAll();
  s.ctx.startup = false;
  s.indexing = indexSkipped(s);
  await s.indexing;
  // Obsidian's create-on-click leaf: inherits the (possibly wrapped) prototype methods.
  const leaf = Object.create(fake.leafProto);
  return { base, fake, s, leaf };
}

// BREAK 1: a transient load failure marks the folder loaded without loading it.
// The next click finds nothing in the index and creates a root note, a fork.
test("BREAK 1: after a failed load, the next link click forks a root note instead of opening Cold/old.md", async () => {
  let fail = true;
  const { base, fake, leaf } = await setup({
    before: (f) => {
      const orig = f.adapter.reconcileFile;
      f.adapter.reconcileFile = function (e, t) {
        if (t === "Cold" && fail) {
          fail = false;
          return Promise.reject(new Error("EACCES: transient"));
        }
        return orig.call(this, e, t);
      };
    },
  });
  await leaf.openLinkText("old", "Home.md");
  await leaf.openLinkText("old", "Home.md");
  assert.equal(existsSync(join(base, "old.md")), false, "a root old.md was created: fork");
  assert.ok(fake.opened.includes("Cold/old.md"), `opened: ${JSON.stringify(fake.opened)}`);
});

// BREAK 2: write guard compares the raw path case-sensitively, so a case variant of a
// skipped folder is written without loading it. On a case-insensitive disk (macOS
// default) that writes into the skipped folder while the plugin still hides it.
test("BREAK 2: vault.create on a case variant (cold/new.md) does not load the skipped Cold folder", async () => {
  const { fake } = await setup();
  await fake.vault.create("cold/new.md", "x");
  assert.ok(fake.adapter.files["Cold/old.md"], "Cold should have been loaded before the write");
});

// BREAK 3: a file dropped into a skipped folder after startup is dropped by the
// watcher and is missing from the startup index, so a link click creates a fork.
test("BREAK 3: a note added to a skipped repo mid-session is forked by a link click", async () => {
  const { base, fake, leaf } = await setup();
  writeFileSync(join(base, "Proj/late.md"), "x");
  await fake.adapter.reconcileFile("Proj/late.md", "Proj/late.md");
  await leaf.openLinkText("late", "Home.md");
  assert.equal(existsSync(join(base, "late.md")), false, "a root late.md was created: fork");
  assert.ok(fake.opened.includes("Proj/late.md"), `opened: ${JSON.stringify(fake.opened)}`);
});

// BREAK 4: walkNames skips build-named folders, so a note under Cold/build/ is never
// indexed. A link click to it creates a root note with the same basename.
test("BREAK 4: a link to a note inside a build-named folder under a skipped root forks a root note", async () => {
  const { base, leaf, fake } = await setup({ extra: ["Cold/build/Uniq.md"] });
  await leaf.openLinkText("Uniq", "Home.md");
  assert.equal(existsSync(join(base, "Uniq.md")), false, "a root Uniq.md was created: fork");
  assert.ok(fake.opened.includes("Cold/build/Uniq.md"), `opened: ${JSON.stringify(fake.opened)}`);
});

// BREAK 5: two clicks on the same skipped note at once. The second one sees the folder
// already marked loaded, returns before the reconcile finishes, and forks a root note.
test("BREAK 5: two concurrent link clicks on Cold/old.md: the second forks a root note", async () => {
  const { base, fake, leaf } = await setup({
    before: (f) => {
      const orig = f.adapter.reconcileFile;
      f.adapter.reconcileFile = async function (e, t) {
        await new Promise((r) => setTimeout(r, 30));
        return orig.call(this, e, t);
      };
    },
  });
  await Promise.all([leaf.openLinkText("old", "Home.md"), leaf.openLinkText("old", "Home.md")]);
  assert.equal(existsSync(join(base, "old.md")), false, "a root old.md was created: fork");
  assert.ok(fake.adapter.files["Cold/old.md"], "Cold/old.md should be loaded");
});

// BREAK 6: installHooks is supposed to fail open, but an assignment that throws
// (a getter-only property, as a future Obsidian might ship) escapes as an exception,
// and the adapter methods wrapped before it stay wrapped.
test("BREAK 6: a getter-only hooked method makes installHooks throw instead of failing open", () => {
  const base = tmpVault();
  writeTree(base, TREE);
  const f = makeFake(base);
  const fn = f.vault.createFolder;
  Object.defineProperty(f.vault, "createFolder", { get: () => fn, configurable: true });
  const scanBefore = f.adapter.listRecursiveChild;
  const s = newState(base, ctxFor(base));
  let out;
  try {
    out = installHooks(f.targets, s, f.deps);
  } catch (err) {
    assert.fail(`installHooks threw: ${err.message}`);
  }
  assert.equal(s.active, false);
  assert.ok(f.adapter.listRecursiveChild === scanBefore, "scan hook left wrapped after a failed install");
  assert.ok(out.problems.length > 0, "a failed install should report why");
});

// BREAK 7: the plan says new folders go through the scan wrapper. The folder root itself
// is never decided, only its children, so a repo that appears mid-session loads in full.
test("BREAK 7: a repo folder created mid-session is skipped (its files are not loaded)", async () => {
  const { base, fake, s } = await setup();
  writeTree(base, ["NewRepo/.git/HEAD", "NewRepo/a.md", "NewRepo/src/b.md"]);
  await fake.adapter.reconcileFile("NewRepo", "NewRepo");
  assert.equal(fake.adapter.files["NewRepo/a.md"], undefined, "NewRepo/a.md was loaded");
  assert.equal(s.skipped.get("NewRepo"), "repo");
});
