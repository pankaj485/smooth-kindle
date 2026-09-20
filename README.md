# Kindle Vertical Scroll

A Firefox extension that adds **continuous vertical scrolling** to the Kindle web reader
(`read.amazon.in`, `read.amazon.com` and the other regional `read.amazon.*` hosts), like the
"Continuous Scrolling" layout in the Kindle mobile app. Scroll with the wheel, trackpad or
keyboard instead of clicking through pages.

## How it works (and why it's built this way)

The Kindle web reader never puts book text in the DOM: it paints each page onto a `<canvas>`
and shows a page *image*. So the extension

1. captures the page images the reader renders,
2. stacks them in a vertical, virtualised scroller mounted inside the reader's own UI layer
   (below its menus and popovers, above its page-turn layer),
3. drives the reader's own next/previous navigation in the background to fetch pages
   ahead of / behind where you are, and
4. whenever you pause, moves the reader's *real* current page to the one at the top of your
   screen, so the footer ("Page 24 of 275 ● 9%"), the scrubber and Whispersync stay correct.

It also rewrites the reader's own render requests to single-column, zero vertical margin, so
consecutive pages butt together with no visible seam.

## Load it in Firefox

1. Open `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on…** → pick `extension/manifest.json`
3. Open a book on read.amazon.* and toggle scroll mode with any of:
   - the **⇅ Scroll** pill in the bottom-right corner,
   - the toolbar button,
   - **Alt+Shift+S**.

The mode is remembered and re-engages when you open the next book. After editing the code,
click **Reload** next to the extension on the `about:debugging` page.

## Keys in scroll mode

| Key | Action |
| --- | --- |
| Space / PageDown / → / right chevron | one screen down |
| Shift+Space / PageUp / ← / left chevron | one screen up |
| ↓ / j, ↑ / k | a few lines |

## Preferences

Stored in `browser.storage.local` (no options page yet). To change one, open
`about:debugging#/runtime/this-firefox` → **Inspect** next to the extension → Console:

```js
browser.storage.local.set({ prefetchAhead: 5 })
```

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | scroll mode on; set automatically by the toggle and remembered across books |
| `prefetchAhead` | `3` | pages fetched below the visible area |
| `prefetchBehind` | `1` | pages fetched above it |
| `showSeams` | `false` | draw a dashed line at each page join (debugging) |

## Project layout

```
extension/
  manifest.json   MV3, Firefox; matches https://read.amazon.*/
  page.js         the feature (page world): CONFIG, Reader, Interceptor, Store, View, App
  content.js      injects page.js, relays prefs (browser.storage.local) and the toggle
  background.js   toolbar button + Alt+Shift+S → toggle
  styles.css      overlay styles (#kvs-*)
test/
  run.mjs, mock-reader.html   headless-Chrome test of the control loop against a mock reader
  live.mjs, live-cmd.mjs      drive a real Firefox against the real reader
tools/probe.js    devtools console script that dumps the reader's markup
```

## Development

```sh
npm install
npm run lint       # web-ext lint
npm test           # drives page.js against test/mock-reader.html in headless Chrome
npm run build      # zip into web-ext-artifacts/
```

### Testing against the real reader

`test/live.mjs` launches a separate, visible Firefox (throwaway profile under `.tmp-profile/`)
with the extension installed and opens read.amazon.in. Log in there once; the profile persists.
It then executes any script handed to it by `test/live-cmd.mjs`:

```sh
npm run live &                       # keep running
node test/live-cmd.mjs my-script.mjs # `export default async (page, browser, consoleLogs) => {…}`
```

`npm start` (`web-ext run`) also works but uses a blank profile each time, so you have to
sign in to Amazon on every launch.

`window.__kvs` exposes `App`, `Reader`, `View`, `Store` and `CONFIG` in the page for debugging.

### Reader markup

Selectors live in the `CONFIG` block at the top of `extension/page.js` and were verified against
read.amazon.in (Sept 2026): page image `#kr-renderer .kg-full-page-img img`, chevrons
`#kr-chevron-left/right` (React handlers need a pointer-event sequence, not `.click()`), position
`ion-title.footer-label.position`, UI layer `#main-content`. If Amazon changes its markup,
`tools/probe.js` (paste into the devtools console on an open book) dumps what's there.

## Limitations

- Scroll mode shows page images: no highlighting, text selection, dictionary or Word Wise.
  Toggle back to paged mode for those.
- Progress sync trails by up to the prefetch window (3 pages) until you pause for ~1 s.
- Changing font/theme/margins re-renders the book. If the reader stays on the same position the
  column is refreshed in place; if it re-paginates to a different position (or you jump via the
  table of contents / scrubber) the column is rebuilt from the page the reader lands on.
- Firefox only (MV3 with `background.scripts`).
