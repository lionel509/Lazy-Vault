import { App, FuzzySuggestModal, ItemView, TFile, WorkspaceLeaf } from "obsidian";
import type LazyVaultPlugin from "./main";
import type { Reason } from "./rules";
import { indexedFiles } from "./walk";

export const VIEW_TYPE = "lazy-vault";

const MODE_LABEL: Record<string, string> = {
  on: "Skipping: on",
  off: "Skipping: off (settings)",
  failopen: "Fail-open: nothing skipped",
  late: "Enabled mid-session: skipping starts at next Obsidian start",
};

function reasonLabel(reason: Reason, coldDays: number): string {
  switch (reason) {
    case "repo":
      return "repo";
    case "build":
      return "build output";
    case "cold":
      return `cold: not opened in ≥ ${coldDays} days`;
    case "listed":
      return "your skip list";
  }
}

type Action = [label: string, run: () => void];

function row(parent: HTMLElement, text: string, actions: Action[]): void {
  const r = parent.createDiv({ cls: "lv-row" });
  r.createSpan({ text, cls: "lv-row-text" });
  for (const [label, run] of actions) {
    r.createEl("button", { text: label }).addEventListener("click", () => run());
  }
}

export class LazyVaultView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private plugin: LazyVaultPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Lazy Vault";
  }

  getIcon(): string {
    return "snowflake";
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  render(): void {
    const p = this.plugin;
    const s = p.state;
    const root = this.contentEl;
    root.empty();
    root.addClass("lazy-vault");
    if (!s) return;

    // (a) Status: what is happening, and why nothing is skipped when it isn't.
    const status = root.createDiv({ cls: "lv-section" });
    status.createEl("h4", { text: "Status" });
    status.createEl("p", { text: MODE_LABEL[p.mode] ?? p.mode, cls: "lv-status" });
    if (s.problems.length) {
      const ul = status.createEl("ul");
      for (const msg of s.problems) ul.createEl("li", { text: msg });
    }
    if (p.cfg.pausedAfterSlowStart) {
      status
        .createEl("button", { text: "Resume skipping (at next start)" })
        .addEventListener("click", () => void p.resumeSkipping());
    }
    if (p.syncIsOn && p.cfg.allowWithSync) {
      status.createEl("p", {
        text: "Obsidian Sync is on and 'Allow with Obsidian Sync' is set: a skipped folder may look deleted to Sync.",
        cls: "lv-warn",
      });
    }
    if (s.errors.length) {
      status.createEl("h4", { text: "Errors" });
      const ul = status.createEl("ul");
      for (const msg of s.errors.slice(-20)) ul.createEl("li", { text: msg });
    }

    // (b) This startup, then the last five.
    const startup = root.createDiv({ cls: "lv-section" });
    startup.createEl("h4", { text: "This startup" });
    const r = p.record;
    if (r) {
      const layout = r.layoutReadyMs === null ? "not yet" : `${(r.layoutReadyMs / 1000).toFixed(1)} s`;
      const skippedFiles = r.skippedFiles === null ? "counting…" : String(r.skippedFiles);
      startup.createEl("p", {
        text: `plugin loaded at ${(r.onloadMs / 1000).toFixed(1)} s · layout ready at ${layout} · ${r.vaultFiles ?? "?"} files loaded · ${skippedFiles} files skipped`,
      });
    }
    const recent = p.history.startups.slice(-5).reverse();
    if (recent.length) {
      const table = startup.createEl("table", { cls: "lv-table" });
      const head = table.createEl("tr");
      for (const h of ["Date", "Mode", "Layout ready (s)", "Files loaded"]) head.createEl("th", { text: h });
      for (const st of recent) {
        const tr = table.createEl("tr");
        tr.createEl("td", { text: new Date(st.at).toLocaleString() });
        tr.createEl("td", { text: st.mode });
        tr.createEl("td", { text: st.layoutReadyMs === null ? "—" : (st.layoutReadyMs / 1000).toFixed(1) });
        tr.createEl("td", { text: st.vaultFiles === null ? "—" : String(st.vaultFiles) });
      }
    }

    // (c) Buttons.
    const buttons = root.createDiv({ cls: "lv-section lv-buttons" });
    buttons.createEl("button", { text: "Load all" }).addEventListener("click", () => void p.loadAllNow());
    buttons
      .createEl("button", { text: "Open skipped note…" })
      .addEventListener("click", () => new SkippedNoteModal(this.app, p).open());

    // (d) Skipped now, biggest first.
    const skipped = [...s.skipped].map(([path, reason]) => ({
      path,
      reason,
      count: s.index.get(path)?.length ?? null,
    }));
    skipped.sort((a, b) => (b.count ?? -1) - (a.count ?? -1) || a.path.localeCompare(b.path));
    const sec = root.createDiv({ cls: "lv-section" });
    sec.createEl("h4", { text: `Skipped now (${skipped.length})` });
    for (const item of skipped) {
      const count = item.count === null ? "counting…" : `${item.count} files`;
      row(sec, `${item.path || "/"} · ${reasonLabel(item.reason, p.cfg.coldDays)} · ${count}`, [
        ["Load", () => void p.loadFolderNow(item.path)],
        ["Pin", () => void p.setListed("pins", item.path, true)],
      ]);
    }

    // (e) Loaded this session.
    const loaded = [...s.loaded];
    const loadedSec = root.createDiv({ cls: "lv-section" });
    loadedSec.createEl("h4", { text: `Loaded this session (${loaded.length})` });
    for (const [path, reason] of loaded) {
      row(loadedSec, `${path || "/"} · ${reasonLabel(reason, p.cfg.coldDays)}`, [
        ["Skip from next start", () => void p.setListed("skipList", path, true)],
      ]);
    }

    // (f) Pins and skip list.
    const pinSec = root.createDiv({ cls: "lv-section" });
    pinSec.createEl("h4", { text: "Pinned" });
    for (const path of p.cfg.pins) {
      row(pinSec, path, [["Unpin", () => void p.setListed("pins", path, false)]]);
    }
    const listSec = root.createDiv({ cls: "lv-section" });
    listSec.createEl("h4", { text: "Skip list" });
    for (const path of p.cfg.skipList) {
      row(listSec, path, [["Remove", () => void p.setListed("skipList", path, false)]]);
    }
  }
}

// Names-only picker over the skipped folders' file names. Parses no contents.
export class SkippedNoteModal extends FuzzySuggestModal<string> {
  constructor(
    app: App,
    private plugin: LazyVaultPlugin,
  ) {
    super(app);
    this.setPlaceholder("Skipped note…");
  }

  getItems(): string[] {
    return indexedFiles(this.plugin.state).filter((f) => /\.(md|canvas|pdf|base)$/i.test(f));
  }

  getItemText(item: string): string {
    return item;
  }

  onChooseItem(item: string): void {
    void this.openItem(item);
  }

  private async openItem(item: string): Promise<void> {
    await this.plugin.loadPathNow(item);
    const file = this.app.vault.getAbstractFileByPath(item);
    if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
  }
}

export class SkippedFolderModal extends FuzzySuggestModal<string> {
  constructor(
    app: App,
    private plugin: LazyVaultPlugin,
  ) {
    super(app);
    this.setPlaceholder("Skipped folder to load…");
  }

  getItems(): string[] {
    return [...this.plugin.state.skipped.keys()];
  }

  getItemText(item: string): string {
    return item;
  }

  onChooseItem(item: string): void {
    void this.plugin.loadFolderNow(item);
  }
}
