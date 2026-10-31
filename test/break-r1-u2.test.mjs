// Breaker round 1, unit U2 (paths, rules, data, resolve). Each test is a break
// against PR #2 at 24a5a44. Expected behaviour is stated per test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isCold } from "../.testbuild/rules.mjs";
import { parseHistory, parseSettings, openFilesFromWorkspace } from "../.testbuild/data.mjs";

const TODAY = 20000;
const BASE = "/v";

// A history where the vault has been seen for 60 days, so the cold gate is open.
const OLD_HISTORY = () => ({ vaultBase: BASE, firstSeenDay: TODAY - 60, lastActive: {}, startups: [] });

// 1. A folder whose name is an Object.prototype property has no history entry,
//    so it must be cold. The lookup h.lastActive["constructor"] returns the
//    Object function, not undefined, so isCold compares NaN and returns false.
test("break: a folder named 'constructor' with no history is cold", () => {
  assert.equal(isCold("constructor", OLD_HISTORY(), TODAY, 30), true);
});

// 2. Same cause with another inherited name.
test("break: a folder named 'toString' with no history is cold", () => {
  assert.equal(isCold("toString", OLD_HISTORY(), TODAY, 30), true);
});

// 3. Huge settings lists. cleanList calls out.includes for every entry, so
//    parsing is quadratic: 100k skipList entries take about 11 s on this Mac.
test("break: a 100k-entry skipList parses in under 2 s", () => {
  const list = Array.from({ length: 100000 }, (_, i) => `Folder ${i}`);
  const t0 = Date.now();
  const { settings } = parseSettings({ skipList: list });
  const ms = Date.now() - t0;
  assert.equal(settings.skipList.length, 100000);
  assert.ok(ms < 2000, `parseSettings took ${ms} ms`);
});

// 4. coldDays above the 3650 cap is rejected and falls back to 30. A user who
//    wrote a huge value to mean "never go cold" gets the most aggressive setting.
//    Expected: the cap (3650) or 0, not the 30-day default.
test("break: coldDays above the 3650 cap does not fall back to 30 days", () => {
  const { settings } = parseSettings({ coldDays: 5000 });
  assert.notEqual(settings.coldDays, 30);
});

// 5. openFilesFromWorkspace is recursive. A workspace.json nested 20000 levels
//    deep parses fine with JSON.parse, then the walk overflows the stack and
//    throws. The plan says parsers never throw.
test("break: a deeply nested workspace.json returns its open file instead of throwing", () => {
  let node = { type: "leaf", state: { type: "markdown", state: { file: "Deep/x.md" } } };
  for (let i = 0; i < 20000; i++) node = { type: "split", children: [node] };
  const parsed = JSON.parse(JSON.stringify({ main: node }));
  assert.deepEqual(openFilesFromWorkspace(parsed), ["Deep/x.md"]);
});

// 6. Two history keys normalise to the same folder ("Proj/" and "Proj"). The
//    later key in object order overwrites the earlier one, so a stale value
//    wins over a fresh one and a folder active today is treated as cold.
//    Expected: the most recent activity wins.
test("break: a stale 'Proj' key does not overwrite a fresh 'Proj/' key", () => {
  const raw = {
    vaultBase: BASE,
    firstSeenDay: TODAY - 60,
    lastActive: { "Proj/": TODAY, Proj: TODAY - 40 },
    startups: [],
  };
  const { history } = parseHistory(raw, BASE, TODAY);
  assert.equal(isCold("Proj", history, TODAY, 30), false);
});

// 7. A lastActive key containing ".." is not collapsed by norm, so it can never
//    match the folder it refers to. Folder "Cold" is active today in the file,
//    but the lookup misses and it is treated as cold.
//    Expected: "Proj/../Cold" resolves to "Cold" and Cold is warm.
test("break: a lastActive key with '..' still counts as activity for the folder it names", () => {
  const raw = { vaultBase: BASE, firstSeenDay: TODAY - 60, lastActive: { "Proj/../Cold": TODAY }, startups: [] };
  const { history } = parseHistory(raw, BASE, TODAY);
  assert.equal(isCold("Cold", history, TODAY, 30), false);
});

// 8. Keys are case-sensitive, but the folder is one folder on the default macOS
//    filesystem. A history key "proj" from before a case-only rename does not
//    match the folder "Proj", so the folder with yesterday's activity is cold.
//    Expected: a case-only difference keeps the folder warm.
test("break: a lastActive key differing only by case keeps the folder warm", () => {
  const raw = { vaultBase: BASE, firstSeenDay: TODAY - 60, lastActive: { proj: TODAY - 1 }, startups: [] };
  const { history } = parseHistory(raw, BASE, TODAY);
  assert.equal(isCold("Proj", history, TODAY, 30), false);
});
