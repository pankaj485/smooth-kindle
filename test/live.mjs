// Drives a separate, visible Firefox with the extension installed against the real reader.
//   node test/live.mjs            # start Firefox (stays open); log in and open a book there
//   node test/live-cmd.mjs x.mjs  # run a script `export default async (page, browser) => {}` in it
// Firefox allows one automation session, so this process owns it and executes command files
// dropped into .tmp-profile/cmd/.
import puppeteer from 'puppeteer-core';
import { writeFileSync, mkdirSync, readdirSync, renameSync, existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tmp = path.join(root, '.tmp-profile');
const cmdDir = path.join(tmp, 'cmd');
mkdirSync(cmdDir, { recursive: true });

const browser = await puppeteer.launch({
  browser: 'firefox',
  executablePath: '/usr/bin/firefox',
  headless: false,
  userDataDir: path.join(tmp, 'profile'),
  defaultViewport: null,
  args: ['--width=1100', '--height=900'],
  extraPrefsFirefox: { 'xpinstall.signatures.required': false },
});
browser.on('disconnected', () => process.exit(0));
console.log('extension installed:', await browser.installExtension(path.join(root, 'extension')));
const first = (await browser.pages())[0] || (await browser.newPage());
if (!/read\.amazon\./.test(first.url())) await first.goto('https://read.amazon.in/', { waitUntil: 'domcontentloaded' });
console.log('Firefox is open at', first.url(), '— log in there, open a book.');

const readerPage = async () => (await browser.pages()).find((p) => /read\.amazon\./.test(p.url())) || (await browser.pages())[0];
const logs = [];
const hook = (p) => { if (p.__hooked) return; p.__hooked = true; p.on('console', (m) => logs.push(`[console.${m.type()}] ${m.text()}`)); p.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`)); };
for (;;) {
  await new Promise((r) => setTimeout(r, 300));
  for (const f of readdirSync(cmdDir).filter((n) => n.endsWith('.mjs')).sort()) {
    const file = path.join(cmdDir, f);
    const out = file.replace(/\.mjs$/, '.out');
    const lines = [];
    const orig = console.log;
    console.log = (...a) => lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    try {
      const page = await readerPage();
      hook(page);
      const mod = await import(`${file}?t=${Date.now()}`);
      await mod.default(page, browser, logs);
    } catch (e) { lines.push('ERROR: ' + (e.stack || e)); }
    finally { console.log = orig; }
    writeFileSync(out, lines.join('\n') + '\n');
    renameSync(file, file + '.done');
  }
}
