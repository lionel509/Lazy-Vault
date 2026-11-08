// Breaker round 1 for U4 (src/main.ts, src/view.ts, src/settings.ts).
// Bundles the real plugin with esbuild, aliasing "obsidian" to an in-memory stub,
// then drives it against the shared fake adapter from test/fake.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeFake, tmpVault, writeTree } from "./fake.mjs";

// main.ts uses window.setTimeout; Node's global timers stand in for it.
globalThis.window ??= globalThis;

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "lv-breaker-r1-u4-"));

const STUB = `
globalThis.__settingRegistry = globalThis.__settingRegistry || [];
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
export class TFolder {}
export class WorkspaceLeaf { async openLinkText(linktext, sourcePath, openState) {} }
const comp = (name) => ({
  value: "",
  setValue(v) { this.value = v; return this; },
  onChange(f) { globalThis.__settingRegistry.push({ name, f }); return this; },
});
export class Setting {
  constructor() { this.name = ""; }
  setName(n) { this.name = n; return this; }
  setDesc() { return this; }
  addToggle(fn) { fn(comp(this.name)); return this; }
  addText(fn) { fn(comp(this.name)); return this; }
  addTextArea(fn) { fn(comp(this.name)); return this; }
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

async function bundle(entry, outName) {
  const out = await build({
    entryPoints: [join(REPO, entry)],
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
    logLevel: "silent",
    plugins: [obsidianAlias],
  });
  const p = join(work, outName);
  writeFileSync(p, out.outputFiles[0].text);
  return pathToFileURL(p).href;
}

const { default: LazyVaultPlugin } = await import(await bundle("src/main.ts", "main.mjs"));
const { LazyVaultSettingTab } = await import(await bundle("src/settings.ts", "settings.mjs"));

// Boots the plugin the way Obsidian does: onload, then the layout-ready callback.
function boot(f) {
  process.env.LAZY_VAULT_HOME = mkdtempSync(join(work, "hist-"));
  f.adapter.__fsAdapter = true;
  const handlers = {};
  const app = {
    vault: {
      ...f.vault,
      adapter: f.adapter,
      configDir: ".obsidian",
      getFiles: () => [],
      getAllLoadedFiles: () => [],
      on: () => ({}),
      getAbstractFileByPath: (p) => f.vault.getAbstractFileByPath(p),
    },
    workspace: {
      layoutReady: false,
      cb: null,
      onLayoutReady(cb) { this.cb = cb; },
      on(ev, cb) { handlers[ev] = cb; return {}; },
      getLeavesOfType: () => [],
      getActiveFile: () => null,
      openLinkText: async () => {},
    },
    metadataCache: { getFirstLinkpathDest: () => null, getFileCache: () => null },
    fileManager: f.fileManager,
  };
  const plugin = new LazyVaultPlugin(app, { id: "lazy-vault", dir: ".obsidian/plugins/lazy-vault", version: "0.1.0" });
  plugin.onload();
  return { plugin, app, handlers };
}

async function layoutReady(app) {
  if (app.workspace.cb) await app.workspace.cb();
}

// BREAK 1: unload while a scan probe is still awaiting lstat.
// onunload restores the originals and loads what is skipped, but the in-flight
// scan wrapper then resumes, decides "repo", records it as skipped, and drops the
// folder from adapter.files. Nothing loads it again, so it stays hidden.
test("breaker: unload during an in-flight scan probe leaves a repo hidden after unload", async () => {
  const f = makeFake(tmpVault());
  writeTree(f.base, ["Repo/.git/", "Repo/note.md"]);
  const { plugin, app } = boot(f);
  await layoutReady(app);
  assert.equal(plugin.mode, "on", plugin.state.problems.join(" | "));
  const pending = f.adapter.listRecursiveChild("", "Repo");
  plugin.onunload();
  await pending;
  assert.ok(f.adapter.files["Repo/note.md"], "Repo/note.md should be visible once the plugin is unloaded");
});

// BREAK 2: clearing the "Cold after N days" text field. Number("") is 0, which passes
// the integer check, so the empty field saves coldDays=0 and cold skipping goes off.
test("breaker: clearing the Cold-after field does not save 0 and turn cold skipping off", async () => {
  globalThis.__settingRegistry = [];
  const plugin = {
    cfg: { enabled: true, coldDays: 30, buildNames: [], pins: [], skipList: [], allowWithSync: false },
    saveSettings: async function () { this.saves = (this.saves || 0) + 1; },
  };
  new LazyVaultSettingTab({}, plugin).display();
  const field = globalThis.__settingRegistry.find((r) => r.name.startsWith("Cold after"));
  assert.ok(field, "cold field registered");
  await field.f("");
  assert.equal(plugin.cfg.coldDays, 30, "empty input must not change coldDays");
});

// BREAK 3: the build-folder field says "Takes effect at next start", but decide()
// reads ctx.settings live, and that object is the same one the settings tab mutates.
// A folder reconciled mid-session with a newly typed name is hidden straight away.
test("breaker: a build-folder name typed mid-session does not hide a folder before the next start", async () => {
  const f = makeFake(tmpVault());
  writeTree(f.base, ["Fresh/a.md"]);
  const { plugin, app } = boot(f);
  await layoutReady(app);
  assert.equal(plugin.mode, "on", plugin.state.problems.join(" | "));
  plugin.cfg.buildNames = [...plugin.cfg.buildNames, "Fresh"];
  await f.adapter.listRecursiveChild("", "Fresh");
  assert.ok(f.adapter.files["Fresh/a.md"], "Fresh should stay visible until the next start");
});
