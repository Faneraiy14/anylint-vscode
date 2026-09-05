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

// Бічна панель (TreeView) - будується напряму з diagnostics (не з
// findingsByDocUri), щоб не тримати другу паралельну структуру даних:
// усе, що показує Problems-панель VS Code, показує й наша.
class AnyLintFindingItem extends vscode.TreeItem {
    constructor(uri, diagnostic) {
        super(diagnostic.message, vscode.TreeItemCollapsibleState.None);
        this.description = diagnostic.code;
        this.tooltip = `[${diagnostic.code}] ${diagnostic.message}`;
        this.iconPath = new vscode.ThemeIcon(
            diagnostic.severity === vscode.DiagnosticSeverity.Error ? 'error'
                : diagnostic.severity === vscode.DiagnosticSeverity.Warning ? 'warning'
                    : 'info'
        );
        this.command = {
            command: 'vscode.open',
            title: 'Відкрити знахідку',
            arguments: [uri, { selection: diagnostic.range }],
        };
    }
}

class AnyLintFileItem extends vscode.TreeItem {
    constructor(uri, diags) {
        super(path.basename(uri.fsPath), vscode.TreeItemCollapsibleState.Expanded);
        this.description = String(diags.length);
        this.resourceUri = uri;
        this.contextValue = 'anylintFile';
        this.fileUri = uri;
        this.diags = diags;
    }
}

class AnyLintTreeProvider {
    constructor(diagnosticsCollection) {
        this.diagnosticsCollection = diagnosticsCollection;
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    }

    refresh() {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element) {
        return element;
    }

    getChildren(element) {
        if (!element) {
            const files = [];
            this.diagnosticsCollection.forEach((uri, diags) => {
                if (diags.length > 0) files.push(new AnyLintFileItem(uri, diags));
            });
            files.sort((a, b) => a.label.localeCompare(b.label));
            return files;
        }
        if (element instanceof AnyLintFileItem) {
            return element.diags
                .slice()
                .sort((a, b) => a.range.start.line - b.range.start.line)
                .map((d) => new AnyLintFindingItem(element.fileUri, d));
        }
        return [];
    }
}

const treeProvider = new AnyLintTreeProvider(diagnostics);

function isSupported(document) {
    if (document.uri.scheme !== 'file') return false;
    return SUPPORTED_EXTENSIONS.has(path.extname(document.uri.fsPath));
}

// binPath не заданий явно (типовий випадок) - шукаємо сусідню теку
// "anylint" поруч із поточним workspace-коренем (найчастіший сценарій:
// клони репозиторіїв лежать в одній батьківській теці). Якщо workspace
// відкритий не поруч з anylint (інша тека, інший диск, інший користувач) -
// евристика не спрацює, і замість вгадування точного шляху (який працює
// тільки в одного конкретного користувача) користувачу пропонується
// обрати файл вручну через promptForBinPath().
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

// Відкриває системний діалог вибору файлу, зберігає обраний шлях у
// налаштування (User scope, щоб діяло у всіх workspace) і повертає його -
// щоб виклик міг одразу продовжити аналіз без повторного натискання команди.
async function promptForBinPath() {
    const picked = await vscode.window.showOpenDialog({
        title: 'Оберіть виконуваний файл bin/anylint',
        canSelectMany: false,
        canSelectFolders: false,
        openLabel: 'Обрати',
    });
    if (!picked || picked.length === 0) return null;

    const binPath = picked[0].fsPath;
    await vscode.workspace
        .getConfiguration('anylint')
        .update('binPath', binPath, vscode.ConfigurationTarget.Global);
    return binPath;
}

async function resolveBinPathOrPrompt() {
    const found = resolveBinPath();
    if (found) return found;

    const choice = await vscode.window.showWarningMessage(
        'AnyLint: не знайдено bin/anylint. Задай "anylint.binPath" у налаштуваннях.',
        'Обрати файл...'
    );
    if (choice !== 'Обрати файл...') return null;
    return promptForBinPath();
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

function findingsToDiagnostics(findings, document) {
    return findings.map((f) => {
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
    diagnostics.set(document.uri, findingsToDiagnostics(result.findings, document));
    treeProvider.refresh();
}

function analyzeAllOpenDocuments() {
    vscode.workspace.textDocuments.forEach((doc) => analyzeDocument(doc));
}

// На відміну від analyzeAllOpenDocuments() (лише вкладки, вже відкриті в
// редакторі), тут anylint отримує КОРІНЬ workspace одним викликом -
// Analyzer::analyzePath() у самому anylint сам рекурсивно обходить
// директорію, тож це один subprocess на весь проєкт, а не по одному на
// кожен файл. Findings групуються за f.file, і лише файли З findings
// відкриваються через openTextDocument() (без показу в редакторі) - щоб
// побудувати Range з реального тексту рядка, не одним оком не читаючи
// увесь інакше чистий проєкт.
async function analyzeWorkspace() {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        vscode.window.showWarningMessage('AnyLint: немає відкритого workspace для сканування.');
        return;
    }
    const binPath = await resolveBinPathOrPrompt();
    if (!binPath) {
        return;
    }
    const phpPath = vscode.workspace.getConfiguration('anylint').get('phpPath') || 'php';

    const workspaceRoot = folders[0].uri.fsPath;
    const result = await runAnylint(workspaceRoot, binPath, phpPath);
    if (!result.ok) {
        vscode.window.showErrorMessage(`AnyLint: ${result.error}`);
        return;
    }

    const byFile = new Map();
    for (const f of result.findings) {
        if (!byFile.has(f.file)) byFile.set(f.file, []);
        byFile.get(f.file).push(f);
    }

    // Файл, що раніше мав знахідки в межах цього ж workspace, а тепер
    // (уже полагоджений) відсутній у byFile, інакше лишився б назавжди
    // "брудним" у панелі й Problems - жоден наступний прогін
    // analyzeWorkspace() його вже не торкається, бо цикл нижче лише
    // ДОДАЄ записи для файлів З поточними знахідками.
    const staleUris = [];
    diagnostics.forEach((uri) => {
        if (uri.fsPath.startsWith(workspaceRoot) && !byFile.has(uri.fsPath)) staleUris.push(uri);
    });
    for (const uri of staleUris) {
        diagnostics.delete(uri);
        findingsByDocUri.delete(uri.toString());
    }

    for (const [file, findings] of byFile) {
        const uri = vscode.Uri.file(file);
        let document;
        try {
            document = await vscode.workspace.openTextDocument(uri);
        } catch {
            continue; // файл зник/недоступний між прогоном anylint і зараз - пропускаємо, не падаємо
        }
        findingsByDocUri.set(uri.toString(), findings);
        diagnostics.set(uri, findingsToDiagnostics(findings, document));
    }

    treeProvider.refresh();
    vscode.window.showInformationMessage(
        byFile.size > 0
            ? `AnyLint: ${result.findings.length} знахідок у ${byFile.size} файлах.`
            : 'AnyLint: проблем не знайдено.'
    );
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
    context.subscriptions.push(vscode.window.registerTreeDataProvider('anylintFindings', treeProvider));

    context.subscriptions.push(
        vscode.commands.registerCommand('anylint.runOnCurrentFile', () => {
            const editor = vscode.window.activeTextEditor;
            if (editor) analyzeDocument(editor.document);
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('anylint.refreshAll', analyzeAllOpenDocuments)
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('anylint.scanWorkspace', analyzeWorkspace)
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
            treeProvider.refresh();
        })
    );

    // Файли, вже відкриті на момент активації - onDidOpenTextDocument їх не ловить.
    analyzeAllOpenDocuments();
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
    _internal: {
        isSupported, resolveBinPath, runAnylint, findMatchingFinding, findingsByDocUri, SUPPORTED_EXTENSIONS,
        diagnostics, treeProvider, AnyLintFileItem, AnyLintFindingItem, analyzeDocument,
        findingsToDiagnostics, analyzeWorkspace,
    },
};
