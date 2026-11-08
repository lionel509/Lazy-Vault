// Breaker round 2 against 88f8444: plugin-shell attacks on the round-2 fixes.
// Same esbuild stub harness as test/r2-main.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeFake, tmpVault, writeTree } from "./fake.mjs";

globalThis.window ??= globalThis;
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "lv-breaker-r2-plugin-"));

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
const out = await build({
  entryPoints: [join(REPO, "src/main.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  logLevel: "silent",
  plugins: [{ name: "obsidian-stub", setup(b) { b.onResolve({ filter: /^obsidian$/ }, () => ({ path: stubPath })); } }],
});
const mainFile = join(work, "main.mjs");
writeFileSync(mainFile, out.outputFiles[0].text);
const { default: LazyVaultPlugin } = await import(pathToFileURL(mainFile).href);

const historyName = (base) => createHash("sha256").update(base).digest("hex").slice(0, 16) + ".json";

function boot(f, { home, seed } = {}) {
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
      getAbstractFileByPath: (p) => {
        const e = f.vault.getAbstractFileByPath(p);
        return e ? Object.assign(new globalThis.__TFile(), e) : null;
      },
    },
    workspace: {
      layoutReady: false,
      cb: null,
      onLayoutReady(cb) { this.cb = cb; },
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

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

function startupRecord(at, layoutReadyMs, mode = "on") {
  return {
    at, mode, apiVersion: "stub", onloadMs: 400, layoutReadyMs,
    vaultFiles: 166, vaultEntries: 170, skippedFolders: 1, skipped: [], skippedFiles: 0, problems: [],
  };
}

function seedHistory(base, startups) {
  return (dir) => {
    const body = { vaultBase: base, firstSeenDay: 19000, lastActive: {}, startups };
    writeFileSync(join(dir, historyName(base)), JSON.stringify(body));
  };
}

// ---- Break: slow-start guard reads Obsidian's whole startup, not the skipping cost ----

test("BREAK F14: a 25 s layout with a 5 ms skip scan must not pause skipping", () => {
  const f = makeFake(tmpVault());
  writeTree(f.base, ["Home.md"]);
  const rec = startupRecord(Date.now() - 86400000, 25000);
  Object.assign(rec, { scanFirstMs: 100, scanLastMs: 105, probeCount: 3, probeTotalMs: 5, probeMaxMs: 3, probeMaxPath: "Home.md" });
  const { plugin } = boot(f, { seed: seedHistory(f.base, [rec]) });
  assert.equal(plugin.mode, "on", `paused although the probes took 5 ms: ${plugin.state.problems.join(" | ")}`);
});

// ---- Break: the pause is said to persist even if history is lost, but is only written later ----

test("BREAK F14: the pause is written to data.json when the slow start is detected", () => {
  const f = makeFake(tmpVault());
  writeTree(f.base, ["Home.md"]);
  const { plugin } = boot(f, { seed: seedHistory(f.base, [startupRecord(Date.now() - 86400000, 208000)]) });
  assert.equal(plugin.mode, "failopen");
  assert.equal(plugin.saved?.pausedAfterSlowStart, true, "pause not written to data.json (saved is " + JSON.stringify(plugin.saved) + ")");
});

// ---- Break: a deleted subfolder stays in the names index, so links still resolve to it ----

test("BREAK F4: a subfolder deleted mid-session leaves the names index", { timeout: 15000 }, async () => {
  const f = makeFake(tmpVault());
  writeTree(f.base, ["Repo/.git/HEAD", "Repo/Sub/a.md", "Repo/Sub/b.md", "Repo/Keep.md", "Home.md"]);
  const { plugin, app } = boot(f);
  await f.adapter.listAll();
  await layoutReady(app);
  await plugin.state.indexing;
  assert.equal(plugin.mode, "on", plugin.state.problems.join(" | "));
  assert.ok((plugin.state.index.get("Repo") ?? []).includes("Repo/Sub/a.md"), "precondition: indexed");
  rmSync(join(f.base, "Repo/Sub"), { recursive: true });
  await f.adapter.reconcileFile("Repo/Sub", "Repo/Sub");
  await tick();
  const left = (plugin.state.index.get("Repo") ?? []).filter((p) => p.startsWith("Repo/Sub/"));
  assert.deepEqual(left, [], `index still lists deleted notes: ${JSON.stringify(left)}`);
});

// ---- Break: a failed load leaves the children of a folder that is still skipped visible ----

test("BREAK F2: a failed folder load keeps its children out of the vault", { timeout: 15000 }, async () => {
  const f = makeFake(tmpVault());
  writeTree(f.base, ["Archive/.git/HEAD", "Archive/Note.md", "Home.md"]);
  const realRec = f.adapter.reconcileFile;
  f.adapter.reconcileFile = async function (e, t) {
    if (t === "Archive") {
      await this.reconcileFileInternal(e, "Archive");
      throw new Error("disk hiccup after listing");
    }
    return realRec.call(this, e, t);
  };
  const { plugin, app } = boot(f);
  await f.adapter.listAll();
  await layoutReady(app);
  await plugin.state.indexing;
  await plugin.loadFolderNow("Archive");
  assert.ok(plugin.state.skipped.has("Archive"), "precondition: Archive is back in skipped");
  assert.equal(f.adapter.files["Archive/Note.md"], undefined, "Note.md is listed although Archive is still skipped");
});

