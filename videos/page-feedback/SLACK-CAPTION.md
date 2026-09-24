Added Page Feedback to browse-tool for the “fix this bit” problem. You point at a page, leave a note, and your coding agent gets the comment, page URL, exact target and screenshot together. No MCP required.

The 40-second demo shows the actual Chrome extension saving a region comment, then the CLI reading it back.

To try it on a Mac:
1. Run the setup block in the README, then load the unpacked extension in Chrome.
2. Start a named review, select an element or draw a region, and save your comments.
3. Give Codex or Claude Code the local feedback launcher path and review name. The README has a copy-paste prompt for reading the notes, opening screenshots and marking checked fixes resolved.

Setup: https://github.com/nino-chavez/browse-tool#chrome-extension

Feedback stays in local files on your Mac. Chrome starts the helper when needed; there is no separate desktop app or always-running server. This is an unpacked extension, so it needs Chrome developer mode. Curious what breaks when you try it.
