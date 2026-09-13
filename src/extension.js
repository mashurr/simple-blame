const vscode = require('vscode');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// How long to wait after the last edit before re-running blame
const EDIT_DEBOUNCE_MS = 300;
// git blame uses this hash for lines that are not committed yet
const UNCOMMITTED_HASH = '0'.repeat(40);

// Annotation columns, in characters, so the code after every annotation lines up
const HASH_WIDTH = 8;
const MAX_AUTHOR_WIDTH = 20;
const UNCOMMITTED_LABEL = 'uncommitted';
const DATE_WIDTH = UNCOMMITTED_LABEL.length; // also fits YYYY-MM-DD
// Columns are padded with non-breaking spaces; regular spaces collapse when rendered
const NBSP = '\u00a0';
const COLUMN_GAP = NBSP.repeat(2);

// --- Global State Variables ---
let blameDecorationType;
let blameStatusBarItem;
let isBlameActive = false; // The master switch
let visibleEditors = new Set(); // Editors visible at the last change, to spot newly opened ones
const editTimers = new Map(); // document -> pending re-blame after typing
const latestBlameRequest = new Map(); // document -> id of its most recent blame run
const blameProblems = new Map(); // document -> why blame is unavailable, shown in the status bar
let blameRequestCounter = 0;
let gitMissingReported = false; // Only tell the user once that git is missing

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

        if (isBlameActive) {
            visibleEditors = new Set(vscode.window.visibleTextEditors);
            blameEditors(vscode.window.visibleTextEditors);
        } else {
            cancelPendingBlames();
            clearAllDecorations();
            blameProblems.clear();
        }
        updateStatusBar();
    });
    context.subscriptions.push(toggleCommand);

    // 4. Register Event Listeners
    // When editors are opened, switched, or split, blame the ones that just became visible
    context.subscriptions.push(
        vscode.window.onDidChangeVisibleTextEditors(editors => {
            const newlyVisible = editors.filter(editor => !visibleEditors.has(editor));
            visibleEditors = new Set(editors);
            if (isBlameActive) {
                blameEditors(newlyVisible);
            }
        })
    );

    // When focus moves to another editor, show that file's blame status
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(() => updateStatusBar())
    );

    // When the user saves a visible file (blame info might have changed)
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(document => {
            if (isBlameActive && isVisible(document)) {
                blameDocument(document);
            }
        })
    );

    // When the user edits a visible file, re-blame the unsaved text once typing pauses
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(event => {
            const document = event.document;
            if (!isBlameActive || event.contentChanges.length === 0 || !isVisible(document)) {
                return;
            }
            clearTimeout(editTimers.get(document));
            editTimers.set(document, setTimeout(() => {
                editTimers.delete(document);
                blameDocument(document);
            }, EDIT_DEBOUNCE_MS));
        })
    );

    // Forget per-document state when a file is closed
    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument(document => {
            clearTimeout(editTimers.get(document));
            editTimers.delete(document);
            latestBlameRequest.delete(document);
            blameProblems.delete(document);
        })
    );

    // 5. Set the initial state of the UI
    updateStatusBar();
    blameStatusBarItem.show();
}

/**
 * Updates the text and tooltip of the status bar item.
 * While blame is on, it also explains why blame is unavailable for the focused file, if it is.
 */
function updateStatusBar() {
    if (!isBlameActive) {
        blameStatusBarItem.text = `$(git-commit) Blame: OFF`;
        blameStatusBarItem.tooltip = "Click to show blame for the whole file";
        return;
    }

    const editor = vscode.window.activeTextEditor;
    const problem = editor && blameProblems.get(editor.document);
    if (problem) {
        blameStatusBarItem.text = `$(git-commit) Blame: ON $(info)`;
        blameStatusBarItem.tooltip = `Blame unavailable: ${problem}. Click to hide blame.`;
    } else {
        blameStatusBarItem.text = `$(git-commit) Blame: ON`;
        blameStatusBarItem.tooltip = "Click to hide blame for the whole file";
    }
}

/**
 * Returns true if the document is shown in at least one visible editor.
 * @param {vscode.TextDocument} document
 */
function isVisible(document) {
    return vscode.window.visibleTextEditors.some(editor => editor.document === document);
}

/**
 * Blames each distinct document shown in the given editors.
 * @param {readonly vscode.TextEditor[]} editors
 */
function blameEditors(editors) {
    new Set(editors.map(editor => editor.document)).forEach(document => blameDocument(document));
}

/**
 * Cancels pending re-blames and makes any in-flight blame results stale.
 */
function cancelPendingBlames() {
    editTimers.forEach(timer => clearTimeout(timer));
    editTimers.clear();
    latestBlameRequest.clear();
}

/**
 * Clears blame decorations from every visible editor.
 */
function clearAllDecorations() {
    for (const editor of vscode.window.visibleTextEditors) {
        editor.setDecorations(blameDecorationType, []);
    }
}

/**
 * Fetches blame for an entire document and shows it in every visible editor displaying it.
 * Problems (e.g. an untracked file) are reported quietly in the status bar instead of pop-ups.
 * @param {vscode.TextDocument} document The document to blame.
 */
function blameDocument(document) {
    // Only real files on disk can be blamed (skips untitled, output panels, diff views, etc.)
    if (document.uri.scheme !== 'file') {
        return;
    }

    const requestId = ++blameRequestCounter;
    latestBlameRequest.set(document, requestId);

    runGitBlame(document.uri.fsPath, document.getText(), (error, stdout, stderr) => {
        // Skip stale results: a newer blame of this document has started, or blame was turned off
        if (latestBlameRequest.get(document) !== requestId || !isBlameActive) {
            return;
        }

        const editors = vscode.window.visibleTextEditors.filter(editor => editor.document === document);

        if (error) {
            editors.forEach(editor => editor.setDecorations(blameDecorationType, []));
            blameProblems.set(document, describeBlameError(document, error, stderr));
            updateStatusBar();
            return;
        }

        blameProblems.delete(document);
        updateStatusBar();

        const decorations = parseFullBlame(stdout, document);
        editors.forEach(editor => editor.setDecorations(blameDecorationType, decorations));
    });
}

/**
 * Turns a failed git blame into a short, human-readable reason for the status bar.
 * A missing git installation is the one real problem, so it also gets a one-time error message.
 * @param {vscode.TextDocument} document The document that failed to blame.
 * @param {Error & { code?: string }} error The error from running git.
 * @param {string} stderr git's error output.
 * @returns {string}
 */
function describeBlameError(document, error, stderr) {
    if (error.code === 'ENOENT') {
        // spawn reports ENOENT both when git is missing and when the file's folder is gone
        if (!fs.existsSync(path.dirname(document.uri.fsPath))) {
            return 'File no longer exists on disk';
        }
        if (!gitMissingReported) {
            gitMissingReported = true;
            vscode.window.showErrorMessage('Simple Blame: Git was not found. Install Git and make sure it is on your PATH.');
        }
        return 'Git was not found';
    }
    if (/not a git repository/i.test(stderr)) {
        return 'Not in a Git repository';
    }
    if (/no such path .* in HEAD/i.test(stderr)) {
        return 'File is not committed yet';
    }
    if (/no such ref: HEAD|bad revision 'HEAD'/i.test(stderr)) {
        return 'Repository has no commits yet';
    }
    return (stderr.trim().split('\n')[0] || error.message).replace(/^fatal: /, '');
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
 * Parses the full --porcelain output from git blame into decorations for the document.
 * @param {string} blameOutput The raw string output from the git blame command.
 * @param {vscode.TextDocument} document The document to which the blame applies.
 * @returns {vscode.DecorationOptions[]} An array of DecorationOptions.
 */
function parseFullBlame(blameOutput, document) {
    return buildDecorations(parseBlameLines(blameOutput, document.lineCount), document);
}

/**
 * Reads porcelain output into one entry per blamed line.
 * Commit details only appear the first time a commit is seen, so they are cached by hash.
 * @param {string} blameOutput The raw string output from the git blame command.
 * @param {number} lineCount Lines currently in the document; entries beyond it are dropped.
 * @returns {{ lineNumber: number, hash: string, commit: Record<string, string> }[]}
 */
function parseBlameLines(blameOutput, lineCount) {
    const entries = [];
    const commits = new Map();
    let hash = null;
    let lineNumber = -1;

    for (const line of blameOutput.split('\n')) {
        if (line.startsWith('\t')) {
            // This is the line of code. Its commit header has already been read.
            if (hash && lineNumber >= 0 && lineNumber < lineCount) {
                entries.push({ lineNumber, hash, commit: commits.get(hash) });
            }
            continue;
        }

        const parts = line.split(' ');
        if (parts.length >= 3 && /^[0-9a-f]{40}$/.test(parts[0])) {
            // Header line: <hash> <original line> <final line> [<lines in group>]
            hash = parts[0];
            lineNumber = parseInt(parts[2], 10) - 1;
            if (!commits.has(hash)) {
                commits.set(hash, {});
            }
        } else if (hash && parts.length > 1) {
            // Commit details (author, author-time, summary, etc.)
            commits.get(hash)[parts[0]] = parts.slice(1).join(' ');
        }
    }
    return entries;
}

/**
 * Builds a decoration for each blamed line. Every annotation is padded to the same width
 * (hash, author, date columns) so the code after it stays aligned.
 * Only the first line of a run of lines from the same commit is annotated; the rest are left blank.
 * @param {{ lineNumber: number, hash: string, commit: Record<string, string> }[]} entries
 * @param {vscode.TextDocument} document
 * @returns {vscode.DecorationOptions[]}
 */
function buildDecorations(entries, document) {
    const blamed = entries.filter(entry => entry.hash === UNCOMMITTED_HASH || (entry.commit.author && entry.commit['author-time']));
    const authorWidth = Math.min(MAX_AUTHOR_WIDTH, blamed.reduce((width, entry) => Math.max(width, charCount(authorOf(entry))), 0));
    // Blank lines inside a block still get an annotation of the same width, or their code would shift left
    const blankAnnotation = NBSP.repeat(HASH_WIDTH + authorWidth + DATE_WIDTH + 2 * COLUMN_GAP.length);
    const hovers = new Map(); // one hover per commit instead of one per line

    return blamed.map((entry, index) => {
        const uncommitted = entry.hash === UNCOMMITTED_HASH;
        const previous = blamed[index - 1];
        const continuesBlock = previous && previous.hash === entry.hash && previous.lineNumber === entry.lineNumber - 1;
        const contentText = continuesBlock ? blankAnnotation : [
            padColumn(uncommitted ? '' : entry.hash.substring(0, HASH_WIDTH), HASH_WIDTH),
            padColumn(authorOf(entry), authorWidth),
            padColumn(uncommitted ? UNCOMMITTED_LABEL : formatDate(entry.commit['author-time']), DATE_WIDTH),
        ].join(COLUMN_GAP);

        if (!hovers.has(entry.hash)) {
            hovers.set(entry.hash, uncommitted ? uncommittedHover() : commitHover(entry.hash, entry.commit));
        }

        return {
            range: document.lineAt(entry.lineNumber).range,
            renderOptions: {
                // Uncommitted lines are dimmed so real commits stand out
                before: uncommitted ? { contentText, color: new vscode.ThemeColor('disabledForeground') } : { contentText },
            },
            hoverMessage: hovers.get(entry.hash),
        };
    });
}

/**
 * @param {{ hash: string, commit: Record<string, string> }} entry
 * @returns {string} The name shown in the author column.
 */
function authorOf(entry) {
    return entry.hash === UNCOMMITTED_HASH ? 'You' : entry.commit.author.trim();
}

/**
 * Pads text with non-breaking spaces to exactly `width` characters, truncating with an ellipsis if needed.
 * (Regular spaces would be collapsed when the annotation is rendered.)
 * @param {string} text
 * @param {number} width
 */
function padColumn(text, width) {
    const chars = [...text];
    if (chars.length > width) {
        return chars.slice(0, width - 1).join('') + '…';
    }
    return text + NBSP.repeat(width - chars.length);
}

/**
 * @param {string} text
 * @returns {number} Number of characters (not UTF-16 code units).
 */
function charCount(text) {
    return [...text].length;
}

/**
 * @param {string} authorTime Unix timestamp in seconds.
 * @returns {string} The date as YYYY-MM-DD.
 */
function formatDate(authorTime) {
    const date = new Date(parseInt(authorTime, 10) * 1000);
    return `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}`;
}

/**
 * @param {string} hash Full commit hash.
 * @param {Record<string, string>} commit Commit details from the porcelain output.
 */
function commitHover(hash, commit) {
    const hoverMessage = new vscode.MarkdownString();
    hoverMessage.appendCodeblock(commit.summary || 'No commit message.', 'text');
    hoverMessage.appendMarkdown(`\n\n**Commit:** ${hash}\n\n**Author:** ${commit.author} <${commit['author-mail']}>`);
    return hoverMessage;
}

function uncommittedHover() {
    return new vscode.MarkdownString('**Uncommitted changes**\n\nThis line has not been committed yet.');
}

function deactivate() {
    cancelPendingBlames();
}

module.exports = {
    activate,
    deactivate
};
