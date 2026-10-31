// Runs an isolated Obsidian instance against a scratch clone of a vault, once with the
// plugin off (R1-R4) and once with it on (R5-R8), and checks the demo PASS list.
// Never touches a real vault or the real obsidian.json (only hashes it).
//
// node demo/measure.mjs --vault <clone> --userdata <dir> --home <dir> --out <dir> \
//   --real-config <path> --expect-version 1.14.5 [--app <binary>]
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { snapshot } from "./snapshot.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DAY_MS = 86400000;
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => {
  const s = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const LAYOUT = {
  main: {
    id: "m0",
    type: "split",
    direction: "vertical",
    children: [{ id: "t0", type: "tabs", children: [{ id: "l0", type: "leaf", state: { type: "empty", state: {} } }] }],
  },
  right: {
    id: "r0",
    type: "split",
    direction: "horizontal",
    width: 460,
    children: [
      {
        id: "t1",
        type: "tabs",
        children: [{ id: "lv0", type: "leaf", state: { type: "lazy-vault", state: {} } }],
      },
    ],
  },
  active: "lv0",
  lastOpenFiles: [],
};

function parseArgs(argv) {
  const out = { app: "/Applications/Obsidian.app/Contents/MacOS/Obsidian" };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const val = argv[i + 1];
    if (!key?.startsWith("--") || val === undefined || val.startsWith("--")) {
      throw new Error(`bad argument near ${key}`);
    }
    out[key.slice(2)] = val;
  }
  for (const k of ["vault", "userdata", "home", "out", "real-config", "expect-version"]) {
    if (!out[k]) throw new Error(`missing --${k}`);
  }
  return out;
}

const readJsonOr = (p, fallback) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
};
const writeJson = (p, obj) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
};

// All .md files under a folder (vault-relative, "/" separated), skipping dot-entries.
function mdUnder(vault, folder) {
  const out = [];
  const stack = [folder];
  while (stack.length) {
    const rel = stack.pop();
    const abs = rel ? join(vault, rel) : vault;
    if (!existsSync(abs)) continue;
    for (const ent of readdirSync(abs, { withFileTypes: true })) {
      if (ent.name.startsWith(".")) continue;
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) stack.push(r);
      else if (ent.isFile() && ent.name.endsWith(".md")) out.push(r);
    }
  }
  return out.sort();
}

// The link target for the selftest: the first .md under Archive/ (or Reference/ when Archive has none)
// whose basename is unique across the clone.
function pickNote(vault) {
  const all = mdUnder(vault, "");
  const counts = new Map();
  for (const p of all) {
    const b = p.split("/").pop();
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  let pool = mdUnder(vault, "Archive");
  if (!pool.length) pool = mdUnder(vault, "Reference");
  const pick = pool.find((p) => counts.get(p.split("/").pop()) === 1);
  if (!pick) throw new Error("no .md under Archive/ or Reference/ with a unique basename");
  return pick;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const expect = args["expect-version"];
  const vault = resolve(args.vault);
  const home = resolve(args.home);
  const out = resolve(args.out);
  const userdata = resolve(args.userdata);
  const realConfig = resolve(args["real-config"]);

  // Refuse anything inside ~/Documents: the clone must be a scratch copy.
  let vaultReal = realpathSync(vault);
  let docs = null;
  try {
    docs = realpathSync(join(homedir(), "Documents"));
  } catch {
    docs = null;
  }
  if (docs && (vaultReal === docs || vaultReal.startsWith(docs + sep))) {
    throw new Error("refusing: --vault is inside ~/Documents; use a scratch clone");
  }
  if (!existsSync(join(vault, ".obsidian"))) throw new Error("--vault has no .obsidian folder");
  if (!existsSync(args.app)) throw new Error(`app not found: ${args.app}`);
  const realConfigBefore = sha(readFileSync(realConfig));

  mkdirSync(out, { recursive: true });
  mkdirSync(home, { recursive: true });
  const candidates = [vault, vaultReal];
  const historyFile = () => {
    for (const name of readdirSync(home)) {
      if (!name.endsWith(".json")) continue;
      const p = join(home, name);
      const h = readJsonOr(p, null);
      if (h && candidates.includes(h.vaultBase)) return p;
    }
    return null;
  };
  const readHistory = () => {
    const f = historyFile();
    return f ? readJsonOr(f, null) : null;
  };
  const lastStartup = (h) => h?.startups?.at(-1) ?? null;

  const chosen = pickNote(vault);
  const chosenBase = chosen.split("/").pop().replace(/\.md$/, "");

  function writeConfig({ enabled, sync }) {
    const obs = join(vault, ".obsidian");
    writeJson(join(obs, "workspace.json"), LAYOUT);
    const core = readJsonOr(join(obs, "core-plugins.json"), {});
    core.sync = sync;
    writeJson(join(obs, "core-plugins.json"), core);
    const dataPath = join(obs, "plugins", "lazy-vault", "data.json");
    const data = readJsonOr(dataPath, {});
    data.enabled = enabled;
    writeJson(dataPath, data);
  }

  function launch(extraEnv) {
    const env = { ...process.env, LAZY_VAULT_HOME: home };
    delete env.LAZY_VAULT_SELFTEST_LINK;
    Object.assign(env, extraEnv ?? {});
    return spawn(args.app, [`--user-data-dir=${userdata}`], { env, stdio: "ignore" });
  }

  // Stops only the pid we started: SIGTERM, 20 s, then SIGKILL. Never by pattern.
  async function stop(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((r) => child.once("exit", r));
    child.kill("SIGTERM");
    const done = await Promise.race([exited.then(() => true), sleep(20000).then(() => false)]);
    if (!done) {
      child.kill("SIGKILL");
      await Promise.race([exited, sleep(10000)]);
    }
  }

  async function waitForStartup(prevAt, timeoutMs, { needSelftest }) {
    const deadline = Date.now() + timeoutMs;
    let foundAt = null;
    for (;;) {
      const last = lastStartup(readHistory());
      if (last && last.at > prevAt) {
        foundAt ??= Date.now();
        // Only an on-mode record gets an index count and, when asked, a selftest.
        const live = last.mode === "on";
        const indexed = !live || last.skippedFiles !== null;
        const selftested = !live || !needSelftest || last.selftest !== undefined;
        if (indexed && selftested) return last;
        if (Date.now() - foundAt > 60000) throw new Error("index or selftest not finished within 60 s");
      } else if (foundAt === null && Date.now() > deadline) {
        throw new Error(`no startup record after ${timeoutMs} ms`);
      }
      await sleep(1000);
    }
  }

  async function doRun(id, { enabled, sync, timeoutMs, selftest, screenshot }) {
    writeConfig({ enabled, sync });
    const prevAt = lastStartup(readHistory())?.at ?? 0;
    const child = launch(selftest ? { LAZY_VAULT_SELFTEST_LINK: selftest } : undefined);
    try {
      const rec = await waitForStartup(prevAt, timeoutMs, { needSelftest: Boolean(selftest) });
      if (screenshot) {
        await sleep(5000);
        const winid = execFileSync("swift", [join(HERE, "winid.swift"), String(child.pid)], {
          encoding: "utf8",
          timeout: 120000,
        }).trim();
        execFileSync("screencapture", ["-x", "-o", `-l${winid}`, join(out, "view.png")], { timeout: 60000 });
      }
      console.log(`${id}: mode=${rec.mode} vaultFiles=${rec.vaultFiles} layoutReadyMs=${rec.layoutReadyMs}`);
      return { run: id, ...rec };
    } finally {
      await stop(child);
    }
  }

  const runs = [];
  const T0 = 300000;
  const T = 120000;
  runs.push(await doRun("R0", { enabled: true, sync: true, timeoutMs: T0 }));
  for (const id of ["R1", "R2", "R3", "R4"]) {
    runs.push(await doRun(id, { enabled: false, sync: false, timeoutMs: id === "R1" ? T0 : T }));
  }

  // Seed history so the top-level folders except Archive and Reference are warm and the two are cold.
  const hf = historyFile();
  if (!hf) throw new Error("history file not found after the OFF runs");
  const seed = readJsonOr(hf, null);
  const today = Math.floor(Date.now() / DAY_MS);
  const warm = readdirSync(vault, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "Archive" && e.name !== "Reference")
    .map((e) => e.name);
  seed.firstSeenDay = today - 60;
  seed.lastActive = Object.fromEntries(warm.map((n) => [n, today]));
  writeJson(hf, seed);

  for (const id of ["R5", "R6", "R7", "R8"]) {
    const last = id === "R8";
    runs.push(
      await doRun(id, {
        enabled: true,
        sync: false,
        timeoutMs: id === "R5" ? T0 : T,
        selftest: last ? `${chosenBase}|Home.md` : undefined,
        screenshot: last,
      }),
    );
  }

  // Checks.
  const by = Object.fromEntries(runs.map((r) => [r.run, r]));
  const off = ["R1", "R2", "R3", "R4"].map((k) => by[k]);
  const on = ["R5", "R6", "R7", "R8"].map((k) => by[k]);
  // Medians use R2-R4 (OFF) and R6-R8 (ON); R1 and R5 are warm-ups.
  const offVF = median(off.slice(1).map((r) => r.vaultFiles));
  const onVF = median(on.slice(1).map((r) => r.vaultFiles));
  const offLR = median(off.slice(1).map((r) => r.layoutReadyMs));
  const onLR = median(on.slice(1).map((r) => r.layoutReadyMs));
  const skipped = by.R8.skipped ?? [];
  const repoCount = skipped.filter((s) => s.reason === "repo").length;
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

  check(
    "apiVersion",
    runs.every((r) => r.apiVersion === expect),
    runs.map((r) => `${r.run}=${r.apiVersion}`).join(" "),
  );
  check(
    "R0 failopen with Sync problem",
    by.R0.mode === "failopen" && (by.R0.problems ?? []).some((p) => /sync/i.test(p)),
    `${by.R0.mode}, problems=${JSON.stringify(by.R0.problems)}`,
  );
  check(
    "R0 vaultFiles within 1% of OFF median",
    offVF !== null && Math.abs(by.R0.vaultFiles - offVF) <= 0.01 * offVF,
    `R0=${by.R0.vaultFiles} offMedian=${offVF}`,
  );
  check(
    "R1-R4 off, R5-R8 on with no problems",
    off.every((r) => r.mode === "off") && on.every((r) => r.mode === "on" && r.problems.length === 0),
    on.map((r) => `${r.run}:${r.mode}/${r.problems.length}`).join(" "),
  );
  check(
    "ON median vaultFiles <= 10% of OFF median",
    onVF !== null && offVF !== null && onVF <= 0.1 * offVF,
    `on=${onVF} off=${offVF} ratio=${offVF ? (onVF / offVF).toFixed(4) : "n/a"}`,
  );
  check(
    "ON skipped has Archive:cold, Reference:cold and >= 40 repo roots",
    skipped.some((s) => s.path === "Archive" && s.reason === "cold") &&
      skipped.some((s) => s.path === "Reference" && s.reason === "cold") &&
      repoCount >= 40,
    `repos=${repoCount}`,
  );
  check(
    "ON median layoutReadyMs below OFF median",
    onLR !== null && offLR !== null && onLR < offLR,
    `on=${onLR} off=${offLR} ratio=${offLR ? (onLR / offLR).toFixed(3) : "n/a"}`,
  );
  check(
    "R8 selftest opened the chosen note",
    by.R8.selftest?.opened === chosen,
    `opened=${by.R8.selftest?.opened} expected=${chosen}`,
  );
  const beforeFile = join(out, "before.txt");
  if (existsSync(beforeFile)) {
    const now = snapshot(vault).join("\n");
    const was = readFileSync(beforeFile, "utf8").trimEnd();
    check("before/after snapshot identical", now === was, now === was ? "no change" : "vault changed");
  } else {
    check("before/after snapshot identical", false, "no before.txt in out dir");
  }
  check(
    "real obsidian.json unchanged",
    sha(readFileSync(realConfig)) === realConfigBefore,
    "sha256 compared before and after",
  );
  const png = join(out, "view.png");
  check("view.png exists and > 10 KB", existsSync(png) && statSync(png).size > 10240, png);

  const pass = checks.every((c) => c.ok);
  writeJson(join(out, "results.json"), { expect, runs, checks, medians: { offVF, onVF, offLR, onLR } });
  const rows = runs.map(
    (r) =>
      `| ${r.run} | ${r.mode} | ${r.vaultFiles} | ${r.layoutReadyMs} | ${r.skippedFolders} | ${(r.skipped ?? []).length} | ${(r.problems ?? []).length} |`,
  );
  const md = [
    "| run | mode | vaultFiles | layoutReadyMs | skippedFolders | skipped | problems |",
    "|---|---|---|---|---|---|---|",
    ...rows,
    "",
    ...checks.map((c) => `${c.ok ? "PASS" : "FAIL"} ${c.name}: ${c.detail}`),
    "",
    `Medians (R2-R4 OFF, R6-R8 ON): vaultFiles ON ${onVF} vs OFF ${offVF}; layoutReadyMs ON ${onLR} vs OFF ${offLR}`,
  ].join("\n");
  writeFileSync(join(out, "results.md"), md + "\n");
  console.log(md);

  const realConfigAfter = sha(readFileSync(realConfig));
  if (realConfigAfter !== realConfigBefore) console.error("WARNING: real obsidian.json changed");
  process.exitCode = pass ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
}
