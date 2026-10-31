import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeFake, plainScan, diskFiles, tmpVault, nfc } from "./fake.mjs";
import { newState, installHooks, loadAll } from "../.testbuild/hooks.mjs";
import { indexSkipped } from "../.testbuild/walk.mjs";
import { DEFAULT_SETTINGS } from "../.testbuild/data.mjs";
import { isInside } from "../.testbuild/paths.mjs";

const TODAY = 20000;
const FOLDERS = ["Notes", "Proj", "Cold", "Archive v1.2", "노트".normalize("NFD"), "Sub", "Inner", "node_modules", "dist", "Ideas"];
const FILES = ["x", "old", "deep", "Home", "v1.2", "노트".normalize("NFD")].map((n) => n + ".md");

// Inline mulberry32, so every seed is reproducible.
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Builds a random tree of depth <= 4 on disk. Returns every entry and every folder.
function genTree(rnd, base) {
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const entries = [];
  const dirs = [];
  const gen = (dir, depth) => {
    const used = new Set();
    if (dir === "") {
      used.add("Home.md");
      writeFileSync(join(base, "Home.md"), "x");
      entries.push("Home.md");
    }
    const n = 1 + Math.floor(rnd() * 5);
    for (let i = 0; i < n; i++) {
      if (rnd() < 0.4 && depth < 4) {
        const name = pick(FOLDERS);
        if (used.has(name)) continue;
        used.add(name);
        const rel = dir === "" ? name : dir + "/" + name;
        mkdirSync(join(base, rel), { recursive: true });
        entries.push(rel);
        dirs.push(rel);
        const r = rnd();
        if (r < 0.15) writeFileSync(join(base, rel, ".git"), "gitdir: x\n");
        else if (r < 0.3) mkdirSync(join(base, rel, ".git"));
        if (rnd() < 0.2) mkdirSync(join(base, rel, ".obsidian"));
        gen(rel, depth + 1);
      } else {
        const name = pick(FILES);
        if (used.has(name)) continue;
        used.add(name);
        const rel = dir === "" ? name : dir + "/" + name;
        writeFileSync(join(base, rel), "x");
        entries.push(rel);
      }
    }
  };
  gen("", 0);
  return { entries, dirs };
}

const pickSome = (rnd, arr, max) => {
  const out = [];
  for (let i = 0; i < max && arr.length; i++) out.push(arr[Math.floor(rnd() * arr.length)]);
  return [...new Set(out.map(nfc))];
};

// Property test. The plugin never creates, deletes, moves or rewrites a vault file.
// Every on-disk file is loaded or inside exactly one skipped root, never both.
// A link click never creates a note while a same-named note exists on disk.
for (let seed = 1; seed <= 40; seed++) {
  test(`invariants hold on random tree, seed ${seed}`, async () => {
    const rnd = mulberry32(seed);
    const base = tmpVault();
    try {
      const { entries, dirs } = genTree(rnd, base);
      const fake = makeFake(base);

      const pins = pickSome(rnd, entries, 2);
      const openFiles = pickSome(rnd, entries.filter((e) => e.endsWith(".md")), 2);
      const protect = [...pins, ...openFiles];
      const skipList = pickSome(rnd, dirs, 2);
      const history = {
        vaultBase: base,
        firstSeenDay: TODAY - Math.floor(rnd() * 60),
        lastActive: {},
        startups: [],
      };
      for (const d of dirs) {
        if (rnd() < 0.5) history.lastActive[nfc(d)] = TODAY - Math.floor(rnd() * 60);
      }
      const settings = { ...DEFAULT_SETTINGS, pins, skipList };
      const s = newState(base, { settings, history, today: TODAY, startup: true, protect });
      s.changed = () => {};
      const { problems, restore } = installHooks(fake.targets, s, fake.deps);
      assert.deepEqual(problems, []);

      try {
        await fake.adapter.listAll();
        s.ctx.startup = false;
        s.indexing = indexSkipped(s);
        await s.indexing;

        // I1: every on-disk file is loaded or inside exactly one skipped root, never both.
        const disk = diskFiles(base);
        const loaded = new Set(
          Object.keys(fake.adapter.files).filter((k) => fake.adapter.files[k].type === "file"),
        );
        const roots = [...s.skipped.keys()];
        for (const k of loaded) assert.ok(disk.includes(k), `loaded ${k} is not on disk`);
        for (const f of disk) {
          const hits = roots.filter((r) => isInside(f, r)).length;
          assert.equal(Number(loaded.has(f)) + hits, 1, `${f}: loaded=${loaded.has(f)} roots=${hits}`);
        }

        // I2: no protect entry is inside a skipped root, and every root-level file is loaded.
        for (const p of protect) for (const r of roots) assert.equal(isInside(p, r), false, `${p} inside ${r}`);
        for (const f of disk) if (!f.includes("/")) assert.ok(loaded.has(f), `root file ${f} not loaded`);

        // I3: a link click on any on-disk note opens an existing note and creates nothing.
        // Build folders are not indexed (walkNames skips them), so a click into one creates a note by design.
        const buildNames = new Set(DEFAULT_SETTINGS.buildNames);
        const clickable = (f) => f.endsWith(".md") && !f.split("/").some((seg) => buildNames.has(seg));
        for (const md of disk.filter(clickable)) {
          const before = diskFiles(base);
          const count = fake.opened.length;
          const basename = md.split("/").pop().slice(0, -3);
          const leaf = Object.create(fake.leafProto);
          await leaf.openLinkText(basename, "Home.md", {});
          assert.deepEqual(diskFiles(base), before, `click on ${basename} changed disk`);
          assert.equal(fake.opened.length, count + 1, `click on ${basename} opened nothing`);
          const opened = fake.opened.at(-1);
          assert.ok(before.includes(opened), `${basename} opened ${opened}, which did not exist`);
          assert.equal(opened.split("/").pop().slice(0, -3), basename);
        }

        // I4: after loadAll, the scan matches a plain scan.
        await loadAll(fake.targets, s);
        assert.deepEqual(Object.keys(fake.adapter.files).sort(), await plainScan(base));
      } finally {
        restore();
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
}
