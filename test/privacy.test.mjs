import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { DENY_HASHES } from "../install.mjs";
import { sha256 } from "./fake.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  cwd: ROOT,
  encoding: "utf8",
})
  .split("\n")
  .filter(Boolean);

test("the repo lists at least one file to check", () => {
  assert.ok(files.includes("package.json"));
});

for (const f of files) {
  test(`no denied name and no personal path in ${f}`, () => {
    const text = readFileSync(join(ROOT, f), "utf8");
    assert.equal(text.includes("/Users/"), false, "contains /Users/");
    const words = new Set([...(f + "\n" + text).split(/[^A-Za-z]+/)].map((w) => w.toLowerCase()).filter(Boolean));
    for (const w of words) {
      assert.equal(DENY_HASHES.includes(sha256(w)), false, `a word hashes to a denied name`);
    }
  });
}
