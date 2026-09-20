// Hand a script to the running test/live.mjs and print its output.
import { copyFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const name = `${Date.now()}.mjs`;
const dst = path.join(root, '.tmp-profile', 'cmd', name);
copyFileSync(process.argv[2], dst);
const out = dst.replace(/\.mjs$/, '.out');
const deadline = Date.now() + (Number(process.argv[3]) || 120000);
while (!existsSync(dst + '.done') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
if (!existsSync(out)) { console.log('timed out waiting for the runner (is test/live.mjs running?)'); process.exit(1); }
process.stdout.write(readFileSync(out, 'utf8'));
try { unlinkSync(dst + '.done'); unlinkSync(out); } catch (_) {}
