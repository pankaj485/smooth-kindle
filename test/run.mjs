// End-to-end check of page.js against test/mock-reader.html in headless Chrome.
import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = path.join(here, '..', 'extension');
const css = readFileSync(path.join(ext, 'styles.css'), 'utf8');
const js = readFileSync(path.join(ext, 'page.js'), 'utf8');

let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`); if (!ok) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (page, fn, ms = 10000, arg) => { const end = Date.now() + ms; while (Date.now() < end) { if (await page.evaluate(fn, arg)) return true; await sleep(100); } return false; };

const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--window-size=1000,900'] });
const page = await browser.newPage();
await page.setViewport({ width: 1000, height: 900 });
page.on('console', (m) => { if (/\[kvs\]|error/i.test(m.text())) console.log('  browser:', m.text()); });
page.on('pageerror', (e) => console.log('  pageerror:', e.message));
await page.goto('file://' + path.join(here, 'mock-reader.html'));
await page.addStyleTag({ content: css });
await page.evaluate(() => window.__mock.goto(20));
await new Promise((r) => setTimeout(r, 400));
await page.evaluate(js);

const state = () => page.evaluate(() => {
  const { App, View, Store } = window.__kvs;
  return { enabled: App.enabled, readerOrdinal: App.readerOrdinal, stored: [...Store.pages.keys()].sort((a, b) => a - b),
    first: View.first, last: View.last, scrollTop: View.root && View.root.scrollTop, mockPage: window.__mock.page,
    minBound: App.minBound, maxBound: App.maxBound, top: App.currentTopOrdinal(), looping: App.looping, syncTarget: App.syncTarget, rebuilds: App.rebuilds };
});

// 1. Pill appears, enabling captures page 0 and prefetches ahead.
check('pill appears', await until(page, () => !!document.getElementById('kvs-pill')));
await page.click('#kvs-pill');
check('overlay built', await until(page, () => !!document.getElementById('kvs-root') && window.__kvs.App.enabled));
check('prefetched 3 ahead + 1 behind', await until(page, () => window.__kvs.Store.pages.size >= 5 && !window.__kvs.App.looping, 15000), JSON.stringify(await state()));
let s = await state();
check('column ordinals contiguous -1..3', s.first === -1 && s.last === 3, JSON.stringify(s));
check('reader synced back to page 0 after idle', s.readerOrdinal === 0 && s.mockPage === 20, JSON.stringify(s));

// 2. Scrolling down loads more and syncs the reader to the top-visible page.
const slotH = await page.evaluate(() => document.querySelector('.kvs-slot').offsetHeight);
await page.evaluate((h) => { const V = window.__kvs.View; V.root.scrollTop = h * (2 - V.first + 0.5); V.root.dispatchEvent(new Event('scroll')); }, slotH);
check('after scroll: pages up to ordinal 5 loaded', await until(page, () => window.__kvs.Store.has(5) && !window.__kvs.App.looping, 15000), JSON.stringify(await state()));
await sleep(1500);
s = await state();
check('reader synced to top-visible ordinal 2 (mock page 22)', s.readerOrdinal === 2 && s.mockPage === 22, JSON.stringify(s));

// 3. Wheel over the overlay must not reach the reader's own page-turn handler.
const before = await page.evaluate(() => window.__mock.wheelTurns);
await page.mouse.move(500, 400);
await page.mouse.wheel({ deltaY: 300 });
await sleep(300);
check('wheel does not trigger reader page turn', (await page.evaluate(() => window.__mock.wheelTurns)) === before);

// 4. Keyboard: Space scrolls the overlay instead of turning the reader page.
const turnsBefore = await page.evaluate(() => window.__mock.turns);
const stBefore = await page.evaluate(() => window.__kvs.View.root.scrollTop);
await page.keyboard.press('Space');
await sleep(800);
const stAfter = await page.evaluate(() => window.__kvs.View.root.scrollTop);
const turnsNow = await page.evaluate(() => window.__mock.turns);
const loopTurns = turnsNow - turnsBefore; // our own prefetch may turn pages; the mock counts those too
check('Space scrolls overlay', stAfter > stBefore, `${stBefore} → ${stAfter}`);

// 5. Scroll back to the top: pages behind get loaded and prepended without the view jumping.
// Scroll to the very top of the column (ordinal -1); behind-prefetch must prepend -2 and keep the view still.
await page.evaluate(() => { window.__kvs.View.root.scrollTop = 0; window.__kvs.View.root.dispatchEvent(new Event('scroll')); });
check('prefetch behind prepended ordinal -2', await until(page, () => window.__kvs.View.first === -2 && window.__kvs.Store.has(-2), 15000), JSON.stringify(await state()));
s = await state();
check('scrollTop shifted by one slot to keep view stable', Math.abs(s.scrollTop - slotH) < 2, `scrollTop=${s.scrollTop} slot=${slotH}`);
await until(page, () => !window.__kvs.App.looping, 15000);

// 6. Reader-driven relayout (font size change) rebuilds the column from the current page.
const rebuildsBefore = await page.evaluate(() => window.__kvs.App.rebuilds);
const mockPageBefore = await page.evaluate(() => window.__mock.page);
const roBefore = await page.evaluate(() => window.__kvs.App.readerOrdinal);
await page.evaluate(() => document.getElementById('aa').click());
check('refresh after Aa change (same position text)', await until(page, () => window.__kvs.App.refreshes >= 1 && window.__kvs.App.enabled && !window.__kvs.App.busy, 15000), JSON.stringify(await state()));
await until(page, () => !window.__kvs.App.looping && !window.__kvs.App.busy && window.__kvs.Store.pages.size >= 4, 20000);
s = await state();
check('column re-captured around the same page, reader unmoved', s.stored.includes(roBefore) && s.stored.includes(roBefore + 1) && s.readerOrdinal === roBefore && s.mockPage === mockPageBefore && s.rebuilds === rebuildsBefore, JSON.stringify(s));
// A jump (different position text) still does a full rebuild.
await page.evaluate(() => window.__mock.goto(40));
check('rebuild after reader jump', await until(page, (n) => window.__kvs.App.rebuilds === n + 1 && window.__kvs.App.enabled && !window.__kvs.App.busy, 15000, rebuildsBefore), JSON.stringify(await state()));
await until(page, () => !window.__kvs.App.looping && !window.__kvs.App.busy, 15000);
s = await state();
check('rebuilt column anchored on the jumped-to page', s.readerOrdinal === 0 && s.mockPage === 40 && s.stored.includes(0), JSON.stringify(s));

// 7. End of book: no infinite loop, end marker shown.
await page.evaluate(() => { window.__kvs.App.disable(); });
await until(page, () => !window.__kvs.App.enabled && !window.__kvs.App.busy, 15000);
await page.evaluate(() => window.__mock.goto(58));
await sleep(600);
await page.evaluate(() => window.__kvs.App.enable());
check('end of book detected', await until(page, () => window.__kvs.App.maxBound === 2 && !!document.getElementById('kvs-end'), 25000), JSON.stringify(await state()));
s = await state();
check('no runaway: stored pages bounded', s.stored.every((o) => o <= 2), JSON.stringify(s));

// 8. Disable leaves the reader on the page at the top of the view.
await page.evaluate(() => { const r = window.__kvs.View.root; r.scrollTop = r.scrollHeight; r.dispatchEvent(new Event('scroll')); });
await sleep(1200);
const topBefore = await page.evaluate(() => window.__kvs.App.currentTopOrdinal());
await page.evaluate(() => window.__kvs.App.disable());
await until(page, () => !window.__kvs.App.enabled && !window.__kvs.App.busy, 15000);
s = await state();
check('disable syncs reader to top-visible page', s.mockPage === 58 + topBefore, `top=${topBefore} mockPage=${s.mockPage}`);
check('overlay removed', !(await page.evaluate(() => document.getElementById('kvs-root'))));

await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
