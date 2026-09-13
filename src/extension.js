const vscode = require('vscode');
const { spawn } = require('child_process');
const path = require('path');

// How long to wait after the last edit before re-running blame
const EDIT_DEBOUNCE_MS = 300;

// --- Global State Variables ---
let blameDecorationType;
let blameStatusBarItem;
let isBlameActive = false; // The master switch
let editDebounceTimer;
let latestBlameRequest = 0;

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
            clearTimeout(editDebounceTimer);
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

    // When the user edits the current file, re-blame the unsaved text once typing pauses
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(event => {
            const editor = vscode.window.activeTextEditor;
            if (!isBlameActive || !editor || editor.document !== event.document || event.contentChanges.length === 0) {
                return;
            }
            clearTimeout(editDebounceTimer);
            editDebounceTimer = setTimeout(() => applyFullBlame(editor, { showErrors: false }), EDIT_DEBOUNCE_MS);
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
 * @param {{ showErrors?: boolean }} [options] Set showErrors to false to fail silently (e.g. while typing).
 */
function applyFullBlame(editor, { showErrors = true } = {}) {
    // Only real files on disk can be blamed (skips untitled, output panels, diff views, etc.)
    if (!editor || editor.document.uri.scheme !== 'file') {
        return;
    }

    const document = editor.document;
    const requestId = ++latestBlameRequest;

    runGitBlame(document.uri.fsPath, document.getText(), (error, stdout, stderr) => {
        // Skip stale results: a newer blame has started, blame was turned off, or the user moved on
        if (requestId !== latestBlameRequest || !isBlameActive || vscode.window.activeTextEditor !== editor) {
            return;
        }

        if (error) {
            editor.setDecorations(blameDecorationType, []);
            if (showErrors) {
                const msg = (stderr || error.message || '').trim();
                vscode.window.showErrorMessage(`Blame failed: ${msg || 'Unknown error.'} Is the file committed?`);
            }
            return;
        }

        const decorations = parseFullBlame(stdout, document);
        editor.setDecorations(blameDecorationType, decorations);
    });
}

/**
 * Runs `git blame --porcelain` on the given text, as if it were the file's contents.
 * Output is streamed, so there is no size limit for large files.
 * @param {string} filePath Absolute file path.
 * @param {string} contents Current text of the file (may include unsaved edits).
 * @param {(error: Error|null, stdout: string, stderr: string) => void} callback Called once when git finishes.
 */
function runGitBlame(filePath, contents, callback) {
    // Run git from the file's own directory so it resolves the nearest repository.
    // This handles submodules and workspaces opened through symlinks.
    // The text is passed on stdin (--contents -) so blame matches unsaved edits.
    const git = spawn('git', ['blame', '--porcelain', '--contents', '-', '--', path.basename(filePath)], {
        cwd: path.dirname(filePath),
    });

    const stdout = [];
    const stderr = [];
    let finished = false;
    const finish = (error) => {
        if (finished) {
            return;
        }
        finished = true;
        callback(error, Buffer.concat(stdout).toString(), Buffer.concat(stderr).toString());
    };

    git.stdout.on('data', chunk => stdout.push(chunk));
    git.stderr.on('data', chunk => stderr.push(chunk));
    // Failed to start at all, e.g. git is not installed or the folder no longer exists
    git.on('error', finish);
    git.on('close', code => finish(code === 0 ? null : new Error(`git blame exited with code ${code}`)));

    // git can exit before reading all of stdin (e.g. outside a repository); ignore the resulting pipe error
    git.stdin.on('error', () => {});
    git.stdin.end(contents);
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
