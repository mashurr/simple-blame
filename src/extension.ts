import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// How long to wait after the last edit before re-running blame
const EDIT_DEBOUNCE_MS = 300;
// git blame uses this hash for lines that are not committed yet
const UNCOMMITTED_HASH = '0'.repeat(40);

// Annotation columns, in characters, so the code after every annotation lines up
const HASH_WIDTH = 8;
const MAX_AUTHOR_WIDTH = 20;
const UNCOMMITTED_LABEL = 'uncommitted';
// Columns are padded with non-breaking spaces; regular spaces collapse when rendered
const NBSP = '\u00a0';
const COLUMN_GAP = NBSP.repeat(2);

// Units for the relative date column (e.g. "3 months ago"), largest first
const DAY_SECONDS = 24 * 60 * 60;
const AGE_UNITS: [unit: string, seconds: number][] = [
    ['year', 365 * DAY_SECONDS],
    ['month', 30 * DAY_SECONDS],
    ['week', 7 * DAY_SECONDS],
    ['day', DAY_SECONDS],
    ['hour', 60 * 60],
    ['minute', 60],
];
// Older commits fade so recent changes stand out: [age below this many seconds, opacity]
const AGE_OPACITY: [maxAgeSeconds: number, opacity: number][] = [
    [7 * DAY_SECONDS, 0.9],
    [30 * DAY_SECONDS, 0.82],
    [182 * DAY_SECONDS, 0.75],
    [365 * DAY_SECONDS, 0.68],
    [2 * 365 * DAY_SECONDS, 0.62],
    [Infinity, 0.55], // still readable on light and high-contrast themes
];

// Commands behind the hover's action links (not listed in the command palette)
const COPY_HASH_COMMAND = 'simple-blame.copyCommitHash';
const SHOW_DIFF_COMMAND = 'simple-blame.showCommitDiff';
// Read-only documents with a file's contents at a commit, shown in the diff view
const REVISION_SCHEME = 'simple-blame-revision';
// Hosts with a web page per commit, matched against the remote's host name (so self-hosted GitHub/GitLab work too)
const WEB_HOSTS: { match: string; name: string; commitPath: string }[] = [
    { match: 'github', name: 'GitHub', commitPath: '/commit/' },
    { match: 'gitlab', name: 'GitLab', commitPath: '/-/commit/' },
    { match: 'bitbucket', name: 'Bitbucket', commitPath: '/commits/' },
];

/** A repository's web page: commits open at url + commitPath + hash. */
interface WebRepository {
    name: string;
    url: string;
    commitPath: string;
}

/** Commit details from git blame's porcelain output (author, author-time, summary, filename, previous, ...). */
type CommitDetails = Record<string, string>;

/** One blamed line of the document. */
interface BlameEntry {
    lineNumber: number;
    hash: string;
    commit: CommitDetails;
}

/** What the Show diff hover action compares. Paths are relative to the repository root. */
interface CommitDiff {
    folder: string;
    hash: string;
    path: string;
    /** null when the commit added the file */
    previousHash: string | null;
    previousPath: string | null;
}

type GitError = Error & { code?: string };
type GitCallback = (error: GitError | null, stdout: string, stderr: string) => void;

// --- Global State Variables ---
let blameDecorationType: vscode.TextEditorDecorationType;
let blameStatusBarItem: vscode.StatusBarItem;
let isBlameActive = false; // The master switch
let visibleEditors = new Set<vscode.TextEditor>(); // Editors visible at the last change, to spot newly opened ones
const editTimers = new Map<vscode.TextDocument, NodeJS.Timeout>(); // pending re-blame after typing
const latestBlameRequest = new Map<vscode.TextDocument, number>(); // id of each document's most recent blame run
const blameProblems = new Map<vscode.TextDocument, string>(); // why blame is unavailable, shown in the status bar
let blameRequestCounter = 0;
let gitMissingReported = false; // Only tell the user once that git is missing
const remoteRepositories = new Map<string, Promise<WebRepository | null>>(); // per folder, for "Open on GitHub" links

export function activate(context: vscode.ExtensionContext) {
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
            remoteRepositories.clear();
        }
        updateStatusBar();
    });
    context.subscriptions.push(toggleCommand);

    // Hover actions: copy the commit hash, or show what the commit changed in the file
    context.subscriptions.push(
        vscode.commands.registerCommand(COPY_HASH_COMMAND, copyCommitHash),
        vscode.commands.registerCommand(SHOW_DIFF_COMMAND, showCommitDiff),
        vscode.workspace.registerTextDocumentContentProvider(REVISION_SCHEME, { provideTextDocumentContent: provideRevisionContent })
    );

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
 */
function isVisible(document: vscode.TextDocument): boolean {
    return vscode.window.visibleTextEditors.some(editor => editor.document === document);
}

/**
 * Blames each distinct document shown in the given editors.
 */
function blameEditors(editors: readonly vscode.TextEditor[]) {
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
 * @param document The document to blame.
 */
function blameDocument(document: vscode.TextDocument) {
    // Only real files on disk can be blamed (skips untitled, output panels, diff views, etc.)
    if (document.uri.scheme !== 'file') {
        return;
    }

    const requestId = ++blameRequestCounter;
    latestBlameRequest.set(document, requestId);

    // Look up the remote for "Open on GitHub" links alongside blame (cached per folder)
    const remoteRepository = getRemoteRepository(path.dirname(document.uri.fsPath));

    runGitBlame(document.uri.fsPath, document.getText(), async (error, stdout, stderr) => {
        // Skip stale results: a newer blame of this document has started, or blame was turned off
        const isStale = () => latestBlameRequest.get(document) !== requestId || !isBlameActive;
        const editorsShowingDocument = () => vscode.window.visibleTextEditors.filter(editor => editor.document === document);
        if (isStale()) {
            return;
        }

        if (error) {
            editorsShowingDocument().forEach(editor => editor.setDecorations(blameDecorationType, []));
            blameProblems.set(document, describeBlameError(document, error, stderr));
            updateStatusBar();
            return;
        }

        const webRepository = await remoteRepository;
        if (isStale()) {
            return;
        }

        blameProblems.delete(document);
        updateStatusBar();

        const decorations = parseFullBlame(stdout, document, webRepository);
        editorsShowingDocument().forEach(editor => editor.setDecorations(blameDecorationType, decorations));
    });
}

/**
 * Turns a failed git blame into a short, human-readable reason for the status bar.
 * A missing git installation is the one real problem, so it also gets a one-time error message.
 * @param document The document that failed to blame.
 * @param error The error from running git.
 * @param stderr git's error output.
 */
function describeBlameError(document: vscode.TextDocument, error: GitError, stderr: string): string {
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
 * @param filePath Absolute file path.
 * @param contents Current text of the file (may include unsaved edits).
 * @param callback Called once when git finishes.
 */
function runGitBlame(filePath: string, contents: string, callback: GitCallback) {
    // Run git from the file's own directory so it resolves the nearest repository.
    // This handles submodules and workspaces opened through symlinks.
    // The text is passed on stdin (--contents -) so blame matches unsaved edits.
    runGit(['blame', '--porcelain', '--contents', '-', '--', path.basename(filePath)], path.dirname(filePath), contents, callback);
}

/**
 * Runs a git command. Output is streamed, so there is no size limit for large files.
 * @param args Arguments for git.
 * @param cwd Folder to run git in.
 * @param input Text to pass on stdin, if any.
 * @param callback Called once when git finishes.
 */
function runGit(args: string[], cwd: string, input: string | undefined, callback: GitCallback) {
    const git = spawn('git', args, { cwd });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let finished = false;
    const finish = (error: GitError | null) => {
        if (finished) {
            return;
        }
        finished = true;
        callback(error, Buffer.concat(stdout).toString(), Buffer.concat(stderr).toString());
    };

    git.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    git.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    // Failed to start at all, e.g. git is not installed or the folder no longer exists
    git.on('error', finish);
    git.on('close', code => finish(code === 0 ? null : new Error(`git ${args[0]} exited with code ${code}`)));

    // git can exit before reading all of stdin (e.g. outside a repository); ignore the resulting pipe error
    git.stdin.on('error', () => {});
    git.stdin.end(input);
}

/**
 * Parses the full --porcelain output from git blame into decorations for the document.
 * @param blameOutput The raw string output from the git blame command.
 * @param document The document to which the blame applies.
 * @param webRepository Where commits can be opened on the web, if known.
 */
function parseFullBlame(blameOutput: string, document: vscode.TextDocument, webRepository: WebRepository | null): vscode.DecorationOptions[] {
    return buildDecorations(parseBlameLines(blameOutput, document.lineCount), document, webRepository);
}

/**
 * Reads porcelain output into one entry per blamed line.
 * Commit details only appear the first time a commit is seen, so they are cached by hash.
 * @param blameOutput The raw string output from the git blame command.
 * @param lineCount Lines currently in the document; entries beyond it are dropped.
 */
function parseBlameLines(blameOutput: string, lineCount: number): BlameEntry[] {
    const entries: BlameEntry[] = [];
    const commits = new Map<string, CommitDetails>();
    let hash: string | null = null;
    let commit: CommitDetails = {};
    let lineNumber = -1;

    for (const line of blameOutput.split('\n')) {
        if (line.startsWith('\t')) {
            // This is the line of code. Its commit header has already been read.
            if (hash && lineNumber >= 0 && lineNumber < lineCount) {
                entries.push({ lineNumber, hash, commit });
            }
            continue;
        }

        const parts = line.split(' ');
        if (parts.length >= 3 && /^[0-9a-f]{40}$/.test(parts[0])) {
            // Header line: <hash> <original line> <final line> [<lines in group>]
            hash = parts[0];
            lineNumber = parseInt(parts[2], 10) - 1;
            commit = commits.get(hash) ?? {};
            commits.set(hash, commit);
        } else if (hash && parts.length > 1) {
            // Commit details (author, author-time, summary, etc.)
            commit[parts[0]] = parts.slice(1).join(' ');
        }
    }
    return entries;
}

/**
 * Builds a decoration for each blamed line. Every annotation is padded to the same width
 * (hash, author, date columns) so the code after it stays aligned.
 * Only the first line of a run of lines from the same commit is annotated; the rest are left blank.
 */
function buildDecorations(entries: BlameEntry[], document: vscode.TextDocument, webRepository: WebRepository | null): vscode.DecorationOptions[] {
    const folder = path.dirname(document.uri.fsPath);
    const blamed = entries.filter(entry => entry.hash === UNCOMMITTED_HASH || (entry.commit.author && entry.commit['author-time']));
    const now = Date.now();
    const dateLabels = new Map<string, string>(); // one relative age per commit instead of one per line
    const dateLabel = (entry: BlameEntry): string => {
        let label = dateLabels.get(entry.hash);
        if (label === undefined) {
            label = entry.hash === UNCOMMITTED_HASH ? UNCOMMITTED_LABEL : formatAge(entry.commit['author-time'], now);
            dateLabels.set(entry.hash, label);
        }
        return label;
    };
    const authorWidth = Math.min(MAX_AUTHOR_WIDTH, blamed.reduce((width, entry) => Math.max(width, charCount(authorOf(entry))), 0));
    const dateWidth = blamed.reduce((width, entry) => Math.max(width, charCount(dateLabel(entry))), 0);
    // Blank lines inside a block still get an annotation of the same width, or their code would shift left
    const blankAnnotation = NBSP.repeat(HASH_WIDTH + authorWidth + dateWidth + 2 * COLUMN_GAP.length);
    const hovers = new Map<string, vscode.MarkdownString>(); // one hover per commit instead of one per line

    return blamed.map((entry, index) => {
        const uncommitted = entry.hash === UNCOMMITTED_HASH;
        const previous = blamed[index - 1];
        const continuesBlock = previous && previous.hash === entry.hash && previous.lineNumber === entry.lineNumber - 1;
        const contentText = continuesBlock ? blankAnnotation : [
            padColumn(uncommitted ? '' : entry.hash.substring(0, HASH_WIDTH), HASH_WIDTH),
            padColumn(authorOf(entry), authorWidth),
            padColumn(dateLabel(entry), dateWidth),
        ].join(COLUMN_GAP);

        let hoverMessage = hovers.get(entry.hash);
        if (!hoverMessage) {
            hoverMessage = uncommitted ? uncommittedHover() : commitHover(entry.hash, entry.commit, now, folder, webRepository);
            hovers.set(entry.hash, hoverMessage);
        }

        return {
            range: document.lineAt(entry.lineNumber).range,
            renderOptions: {
                // Uncommitted lines are dimmed; committed ones fade with age so recent changes stand out
                before: uncommitted
                    ? { contentText, color: new vscode.ThemeColor('disabledForeground') }
                    : { contentText, textDecoration: `none; opacity: ${ageOpacity(entry.commit['author-time'], now)};` },
            },
            hoverMessage,
        };
    });
}

/**
 * @returns The name shown in the author column.
 */
function authorOf(entry: BlameEntry): string {
    return entry.hash === UNCOMMITTED_HASH ? 'You' : entry.commit.author.trim();
}

/**
 * Pads text with non-breaking spaces to exactly `width` characters, truncating with an ellipsis if needed.
 * (Regular spaces would be collapsed when the annotation is rendered.)
 */
function padColumn(text: string, width: number): string {
    const chars = [...text];
    if (chars.length > width) {
        return chars.slice(0, width - 1).join('') + '…';
    }
    return text + NBSP.repeat(width - chars.length);
}

/**
 * @returns Number of characters (not UTF-16 code units).
 */
function charCount(text: string): number {
    return [...text].length;
}

/**
 * @param authorTime Unix timestamp in seconds.
 * @returns The date as YYYY-MM-DD.
 */
function formatDate(authorTime: string): string {
    const date = new Date(parseInt(authorTime, 10) * 1000);
    return `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}`;
}

/**
 * @param authorTime Unix timestamp in seconds.
 * @returns The time as HH:MM.
 */
function formatTime(authorTime: string): string {
    const date = new Date(parseInt(authorTime, 10) * 1000);
    return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
}

/**
 * @param authorTime Unix timestamp in seconds.
 * @param now Current time in milliseconds.
 * @returns How long ago, e.g. "3 months ago", or "just now" for under a minute (or a clock ahead of ours).
 */
function formatAge(authorTime: string, now: number): string {
    const elapsed = now / 1000 - parseInt(authorTime, 10);
    for (const [unit, seconds] of AGE_UNITS) {
        if (elapsed >= seconds) {
            const count = Math.floor(elapsed / seconds);
            return `${count} ${unit}${count === 1 ? '' : 's'} ago`;
        }
    }
    return 'just now';
}

/**
 * @param authorTime Unix timestamp in seconds.
 * @param now Current time in milliseconds.
 * @returns Annotation opacity, lower for older commits.
 */
function ageOpacity(authorTime: string, now: number): number {
    const elapsed = now / 1000 - parseInt(authorTime, 10);
    const [, opacity] = AGE_OPACITY.find(([maxAge]) => elapsed < maxAge) ?? AGE_OPACITY[AGE_OPACITY.length - 1];
    return opacity;
}

/**
 * Builds the hover for a committed line: commit details plus links to copy the hash,
 * show what the commit changed in this file, and open the commit on GitHub, GitLab or Bitbucket.
 * @param hash Full commit hash.
 * @param commit Commit details from the porcelain output.
 * @param now Current time in milliseconds.
 * @param folder Folder of the blamed file, where git commands for the diff run.
 * @param webRepository Where commits can be opened on the web, if known.
 */
function commitHover(hash: string, commit: CommitDetails, now: number, folder: string, webRepository: WebRepository | null): vscode.MarkdownString {
    const hoverMessage = new vscode.MarkdownString('', true);
    // Only our own hover actions may run from links in this hover
    hoverMessage.isTrusted = { enabledCommands: [COPY_HASH_COMMAND, SHOW_DIFF_COMMAND] };
    hoverMessage.appendCodeblock(commit.summary || 'No commit message.', 'text');
    hoverMessage.appendMarkdown(`\n\n**Commit:** ${hash}\n\n**Author:** ${commit.author} <${commit['author-mail']}>` +
        `\n\n**Date:** ${formatDate(commit['author-time'])} ${formatTime(commit['author-time'])} (${formatAge(commit['author-time'], now)})`);

    const actions = [`[$(copy) Copy hash](${commandUri(COPY_HASH_COMMAND, hash)})`];
    if (commit.filename) {
        // "previous" is "<parent hash> <path in parent>"; it is missing when the commit added the file
        const [previousHash, ...previousPath] = (commit.previous || '').split(' ');
        const diff: CommitDiff = {
            folder,
            hash,
            path: unquoteGitPath(commit.filename),
            previousHash: previousHash || null,
            previousPath: previousHash ? unquoteGitPath(previousPath.join(' ')) : null,
        };
        actions.push(`[$(diff) Show diff](${commandUri(SHOW_DIFF_COMMAND, diff)})`);
    }
    if (webRepository) {
        actions.push(`[$(link-external) Open on ${webRepository.name}](${webRepository.url}${webRepository.commitPath}${hash})`);
    }
    hoverMessage.appendMarkdown(`\n\n${actions.join(' · ')}`);
    return hoverMessage;
}

/**
 * Decodes a path as git prints it in porcelain output. Paths with unusual characters are wrapped
 * in quotes with C-style escapes, and non-ASCII bytes are written as octal (e.g. "caf\303\251.txt").
 */
function unquoteGitPath(value: string): string {
    if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) {
        return value;
    }
    const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
    const inner = value.slice(1, -1);
    const bytes: number[] = [];
    for (let i = 0; i < inner.length; i++) {
        if (inner[i] !== '\\') {
            bytes.push(...Buffer.from(inner[i]));
        } else if (/^[0-7]{3}$/.test(inner.slice(i + 1, i + 4))) {
            bytes.push(parseInt(inner.slice(i + 1, i + 4), 8));
            i += 3;
        } else {
            i++;
            bytes.push(escapes[inner[i]] ?? inner.charCodeAt(i));
        }
    }
    return Buffer.from(bytes).toString('utf8');
}

function uncommittedHover(): vscode.MarkdownString {
    return new vscode.MarkdownString('**Uncommitted changes**\n\nThis line has not been committed yet.');
}

/**
 * @param command Command id.
 * @param args Arguments passed to the command.
 * @returns A markdown link target that runs the command.
 */
function commandUri(command: string, ...args: unknown[]): string {
    // encodeURIComponent leaves ( and ) alone, but a ) would end the markdown link early (e.g. a file named "a (1).txt")
    const query = encodeURIComponent(JSON.stringify(args)).replace(/\(/g, '%28').replace(/\)/g, '%29');
    return `command:${command}?${query}`;
}

/**
 * Hover action: copies a commit hash to the clipboard.
 * @param hash Full commit hash.
 */
async function copyCommitHash(hash: string) {
    await vscode.env.clipboard.writeText(hash);
    vscode.window.setStatusBarMessage(`$(check) Copied commit ${hash.substring(0, HASH_WIDTH)}`, 2000);
}

/**
 * Hover action: shows what a commit changed in a file, as a diff of the file in the parent commit and in the commit.
 */
async function showCommitDiff({ folder, hash, path: filePath, previousHash, previousPath }: CommitDiff) {
    const before = revisionUri(folder, previousPath || filePath, previousHash);
    const after = revisionUri(folder, filePath, hash);
    const title = `${path.basename(filePath)} (${hash.substring(0, HASH_WIDTH)})`;
    await vscode.commands.executeCommand('vscode.diff', before, after, title);
}

/**
 * @param folder Folder inside the repository, where git runs.
 * @param filePath Path relative to the repository root.
 * @param ref Commit hash, or null for an empty document.
 */
function revisionUri(folder: string, filePath: string, ref: string | null): vscode.Uri {
    return vscode.Uri.from({ scheme: REVISION_SCHEME, path: `/${filePath}`, query: JSON.stringify({ folder, ref }) });
}

/**
 * Supplies a file's contents at a commit for the diff view.
 * @param uri A URI built by revisionUri().
 */
function provideRevisionContent(uri: vscode.Uri): Promise<string> {
    const { folder, ref } = JSON.parse(uri.query) as { folder: string; ref: string | null };
    if (!ref) {
        return Promise.resolve('');
    }
    return new Promise(resolve => {
        // In <commit>:<path>, the path is relative to the repository root
        runGit(['show', `${ref}:${uri.path.replace(/^\//, '')}`], folder, undefined, (error, stdout) => resolve(error ? '' : stdout));
    });
}

/**
 * Finds the web page of the `origin` remote for a folder. Cached per folder.
 */
function getRemoteRepository(folder: string): Promise<WebRepository | null> {
    let repository = remoteRepositories.get(folder);
    if (!repository) {
        repository = new Promise(resolve => {
            runGit(['remote', 'get-url', 'origin'], folder, undefined, (error, stdout) => resolve(error ? null : toWebRepository(stdout)));
        });
        remoteRepositories.set(folder, repository);
    }
    return repository;
}

/**
 * Converts a git remote URL to its web repository, e.g. git@github.com:owner/repo.git -> https://github.com/owner/repo.
 * Handles https://, ssh:// and scp-style (user@host:path) remotes; any credentials in the URL are dropped.
 * @returns null for local paths and hosts without known commit pages.
 */
function toWebRepository(remote: string): WebRepository | null {
    const match = remote.trim().match(/^(?:[a-z][a-z+.-]*:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/i);
    if (!match) {
        return null;
    }
    const [, host, repositoryPath] = match;
    const knownHost = WEB_HOSTS.find(candidate => host.toLowerCase().includes(candidate.match));
    return knownHost ? { name: knownHost.name, url: `https://${host}/${repositoryPath}`, commitPath: knownHost.commitPath } : null;
}

export function deactivate() {
    cancelPendingBlames();
}
