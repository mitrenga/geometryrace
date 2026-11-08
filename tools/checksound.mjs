#!/usr/bin/env node
/**
 * checksound — the sound of the game (GR-M9) checked under Node. Since
 * the operator's decision of 2026-09-16 the game plays the original's
 * own recordings and nothing else (a missing file means silence, not a
 * substitute), so what there is to check is the files and the rules
 * around them:
 *   - every effect `app/audioManager.js` names (`AudioManager.samples`)
 *     is in `assets/sfx/` in both formats the application asks for
 *     (`.m4a` where the browser has AAC, `.ogg` for the others), and of
 *     a believable size;
 *   - every world of `data/worlds.json` has its track in `assets/music/`
 *     in both formats;
 *   - the files are what their extension promises: an MPEG-4 container
 *     (`ftyp`) and an Ogg stream (`OggS`) with Vorbis in it;
 *   - the pickup ladder of the original (notes 17,
 *     `SoundManager.PlayPickupSfx`: play, then step +0.05 while at most
 *     1.8, so the top is 1.85; back to 1 after 2 s of the game's ticks);
 *   - the events the worker can send (WORKER-PROTOCOL.md `sounds`) are
 *     each either mapped to one of the original's clips or deliberately
 *     silent, and every mapped name is one of the samples.
 * No DOM, no Web Audio: the same names and the same rules the
 * application plays by.
 *
 * The report is the number of checks and the number of differences; the
 * exit code is the number of differences.
 *
 * usage: node tools/checksound.mjs [-v]
 */
import '../app/svision/tools/nodeEnv.mjs';   // must come first: the import headers read window.srcVersion
import fs from 'node:fs';
import path from 'node:path';

const { AudioManager } = await import('../app/audioManager.js');

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const verbose = process.argv.includes('-v');
let checks = 0, differences = 0;

function check(name, ok, detail) {
  checks++;
  if (!ok) {
    differences++;
    console.log(`  DIFF ${name}${detail === undefined ? '' : ': '+detail}`);
  } else if (verbose) {
    console.log(`  ok   ${name}`);
  }
}

function same(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** the formats the application looks for, in the order `GameApp.musicFormats` offers them */
const FORMATS = ['m4a', 'ogg'];
/** the smallest a clip and a track may believably be */
const MIN_BYTES = {sfx: 4*1024, music: 256*1024};

/**
 * The first bytes of a file, for the format check.
 */
function head(file, bytes) {
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(bytes);
  const read = fs.readSync(fd, buffer, 0, bytes, 0);
  fs.closeSync(fd);
  return buffer.subarray(0, read);
}

/**
 * One sound file: there, of a believable size, and of the format its
 * extension promises.
 */
function checkFile(kind, name, format) {
  const relative = `assets/${kind}/${name}.${format}`;
  const file = path.join(root, relative);
  if (!fs.existsSync(file)) {
    check(`${relative}: there`, false, 'missing — the game is silent without it (README: the operator converts it)');
    return;
  }
  check(`${relative}: there`, true);
  const size = fs.statSync(file).size;
  check(`${relative}: at least ${Math.round(MIN_BYTES[kind]/1024)} kB`, size >= MIN_BYTES[kind], `${Math.round(size/1024)} kB`);
  const bytes = head(file, 64);
  if (format === 'm4a') {
    check(`${relative}: an MPEG-4 container`, bytes.subarray(4, 8).toString('latin1') === 'ftyp', bytes.subarray(0, 12).toString('latin1'));
  } else {
    const text = bytes.toString('latin1');
    check(`${relative}: an Ogg stream`, text.startsWith('OggS'), text.slice(0, 4));
    check(`${relative}: Vorbis in it`, text.includes('vorbis'), text.slice(0, 40).replace(/[^\x20-\x7e]/g, '.'));
  }
}

console.log('checksound: the original\'s effects (assets/sfx)');
const samples = AudioManager.samples;
same('the effects the game names', Object.keys(samples).sort(), ['explosion', 'pickup', 'ping', 'pingLast']);
Object.keys(samples).forEach((name) => {
  check(`${name}: comes from a clip of notes 17`, typeof samples[name] === 'string' && samples[name].length > 0, samples[name]);
  FORMATS.forEach((format) => checkFile('sfx', name, format));
});

console.log('checksound: the music of the worlds (assets/music)');
const worlds = JSON.parse(fs.readFileSync(path.join(root, 'data', 'worlds.json'), 'utf8')).worlds;
check('three worlds', worlds.length === 3, worlds.length);
worlds.forEach((world) => FORMATS.forEach((format) => checkFile('music', world.id, format)));

console.log('checksound: the pickup ladder (notes 17)');
const global = JSON.parse(fs.readFileSync(path.join(root, 'data', 'global.json'), 'utf8'));
const P = AudioManager.PITCH;
same('step', P.step, 0.05);
same('the last pitch that still steps up', P.max, 1.8);
same('reset after 2 s of ticks', P.resetTicks, Math.round(2*global.tick.hz));
let f = 1;
const ladder = [];
for (let i = 0; i < 20; i++) {
  f = AudioManager.nextPitch(f);
  ladder.push(f);
}
same('first step', ladder[0], 1.05);
same('16 steps to 1.8', ladder[15], 1.8);
same('one more step past it (the original steps while <= 1.8)', ladder[16], 1.85);
same('stays at the top', ladder[19], 1.85);
check('monotone', ladder.every((v, i) => i === 0 || v >= ladder[i-1]));

console.log('checksound: the events of a frame (WORKER-PROTOCOL.md)');
// what the worker can send, and the clip the original plays for it (null: the original has none)
const EVENTS = {
  crash: 'explosion',                 // PlayerCrash.Crash
  energyOut: 'explosion',             // the same call without the explosion
  'pickup:coin': 'pickup',            // PowerupManager.ApplyPowerup
  'pickup:multiplier': 'pickup',
  'pickup:energy': 'pickup',
  boosterOn: 'pingLast',              // PlayerControl: BOOSTERS_ON
  boosterOff: null,
  lowEnergy: null,                    // the original reddens the HUD and slows the music, it has no sound
  energyOk: null,
  multiplierOff: null,
  gameOver: null
};
const protocol = fs.readFileSync(path.join(root, 'app', 'WORKER-PROTOCOL.md'), 'utf8');
Object.keys(EVENTS).forEach((event) => {
  check(`${event}: in the protocol`, protocol.includes('`'+event+'`'), 'not named in WORKER-PROTOCOL.md');
  if (EVENTS[event] !== null) {
    check(`${event}: plays ${EVENTS[event]}`, EVENTS[event] in samples, EVENTS[event]);
  }
});
// the countdown's ping is not an event of the worker: the model plays it (UnpauseCounting)
check('the countdown plays ping', 'ping' in samples);

console.log(`checksound: ${checks} checks, ${differences} differences`);
process.exit(differences);
