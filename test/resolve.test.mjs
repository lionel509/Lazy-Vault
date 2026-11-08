import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSkipped } from "../.testbuild/resolve.mjs";

test("bare name resolves to its skipped note", () => {
  assert.equal(resolveSkipped("old", "Home.md", ["Cold/old.md"]), "Cold/old.md");
});

test("a link that already ends in .md resolves", () => {
  assert.equal(resolveSkipped("old.md", "Home.md", ["Cold/old.md"]), "Cold/old.md");
});

test("a path link resolves", () => {
  assert.equal(resolveSkipped("Cold/old", "Home.md", ["Cold/old.md"]), "Cold/old.md");
});

test("case differences still match", () => {
  assert.equal(resolveSkipped("OLD", "Home.md", ["Cold/old.md"]), "Cold/old.md");
});

test("same-folder candidate wins", () => {
  assert.equal(resolveSkipped("x", "B/y.md", ["A/x.md", "B/x.md"]), "B/x.md");
});

test("shortest path wins among equal basenames", () => {
  assert.equal(resolveSkipped("x", "Home.md", ["Deep/Inner/x.md", "Deep/x.md"]), "Deep/x.md");
});

test("../ resolves against the source note's folder", () => {
  assert.equal(resolveSkipped("../x", "A/B/y.md", ["A/x.md"]), "A/x.md");
});

test("a non-markdown attachment resolves by its full name", () => {
  assert.equal(resolveSkipped("img.png", "Home.md", ["Cold/img.png"]), "Cold/img.png");
});

test("no match gives null, and an empty link gives null", () => {
  assert.equal(resolveSkipped("nothere", "Home.md", ["Cold/old.md"]), null);
  assert.equal(resolveSkipped("", "Home.md", ["Cold/old.md"]), null);
});
