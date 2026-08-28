// Мінімальний мок модуля "vscode" - лише те, що реально використовує
// extension.js. Не для продакшену - лише щоб можна було протестувати
// логіку розширення (isSupported, resolveBinPath, formatFinding->
// Diagnostic, code actions, TreeDataProvider) звичайним `node
// test/*.mjs`, без запуску повного VS Code через @vscode/test-electron.
//
// Живе тут (не напряму в node_modules/vscode/), бо node_modules/ -
// gitignored: якби мок жив тільки там, `git clone` цього репо давав би
// комусь (напр. дяді Вові) робочий extension.js, але тести падали б з
// "Cannot find module 'vscode'" - `npm install` через package.json
// ("vscode": "file:test/vscode-mock") symlink'ає його в
// node_modules/vscode автоматично, той самий стандартний механізм
// npm's file: залежностей.

class Range {
    constructor(startLine, startChar, endLine, endChar) {
        this.start = new Position(startLine, startChar);
        this.end = new Position(endLine, endChar);
    }
}

class Position {
    constructor(line, character) {
        this.line = line;
        this.character = character;
    }
}

class Diagnostic {
    constructor(range, message, severity) {
        this.range = range;
        this.message = message;
        this.severity = severity;
    }
}

class CodeAction {
    constructor(title, kind) {
        this.title = title;
        this.kind = kind;
    }
}

class WorkspaceEdit {
    constructor() {
        this.edits = [];
    }
    replace(uri, range, newText) {
        this.edits.push({ uri, range, newText });
    }
}

class DiagnosticCollection {
    constructor() {
        this.store = new Map();
    }
    set(uri, diags) {
        if (diags.length === 0) {
            this.store.delete(uri.toString());
        } else {
            this.store.set(uri.toString(), { uri, diags });
        }
    }
    delete(uri) {
        this.store.delete(uri.toString());
    }
    forEach(callback) {
        for (const { uri, diags } of this.store.values()) {
            callback(uri, diags, this);
        }
    }
    dispose() {}
}

class TreeItem {
    constructor(label, collapsibleState) {
        this.label = label;
        this.collapsibleState = collapsibleState;
    }
}

class ThemeIcon {
    constructor(id) {
        this.id = id;
    }
}

class EventEmitter {
    constructor() {
        this._listeners = [];
        this.event = (listener) => {
            this._listeners.push(listener);
            return { dispose: () => {} };
        };
    }
    fire(data) {
        this._listeners.forEach((l) => l(data));
    }
}

const fs = require('fs');

class Uri {
    static file(fsPath) {
        return { scheme: 'file', fsPath, toString: () => `file://${fsPath}` };
    }
}

let configStore = {};
let workspaceFoldersStore = [{ uri: { fsPath: '/tmp/fake-workspace' } }];

module.exports = {
    Range,
    Position,
    Diagnostic,
    CodeAction,
    WorkspaceEdit,
    TreeItem,
    ThemeIcon,
    EventEmitter,
    Uri,
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 },
    CodeActionKind: { QuickFix: 'quickfix' },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    languages: {
        createDiagnosticCollection: () => new DiagnosticCollection(),
        registerCodeActionsProvider: () => ({ dispose() {} }),
    },
    workspace: {
        get workspaceFolders() {
            return workspaceFoldersStore;
        },
        getConfiguration: () => ({
            get: (key) => configStore[key],
        }),
        onDidSaveTextDocument: () => ({ dispose() {} }),
        onDidOpenTextDocument: () => ({ dispose() {} }),
        onDidChangeTextDocument: () => ({ dispose() {} }),
        onDidCloseTextDocument: () => ({ dispose() {} }),
        textDocuments: [],
        openTextDocument: async (uri) => {
            const fsPath = typeof uri === 'string' ? uri : uri.fsPath;
            const lines = fs.readFileSync(fsPath, 'utf8').split('\n');
            return {
                uri: typeof uri === 'string' ? Uri.file(uri) : uri,
                lineCount: lines.length,
                lineAt: (line) => ({ text: lines[line] ?? '' }),
            };
        },
    },
    commands: {
        registerCommand: () => ({ dispose() {} }),
    },
    window: {
        activeTextEditor: null,
        registerTreeDataProvider: () => ({ dispose() {} }),
        showInformationMessage: () => {},
        showWarningMessage: () => {},
        showErrorMessage: () => {},
    },
    __setConfig(next) {
        configStore = next;
    },
    __setWorkspaceFolders(next) {
        workspaceFoldersStore = next;
    },
};
