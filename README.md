# Simple Blame

A simple, lightweight VS Code extension to toggle a whole-file Git blame view directly in your editor. Instantly see who last edited every line of a file without leaving your code or needing a complex side panel.



*(Image: Toggling blame on, hovering for details, and toggling off)*

## Features

Simple Blame is designed to be unobtrusive and easy to use.

*   **Toggleable Blame View:** Turn the blame annotations on or off with a single click. You can use:
    *   The **`Blame: ON/OFF`** button in the status bar.
    *   The command palette (`Ctrl+Shift+P` or `Cmd+Shift+P`) and search for **"Simple Blame: Toggle Inline Blame"**.

*   **Inline Annotations:** When enabled, blame information is shown to the left of each line of code in a clean `[commit] [author] [date]` format.

*   **Detailed Hover Information:** Hover over any blame annotation to see the full commit details, including the complete commit message, author email, and full commit hash.

*   **Automatic Updates:** The blame view automatically updates when you switch to a new file or save changes to the current file.

*   **Lightweight:** The extension is activated on command and does nothing when the blame view is off, ensuring it uses zero resources in the background.

## Requirements

For the extension to work, you must have the following:

1.  **Git** installed on your system and available in your system's PATH.
2.  The file you are viewing must be inside a **Git repository**.
3.  The file must be **committed**. The extension cannot show blame information for new, uncommitted files.

## Extension Settings

This extension does not contribute any settings. It is configured entirely through the toggle command.

## Known Issues

*   **Performance on very large files:** Running `git blame` on files with hundreds of thousands of lines may take a moment to process. The editor will remain responsive while the command runs in the background.
*   **Binary files:** The extension is not designed to work on binary files and will not show blame information for them.

Please report any other issues on the GitHub repository issues page.

## Release Notes

### 1.0.0

Initial release of Simple Blame.
*   Added whole-file blame view.
*   Added toggle command in the Command Palette.
*   Added clickable status bar item to show state and toggle blame.
*   Added detailed hover information for each line.

---

**Enjoy!**