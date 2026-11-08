import {
  FileSystemAdapter,
  Menu,
  Notice,
  Plugin,
  TAbstractFile,
  TFile,
  TFolder,
  WorkspaceLeaf,
  apiVersion,
  parseLinktext,
} from "obsidian";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { configPins, historyFileName, openFilesFromWorkspace, parseHistory, parseSettings, syncOn } from "./data";
import { epochDay, norm } from "./paths";
import { Ctx, History, Settings, Startup, touch } from "./rules";
import { Deps, State, Targets, installHooks, loadAll, loadFolder, loadFor, newState } from "./hooks";
import { resolveSkipped } from "./resolve";
import { indexSkipped, indexedFiles } from "./walk";
import { LazyVaultSettingTab } from "./settings";
import { LazyVaultView, SkippedFolderModal, SkippedNoteModal, VIEW_TYPE } from "./view";

const SYNC_GATE =
  "Obsidian Sync is on in this vault, so nothing is skipped. Turn on 'Allow with Obsidian Sync' in settings to skip anyway (a skipped folder may look deleted to Sync).";

// A start with skipping that takes longer than this pauses skipping until the user resumes it.
const SLOW_START_MS = 20000;

const unique = (xs: string[]): string[] => [...new Set(xs)];

function historyDir(): string {
  return process.env.LAZY_VAULT_HOME || join(homedir(), "Library", "Application Support", "lazy-vault");
}

// Undefined when the file is missing or corrupt. Used for files Obsidian owns.
function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

// Like readJson, but a corrupt file is first copied aside so nothing is lost.
function readStored(path: string, errors: string[]): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    const copy = `${path}.corrupt-${Date.now()}`;
    try {
      copyFileSync(path, copy);
      errors.push(`${basename(path)} was not valid JSON; kept a copy as ${basename(copy)} and used defaults`);
    } catch (e) {
      errors.push(`${basename(path)} was not valid JSON and could not be copied: ${String(e)}`);
    }
    return undefined;
  }
}

export default class LazyVaultPlugin extends Plugin {
  cfg!: Settings;
  history!: History;
  state!: State;
  targets!: Targets;
  deps!: Deps;
  mode: Startup["mode"] = "off";
  record: Startup | null = null;
  syncIsOn = false;
  desktop = false;
  private base = "";
  private restoreHooks: (() => void) | null = null;
  private viewTimer: number | null = null;
  private historyTimer: number | null = null;
  private t0 = 0;

  onload(): void {
    // Everything up to installHooks is synchronous, so it does not depend on
    // whether Obsidian awaits onload.
    this.t0 = performance.now();
    const today = epochDay(Date.now());
    const adapter = this.app.vault.adapter;
    const desktop = adapter instanceof FileSystemAdapter;
    this.desktop = desktop;
    const base = desktop ? adapter.getBasePath() : "";
    this.base = base;
    const errors: string[] = [];
    const cfgDir = this.app.vault.configDir;
    const readCfg = (rel: string): unknown => (desktop ? readJson(join(base, cfgDir, rel)) : undefined);

    const dataPath = join(base, this.manifest.dir ?? join(cfgDir, "plugins", this.manifest.id), "data.json");
    const parsedSettings = parseSettings(desktop ? readStored(dataPath, errors) : undefined);
    const settings = parsedSettings.settings;
    errors.push(...parsedSettings.errors);

    const parsedHistory = parseHistory(
      desktop ? readStored(join(historyDir(), historyFileName(base)), errors) : undefined,
      base,
      today,
    );
    errors.push(...parsedHistory.errors);
    const history = parsedHistory.history;

    const ws = readCfg("workspace.json");
    const core = readCfg("core-plugins.json");
    this.syncIsOn = syncOn(core);
    const protect = unique(
      [...openFilesFromWorkspace(ws), ...settings.pins, ...configPins(readCfg)].map(norm).filter((p) => p !== ""),
    );

    this.cfg = settings;
    this.history = history;
    // Persist the pause now, so it holds even if the history file is lost.
    if (settings.pausedAfterSlowStart) void this.saveSettings();
    // A snapshot: the settings tab edits this.cfg, and that edit takes effect at the next start, not now.
    const ctx: Ctx = { settings: structuredClone(settings), history, today, startup: true, protect };
    const s = newState(base, ctx);
    s.changed = () => this.emitChanged();
    s.errors.push(...errors);
    this.state = s;

    this.targets = {
      adapter,
      vault: this.app.vault,
      fileManager: this.app.fileManager,
      leafProto: WorkspaceLeaf.prototype,
    };
    this.deps = {
      parseLinktext: (t: string) => parseLinktext(t),
      getFirstLinkpathDest: (lp: string, src: string) => this.app.metadataCache.getFirstLinkpathDest(lp, src),
      getFile: (p: string) => {
        const f = this.app.vault.getAbstractFileByPath(p);
        return f instanceof TFile ? f : null;
      },
      notice: (m: string) => new Notice(m),
    };

    // The last start with skipping, if it was slow and the user has not resumed since, pauses skipping.
    const lastOn = [...history.startups].reverse().find((r) => r.mode === "on");
    const slowMs = lastOn && !lastOn.acked && typeof lastOn.layoutReadyMs === "number" ? lastOn.layoutReadyMs : null;
    if (slowMs !== null && slowMs > SLOW_START_MS) settings.pausedAfterSlowStart = true;

    if (!desktop) {
      this.mode = "failopen";
      s.problems.push("Not a desktop vault: nothing skipped");
    } else if (!settings.enabled) {
      this.mode = "off";
    } else if (settings.pausedAfterSlowStart) {
      this.mode = "failopen";
      const why =
        slowMs !== null ? `Last start with skipping took ${Math.round(slowMs / 1000)} s` : "A previous start with skipping was slow";
      s.problems.push(`${why}; skipping paused. Resume it in the Lazy Vault view (takes effect at next start).`);
    } else if (this.syncIsOn && !settings.allowWithSync) {
      this.mode = "failopen";
      s.problems.push(SYNC_GATE);
    } else if (this.app.workspace.layoutReady || Object.keys((adapter as any).files ?? {}).length > 1) {
      this.mode = "late";
      s.problems.push("Enabled mid-session: skipping starts at next Obsidian start");
    } else {
      // installHooks has already put its problems in s.problems; do not add them again.
      const r = installHooks(this.targets, s, this.deps);
      this.restoreHooks = r.restore;
      this.mode = r.problems.length ? "failopen" : "on";
    }

    this.registerView(VIEW_TYPE, (leaf) => new LazyVaultView(leaf, this));
    this.addRibbonIcon("snowflake", "Lazy Vault", () => void this.activateView());
    this.addCommand({ id: "open-view", name: "Show skipped folders", callback: () => void this.activateView() });
    this.addCommand({
      id: "open-skipped-note",
      name: "Open skipped note…",
      callback: () => new SkippedNoteModal(this.app, this).open(),
    });
    this.addCommand({
      id: "load-folder",
      name: "Load a skipped folder…",
      callback: () => new SkippedFolderModal(this.app, this).open(),
    });
    this.addCommand({
      id: "load-all",
      name: "Load all skipped folders (this session)",
      callback: () => void this.loadAllNow(),
    });
    this.addSettingTab(new LazyVaultSettingTab(this.app, this));

    this.registerEvent(this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => this.onFileMenu(menu, file)));
    this.registerEvent(this.app.workspace.on("file-open", (file: TFile | null) => void this.onFileOpen(file)));
    this.registerEvent(this.app.vault.on("create", (f: TAbstractFile) => this.onWrite(f.path)));
    this.registerEvent(this.app.vault.on("modify", (f: TAbstractFile) => this.onWrite(f.path)));
    this.registerEvent(this.app.vault.on("rename", (f: TAbstractFile) => this.onWrite(f.path)));

    this.app.workspace.onLayoutReady(() => this.afterLayout());
  }

  onunload(): void {
    if (this.restoreHooks) {
      this.restoreHooks();
      this.restoreHooks = null;
      // The originals are back, so nothing can guard a link click any more: load everything.
      void loadAll(this.targets, this.state);
    }
    if (this.viewTimer !== null) window.clearTimeout(this.viewTimer);
    if (this.historyTimer !== null) window.clearTimeout(this.historyTimer);
    this.viewTimer = null;
    this.historyTimer = null;
  }

  private afterLayout(): void {
    const s = this.state;
    s.ctx.startup = false;
    if (this.mode === "on" && s.scanCalls === 0) s.problems.push("scan hook never ran; nothing skipped");
    const record: Startup = {
      at: Date.now(),
      mode: this.mode,
      apiVersion: String(apiVersion),
      onloadMs: this.t0,
      layoutReadyMs: performance.now(),
      vaultFiles: this.app.vault.getFiles().length,
      vaultEntries: this.app.vault.getAllLoadedFiles().length,
      skippedFolders: s.skipped.size,
      skipped: [...s.skipped].map(([path, reason]) => ({ path, reason })),
      skippedFiles: null,
      problems: [...s.problems],
      scanFirstMs: s.probe.first,
      scanLastMs: s.probe.last,
      probeCount: s.probe.count,
      probeTotalMs: s.probe.totalMs,
      probeMaxMs: s.probe.maxMs,
      probeMaxPath: s.probe.maxPath,
    };
    this.record = record;
    this.history.startups = [...this.history.startups, record].slice(-20);
    this.saveHistory();
    if (this.mode === "on") {
      s.indexing = indexSkipped(s)
        .then(() => {
          record.skippedFiles = indexedFiles(s).length;
          this.saveHistory();
          this.emitChanged();
        })
        .catch((e: unknown) => {
          s.errors.push(`index failed: ${String(e)}`);
        });
      // Outside the indexing chain: a link click awaits s.indexing, so the selftest must not be inside it.
      void s.indexing.then(() => this.selftest(record)).catch((e: unknown) => {
        s.errors.push(`selftest failed: ${String(e)}`);
      });
    }
    this.emitChanged();
  }

  // Inert unless LAZY_VAULT_SELFTEST_LINK="<linktext>|<sourcePath>" is set. The only way to drive the live link hook from the demo.
  private async selftest(record: Startup): Promise<void> {
    const link = process.env.LAZY_VAULT_SELFTEST_LINK;
    if (!link || this.mode !== "on") return;
    const i = link.lastIndexOf("|");
    if (i <= 0) return;
    const linktext = link.slice(0, i);
    const source = link.slice(i + 1);
    await this.app.workspace.openLinkText(linktext, source, true);
    record.selftest = { link: linktext, source, opened: this.app.workspace.getActiveFile()?.path ?? null };
    this.saveHistory();
  }

  private async onFileOpen(file: TFile | null): Promise<void> {
    if (!file) return;
    const today = this.state.ctx.today;
    if (touch(this.history, norm(file.path), today)) this.scheduleHistorySave();
    if (this.state.ctx.startup) return;
    const embeds = this.app.metadataCache.getFileCache(file)?.embeds ?? [];
    for (const e of embeds) {
      const lp = parseLinktext(e.link).path;
      const dest = this.app.metadataCache.getFirstLinkpathDest(lp, file.path);
      if (dest) {
        if (touch(this.history, dest.path, today)) this.scheduleHistorySave();
        continue;
      }
      if (this.mode !== "on") continue;
      try {
        await this.state.indexing;
        const hit = resolveSkipped(lp, file.path, indexedFiles(this.state));
        if (hit) await loadFor(this.targets, this.state, hit);
      } catch (err) {
        this.state.errors.push(`embed ${lp}: ${String(err)}`);
      }
    }
    this.emitChanged();
  }

  private onWrite(path: string): void {
    if (this.state.ctx.startup || !this.desktop) return;
    if (touch(this.history, norm(path), this.state.ctx.today)) this.scheduleHistorySave();
  }

  private onFileMenu(menu: Menu, file: TAbstractFile): void {
    if (!(file instanceof TFolder)) return;
    const path = norm(file.path);
    if (path === "") return;
    menu.addItem((i) =>
      i
        .setTitle("Lazy Vault: never skip (pin)")
        .setIcon("pin")
        .onClick(() => void this.setListed("pins", path, true)),
    );
    menu.addItem((i) =>
      i
        .setTitle("Lazy Vault: skip from next start")
        .setIcon("eye-off")
        .onClick(() => void this.setListed("skipList", path, true)),
    );
  }

  // Pins and the skip list are read at startup only, so the change takes effect next start.
  async setListed(key: "pins" | "skipList", path: string, on: boolean): Promise<void> {
    const rest = this.cfg[key].filter((p) => p !== path);
    this.cfg[key] = on ? unique([...rest, path]) : rest;
    await this.saveSettings();
    this.emitChanged();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.cfg);
  }

  // Clears the slow-start pause. The latest slow start is marked acknowledged, so the next start does not pause again.
  // Takes effect at the next start, since the hooks are installed at onload.
  async resumeSkipping(): Promise<void> {
    this.cfg.pausedAfterSlowStart = false;
    const lastOn = [...this.history.startups].reverse().find((r) => r.mode === "on");
    if (lastOn) lastOn.acked = true;
    this.saveHistory();
    await this.saveSettings();
    this.emitChanged();
  }

  async loadFolderNow(root: string): Promise<void> {
    try {
      await loadFolder(this.targets, this.state, root);
    } catch (e) {
      this.state.errors.push(`load ${root}: ${String(e)}`);
      new Notice(`Lazy Vault: couldn't load ${root}`);
    }
    this.emitChanged();
  }

  async loadPathNow(path: string): Promise<void> {
    try {
      await loadFor(this.targets, this.state, path);
    } catch (e) {
      this.state.errors.push(`load ${path}: ${String(e)}`);
      new Notice(`Lazy Vault: couldn't load ${path}`);
    }
    this.emitChanged();
  }

  async loadAllNow(): Promise<void> {
    try {
      await loadAll(this.targets, this.state);
    } catch (e) {
      this.state.errors.push(`load all: ${String(e)}`);
    }
    this.emitChanged();
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  // Debounced re-render of every open Lazy Vault view.
  emitChanged(): void {
    if (this.viewTimer !== null) return;
    this.viewTimer = window.setTimeout(() => {
      this.viewTimer = null;
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
        if (leaf.view instanceof LazyVaultView) leaf.view.render();
      }
    }, 200);
  }

  private scheduleHistorySave(): void {
    if (this.historyTimer !== null) return;
    this.historyTimer = window.setTimeout(() => {
      this.historyTimer = null;
      this.saveHistory();
    }, 5000);
  }

  // Temp file, then rename, so a crash never leaves a half-written history.
  private saveHistory(): void {
    if (!this.desktop) return;
    try {
      const dir = historyDir();
      mkdirSync(dir, { recursive: true });
      const file = join(dir, historyFileName(this.base));
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.history, null, 2));
      renameSync(tmp, file);
    } catch (e) {
      this.state.errors.push(`history save failed: ${String(e)}`);
    }
  }
}
