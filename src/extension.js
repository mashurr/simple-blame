const vscode = require('vscode');
const { exec } = require('child_process');
const path = require('path');

// --- Global State Variables ---
let blameDecorationType;
let blameStatusBarItem;
let isBlameActive = false; // The master switch

function activate(context) {
    // 1. Create the Decoration Style
    blameDecorationType = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        before: {
            margin: '0 3em 0 0',
            color: new vscode.ThemeColor('editorCodeLens.foreground'),
            fontStyle: 'italic',
            textDecoration: 'none; opacity: 0.7;',
        },
    });

    // 2. Create the Status Bar Item
    blameStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    blameStatusBarItem.command = 'simple-blame.toggle';
    context.subscriptions.push(blameStatusBarItem);

    // 3. Register the Toggle Command
    const toggleCommand = vscode.commands.registerCommand('simple-blame.toggle', () => {
        isBlameActive = !isBlameActive;
        updateStatusBar();

        if (isBlameActive) {
            applyFullBlame(vscode.window.activeTextEditor);
        } else {
            clearAllDecorations();
        }
    });
    context.subscriptions.push(toggleCommand);

    // 4. Register Event Listeners
    // When the user switches to a different file
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (isBlameActive) {
                applyFullBlame(editor);
            }
        })
    );

    // When the user saves the current file (blame info might have changed)
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(document => {
            const editor = vscode.window.activeTextEditor;
            if (isBlameActive && editor && editor.document === document) {
                applyFullBlame(editor);
            }
        })
    );

    // 5. Set the initial state of the UI
    updateStatusBar();
    blameStatusBarItem.show();
}

/**
 * Updates the text and tooltip of the status bar item.
 */
function updateStatusBar() {
    if (isBlameActive) {
        blameStatusBarItem.text = `$(git-commit) Blame: ON`;
        blameStatusBarItem.tooltip = "Click to hide blame for the whole file";
    } else {
        blameStatusBarItem.text = `$(git-commit) Blame: OFF`;
        blameStatusBarItem.tooltip = "Click to show blame for the whole file";
    }
}

/**
 * Clears all blame decorations from the active editor.
 */
function clearAllDecorations() {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
        editor.setDecorations(blameDecorationType, []);
    }
}

/**
 * The core function to fetch and display blame for the ENTIRE file.
 * @param {vscode.TextEditor} editor The active text editor.
 */
function applyFullBlame(editor) {
    if (!editor || editor.document.isUntitled) {
        return;
    }

    clearAllDecorations();

    const filePath = editor.document.uri.fsPath;
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    const cwd = workspaceFolder ? workspaceFolder.uri.fsPath : path.dirname(filePath);

    const command = `git blame --porcelain -- "${filePath}"`;

    // We are now about to run the git command.
    // The code INSIDE this exec callback is what we need to check.
    exec(command, { cwd }, (error, stdout, stderr) => {

        if (error) {
            vscode.window.showErrorMessage(`Blame failed: Is git installed and is this a git repository?`);
            return;
        }
        if (stderr) {
            vscode.window.showErrorMessage(`Blame failed: ${stderr}. Is the file committed?`);
            return;
        }


        if (!isBlameActive || vscode.window.activeTextEditor !== editor) {
            return;
        }

        const decorations = parseFullBlame(stdout, editor.document);
        editor.setDecorations(blameDecorationType, decorations);
    });
}

/**
 * Parses the full --porcelain output from git blame for an entire file.
 * This version uses a cache to correctly handle multi-line commit groups.
 * @param {string} blameOutput The raw string output from the git blame command.
 * @param {vscode.TextDocument} document The document to which the blame applies.
 * @returns {vscode.DecorationOptions[]} An array of DecorationOptions.
 */
function parseFullBlame(blameOutput, document) {
    const decorations = [];
    const lines = blameOutput.split('\n');

    // Cache to store full metadata for each commit hash
    const commitDataCache = new Map();
    let currentCommitHash = null;
    let currentLineNumber = -1;

    for (const line of lines) {
        try {
            if (line.startsWith('\t')) {
                // This is the line of code. We must have seen its metadata already.
                if (currentCommitHash && currentLineNumber >= 0 && currentLineNumber < document.lineCount) {
                    const commitInfo = commitDataCache.get(currentCommitHash);

                    // If we have valid, cached info for this commit, create the decoration
                    if (commitInfo && commitInfo.author && commitInfo['author-time']) {
                        const shortCommit = currentCommitHash.substring(0, 8);
                        const author = commitInfo.author.trim();
                        const date = new Date(parseInt(commitInfo['author-time']) * 1000);
                        const formattedDate = `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}`;
                        const contentText = `${shortCommit}  ${author}  ${formattedDate}`;

                        const hoverMessage = new vscode.MarkdownString();
                        hoverMessage.appendCodeblock(commitInfo.summary || 'No commit message.', 'text');
                        hoverMessage.appendMarkdown(`\n\n**Commit:** ${currentCommitHash}\n\n**Author:** ${commitInfo.author} <${commitInfo['author-mail']}>`);

                        const decoration = {
                            range: document.lineAt(currentLineNumber).range,
                            renderOptions: { before: { contentText } },
                            hoverMessage: hoverMessage
                        };
                        decorations.push(decoration);
                    }
                }
            } else {
                // This is a metadata line.
                const parts = line.split(' ');
                if (parts.length > 1 && parts[0].length === 40) {
                    // This is a new commit hash line.
                    currentCommitHash = parts[0];
                    currentLineNumber = parseInt(parts[2], 10) - 1;

                    // If we haven't seen this commit before, create a placeholder in the cache.
                    if (!commitDataCache.has(currentCommitHash)) {
                        commitDataCache.set(currentCommitHash, {});
                    }
                } else if (currentCommitHash && parts.length > 1) {
                    // This is other metadata (author, summary, etc.).
                    // Add it to the cache for the current commit.
                    const key = parts[0];
                    const value = parts.slice(1).join(' ');
                    const commitInfo = commitDataCache.get(currentCommitHash);
                    if (commitInfo) {
                        commitInfo[key] = value;
                    }
                }
            }
        } catch (e) {
            console.error(`[Simple Blame] PARSE CRASH: An unexpected error occurred. Error: ${e.message}`);
        }
    }
    return decorations;
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
};