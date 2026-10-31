# Lazy Vault

A desktop Obsidian plugin that stops Obsidian from loading folders you don't need at startup, and loads them when you ask. It never moves, renames, creates or deletes a file.

## What it skips

Obsidian scans the whole vault on startup. In a big vault most of that scan is nested git repositories, build output and folders you haven't opened in a long time. Lazy Vault skips these folders during the scan:

- **Repos**: a folder that contains `.git` (a directory or a file), unless it also contains `.obsidian`. A vault nested inside another vault counts as content, not a repo.
- **Build output**: folders named `node_modules`, `__pycache__`, `target`, `dist`, `build` or `venv` (exact, case-sensitive; editable in settings).
- **Cold folders**: a folder with no opens, edits or writes for 30 days (editable; `0` turns the rule off). Activity is recorded by the plugin itself, not read from file dates. Nothing is cold until the plugin has 30 days of history in that vault.
- **Your skip list**: folders you chose to skip from the next start.

The unit is always a folder, at any depth. The scan never descends into a skipped folder, and the top-most skipped folder is the one that counts.

## What is never skipped

- The vault root and the files directly in it.
- Any folder that holds a file open in your restored layout.
- Anything in your pin list, and the config folders Obsidian and common plugins use (templates, daily notes, attachments, new-file folder).

## Loading on request

- Clicking a link to a note in a skipped folder loads that folder and opens the note. It never creates an empty note in place of the skipped one.
- **Open skipped note...** searches a list of file names in skipped folders. It does not read any note contents.
- **Load all** and per-folder **Load** buttons in the Lazy Vault view.
- A write from another plugin into a skipped folder loads that folder first, so nothing fails or forks.
- Renaming a note loads the cold and listed folders first, so link updates reach them. Repos stay skipped.

## Install

Requires Obsidian desktop 1.6 or later. Mobile is not supported.

```sh
npm ci
npm run install-local
```

`install-local` builds the plugin and copies exactly three files (`main.js`, `manifest.json`, `styles.css`) into `.obsidian/plugins/lazy-vault/` of each target vault. It does not edit `community-plugins.json`, `core-plugins.json` or any other file. Enable the plugin in Obsidian's community plugins list, then restart Obsidian.

By default the targets are the registered vaults under `~/Documents` listed in `install.mjs`. Override them with a colon-separated list:

```sh
OBSIDIAN_VAULTS="/path/to/vault-a:/path/to/vault-b" npm run install-local
```

Empty entries are ignored. A target without a `.obsidian` folder is reported as `no-obsidian` and left alone. The installer also refuses one protected folder name, whatever `OBSIDIAN_VAULTS` says, and reports it as `forbidden`.

Skipping starts at the next Obsidian start. It never starts mid-session.

## Settings

Open Settings, then Lazy Vault. Each change takes effect at the next start.

| Setting | What it does |
|---|---|
| Skip folders | Turns skipping on or off. Off means Obsidian loads everything as usual. |
| Cold after N days | A folder is cold after this many days with no activity. `0` turns the cold rule off. |
| Build folder names | Comma-separated folder names to treat as build output. |
| Allow with Obsidian Sync | See the Sync gate below. |
| Pins | One folder per line. Never skipped. |
| Skip list | One folder per line. Skipped from the next start, even if it isn't cold. |

The folder right-click menu also has **never skip (pin)** and **skip from next start**.

## The Sync gate

Obsidian Sync syncs the files it knows about, and a skipped folder might look deleted to it. So while Sync is on in a vault, Lazy Vault skips nothing unless you turn on **Allow with Obsidian Sync**. The view says why skipping is off.

## The Lazy Vault view

Open it from the ribbon icon or the "Show skipped folders" command. It shows:

- the status: skipping on, off, or fail-open with the reason
- this startup: when the plugin loaded, when the layout was ready, how many files loaded and how many were skipped, and the last five startups
- **Skipped now**: each folder, its reason, its file count, and Load and Pin buttons
- **Loaded this session**: folders loaded since startup, with Skip from next start
- your pins and skip list, with Unpin and Remove

## Fail-open

Before it wraps anything, Lazy Vault checks that every Obsidian hook it needs is present with the expected signature. If one is missing, or the vault is in a mode it doesn't support, it skips nothing and the view lists each problem. Errors inside its own logic fall through to Obsidian's original behaviour and are recorded in the view.

## Trade-off

Search, the graph, backlinks, Dataview and Bases queries, and bookmarks do not see skipped notes until their folder is loaded. Loading a folder brings them back. Obsidian also drops cached metadata for skipped files, so loading a folder re-reads it.

Explicit creates are not guarded. A URI `new` call or the CLI creates a note exactly as before. A URI `open` on a skipped note shows Obsidian's "not found". A repo cloned while Obsidian is running loads normally until the next start.

## Where the history lives

Activity history is kept outside the vault, in `~/Library/Application Support/lazy-vault/` (override with `LAZY_VAULT_HOME`), one file per vault. It stays out of the vault's own version control and settings sync. If a history or settings file is unreadable, it is copied aside as `*.corrupt-<time>`, and the plugin starts from defaults. Nothing goes cold until 30 days of history have built up again.

## Development

```sh
npm test          # build the test bundles and run the node tests
npm run typecheck
npm run build
```

The demo scripts in `demo/` run an isolated copy of a vault in a second Obsidian instance. They refuse any vault inside `~/Documents` and never touch the real Obsidian configuration.
