// Prints "relpath<TAB>size<TAB>mtimeMs" for every file under a directory, sorted,
// skipping any path with an .obsidian segment (Obsidian writes its own config there).
import { lstatSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function snapshot(dir) {
  const rows = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const ent of readdirSync(cur, { withFileTypes: true })) {
      if (ent.name === ".obsidian") continue;
      const full = join(cur, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile()) {
        const st = lstatSync(full);
        rows.push(`${relative(dir, full).split("\\").join("/")}\t${st.size}\t${st.mtimeMs}`);
      }
    }
  }
  return rows.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: node demo/snapshot.mjs <dir>");
    process.exit(2);
  }
  for (const line of snapshot(dir)) console.log(line);
}
