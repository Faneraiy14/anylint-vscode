// smoke.mjs — тестує реальну логіку розширення (не потребує повного
// VS Code через @vscode/test-electron) через мок node_modules/vscode/
// і РЕАЛЬНИЙ прогін anylint на справжніх файлах з проєкту anylint.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mod = await import('../extension.js');
const _internal = mod.default ? mod.default._internal : mod._internal;

const ANYLINT_BIN = '/home/sviat/Projects/anylint/bin/anylint';
const PHP = 'php';

test('isSupported: .php підтримується, .md - ні', () => {
    const phpDoc = { uri: { scheme: 'file', fsPath: '/x/y.php' } };
    const mdDoc = { uri: { scheme: 'file', fsPath: '/x/y.md' } };
    assert.equal(_internal.isSupported(phpDoc), true);
    assert.equal(_internal.isSupported(mdDoc), false);
});

test('isSupported: non-file scheme (напр. untitled) - ні', () => {
    const doc = { uri: { scheme: 'untitled', fsPath: 'Untitled-1.php' } };
    assert.equal(_internal.isSupported(doc), false);
});

test('SUPPORTED_EXTENSIONS покриває всі 16 мов anylint', () => {
    const expected = [
        '.php', '.nx', '.js', '.ts', '.c', '.cpp', '.cs', '.java',
        '.py', '.rs', '.swift', '.go', '.kt', '.rb', '.dart', '.zig', '.m', '.sol',
    ];
    for (const ext of expected) {
        assert.ok(_internal.SUPPORTED_EXTENSIONS.has(ext), `мав би підтримувати ${ext}`);
    }
});

test('runAnylint: реальний прогін на файлі без знахідок', async () => {
    const clean = path.join(__dirname, 'fixtures', 'clean.php');
    const result = await _internal.runAnylint(clean, ANYLINT_BIN, PHP);
    assert.equal(result.ok, true);
    assert.equal(result.findings.length, 0);
});

test('runAnylint: реальний прогін знаходить promotable-return-type', async () => {
    const dirty = path.join(__dirname, 'fixtures', 'promotable.php');
    const result = await _internal.runAnylint(dirty, ANYLINT_BIN, PHP);
    assert.equal(result.ok, true);
    const promo = result.findings.filter((f) => f.rule === 'promotable-return-type');
    assert.equal(promo.length, 1);
    assert.ok(promo[0].fix, 'знахідка має нести fix');
    assert.equal(promo[0].fix.replacement, ': array|null');
});

test('AnyLintTreeProvider: групує знахідки по файлу й сортує за рядком', () => {
    const uriA = { toString: () => 'file:///a.php', fsPath: '/proj/a.php' };
    const uriB = { toString: () => 'file:///b.php', fsPath: '/proj/b.php' };
    _internal.diagnostics.set(uriA, [
        { message: 'друга', code: 'empty-catch', severity: 1, range: { start: { line: 9 } } },
        { message: 'перша', code: 'dead-code-after-return', severity: 1, range: { start: { line: 2 } } },
    ]);
    _internal.diagnostics.set(uriB, [
        { message: 'єдина', code: 'hardcoded-secret', severity: 0, range: { start: { line: 0 } } },
    ]);

    const files = _internal.treeProvider.getChildren();
    assert.equal(files.length, 2, 'по одному вузлу на кожен файл зі знахідками');
    assert.equal(files[0].label, 'a.php');
    assert.equal(files[0].description, '2');

    const findingsA = _internal.treeProvider.getChildren(files[0]);
    assert.equal(findingsA.length, 2);
    assert.equal(findingsA[0].label, 'перша', 'відсортовано за номером рядка, а не порядком у масиві');
    assert.equal(findingsA[1].label, 'друга');
    assert.equal(findingsA[0].command.command, 'vscode.open', 'клік має відкривати файл на рядку знахідки');

    _internal.diagnostics.delete(uriA);
    _internal.diagnostics.delete(uriB);
});

test('AnyLintTreeProvider: файл без знахідок (порожній diags) - не показується', () => {
    const uri = { toString: () => 'file:///clean.php', fsPath: '/proj/clean.php' };
    _internal.diagnostics.set(uri, []);
    const files = _internal.treeProvider.getChildren();
    assert.equal(files.find((f) => f.fileUri === uri), undefined);
});

test('findMatchingFinding: знаходить Finding за рядком і правилом діагностики', () => {
    const uri = { toString: () => 'file:///fake.php' };
    const document = { uri };
    _internal.findingsByDocUri.set(uri.toString(), [
        { line: 5, rule: 'promotable-return-type', fix: { startOffset: 10, endOffset: 10, replacement: ': int' } },
        { line: 7, rule: 'unused-variable' }, // без fix - не має підходити
    ]);
    const diagnostic = { range: { start: { line: 4 } }, code: 'promotable-return-type' }; // 0-indexed рядок 4 = Finding.line 5
    const found = _internal.findMatchingFinding(document, diagnostic);
    assert.ok(found);
    assert.equal(found.fix.replacement, ': int');

    const noFix = _internal.findMatchingFinding(document, { range: { start: { line: 6 } }, code: 'unused-variable' });
    assert.equal(noFix, undefined, 'знахідка без fix не повинна повертатись як придатна для quick fix');

    _internal.findingsByDocUri.delete(uri.toString());
});
