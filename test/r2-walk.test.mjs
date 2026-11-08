// Round-2 test for the names index (src/walk.ts), F15: one unreadable folder inside a skipped
// root must not take the rest of that root out of the index.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { makeFake, tmpVault, writeTree } from "./fake.mjs";
import { newState, installHooks } from "../.testbuild/hooks.mjs";
import { indexSkipped, indexedFiles } from "../.testbuild/walk.mjs";
import { DEFAULT_SETTINGS } from "../.testbuild/data.mjs";

const TODAY = 20000;

test("F15: an unreadable folder inside a skipped root does not drop the root's other notes", { skip: process.getuid?.() === 0 && "root reads every folder" }, async () => {
  const base = tmpVault();
  writeTree(base, ["Proj/.git/HEAD", "Proj/keep.md", "Proj/sub/hidden.md", "Home.md"]);
  const locked = join(base, "Proj", "sub");
  chmodSync(locked, 0o000);
  try {
    const fake = makeFake(base);
    const s = newState(base, {
      settings: { ...DEFAULT_SETTINGS },
      history: { vaultBase: base, firstSeenDay: TODAY - 60, lastActive: {}, startups: [] },
      today: TODAY,
      startup: true,
      protect: [],
    });
    s.changed = () => {};
    const { problems } = installHooks(fake.targets, s, fake.deps);
    assert.deepEqual(problems, []);
    await fake.adapter.listAll();
    s.ctx.startup = false;
    s.indexing = indexSkipped(s);
    await s.indexing;
    assert.ok(indexedFiles(s).includes("Proj/keep.md"), `index: ${JSON.stringify(indexedFiles(s))}`);

    const leaf = Object.create(fake.leafProto);
    await leaf.openLinkText("keep", "Home.md");
    assert.equal(existsSync(join(base, "keep.md")), false, "a root keep.md was created: fork");
    assert.ok(fake.opened.includes("Proj/keep.md"), `opened: ${JSON.stringify(fake.opened)}`);
  } finally {
    chmodSync(locked, 0o755);
  }
});
