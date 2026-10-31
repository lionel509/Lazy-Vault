import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS,
  parseSettings,
  parseHistory,
  openFilesFromWorkspace,
  configPins,
  syncOn,
  historyFileName,
} from "../.testbuild/data.mjs";

const TODAY = 1000;
const BASE = "/Users/example/Vault";

test("DEFAULT_SETTINGS matches the plan", () => {
  assert.deepEqual(DEFAULT_SETTINGS, {
    enabled: true,
    coldDays: 30,
    buildNames: ["node_modules", "__pycache__", "target", "dist", "build", "venv"],
    pins: [],
    skipList: [],
    allowWithSync: false,
  });
});

test("parseSettings: junk input gives the defaults", () => {
  for (const raw of [null, "x"]) {
    const { settings } = parseSettings(raw);
    assert.deepEqual(settings, DEFAULT_SETTINGS);
  }
});

test("parseSettings: a string coldDays is a bad field, so the default and an error", () => {
  const { settings, errors } = parseSettings({ coldDays: "5" });
  assert.equal(settings.coldDays, 30);
  assert.ok(errors.length > 0);
});

test("parseSettings: a negative coldDays falls back to the default", () => {
  const { settings, errors } = parseSettings({ coldDays: -1 });
  assert.equal(settings.coldDays, 30);
  assert.ok(errors.length > 0);
});

test("parseSettings: pins keep strings only, normalised, deduped", () => {
  const { settings } = parseSettings({ pins: [1, "a/", "a"] });
  assert.deepEqual(settings.pins, ["a"]);
});

test("parseHistory: null gives a fresh history for this vault", () => {
  const { history } = parseHistory(null, BASE, TODAY);
  assert.equal(history.vaultBase, BASE);
  assert.equal(history.firstSeenDay, TODAY);
  assert.deepEqual(history.lastActive, {});
  assert.deepEqual(history.startups, []);
});

test("parseHistory: a foreign vaultBase restarts with an error", () => {
  const raw = { vaultBase: "/Users/example/Other", firstSeenDay: TODAY - 60, lastActive: { A: TODAY - 50 }, startups: [] };
  const { history, errors } = parseHistory(raw, BASE, TODAY);
  assert.equal(history.vaultBase, BASE);
  assert.equal(history.firstSeenDay, TODAY);
  assert.deepEqual(history.lastActive, {});
  assert.ok(errors.length > 0);
});

test("parseHistory: future days clamp to today", () => {
  const raw = { vaultBase: BASE, firstSeenDay: TODAY + 5, lastActive: { A: TODAY + 3 }, startups: [] };
  const { history } = parseHistory(raw, BASE, TODAY);
  assert.equal(history.firstSeenDay, TODAY);
  assert.equal(history.lastActive.A, TODAY);
});

test("parseHistory: NaN days clamp to today", () => {
  const raw = { vaultBase: BASE, firstSeenDay: TODAY - 60, lastActive: { A: Number.NaN }, startups: [] };
  const { history } = parseHistory(raw, BASE, TODAY);
  assert.equal(history.lastActive.A, TODAY);
});

test("openFilesFromWorkspace walks leaves and ignores lastOpenFiles", () => {
  const ws = {
    main: {
      id: "m0",
      type: "split",
      children: [{ id: "t0", type: "tabs", children: [{ id: "l0", type: "leaf", state: { type: "markdown", state: { file: "Proj/a.md" } } }] }],
    },
    right: {
      id: "r0",
      type: "split",
      children: [{ id: "t1", type: "tabs", children: [{ id: "l1", type: "leaf", state: { type: "markdown", state: { file: "Notes/b.md" } } }] }],
    },
    active: "l0",
    lastOpenFiles: ["Ignored/z.md"],
  };
  assert.deepEqual([...openFilesFromWorkspace(ws)].sort(), ["Notes/b.md", "Proj/a.md"]);
});

test("configPins reads the config files and ignores './' and empty paths", () => {
  const files = {
    "app.json": { attachmentFolderPath: "./", newFileFolderPath: "Inbox" },
    "daily-notes.json": { folder: "Journal", template: "Templates/Daily" },
    "templates.json": { folder: "Templates" },
    "plugins/templater-obsidian/data.json": { templates_folder: "Tpl" },
  };
  const pins = configPins((rel) => files[rel]);
  assert.deepEqual([...pins].sort(), ["Inbox", "Journal", "Templates", "Tpl"]);
  assert.equal(pins.includes(""), false);
});

test("syncOn reads the core-plugins shape and rejects junk", () => {
  assert.equal(syncOn({ sync: true }), true);
  assert.equal(syncOn(["sync"]), true);
  assert.equal(syncOn({ sync: false }), false);
  assert.equal(syncOn(["x"]), false);
  assert.equal(syncOn("x"), false);
  assert.equal(syncOn(null), false);
});

test("historyFileName is 16 hex characters plus .json, and stable", () => {
  const name = historyFileName(BASE);
  assert.match(name, /^[0-9a-f]{16}\.json$/);
  assert.equal(historyFileName(BASE), name);
  assert.notEqual(historyFileName("/other"), name);
});
