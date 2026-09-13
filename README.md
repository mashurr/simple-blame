# Simple Blame

Toggle a whole-file Git blame view right in your editor. See who last changed every line without opening a side panel.

## Features

- **Toggle on/off** from the `Blame: ON/OFF` status bar button or the command palette: **Simple Blame: Toggle Inline Blame**.
- **Inline annotations** before each line: `commit  author  date`.
- **Hover details** with the full commit message, hash, and author email.
- **Auto refresh** when you switch files or save.
- **Submodule aware**, including workspaces opened through symlinks.
- **Lightweight**: does nothing while blame is off.

## Requirements

- Git installed and on your `PATH`.
- The file must be committed to a Git repository.

## Known Issues

- Very large files may take a moment to blame.
- Binary files are not supported.

Report issues on [GitHub](https://github.com/mashurr/simple-blame/issues).

## Release Notes

See [CHANGELOG.md](CHANGELOG.md).
