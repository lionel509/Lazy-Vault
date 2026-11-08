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

