// Test helper, not a test. An in-memory mirror of Obsidian 1.14.5's
// FileSystemAdapter scan and write semantics, running on a real temp directory.
// Method arities match the HOOKS table in src/hooks.ts.
import { promises as fsp, readdirSync, lstatSync, mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, dirname, posix } from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";

export const nfc = (s) => s.normalize("NFC");
export const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const dirOf = (r) => {
  const d = posix.dirname(r);
  return d === "." ? "" : d;
};
const hasDot = (p) => p.split("/").some((s) => s.startsWith("."));

// A fresh temp directory standing in for a vault.
export const tmpVault = () => mkdtempSync(join(tmpdir(), "lazy-vault-"));

// Creates entries. A trailing "/" makes a directory; anything else a file.
export function writeTree(base, paths) {
  for (const p of paths) {
    const full = join(base, p);
    if (p.endsWith("/")) {
      mkdirSync(full, { recursive: true });
    } else {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, "x\n");
    }
  }
}

export function makeFake(base) {
  const opened = [];
  const notices = [];
  const files = {};
  const full = (p) => join(base, p);
  const deleteTree = (p) => {
    for (const k of Object.keys(files)) if (k === p || k.startsWith(p + "/")) delete files[k];
  };

  const adapter = {
    files,
    _q: Promise.resolve(),
    queue(fn) {
      const r = this._q.then(fn);
      this._q = r.catch(() => {});
      return r;
    },
    getBasePath() {
      return base;
    },
    getFullRealPath(p) {
      return full(p);
    },
    getRealPath(p) {
      return p;
    },
    async exists(p) {
      try {
        await fsp.access(full(p));
        return true;
      } catch {
        return false;
      }
    },
    async listAll() {
      for (const k of Object.keys(files)) delete files[k];
      files["/"] = { type: "folder", realpath: "/" };
      await this.listRecursive("");
    },
    async listRecursive(e) {
      const children = await fsp.readdir(full(e));
      await Promise.all(children.map((a) => this.listRecursiveChild(e, a)));
    },
    async listRecursiveChild(e, t) {
      const raw = e === "" ? t : e + "/" + t;
      if (hasDot(raw)) return;
      try {
        await this.reconcileFileInternal(raw, nfc(raw));
      } catch (err) {
        // An unreadable folder is listed as empty, as Obsidian does, and the rest of the scan goes on.
        if (err.code === "EACCES") return;
        if (err.code !== "ENOENT") throw err;
        deleteTree(nfc(raw));
      }
    },
    async reconcileFileInternal(raw, p) {
      const st = await fsp.lstat(full(raw));
      if (st.isDirectory()) {
        if (!files[p]) {
          files[p] = { type: "folder", realpath: raw };
          await this.listRecursive(raw);
        }
      } else {
        files[p] = { type: "file", realpath: raw };
      }
    },
    // Watcher and write-event path. e is the real path, t the vault path.
    async reconcileFile(e, t) {
      const p = nfc(t);
      if (hasDot(t)) {
        delete files[p];
        return;
      }
      const parentRaw = dirOf(t);
      const parent = nfc(parentRaw);
      if (parent !== "" && !files[parent]) await this.reconcileFile(parentRaw, parent);
      try {
        await this.reconcileFileInternal(e, p);
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
        deleteTree(p);
      }
    },
    // Writes: the fs call, then reconcile the touched path. No mkdir, like Obsidian.
    write(p, data, opts) {
      return this.queue(async () => {
        await fsp.writeFile(full(p), data);
        await this.reconcileFile(p, p);
      });
    },
    writeBinary(p, data, opts) {
      return this.queue(async () => {
        await fsp.writeFile(full(p), Buffer.from(data));
        await this.reconcileFile(p, p);
      });
    },
    append(p, data, opts) {
      return this.queue(async () => {
        await fsp.appendFile(full(p), data);
        await this.reconcileFile(p, p);
      });
    },
    appendBinary(p, data, opts) {
      return this.queue(async () => {
        await fsp.appendFile(full(p), Buffer.from(data));
        await this.reconcileFile(p, p);
      });
    },
    process(p, fn, opts) {
      return this.queue(async () => {
        const next = fn(await fsp.readFile(full(p), "utf8"));
        await fsp.writeFile(full(p), next);
        await this.reconcileFile(p, p);
        return next;
      });
    },
    mkdir(p) {
      return this.queue(async () => {
        await fsp.mkdir(full(p), { recursive: true });
        await this.reconcileFile(p, p);
      });
    },
    remove(p) {
      return this.queue(async () => {
        await fsp.rm(full(p), { recursive: true });
        deleteTree(nfc(p));
      });
    },
    trashSystem(p) {
      return this.remove(p).then(() => true);
    },
    trashLocal(p) {
      return this.remove(p);
    },
    rmdir(p, recursive) {
      return this.queue(async () => {
        await fsp.rm(full(p), { recursive: !!recursive });
        deleteTree(nfc(p));
      });
    },
    copy(a, b) {
      return this.queue(async () => {
        await fsp.cp(full(a), full(b), { recursive: true });
        await this.reconcileFile(b, b);
      });
    },
    rename(a, b) {
      return this.queue(async () => {
        await fsp.rename(full(a), full(b));
        deleteTree(nfc(a));
        await this.reconcileFile(b, b);
      });
    },
  };

  const vault = {
    adapter,
    getAbstractFileByPath(p) {
      const e = files[nfc(p)];
      return e && e.type === "file" ? { path: nfc(p) } : null;
    },
    async create(p, data, opts) {
      if (await adapter.exists(p)) throw new Error("File already exists.");
      await adapter.write(p, data);
      return vault.getAbstractFileByPath(p);
    },
    async createBinary(p, data, opts) {
      if (await adapter.exists(p)) throw new Error("File already exists.");
      await adapter.writeBinary(p, data);
      return vault.getAbstractFileByPath(p);
    },
    async createFolder(p) {
      if (await adapter.exists(p)) throw new Error("Folder already exists.");
      await adapter.mkdir(p);
    },
  };

  const fileManager = {
    async renameFile(file, newPath) {
      await adapter.rename(file.path, newPath);
    },
  };

  const deps = {
    parseLinktext(t) {
      const core = t.split("|")[0];
      const h = core.search(/[#^]/);
      return h < 0 ? { path: core, subpath: "" } : { path: core.slice(0, h), subpath: core.slice(h) };
    },
    // Resolves against adapter.files only: exact path or path + ".md", else a
    // basename match, same folder first, then shortest, then lexical.
    getFirstLinkpathDest(lp, src) {
      const want = nfc(lp).toLowerCase();
      const cands = [want, want + ".md"];
      const keys = Object.keys(files).filter((k) => files[k].type === "file");
      const exact = keys.filter((k) => cands.includes(k.toLowerCase())).sort();
      if (exact.length) return { path: exact[0] };
      const sd = dirOf(nfc(src));
      const hits = keys
        .filter((k) => cands.some((c) => k.toLowerCase().endsWith("/" + c)))
        .sort((a, b) => {
          const sa = dirOf(a) === sd ? 0 : 1;
          const sb = dirOf(b) === sd ? 0 : 1;
          return sa - sb || a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
        });
      return hits.length ? { path: hits[0] } : null;
    },
    getFile(p) {
      return vault.getAbstractFileByPath(p);
    },
    notice(m) {
      notices.push(m);
    },
  };

  // The original WorkspaceLeaf.prototype.openLinkText: create-on-click.
  const leafProto = {
    async openLinkText(linktext, sourcePath, openState) {
      const { path } = deps.parseLinktext(linktext);
      const f = deps.getFirstLinkpathDest(path, sourcePath);
      if (f) return this.openFile(f, openState);
      const created = await vault.create(path + ".md", "");
      return this.openFile(created, openState);
    },
    async openFile(f) {
      opened.push(f.path);
    },
  };

  const targets = { adapter, vault, fileManager, leafProto };
  return { base, adapter, vault, fileManager, leafProto, deps, targets, opened, notices };
}

// Sorted keys of a scan with no hooks installed. The reference for "unchanged scan".
export async function plainScan(base) {
  const f = makeFake(base);
  await f.adapter.listAll();
  return Object.keys(f.adapter.files).sort();
}

// Sorted non-dot file paths on disk, NFC-normalised.
export function diskFiles(base) {
  const out = [];
  const walk = (rel) => {
    for (const name of readdirSync(join(base, rel))) {
      if (name.startsWith(".")) continue;
      const r = rel === "" ? name : rel + "/" + name;
      if (lstatSync(join(base, r)).isDirectory()) walk(r);
      else out.push(nfc(r));
    }
  };
  walk("");
  return out.sort();
}

// Every entry on disk, dot entries included, as relative paths (files only).
export function allFiles(base) {
  const out = [];
  const walk = (rel) => {
    for (const name of readdirSync(join(base, rel))) {
      const r = rel === "" ? name : rel + "/" + name;
      if (lstatSync(join(base, r)).isDirectory()) walk(r);
      else out.push(r);
    }
  };
  walk("");
  return out.sort();
}
