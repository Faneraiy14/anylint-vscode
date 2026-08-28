// extension.js — точка входу розширення: запускає anylint (bin/anylint
// --json) на файлі, конвертує Finding[] у vscode.Diagnostic[], і реєструє
// CodeActionProvider, що застосовує Finding.fix (байтові зсуви + заміна)
// там, де правило його дає (наразі лише promotable-return-type).

const vscode = require('vscode');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

// Розширення файлів, за якими anylint взагалі має сенс запускати -
// продубльовано з supports() кожного LanguageProvider (src/Providers/*.php
// у самому anylint) навмисно client-side: без цього список кожен запуск
// на .json/.md-файлі був би марним процесом-і-нічого-не-знайшов, а
// заразом і шумом у Output-панелі, якщо там колись з'явиться логування.
const SUPPORTED_EXTENSIONS = new Set([
    '.php', '.nx',
    '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx',
    '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx',
    '.cs', '.java', '.py', '.rs', '.swift', '.go', '.kt', '.kts',
    '.rb', '.dart', '.zig', '.m', '.mm', '.sol',
]);

const diagnostics = vscode.languages.createDiagnosticCollection('anylint');
// findingsByDocUri: uri.toString() -> Finding[] з останнього прогону -
// CodeActionProvider читає звідси (vscode.Diagnostic сам по собі не несе
// достатньо структурованих даних для fix, тому зберігаємо сирі Finding
// окремо, індексовані тим самим документом).
const findingsByDocUri = new Map();
const debounceTimers = new Map();

function isSupported(document) {
    if (document.uri.scheme !== 'file') return false;
    return SUPPORTED_EXTENSIONS.has(path.extname(document.uri.fsPath));
}

// binPath не заданий явно (типовий випадок) - шукаємо сусідню теку
// "anylint" поруч із поточним workspace-коренем (найчастіший сценарій:
// клони репозиторіїв лежать в одній батьківській теці, як у автора).
function resolveBinPath() {
    const configured = vscode.workspace.getConfiguration('anylint').get('binPath');
    if (configured && configured.trim() !== '') return configured;

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return null;

    const workspaceRoot = folders[0].uri.fsPath;
    const candidates = [
        path.join(workspaceRoot, 'bin', 'anylint'), // сам workspace - це anylint
        path.join(path.dirname(workspaceRoot), 'anylint', 'bin', 'anylint'), // сусідня тека
    ];
    for (const c of candidates) {
        if (fs.existsSync(c)) return c;
    }
    return null;
}

function runAnylint(filePath, binPath, phpPath) {
    return new Promise((resolve) => {
        execFile(phpPath, [binPath, filePath, '--json'], { maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
            // --json завжди друкує валідний JSON і при findings, і без
            // (лише exit-код відрізняється - 1 за наявності findings) -
            // тому саме stdout, а не error, вирішує, чи прогін вдався.
            if (!stdout) {
                resolve({ ok: false, error: error ? error.message : 'порожня відповідь' });
                return;
            }
            try {
                const parsed = JSON.parse(stdout);
                resolve({ ok: true, findings: parsed.findings ?? [] });
            } catch (e) {
                resolve({ ok: false, error: `Не вдалося розпарсити відповідь anylint: ${e.message}` });
            }
        });
    });
}

async function analyzeDocument(document) {
    if (!isSupported(document)) return;

    const binPath = resolveBinPath();
    if (!binPath) {
        return; // тихо пропускаємо - немає сенсу нав'язливо повідомляти на кожному збереженні
    }
    const phpPath = vscode.workspace.getConfiguration('anylint').get('phpPath') || 'php';

    const result = await runAnylint(document.uri.fsPath, binPath, phpPath);
    if (!result.ok) {
        return;
    }

    findingsByDocUri.set(document.uri.toString(), result.findings);

    const diags = result.findings.map((f) => {
        const line = Math.max(0, f.line - 1);
        const lineText = line < document.lineCount ? document.lineAt(line).text : '';
        const range = new vscode.Range(line, 0, line, lineText.length);
        const severity =
            f.severity === 'error' ? vscode.DiagnosticSeverity.Error
                : f.severity === 'warning' ? vscode.DiagnosticSeverity.Warning
                    : vscode.DiagnosticSeverity.Information;
        const diag = new vscode.Diagnostic(range, f.message, severity);
        diag.source = `anylint:${f.rule}`;
        diag.code = f.rule;
        return diag;
    });

    diagnostics.set(document.uri, diags);
}

function scheduleAnalyze(document, delayMs) {
    if (!isSupported(document)) return;
    const key = document.uri.toString();
    clearTimeout(debounceTimers.get(key));
    debounceTimers.set(key, setTimeout(() => analyzeDocument(document), delayMs));
}

// Знаходить Finding, що відповідає конкретному Diagnostic - за рядком і
// правилом (не за message, бо повідомлення однієї й тієї ж знахідки
// можуть повторюватись на сусідніх рядках для інших змінних/типів).
function findMatchingFinding(document, diagnostic) {
    const findings = findingsByDocUri.get(document.uri.toString()) || [];
    const line = diagnostic.range.start.line + 1;
    return findings.find((f) => f.line === line && f.rule === diagnostic.code && f.fix);
}

const codeActionProvider = {
    provideCodeActions(document, range, context) {
        const actions = [];
        for (const diagnostic of context.diagnostics) {
            if (diagnostic.source && diagnostic.source.startsWith('anylint:')) {
                const finding = findMatchingFinding(document, diagnostic);
                if (!finding) continue;

                const action = new vscode.CodeAction(
                    `AnyLint: застосувати "${finding.fix.replacement.trim()}"`,
                    vscode.CodeActionKind.QuickFix
                );
                action.diagnostics = [diagnostic];
                action.edit = new vscode.WorkspaceEdit();
                const startPos = document.positionAt(finding.fix.startOffset);
                const endPos = document.positionAt(finding.fix.endOffset);
                action.edit.replace(document.uri, new vscode.Range(startPos, endPos), finding.fix.replacement);
                actions.push(action);
            }
        }
        return actions;
    },
};

function activate(context) {
    context.subscriptions.push(diagnostics);
    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider(
            { scheme: 'file' },
            codeActionProvider,
            { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('anylint.runOnCurrentFile', () => {
            const editor = vscode.window.activeTextEditor;
            if (editor) analyzeDocument(editor.document);
        })
    );

    const runOn = () => vscode.workspace.getConfiguration('anylint').get('runOn') || 'save';

    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument((doc) => analyzeDocument(doc))
    );
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument((doc) => analyzeDocument(doc))
    );
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument((e) => {
            if (runOn() === 'type') scheduleAnalyze(e.document, 800);
        })
    );
    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument((doc) => {
            clearTimeout(debounceTimers.get(doc.uri.toString()));
            debounceTimers.delete(doc.uri.toString());
            findingsByDocUri.delete(doc.uri.toString());
            diagnostics.delete(doc.uri);
        })
    );

    // Файли, вже відкриті на момент активації - onDidOpenTextDocument їх не ловить.
    vscode.workspace.textDocuments.forEach((doc) => analyzeDocument(doc));
}

function deactivate() {
    for (const timer of debounceTimers.values()) clearTimeout(timer);
    debounceTimers.clear();
}

module.exports = {
    activate,
    deactivate,
    // Внутрішні функції - лише для тестів (test/*.mjs), не частина
    // публічного контракту розширення для VS Code самого по собі.
    _internal: { isSupported, resolveBinPath, runAnylint, findMatchingFinding, findingsByDocUri, SUPPORTED_EXTENSIONS },
};
