import { App, PluginSettingTab, Setting } from "obsidian";
import type LazyVaultPlugin from "./main";

const lines = (v: string): string[] =>
  v
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");

export class LazyVaultSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: LazyVaultPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const p = this.plugin;
    const st = p.cfg;
    const save = async (): Promise<void> => {
      await p.saveSettings();
    };

    new Setting(containerEl)
      .setName("Skip folders")
      .setDesc("Nested repos, build output and cold folders are skipped at startup. Takes effect at next start.")
      .addToggle((t) =>
        t.setValue(st.enabled).onChange(async (v) => {
          st.enabled = v;
          await save();
        }),
      );

    new Setting(containerEl)
      .setName("Cold after N days (0 = off)")
      .setDesc("A folder not opened, edited or written to in this many days is skipped at next start. Takes effect at next start.")
      .addText((t) =>
        t.setValue(String(st.coldDays)).onChange(async (v) => {
          // An empty field is not 0: Number("") is 0, which would switch cold skipping off.
          if (v.trim() === "") return;
          const n = Number(v);
          if (Number.isInteger(n) && n >= 0 && n <= 3650) {
            st.coldDays = n;
            await save();
          }
        }),
      );

    new Setting(containerEl)
      .setName("Build folder names")
      .setDesc("Comma-separated. Exact, case-sensitive folder names that are always skipped. Takes effect at next start.")
      .addText((t) =>
        t.setValue(st.buildNames.join(", ")).onChange(async (v) => {
          st.buildNames = v
            .split(",")
            .map((x) => x.trim())
            .filter((x) => x !== "");
          await save();
        }),
      );

    new Setting(containerEl)
      .setName("Allow with Obsidian Sync")
      .setDesc(
        "Off by default: with Obsidian Sync on, nothing is skipped. If on, a skipped folder may look deleted to Sync. Takes effect at next start.",
      )
      .addToggle((t) =>
        t.setValue(st.allowWithSync).onChange(async (v) => {
          st.allowWithSync = v;
          await save();
        }),
      );

    new Setting(containerEl)
      .setName("Pins (never skip)")
      .setDesc("One folder per line. Takes effect at next start.")
      .addTextArea((t) =>
        t.setValue(st.pins.join("\n")).onChange(async (v) => {
          st.pins = lines(v);
          await save();
        }),
      );

    new Setting(containerEl)
      .setName("Skip list")
      .setDesc("One folder per line. Skipped at next start. Takes effect at next start.")
      .addTextArea((t) =>
        t.setValue(st.skipList.join("\n")).onChange(async (v) => {
          st.skipList = lines(v);
          await save();
        }),
      );
  }
}
