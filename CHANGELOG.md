# Change Log

## [1.0.0]

- Blame follows unsaved edits while you type.
- Uncommitted lines are dimmed and marked `uncommitted`.
- Blame shows in every visible editor, and turning it off clears them all.
- Files that can't be blamed show a status bar hint instead of error pop-ups.
- Annotations line up in columns and appear once per block of lines from the same commit.
- Relative commit ages such as `3 months ago`, with older commits faded.
- Hover actions: **Copy hash**, **Show diff**, and **Open on GitHub / GitLab / Bitbucket**.
- Large files no longer fail to blame.
- Symlinked files are blamed like the file they point to.
- Blame keeps working when `blame.ignoreRevsFile` points at a missing file.
- The status bar button appears right after startup, without running the command first.
- Hover links can't be added or hijacked through crafted commit author names, emails or remote URLs.
- Rewritten in TypeScript.

## [0.0.4]

- Blame now works for files inside Git submodules.
- Fixed blame for workspaces opened through a symlink.
- Fixed blame for file paths containing quotes or `$`.
- No more error pop-ups for non-file editors such as output panels.

## [0.0.3]

- Lowered the minimum VS Code version to 1.90.

## [0.0.2]

- Added extension icon.

## [0.0.1]

- Initial release: whole-file blame toggle, status bar button, and hover details.
