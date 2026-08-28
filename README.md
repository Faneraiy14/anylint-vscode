# AnyLint for VS Code

*[Українською](README.uk.md)*

A VS Code extension that runs [anylint](https://github.com/Faneraiy14/anylint)
(a cross-platform static analyzer covering 16 languages through one shared
plugin architecture) directly in the editor: inline diagnostics on save, a
Quick Fix for rules that support one, and a sidebar view listing every
finding across your open files.

## Why this exists

anylint already did the hard part — one canonical AST, rules written once
that work across PHP, JS/TS, and 14 more languages via tree-sitter. This
extension is the thin editor layer on top: run the CLI, turn `Finding[]`
into `vscode.Diagnostic[]`, and — where a `Finding` carries a `fix` (byte
offsets + replacement text) — offer it as a one-click Quick Fix instead of
just pointing at the problem.

Right now only `promotable-return-type` (PHP: a `@return TYPE` docblock
that could be a native return type) ships a fix. More anylint rules can
gain one over time without any changes here — the extension already applies
whatever `fix` a `Finding` carries, generically.

## Setup

1. Clone [anylint](https://github.com/Faneraiy14/anylint) somewhere (a
   sibling folder to your project works out of the box — see below).
2. Install this extension (see **Package & install** below).
3. Open a workspace. The extension looks for `anylint` in this order:
   - the `anylint.binPath` setting, if you set one
   - `<your-workspace>/bin/anylint` (if your workspace *is* anylint)
   - `../anylint/bin/anylint` relative to your workspace (a sibling clone)

If none of those exist, the extension stays quiet rather than nagging on
every save — set `anylint.binPath` explicitly if your layout doesn't match.

## Sidebar

A dedicated "AnyLint" icon in the Activity Bar opens a tree view: one node
per file with open findings, its children the findings themselves (severity
icon, message, rule as the description), sorted by line. Click one to jump
straight to it. Two buttons in the view's title bar:

- 🔍 **Scan workspace** (`anylint.scanWorkspace`) — one `bin/anylint <workspace-root> --json`
  call covering the whole project, not just open tabs. This is the one to
  reach for right after opening a project — the tree starts empty
  otherwise, since nothing's been analyzed yet.
- 🔄 **Refresh open files** (`anylint.refreshAll`) — re-runs anylint on
  every currently open editor tab only; faster when you just want to
  recheck what you're actively working on.

A workspace scan also clears out findings for files that got fixed since
the last scan (diffed against the previous run, not just additive) —
otherwise a resolved finding would sit in the tree forever until you
touched that file again.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `anylint.phpPath` | `"php"` | Command to run PHP (anylint itself is PHP, regardless of what language it's analyzing) |
| `anylint.binPath` | `""` | Absolute path to `bin/anylint`; empty = auto-detect (see above) |
| `anylint.runOn` | `"save"` | `"save"` or `"type"` (debounced 800ms) |

## Package & install

```bash
npm install -g @vscode/vsce
vsce package
code --install-extension anylint-vscode-0.1.0.vsix
```

## Architecture

- `extension.js` — everything: spawns `php bin/anylint <file> --json`,
  maps `Finding[]` to `vscode.Diagnostic[]`, registers a
  `CodeActionProvider` that applies `Finding.fix` generically (any rule
  that starts carrying one gets a working Quick Fix for free), and a
  `TreeDataProvider` (`AnyLintTreeProvider`) that reads straight off the
  same `vscode.DiagnosticCollection` the Problems panel uses, rather than
  keeping a second parallel copy of the findings. `analyzeWorkspace()`
  runs anylint once against the workspace root (anylint's own CLI already
  walks directories recursively — no need to loop per file), then opens
  only the files that came back with findings (via `openTextDocument`,
  without showing them) to build `Range`s from the real line text.
- `media/icon.png` — the extension's Marketplace/Extensions-list icon.
  `media/activitybar-icon.svg` — the monochrome Activity Bar icon
  (`currentColor` outline, VS Code recolors it per theme).
- `test/smoke.mjs` — tests the real logic (extension detection, the
  actual anylint subprocess call, fix-matching, tree provider, workspace
  scanning) against a minimal mock of the `vscode` module plus real
  anylint runs against `test/fixtures/*.php`. No `@vscode/test-electron` /
  full editor launch needed for this.
- `test/vscode-mock/` — the mock itself, a local `devDependency`
  (`"vscode": "file:test/vscode-mock"` in `package.json`) so `npm install`
  symlinks it into `node_modules/vscode` — a fresh clone gets working
  tests, not just working code, without a real `vscode` npm package
  existing anywhere.

```bash
npm install
npm test
```

## License

MIT — Faneraiy14.
