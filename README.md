# AnyLint for VS Code

*[Українською](README.uk.md)*

A VS Code extension that runs [anylint](https://github.com/Faneraiy14/anylint)
(a cross-platform static analyzer covering 16 languages through one shared
plugin architecture) directly in the editor: inline diagnostics on save, plus
a Quick Fix for rules that support one.

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
  maps `Finding[]` to `vscode.Diagnostic[]`, and registers a
  `CodeActionProvider` that applies `Finding.fix` generically (any rule
  that starts carrying one gets a working Quick Fix for free).
- `test/smoke.mjs` — tests the real logic (extension detection, the
  actual anylint subprocess call, fix-matching) against a minimal mock of
  the `vscode` module (`node_modules/vscode/` — test-only, not a real
  dependency) plus real anylint runs against `test/fixtures/*.php`. No
  `@vscode/test-electron` / full editor launch needed for this.

## License

MIT — Faneraiy14.
