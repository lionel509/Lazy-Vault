import { test } from "node:test";
import assert from "node:assert/strict";
import { isProtected, isCold, decide, touch } from "../.testbuild/rules.mjs";
import { DEFAULT_SETTINGS } from "../.testbuild/data.mjs";

const TODAY = 20000;
const H = (over = {}) => ({ vaultBase: "/v", firstSeenDay: TODAY - 60, lastActive: {}, startups: [], ...over });
const CTX = (over = {}) => ({ settings: { ...DEFAULT_SETTINGS }, history: H(), today: TODAY, startup: true, protect: [], ...over });
const DIR = { isDir: true, hasGit: false, hasObsidian: false };
const REPO = { isDir: true, hasGit: true, hasObsidian: false };

test("isProtected: an entry inside a folder, or a folder's entry inside it", () => {
  assert.equal(isProtected("Proj", ["Proj/open.md"]), true);
  assert.equal(isProtected("Proj/open.md", ["Proj"]), true);
  assert.equal(isProtected("Projx", ["Proj"]), false);
});

test("decide: a pin beats the skip list", () => {
  const c = CTX({ settings: { ...DEFAULT_SETTINGS, skipList: ["Notes"] }, protect: ["Notes"] });
  assert.equal(decide("Notes", DIR, c), null);
  assert.equal(decide("Notes", DIR, CTX({ settings: { ...DEFAULT_SETTINGS, skipList: ["Notes"] } })), "listed");
});

test("decide: an open file inside a repo protects that repo", () => {
  assert.equal(decide("Proj2", REPO, CTX({ protect: ["Proj2/open.md"] })), null);
  assert.equal(decide("Proj2", REPO, CTX()), "repo");
});

test("decide: a pinned descendant protects its ancestor from the cold rule", () => {
  const h = H({ lastActive: { Cold: TODAY - 40 } });
  assert.equal(decide("Cold", DIR, CTX({ history: h, protect: ["Cold/Inner/deep.md"] })), null);
  assert.equal(decide("Cold", DIR, CTX({ history: h })), "cold");
});

test("decide: a dir with .git and .obsidian is not a repo", () => {
  assert.equal(decide("V", { isDir: true, hasGit: true, hasObsidian: true }, CTX()), null);
});

test("decide: build names are matched case-sensitively on the basename", () => {
  assert.equal(decide("Node_modules", DIR, CTX()), null);
  assert.equal(decide("node_modules", DIR, CTX()), "build");
  assert.equal(decide("a/dist", DIR, CTX()), "build");
});

test("decide: files are never skipped", () => {
  assert.equal(decide("a.md", { isDir: false, hasGit: true, hasObsidian: false }, CTX()), null);
  assert.equal(decide("node_modules", { isDir: false, hasGit: false, hasObsidian: false }, CTX()), null);
});

test("isCold: 30 days of history is the minimum, and 30 days untouched is cold", () => {
  assert.equal(isCold("X", H({ firstSeenDay: TODAY - 30 }), TODAY, 30), true);
  assert.equal(isCold("X", H({ firstSeenDay: TODAY - 29 }), TODAY, 30), false);
});

test("isCold: lastActive 29 days ago is warm, 30 days ago is cold", () => {
  assert.equal(isCold("X", H({ firstSeenDay: TODAY - 100, lastActive: { X: TODAY - 29 } }), TODAY, 30), false);
  assert.equal(isCold("X", H({ firstSeenDay: TODAY - 100, lastActive: { X: TODAY - 30 } }), TODAY, 30), true);
});

test("cold rule: coldDays 0 never skips, and startup false never skips", () => {
  const h = H({ firstSeenDay: TODAY - 100 });
  assert.equal(isCold("X", h, TODAY, 0), false);
  assert.equal(decide("X", DIR, CTX({ history: h, settings: { ...DEFAULT_SETTINGS, coldDays: 0 } })), null);
  assert.equal(decide("X", DIR, CTX({ history: h, startup: false })), null);
  assert.equal(decide("X", DIR, CTX({ history: h })), "cold");
});

test("touch marks the file's folder and every ancestor, once per day", () => {
  const h = H();
  assert.equal(touch(h, "a/b/c.md", TODAY), true);
  assert.equal(h.lastActive.a, TODAY);
  assert.equal(h.lastActive["a/b"], TODAY);
  assert.equal(touch(h, "a/b/c.md", TODAY), false);
});
