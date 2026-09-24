---
format: 1920x1080
duration: 40s
message: Give a coding agent the exact part of a page you want changed.
arc: Demo Loop
audience: Developers in share-and-tell
mode: autonomous
music: none
---

## Video direction
Use the browse-tool dark/green identity in frame.md. Show source footage at a fixed, readable scale. No stylized substitute for the extension UI. Silent, with timed editorial captions. Footage is a synthetic local test; CLI excerpts come from its actual save. Hard cuts distinguish interaction from the evidence excerpt. No logo assets, audio or publication claim.

## Frame 0 — Why page feedback exists

- scene: Explain the missing context before showing the interaction.
- duration: 10s
- poster: 7s
- transition_in: cut
- status: animated
- src: compositions/frames/00-context.html
- asset_candidates: assets/saved-page.png

0–5s: “Fix this” needs context. Explain that the coding agent needs the comment and the exact part of the page. Show the original synthetic page with the saved region and comment as clearly separate overlays.
5–10s: Point. Comment. Hand it off. Explain that the note, URL and screenshot stay together in local files the agent can read. End on Chrome extension, local files, CLI, MCP optional.

## Frame 1 — Point, comment, save

- scene: A real extension interaction on a synthetic practice page.
- duration: 14s
- poster: 6s
- transition_in: cut
- status: animated
- src: compositions/frames/01-annotate.html
- asset_candidates: assets/annotation.webm
- motion_rules: dynamic-content-sequencing

0–4s: Fixed full-width recording centered in the canvas. Top: browse-tool / Page feedback. Caption: Point to what should change. The real Region button activates at 1.8s, selection completes at 3.6s.
4–8.9s: Caption becomes Leave a note. The real textarea types Give these cards more space. There is no artificial cursor or reconstructed UI.
8.9–14s: Caption becomes Save the comment and screenshot. Actual save completed at 8.79s. Hold long enough to read the saved comment. Bottom right throughout: Local demo · synthetic page. Captions use short power3 entrances on the actual action beats. Video plays the first 14 seconds at real speed. No pan, zoom or recreated fields. Canvas 1920x1080, footage 1260x643 displayed at 1760x898 (x80,y112); header y34; caption/footer bottom y1020. Ensure the annotation panel stays fully readable.

## Frame 2 — Read the same feedback

- scene: An excerpt of actual CLI output beside the original saved screenshot.
- duration: 16s
- poster: 9s
- transition_in: cut
- status: animated
- src: compositions/frames/02-handoff.html
- asset_candidates: assets/feedback.json, assets/saved-page.png
- motion_rules: dynamic-content-sequencing

0–3s: Top headline Read the saved review with one command. Left panel command browse-feedback read --root "$INBOX" --batch "$BATCH" in two lines; label Actual CLI result · excerpt. Variables identify the recording's inbox and batch; do not print a user's absolute directory.
3–7s: Reveal the real comment and kind from assets/feedback.json in readable monospace. Avoid raw UUIDs. Right shows actual assets/saved-page.png, label Original screenshot. Add a separate transparent rectangle at the recorded coordinates to identify the selected region; label Selection overlay from saved coordinates. Do not alter the PNG itself.
7–11s: Reveal target rect x38,y262,width690,height264 and status open, all verified against feedback.json. State The same note. The exact region. The original screenshot.
11–16s: Add bottom line Chrome extension + local files + CLI. Secondary line MCP optional. Bottom brand browse-tool, with Local demo · synthetic page and Saved locally on your Mac. Preserve footage truth. Concrete CLI result, no fake coding-agent chat, no claims of MCP or desktop acceptance. Stage each group across the shot, then hold for reading. Use restrained power3 reveals; do not animate the screenshot itself.
