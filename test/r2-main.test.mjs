// Round-2 tests for the plugin shell (src/main.ts): the startup gates (F8), the duplicate
// problem lines (F10), the selftest that waited on itself (F13), the startup timing record
// and the slow-start guard (F14). Bundles the real plugin with esbuild and drives it against
// the shared fake adapter, the same way break-r1-u4 does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeFake, tmpVault, writeTree } from "./fake.mjs";

globalThis.window ??= globalThis;

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "lv-r2-main-"));

// Same stub as break-r1-u4, plus the leaf class on a global so a test can call the real hook.
const STUB = `
export const apiVersion = "stub";
export function parseLinktext(t) {
  const i = t.indexOf("#");
  return { path: i < 0 ? t : t.slice(0, i), subpath: i < 0 ? "" : t.slice(i) };
}
export class FileSystemAdapter {
  static [Symbol.hasInstance](x) { return !!(x && x.__fsAdapter); }
}
export class Plugin {
  constructor(app, manifest) { this.app = app; this.manifest = manifest; }
  registerView() {} addRibbonIcon() {} addCommand() {} addSettingTab() {} registerEvent() {}
  async saveData(d) { this.saved = JSON.parse(JSON.stringify(d)); }
  async loadData() { return undefined; }
}
export class ItemView {}
export class FuzzySuggestModal {}
export class PluginSettingTab {
  constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = { empty() {} }; }
}
export class Menu {}
export class Notice {}
export class TAbstractFile {}
export class TFile {}
globalThis.__TFile = TFile;
export class TFolder {}
export class WorkspaceLeaf { async openLinkText(linktext, sourcePath, openState) {} }
globalThis.__WorkspaceLeaf = WorkspaceLeaf;
export class Setting {
  setName() { return this; } setDesc() { return this; }
  addToggle() { return this; } addText() { return this; } addTextArea() { return this; }
}
`;
const stubPath = join(work, "obsidian-stub.mjs");
writeFileSync(stubPath, STUB);

const obsidianAlias = {
  name: "obsidian-stub",
  setup(b) {
    b.onResolve({ filter: /^obsidian$/ }, () => ({ path: stubPath }));
  },
};

const out = await build({
  entryPoints: [join(REPO, "src/main.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  logLevel: "silent",
  plugins: [obsidianAlias],
});
const mainFile = join(work, "main.mjs");
writeFileSync(mainFile, out.outputFiles[0].text);
const { default: LazyVaultPlugin } = await import(pathToFileURL(mainFile).href);

const SLOW_START_MS = 20000;
const historyName = (base) => createHash("sha256").update(base).digest("hex").slice(0, 16) + ".json";

// Boots the plugin the way Obsidian does: onload now, the layout-ready callback later.
function boot(f, { home, seed, layoutReady = false } = {}) {
  const dir = home ?? mkdtempSync(join(work, "hist-"));
  process.env.LAZY_VAULT_HOME = dir;
  if (seed) seed(dir);
  f.adapter.__fsAdapter = true;
  const leaf = Object.create(globalThis.__WorkspaceLeaf.prototype);
  const nav = { active: null, opened: [] };
  leaf.openFile = async (file) => {
    nav.active = file.path;
    nav.opened.push(file.path);
  };
  const app = {
    vault: {
      ...f.vault,
      adapter: f.adapter,
      configDir: ".obsidian",
      getFiles: () => [],
      getAllLoadedFiles: () => [],
      on: () => ({}),
      // The plugin checks instanceof TFile, so a file comes back as a TFile, as in Obsidian.
      getAbstractFileByPath: (p) => {
        const e = f.vault.getAbstractFileByPath(p);
        return e ? Object.assign(new globalThis.__TFile(), e) : null;
      },
    },
    workspace: {
      layoutReady,
      cb: null,
      onLayoutReady(cb) {
        this.cb = cb;
      },
      on: () => ({}),
      getLeavesOfType: () => [],
      getActiveFile: () => (nav.active ? { path: nav.active } : null),
      openLinkText: (lt, src, st) => leaf.openLinkText(lt, src, st),
    },
    metadataCache: { getFirstLinkpathDest: () => null, getFileCache: () => null },
    fileManager: f.fileManager,
  };
  const plugin = new LazyVaultPlugin(app, { id: "lazy-vault", dir: ".obsidian/plugins/lazy-vault", version: "0.1.0" });
  plugin.onload();
  return { plugin, app, nav, home: dir };
}

async function layoutReady(app) {
  if (app.workspace.cb) await app.workspace.cb();
}

async function waitFor(check, ms = 3000) {
  const t0 = Date.now();
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() - t0 > ms) return undefined;
    await new Promise((r) => setTimeout(r, 10));
  }
}

// Busy-waits, so the time shows up inside a synchronous stub call.
function spin(ms) {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    // spin
  }
}

// Startup records written to the history file for this vault, in the shape afterLayout writes.
function startupRecord(at, layoutReadyMs, mode = "on") {
  return {
    at,
    mode,
    apiVersion: "stub",
    onloadMs: 400,
    layoutReadyMs,
    vaultFiles: 166,
    vaultEntries: 170,
    skippedFolders: 67,
    skipped: [],
    skippedFiles: 0,
    problems: [],
  };
}

function seedHistory(base, startups) {
  return (dir) => {
    const body = { vaultBase: base, firstSeenDay: 19000, lastActive: {}, startups };
    writeFileSync(join(dir, historyName(base)), JSON.stringify(body));
  };
}

// ---- F8: the startup gates are pinned by tests ----

test("F8: Sync on and allowWithSync off fails open, and nothing is wrapped", () => {
  const f = makeFake(tmpVault());
  writeTree(f.base, [".obsidian/core-plugins.json", "Home.md"]);
  writeFileSync(join(f.base, ".obsidian", "core-plugins.json"), JSON.stringify({ sync: true }));
  const before = f.adapter.listRecursiveChild;
  const { plugin } = boot(f);
  assert.equal(plugin.mode, "failopen");
  assert.ok(plugin.state.problems.some((p) => p.includes("Obsidian Sync is on")), plugin.state.problems.join(" | "));
  assert.equal(f.adapter.listRecursiveChild, before, "scan hook was wrapped under Sync");
});

test("F8: enabled mid-session (layout already ready) is late, and nothing is wrapped", () => {
  const f = makeFake(tmpVault());
  writeTree(f.base, ["Home.md"]);
  const before = f.adapter.listRecursiveChild;
  const { plugin } = boot(f, { layoutReady: true });
  assert.equal(plugin.mode, "late");
  assert.equal(f.adapter.listRecursiveChild, before, "scan hook was wrapped mid-session");
});

test("F8: an invalid data.json is copied aside and the defaults are used", () => {
  const f = makeFake(tmpVault());
  writeTree(f.base, [".obsidian/plugins/lazy-vault/", "Home.md"]);
  const dataFile = join(f.base, ".obsidian", "plugins", "lazy-vault", "data.json");
  writeFileSync(dataFile, "{ not json");
  const { plugin } = boot(f);
  const copies = readdirSync(dirname(dataFile)).filter((n) => /^data\.json\.corrupt-\d+$/.test(n));
  assert.equal(copies.length, 1, `copies: ${JSON.stringify(readdirSync(dirname(dataFile)))}`);
  assert.equal(plugin.cfg.coldDays, 30);
  assert.ok(plugin.state.errors.some((e) => e.includes("not valid JSON")), plugin.state.errors.join(" | "));
});

// ---- F10: each hook problem is listed once ----

test("F10: a hook with the wrong arity is listed once in the view, not twice", () => {
  const f = makeFake(tmpVault());
  writeTree(f.base, ["Home.md"]);
  f.vault.createFolder = function () {};
  const { plugin } = boot(f);
  assert.equal(plugin.mode, "failopen");
  const hits = plugin.state.problems.filter((p) => p.includes("createFolder"));
  assert.equal(hits.length, 1, `problems: ${JSON.stringify(plugin.state.problems)}`);
});

// ---- F13: the selftest runs after indexing, not inside it ----

test("F13: the selftest opens a skipped note after indexing and does not wait on itself", { timeout: 15000 }, async () => {
  const f = makeFake(tmpVault());
  writeTree(f.base, ["Archive/.git/HEAD", "Archive/Archive.md", "Home.md"]);
  process.env.LAZY_VAULT_SELFTEST_LINK = "Archive|Home.md";
  try {
    const { plugin, app } = boot(f);
    await f.adapter.listAll();
    await layoutReady(app);
    assert.equal(plugin.mode, "on", plugin.state.problems.join(" | "));
    const rec = await waitFor(() => plugin.record?.selftest);
    assert.ok(rec, `selftest never recorded; errors: ${JSON.stringify(plugin.state.errors)}`);
    assert.equal(rec.opened, "Archive/Archive.md");
  } finally {
    delete process.env.LAZY_VAULT_SELFTEST_LINK;
  }
});

// ---- F14: startup timing fields, and the slow-start guard ----

test("F14: the startup record carries scan timing, and a slow probe shows in probeMaxMs", () => {
  const f = makeFake(tmpVault());
  writeTree(f.base, ["Slow/a.md", "Fast/b.md", "Home.md"]);
  const realFull = f.adapter.getFullRealPath;
  f.adapter.getFullRealPath = (p) => {
    if (p === "Slow") spin(50);
    return realFull(p);
  };
  const { plugin, app } = boot(f);
  return f.adapter.listAll().then(async () => {
    await layoutReady(app);
    const rec = plugin.record;
    assert.ok(rec.probeMaxMs >= 50, `probeMaxMs ${rec.probeMaxMs}`);
    assert.equal(rec.probeMaxPath, "Slow");
    assert.equal(rec.probeCount, plugin.state.scanCalls);
    assert.ok(rec.scanFirstMs !== null && rec.scanLastMs >= rec.scanFirstMs, "scan first and last times");
  });
});

test("F14: a previous start with skipping over 20 s pauses skipping for this start", () => {
  const f = makeFake(tmpVault());
  writeTree(f.base, ["Home.md"]);
  const ref = f.adapter.listRecursiveChild;
  const { plugin } = boot(f, {
    seed: seedHistory(f.base, [startupRecord(Date.now() - 86400000, 208000)]),
  });
  assert.equal(plugin.mode, "failopen");
  assert.equal(f.adapter.listRecursiveChild, ref, "scan hook was wrapped after a slow start");
  assert.ok(plugin.state.problems.some((p) => p.includes("skipping paused")), plugin.state.problems.join(" | "));
  assert.equal(plugin.cfg.pausedAfterSlowStart, true);
});

test("F14: a previous start with skipping under 20 s does not pause skipping", () => {
  const f = makeFake(tmpVault());
  writeTree(f.base, ["Home.md"]);
  const { plugin } = boot(f, {
    seed: seedHistory(f.base, [startupRecord(Date.now() - 86400000, 500)]),
  });
  assert.equal(plugin.mode, "on", plugin.state.problems.join(" | "));
});

test("F14: resuming skipping clears the pause, and the next start is on", async () => {
  const f = makeFake(tmpVault());
  writeTree(f.base, ["Home.md"]);
  const home = mkdtempSync(join(work, "hist-resume-"));
  const first = boot(f, { home, seed: seedHistory(f.base, [startupRecord(Date.now() - 86400000, 208000)]) });
  assert.equal(first.plugin.mode, "failopen");
  await first.plugin.resumeSkipping();
  assert.equal(first.plugin.cfg.pausedAfterSlowStart, false);
  const g = makeFake(f.base);
  const second = boot(g, { home });
  assert.equal(second.plugin.mode, "on", second.plugin.state.problems.join(" | "));
});
