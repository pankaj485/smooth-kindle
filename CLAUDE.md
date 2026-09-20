# Kindle Vertical Scroll

Firefox extension (MV3) adding continuous vertical scrolling to the Kindle web reader. Plain
ES2022, no bundler. See README.md for how it works and how to load it.

## Layout
- `extension/page.js` — the whole feature, runs in the page world. `CONFIG` at the top holds every
  Amazon selector; keep markup knowledge there and nowhere else.
- `extension/content.js` / `background.js` — inject page.js, relay prefs and the toggle.
- `test/run.mjs` + `test/mock-reader.html` — headless-Chrome test of the control loop against a
  mock that mirrors Amazon's real DOM (`#kr-renderer`, `#kr-chevron-*`, `ion-title.footer-label.position`).
- `test/live.mjs` / `test/live-cmd.mjs` — drive a real Firefox with the real reader (see README).
- `tools/probe.js` — console script to dump the reader's markup when Amazon changes it.

## Working rules
- Text is never in the DOM; the reader shows page images. Don't try to reflow text.
- The reader is React/Ionic: turning a page needs a pointer-event sequence on the chevron
  (bare `.click()` is ignored); a synthetic ArrowRight keydown on `body` also works.
- The reader revokes page blob URLs right after decode — rasterise the `<img>`, never `fetch(src)`.
- The overlay lives inside `#main-content` at z-index 5 so the reader's menus stay on top.
- Foreign page changes (not our navigation): same footer text → `refreshFromCurrent()` (re-capture
  in place); different text → full rebuild from the reader's current page.
- Any change to page.js: `npm run lint && npm test`, then verify on the real reader with the live
  harness (the mock cannot catch markup or event-handling differences).
- `.tmp-profile/` (live-harness Firefox profile, logged in) is gitignored; never commit or copy it.
