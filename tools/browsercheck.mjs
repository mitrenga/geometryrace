#!/usr/bin/env node
/**
 * browsercheck — the real page in a headless Chromium (SwiftShader, so the
 * WebGL2 shaders really compile and draw), driven over the DevTools
 * protocol through a pipe (no npm module needed): boot → menu → the
 * dialogs of GR-M8 (HALL OF FAME, SHIPS with an attempt to buy, WORLDS
 * with the first world chosen and an attempt to open a closed one — the
 * store and the worlds read and write the progress in localStorage, and
 * the saved progress is read back at the end) → START GAME
 * → a steer to the left → screenshots, then the worker's own state read
 * from inside the worker (ticks, phase, the clock) and every console error
 * of the page and of the worker. It catches what the Node fingerprints
 * cannot: a shader that does not compile, a worker whose clock never
 * ticks (2026-09-16: `Game.DT` gone → `TICK_MS` NaN → 0 frames, while
 * `regress` was at 0 differences), data that does not reach the worker.
 *
 * Not a fingerprint (R-032: never a pixel from a GPU into a reference) —
 * the report is the worker's tick count after N seconds and the error
 * count; the exit code is 0 when the worker ticked at roughly 50 Hz and
 * nothing errored. The screenshots are for the eye.
 *
 * Needs: the Playwright Chromium on the machine (the newest
 * `~/.cache/ms-playwright/chromium-<n>`, or `--chrome <path>`), `php` (the tool
 * starts `php -S 127.0.0.1:8791 router.php` itself unless the port answers),
 * `config/config.php` with `$devMode = true` (the sources are served as
 * modules; a build is not needed).
 *
 * usage: node tools/browsercheck.mjs [--out dir] [--chrome path] [--port 8791] [--seconds 3] [-v]
 */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i+1] : def; };
const verbose = args.includes('-v');
const port = parseInt(opt('--port', '8791'), 10);
const seconds = parseFloat(opt('--seconds', '3'));
const out = opt('--out', path.join(os.tmpdir(), 'gr-browsercheck'));
fs.mkdirSync(out, {recursive: true});

function findChrome() {
  const given = opt('--chrome', '');
  if (given) return given;
  const base = path.join(os.homedir(), '.cache/ms-playwright');
  if (fs.existsSync(base)) {
    const dirs = fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
    for (const d of dirs) {
      const p = path.join(base, d, 'chrome-linux/chrome');
      if (fs.existsSync(p)) return p;
    }
  }
  for (const c of ['chromium', 'chromium-browser', 'google-chrome']) {
    try { return execSync('which '+c, {stdio: ['ignore', 'pipe', 'ignore']}).toString().trim(); } catch (e) { /* next */ }
  }
  throw new Error('no Chromium found: pass --chrome <path>');
} // findChrome

const portOpen = () => new Promise((resolve) => {
  const s = net.connect(port, '127.0.0.1');
  s.on('connect', () => { s.destroy(); resolve(true); });
  s.on('error', () => resolve(false));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------- the server
let php = null;
if (!(await portOpen())) {
  php = spawn('php', ['-S', '127.0.0.1:'+port, 'router.php'], {cwd: root, stdio: 'ignore'});
  for (let i = 0; i < 30 && !(await portOpen()); i++) await sleep(100);
  if (!(await portOpen())) { console.log('php -S did not come up'); process.exit(2); }
  if (verbose) console.log(`php -S on ${port} started`);
}

// ------------------------------------------------------------- the browser
const chromePath = findChrome();
const chrome = spawn(chromePath, ['--headless=new', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
  '--window-size=1280,720', '--remote-debugging-pipe', 'about:blank'], {stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe']});
const inPipe = chrome.stdio[3], outPipe = chrome.stdio[4];
let id = 0, buf = '', workerSession = null, workerSessions = [];
const pending = new Map();
const events = [];
const send = (method, params, sessionId) => new Promise((resolve) => {
  const m = {id: ++id, method, params: params || {}};
  if (sessionId) m.sessionId = sessionId;
  pending.set(m.id, resolve);
  inPipe.write(JSON.stringify(m)+'\0');
});
outPipe.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\0')) >= 0) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i+1);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method) {
      events.push(msg);
      if (msg.method == 'Target.attachedToTarget' && msg.params.targetInfo.type == 'worker') {
        // a worker (the game's, or the audio handler's scheduler): see its exceptions from its first line on;
        // the game worker is found among them by its `gameWorker` global
        workerSession = msg.params.sessionId;
        workerSessions.push(workerSession);
        send('Runtime.enable', {}, workerSession).then(() => send('Runtime.runIfWaitingForDebugger', {}, workerSession));
      }
    }
  }
});

const t = await send('Target.createTarget', {url: 'about:blank', width: 1280, height: 720});
const a = await send('Target.attachToTarget', {targetId: t.result.targetId, flatten: true});
const s = a.result.sessionId;
await send('Runtime.enable', {}, s);
await send('Target.setAutoAttach', {autoAttach: true, waitForDebuggerOnStart: true, flatten: true}, s);
await send('Log.enable', {}, s);
await send('Network.enable', {}, s);                  // GR-M9: which music file the browser took, and as what
await send('Page.enable', {}, s);
await send('Emulation.setDeviceMetricsOverride', {width: 1280, height: 720, deviceScaleFactor: 1, mobile: false}, s);
await send('Page.navigate', {url: `http://127.0.0.1:${port}/#seed=49374`}, s);
await sleep(9000);                                    // boot: modules, appData, the title's glide into the menu

const shot = async (name) => {
  const r = await send('Page.captureScreenshot', {format: 'png'}, s);
  fs.writeFileSync(path.join(out, name+'.png'), Buffer.from(r.result.data, 'base64'));
};
const key = async (k, vk, type) => send('Input.dispatchKeyEvent', {type: type, key: k, code: k, windowsVirtualKeyCode: vk}, s);

const press = async (k, vk, wait) => { await key(k, vk, 'keyDown'); await sleep(60); await key(k, vk, 'keyUp'); await sleep(wait || 150); };

await shot('menu');
// GR-M8: the dialogs of the menu — HALL OF FAME (row 2), SHIPS (row 3: the
// second ship is not bought, Enter asks for coins), WORLDS (row 4: the second
// world is closed, Enter asks for coins) — each opened, stepped into, shot, closed
await press('ArrowDown', 40); await press('ArrowDown', 40);
await press('Enter', 13, 600);                        // HALL OF FAME (the server answers, or SYSTEM OFFLINE)
await shot('hall');
await press('Escape', 27);
await press('ArrowDown', 40);
await press('Enter', 13, 300);                        // SHIPS
await press('ArrowDown', 40); await press('Enter', 13, 300);
await shot('ships');
await press('Escape', 27);
await press('ArrowDown', 40);
await press('Enter', 13, 300);                        // WORLDS
await press('Enter', 13, 200);                        // the first world chosen again: the progress is saved
await press('ArrowDown', 40); await press('Enter', 13, 300);   // the second, closed: NOT ENOUGH COINS
await shot('worlds');
await press('Escape', 27);
await press('ArrowUp', 38); await press('ArrowUp', 38); await press('ArrowUp', 38); await press('ArrowUp', 38);
const progress = await send('Runtime.evaluate', {returnByValue: true, expression: 'localStorage.getItem(window.appPrefix+".progress")'}, s);
const progressJSON = progress.result && progress.result.result ? progress.result.result.value : null;
await key('Enter', 13, 'keyDown'); await sleep(60); await key('Enter', 13, 'keyUp');   // START GAME
await sleep(seconds*1000/2);
await shot('game-straight');
await key('ArrowLeft', 37, 'keyDown');
await sleep(seconds*1000/2);
await key('ArrowLeft', 37, 'keyUp');
await shot('game-left');

// GR-M9: the pause and the countdown out of it (UnpauseCounting: three digits,
// a ping each, the game back after 1.8 s) — the worker must be running again after
await press(' ', 32, 400);                            // PAUSE
await shot('paused');
await press('Enter', 13, 120);                        // Enter: the countdown runs, the first digit at its full height
await shot('countdown');
await sleep(1900);                                    // past the 1.8 s: the game goes on

let worker = null;
for (const session of workerSessions) {
  const t = await send('Runtime.evaluate', {returnByValue: true, expression: 'typeof gameWorker'}, session);
  if (t.result && t.result.result && t.result.result.value === 'object') {
    workerSession = session;
  }
}
if (workerSession) {
  const w = await send('Runtime.evaluate', {returnByValue: true, expression:
    'JSON.stringify({running: gameWorker.running, paused: gameWorker.paused, ticks: gameWorker.tickCount, tickMs: gameWorker.tickMs(), phase: gameWorker.game && gameWorker.game.phase,'
    +' x: gameWorker.game && gameWorker.game.ship.x, z: gameWorker.game && gameWorker.game.ship.z, roll: gameWorker.game && gameWorker.game.ship.roll,'
    +' camYaw: gameWorker.game && gameWorker.game.camera.yaw, rules: !!(gameWorker.data && gameWorker.data.global && gameWorker.data.global.rules), accumulator: gameWorker.accumulator})'}, workerSession);
  worker = w.result && w.result.result && w.result.result.value ? JSON.parse(w.result.result.value) : {error: JSON.stringify(w.result).slice(0, 300)};
}
const errors = events.filter((e) => e.method == 'Runtime.exceptionThrown'
  || (e.method == 'Runtime.consoleAPICalled' && e.params.type == 'error')
  || (e.method == 'Log.entryAdded' && e.params.entry.level == 'error' && !/manifest\.webmanifest/.test(e.params.entry.url || '')));
await send('Browser.close');
chrome.kill();
if (php) php.kill();

// ------------------------------------------------------------- the report
// the music of the world (GR-M9): the responses for assets/music/ — the format the browser asked for and what came
// (text/html = the site's rewrite of a missing file: the own tune plays then)
const music = events.filter((e) => e.method == 'Network.responseReceived' && /assets\/(music|sfx)\//.test(e.params.response.url))
  .map((e) => e.params.response.url.replace(/.*assets\//, '').replace(/\?.*/, '')+' '+e.params.response.status+' '+e.params.response.mimeType);
const expected = seconds*50;
let saved = null;
try {
  saved = progressJSON ? JSON.parse(progressJSON) : null;
} catch (error) {
  saved = null;
}
const progressOk = !!(saved && saved.version && saved.ships && saved.worlds);   // the worlds dialog saved the choice (or refused the purchase) into localStorage
const ok = worker && worker.rules && worker.ticks > expected*0.6 && worker.phase && errors.length == 0 && progressOk && worker.paused === false;
console.log(`browsercheck: worker ${worker ? worker.ticks : '-'} ticks in ~${seconds} s (expected ~${expected}), phase ${worker ? worker.phase : '-'}, ${worker && worker.paused === false ? 'running after the countdown' : 'PAUSED after the countdown'}, ${errors.length} console errors, progress in localStorage ${progressOk ? 'v'+saved.version+' ('+saved.coins+' coins, ship '+saved.activeShip+', world '+saved.world+')' : 'MISSING'} — ${ok ? 'OK' : 'FAILED'}`);
if (verbose || !ok) {
  console.log('  worker:', JSON.stringify(worker));
  console.log('  progress:', progressJSON);
  errors.slice(0, 10).forEach((e) => console.log('  error:', JSON.stringify(e.params).slice(0, 400)));
}
console.log(`  music: ${music.length ? music.join(', ') : 'not asked for'}`);
console.log(`  screenshots: ${out}/menu.png, hall.png, ships.png, worlds.png, game-straight.png, game-left.png, paused.png, countdown.png`);
process.exit(ok ? 0 : 1);
