import { test } from "node:test";
import assert from "node:assert/strict";
import { norm, parentOf, ancestors, isInside, topSkipped, epochDay } from "../.testbuild/paths.mjs";

test("norm strips slashes, backslashes and dot segments", () => {
  assert.equal(norm("/a//b/"), "a/b");
  assert.equal(norm("a\\b"), "a/b");
  assert.equal(norm("./a"), "a");
  assert.equal(norm(""), "");
});

test("norm makes NFD and NFC spellings equal", () => {
  const nfd = "노트".normalize("NFD");
  assert.equal(norm(nfd), "노트".normalize("NFC"));
  assert.equal(norm(nfd), norm("노트"));
});

test("isInside is segment-aware and the root contains everything", () => {
  assert.equal(isInside("ab", "a"), false);
  assert.equal(isInside("a/b", "a"), true);
  assert.equal(isInside("a", "a"), true);
  assert.equal(isInside("x/y", ""), true);
});

test("ancestors lists the folders above a file, shallowest first", () => {
  assert.deepEqual(ancestors("a/b/c.md"), ["a", "a/b"]);
  assert.deepEqual(ancestors("c.md"), []);
});

test("parentOf returns the folder, or the root", () => {
  assert.equal(parentOf("a/b"), "a");
  assert.equal(parentOf("a"), "");
});

test("topSkipped returns the shortest skipped ancestor-or-self", () => {
  const set = new Set(["a", "a/b"]);
  assert.equal(topSkipped("a/b/c.md", set), "a");
  assert.equal(topSkipped("a/b", set), "a");
  assert.equal(topSkipped("z/c.md", set), null);
});

test("epochDay counts UTC days", () => {
  assert.equal(epochDay(0), 0);
  assert.equal(epochDay(86400000 * 2 + 5), 2);
});
