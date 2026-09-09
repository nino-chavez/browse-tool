# Page feedback demo

A silent 40-second video for the share-and-tell Slack channel (C0BN3586Y4V). It opens with why a comment needs a precise target, then shows a real Chrome extension save on a synthetic page, followed by an excerpt from the actual CLI result. The extension is distributed unpacked in this repository. It does not show an agent modifying a website, or a configured desktop MCP integration.

## Render the existing recording

From this directory:

```sh
npm run check
npm run render -- --quality high --fps 30 --workers 2 --output renders/page-feedback-demo.mp4
```

The CLI is pinned to HyperFrames 0.8.33. Node 22+ and FFmpeg must be available. GSAP 3.14.2 is vendored under assets with its original license notice. Rendering needs no HeyGen login or audio service.

## Record a fresh demonstration

Install the parent repository's dependencies first. Start the standing browse-tool automation browser. The recording script uses BROWSE_PORT (9339 by default). It refuses an existing Page Feedback extension or native-host registration in that automation profile; it never changes the everyday Chrome profile.

```sh
BROWSE_PORT=9339 node capture.mjs
```

The script builds and temporarily registers its own extension and native helper, creates a separate browser window, records Region selection and a comment, and reads the result through browse-feedback. It cleans up its own browser window, extension and native-host registration. It preserves the shared browser profile and its existing tabs. The temporary inbox path is recorded in capture/receipt.json.

A fresh recording changes the batch ID, screenshot ID, URL port and capture timings. Check capture/receipt.json, update the timing captions in compositions/frames/01-annotate.html, and compare the excerpt and rectangle in compositions/frames/02-handoff.html against assets/feedback.json before rendering again.

## Source and evidence

- BRIEF.md and STORYBOARD.md hold the intent and timing.
- frame.md derives the surrounding dark/green style from the repo's assets/readme/how-it-works.svg.
- fixture.html is the synthetic page. The annotation panel is the real extension.
- assets/annotation.webm is the original continuous recording. The edit uses its first 14 seconds at normal speed. The WebM was remuxed without re-encoding to add seek metadata.
- assets/feedback.json is the unmodified browse-feedback read response.
- assets/saved-page.png is the original saved screenshot. The selection rectangle in the video is drawn separately from the returned coordinates, and labeled.
- capture/receipt.json records the actual interaction times and viewport.
- SLACK-CAPTION.md holds the accompanying setup and usage message.

The original capture has no private tabs, account details or customer data. The local page's content and comment are synthetic. Captions describe the observed save and read; no automatic agent action is implied.
