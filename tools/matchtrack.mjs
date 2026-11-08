#!/usr/bin/env node
/**
 * matchtrack — the track generator of the remake against a trace of the
 * instrumented original (METHODOLOGY: match; the acceptance test of
 * GR-M6 and, for the pickups spawned, of GR-M7). The trace
 * (tools/trace/README.md, the GR-M6 build of the tracer or later)
 * carries, besides the state of every `FixedUpdate`, the values
 * `Random.Range` returned with the call site that asked (`rnd`, `rs`), the
 * blocks the original placed (`blk`: prefab, id, section, x, z — and, from
 * the GR-M7 tracer, `pu`: the pickups spawned on it) and the crash as a
 * marker line. The game runs headless through GameWorker on the
 * **reference blocks and sections** of sources/extract/json/
 * sections.json (GR-M4, outside git — converted by tools/tracelib.mjs into
 * the shape app/track.js takes; the game itself never sees them), its
 * generator and its spawner fed the recorded values in place of their
 * own randomness, the per-frame generator run after the ticks of each
 * render frame (`fc`). Compared:
 *
 *   - the sequence of blocks placed: prefab, section index, x and z
 *     (0.05 u) — the generator of notes 8 in every detail that matters
 *     (the row offset, the tiling, the section sequence, the sideways
 *     recycling that feeds the next row's centre);
 *   - the obstacles of every placed block: each collider of the reference
 *     has a shape at the block's traced position plus its centre, of its
 *     size (0.05 u) — the conversion and the placement agree;
 *   - the pickups spawned on every placed block (`pu`): as many, of the
 *     kinds in the spawn points' order, at the points (0.05 u) — the
 *     spawner of notes 12 with its rolls in the original's order;
 *   - the randomness: every value the generator and the spawner ask for
 *     comes from the call site it should (`StartNewBlockRow`, `SetTiling`,
 *     `GetBlockID`, `PowerupSpawner.spawn`), none is left over;
 *   - the crash: the tick the game's ship hits an obstacle is the frame of
 *     the trace's `crash` marker (the collision of notes 11 on the moving
 *     obstacles of chap. 11 that are modelled: MovingBlock, FallingPillar,
 *     Mover, MoverDistanceBased, RotateAround; the rest stand still —
 *     `-v` lists what a block has of them).
 *
 * The report is the number of checks and the number of differences (the
 * exit code); `-v` prints the first divergence of every kind.
 *
 * `--own` runs on the game's own data/sections.json instead of the
 * reference (a trace of the remake, the selftest). `--selftest` writes a
 * trace from the game itself — several ticks per render frame, the
 * spawner's rolls in it, a crash — and matches it back: the plumbing,
 * not the original. `--reference` prints what the conversion makes of the
 * reference (blocks, shapes, spawn points, animators modelled or not).
 *
 * usage: node tools/matchtrack.mjs <trace.jsonl> [--own] [--tolerance 1] [--limit N] [-v]
 *        node tools/matchtrack.mjs --selftest
 *        node tools/matchtrack.mjs --reference [world]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { root, REF_SECTIONS, loadData, readTrace, hasPickups, tracedRng, loggingRng, loadReference, referenceTrack, ownTrack, feedTrace, frameClock } from './tracelib.mjs';

const { GameWorker } = await import('../app/gameWorker.js');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i+1] : def; };
const valued = ['--tolerance', '--limit', '--reference'];
const files = args.filter((a, i) => !a.startsWith('-') && !valued.includes(args[i-1]));
const verbose = args.includes('-v');
const scale = parseFloat(opt('--tolerance', '1'));
const limit = parseInt(opt('--limit', '0'), 10);
const TOL = 0.05;
const data = loadData();

/**
 * Runs the game through the trace and compares.
 * @param {{header: Object, frames: Object[], marks: Object[]}} trace
 * @param {Object} track - `{blocks, worlds}` as referenceTrack()/ownTrack() return it.
 * @returns {Object} The counts and the first differences.
 */
function match(trace, track) {
  const h = trace.header;
  const n = limit > 0 ? Math.min(limit, trace.frames.length) : trace.frames.length;
  const frames = trace.frames.slice(0, n);
  let checks = 0, differences = 0;
  const firsts = {};
  const diff = (kind, detail) => {
    differences++;
    if (!firsts[kind]) {
      firsts[kind] = detail;
    }
  };

  // the recorded randomness and the placed blocks, in trace order
  const replay = tracedRng(frames, (d) => diff('rng', d));
  if (replay.untagged) {
    console.log(`  the trace has ${replay.untagged} random values without a call site (a GR-M5 tracer?) — the generator cannot be fed from it`);
  }
  const traced = [];
  frames.forEach((f) => (f.blk || []).forEach((b) => traced.push(Object.assign({frame: f.f}, b))));
  const withPickups = hasPickups(frames);

  const worker = new GameWorker(() => {});
  worker.handleMessage({id: 'init', seed: h.seed || 0, data: data, headless: true, world: h.world || 0, shipId: h.shipId,
    battery: h.battery || 1, coins: h.coins, multiplier: h.multiplier, magnet: h.magnet,
    trackData: {blocks: track.blocks, worlds: track.worlds}, rng: replay.rng});
  const game = worker.game;

  let crashTick = null, energyTick = null;
  feedTrace(worker, frames, {limit: 0, dt: h.dt, onTick: (f, last) => {
    if (game.phase != 'playing' && crashTick === null && energyTick === null) {
      if (game.crashReason == 'explosion') {
        crashTick = last.state.tick;
      } else {
        energyTick = last.state.tick;
      }
    }
  }});

  // 1. the blocks placed
  const ours = game.track.generated;
  const count = Math.max(traced.length, ours.length);
  for (let k = 0; k < count; k++) {
    const t = traced[k], o = ours[k];
    checks++;
    if (!t || !o) {
      diff('blocks', {n: k+1, traced: t ? t.n : '(none)', ours: o ? o.id : '(none)', problem: 'the counts differ'});
      continue;
    }
    if (t.n !== o.id) {
      diff('block', {n: k+1, frame: t.frame, traced: t.n, ours: o.id});
    }
    checks++;
    if (typeof t.s == 'number' && t.s !== o.section) {
      diff('section', {n: k+1, frame: t.frame, block: t.n, traced: t.s, ours: o.section});
    }
    checks += 2;
    if (Math.abs(t.x-o.x) > TOL*scale) {
      diff('x', {n: k+1, frame: t.frame, block: t.n, traced: t.x, ours: o.x, d: Math.abs(t.x-o.x)});
    }
    if (Math.abs(t.z-o.z) > TOL*scale) {
      diff('z', {n: k+1, frame: t.frame, block: t.n, traced: t.z, ours: o.z, d: Math.abs(t.z-o.z)});
    }
  }

  // 2. the obstacles of every placed block: the reference's colliders at the traced position against our shapes at rest
  let obstacles = 0;
  traced.forEach((t, k) => {
    const def = game.track.defs[t.n];
    const o = ours[k];
    if (!def || !o) {
      return;
    }
    const expected = track.blocks[t.n];
    const list = expected.shapes || (expected.obstacles && def.shapes);   // the own data: the prepared shapes are the expectation
    if (!list) {
      return;
    }
    checks++;
    if (list.length !== def.shapes.length) {
      diff('shapes', {n: k+1, block: t.n, expected: list.length, ours: def.shapes.length});
      return;
    }
    def.shapes.forEach((s, j) => {
      const e = list[j];
      const ec = expected.shapes ? [t.x+e.c[0], e.c[1], t.z+e.c[2]] : [t.x+s.c[0], s.c[1], t.z+s.c[2]];
      const oc = [o.x+s.c[0], s.c[1], o.z+s.c[2]];
      obstacles++;
      checks += 2;
      const d = Math.hypot(ec[0]-oc[0], ec[1]-oc[1], ec[2]-oc[2]);
      if (d > TOL*scale) {
        diff('obstacle', {n: k+1, block: t.n, shape: j, object: s.object, expected: ec, ours: oc, d: d});
      }
      const es = expected.shapes ? e.s : s.s;
      if (Math.abs(es[0]-s.s[0]) > TOL*scale || Math.abs(es[1]-s.s[1]) > TOL*scale || Math.abs(es[2]-s.s[2]) > TOL*scale) {
        diff('size', {n: k+1, block: t.n, shape: j, expected: es, ours: s.s});
      }
    });
  });

  // 3. the pickups spawned on every placed block (the GR-M7 tracer's `pu`)
  let pickups = 0;
  if (withPickups) {
    traced.forEach((t, k) => {
      if (!Array.isArray(t.pu) || !ours[k]) {
        return;
      }
      const spawned = game.track.spawned.filter((p) => p.n == k+1);
      checks++;
      if (t.pu.length !== spawned.length) {
        diff('pickups', {n: k+1, block: t.n, frame: t.frame, traced: t.pu.map((p) => p.t), ours: spawned.map((p) => p.kind), problem: 'the counts differ'});
        return;
      }
      t.pu.forEach((p, j) => {
        const s = spawned[j];
        pickups++;
        checks += 2;
        if (p.t !== s.kind) {
          diff('pickup', {n: k+1, block: t.n, i: j, traced: p.t, ours: s.kind});
        }
        const d = Math.hypot(p.x-s.x, p.z-s.z);
        if (d > TOL*scale) {
          diff('pickupAt', {n: k+1, block: t.n, i: j, kind: p.t, traced: [p.x, p.z], ours: [s.x, s.z], d: d});
        }
      });
    });
  }

  // 4. the crash
  const crashMark = trace.marks.find((m) => m.mark == 'crash');
  const energyMark = trace.marks.find((m) => m.mark == 'energyOut');
  if (crashMark || crashTick !== null) {
    checks++;
    if (!crashMark || crashTick !== crashMark.at) {
      diff('crash', {traced: crashMark ? crashMark.at : '(none)', ours: crashTick === null ? '(none)' : crashTick,
        hit: game.hit ? game.hit.block+' '+(game.hit.shape.object || game.hit.shape.look) : null});
    }
  }
  if (energyMark || energyTick !== null) {
    checks++;
    if (!energyMark || energyTick !== energyMark.at) {
      diff('energyOut', {traced: energyMark ? energyMark.at : '(none)', ours: energyTick === null ? '(none)' : energyTick});
    }
  }

  // 5. the randomness: every ask met its site (counted by the replay), nothing left
  checks += replay.checks();
  if (replay.left()) {
    checks++;
    diff('rng', {problem: `${replay.left()} random values left over in the trace (the game asked for ${replay.asked()})`});
  }
  return {frames: frames.length, checks: checks, differences: differences, firsts: firsts, blocks: traced.length, ours: ours.length, obstacles: obstacles,
    pickups: pickups, withPickups: withPickups, crash: crashTick, asked: replay.asked()};
} // match

// ----------------------------------------------------------------- selftest

/**
 * A trace from the game itself on the own data: 60 render frames a
 * second over the 50 Hz ticks (so frames carry one or two ticks), the
 * generator's and the spawner's values tagged as the patched original
 * would tag them, the pickups of every block in `pu`, a steer into a box
 * for the crash.
 * @param {string} file
 */
function selfTrace(file) {
  let last = null;
  const worker = new GameWorker((msg) => { if (msg.id == 'frame') last = msg; });
  const seed = 0xC0DE;
  const logging = loggingRng(GameWorker.seededSource(seed));
  worker.handleMessage({id: 'init', seed: seed, data: data, headless: true, rng: logging.rng});
  const game = worker.game;
  const clock = frameClock(0.02);
  const out = [JSON.stringify({trace: 'gr', version: 'selftest', kind: 'track', dt: 0.02, world: 0, battery: 1, steering: 'touch', seed: seed})];
  let f = 0, placed = 0, time = 0;
  const record = (steer, frameFlag) => {
    worker.handleMessage({id: 'tick', input: {steer: steer}, frame: frameFlag});
    const s = last.state;
    f++;
    time += 0.02;
    const fc = clock.fc(time);
    // what the generator and the spawner asked since the last record, and the blocks placed with their pickups
    const rnd = logging.log.map((r) => r.value), rs = logging.log.map((r) => r.site);
    logging.log.length = 0;
    const blk = game.track.generated.slice(placed).map((g) => ({n: g.id, id: 0, s: g.section, x: g.x, z: g.z, a: 0, fc: fc,
      pu: game.track.spawned.filter((p) => p.n == g.n).map((p) => ({t: p.kind, x: p.x, y: 6, z: p.z}))}));
    placed = game.track.generated.length;
    const ev = game.events.filter((e) => e == 'crash' || e == 'energyOut');
    if (ev.length) {
      out.push(JSON.stringify({mark: ev[0], at: f, t: s.time}));
    }
    out.push(JSON.stringify({f: f, t: s.time, dt: 0.02, fc: fc, in: steer, pad: 0, x: s.ship.x, y: s.ship.y, z: s.ship.z, e: s.energyFixed, cr: s.coins, rnd: rnd, rs: rs, ev: ev, blk: blk}));
    return s;
  };
  // the ticks of a render frame at 60 Hz: the frame flag on the last tick of each frame
  let steer = 0;
  for (let i = 0; i < 1500; i++) {
    if (i == 400) steer = 1;
    if (i == 700) steer = -1;
    record(steer, clock.lastOfFrame(time));
    if (game.done) {
      break;
    }
  }
  fs.writeFileSync(file, out.join('\n')+'\n');
} // selfTrace

// --------------------------------------------------------------------- main

function report(name, r, trace, track) {
  console.log(`${name}: ${r.frames} frames (${trace.header.kind || '?'}, ${trace.header.version || '?'}, world ${trace.header.world || 0}), ${r.blocks} blocks traced / ${r.ours} ours, ${r.obstacles} obstacles, ${r.withPickups ? r.pickups+' pickups' : 'no pickups in the trace (a GR-M6 tracer)'}, crash at ${r.crash === null ? '-' : r.crash}, ${r.checks} checks, ${r.differences} differences`);
  if (verbose || r.differences) {
    Object.keys(r.firsts).forEach((k) => console.log(`  ${k}: first difference ${JSON.stringify(r.firsts[k])}`));
  }
  if (verbose && track.report) {
    console.log(`  reference: ${track.report.shapes} shapes, ${track.report.animated} animated, ${track.report.spawnPoints} spawn points, not modelled ${JSON.stringify(track.report.notModelled)}`);
  }
} // report

let exitCode = 0;
if (args.includes('--reference')) {
  const ref = loadReference();
  if (!ref) {
    console.log('reference: sources/extract/json/sections.json is not at hand (GR-M4 tools/unity2sections.mjs)');
    process.exit(2);
  }
  const world = parseInt(opt('--reference', '0'), 10) || 0;
  const t = referenceTrack(ref, world, data);
  const r = t.report;
  console.log(`reference world ${world} (${t.worldId}): ${t.worlds[t.worldId].sections.length} sections, ${r.blocks} blocks, ${r.shapes} shapes (${r.animated} animated), ${r.spawnPoints} spawn points, skipped ${JSON.stringify(r.skipped)}, animators not modelled ${JSON.stringify(r.notModelled)}`);
  if (verbose) {
    Object.keys(r.byBlock).forEach((name) => {
      const b = r.byBlock[name];
      console.log(`  ${name}: ${b.shapes} shapes in ${b.children} children, ${b.animated} animated, ${b.spawnPoints} spawn points${Object.keys(b.others).length ? ', still: '+JSON.stringify(b.others) : ''}`);
    });
  }
}
if (args.includes('--selftest')) {
  const file = path.join(os.tmpdir(), 'gr-selftrack.jsonl');
  selfTrace(file);
  const trace = readTrace(file);
  const r = match(trace, ownTrack(data));
  console.log(`selftest: ${r.frames} frames, ${r.blocks} blocks traced / ${r.ours} ours, ${r.obstacles} obstacles, ${r.pickups} pickups, crash at ${r.crash}, ${r.checks} checks, ${r.differences} differences (${path.relative(root, file)})`);
  if (verbose || r.differences) {
    Object.keys(r.firsts).forEach((k) => console.log(`  ${k}: first difference ${JSON.stringify(r.firsts[k])}`));
  }
  exitCode += r.differences;
}
for (const file of files) {
  const trace = readTrace(file);
  if (!trace.frames.length) {
    console.log(`${path.basename(file)}: no frame records`);
    exitCode++;
    continue;
  }
  let track;
  if (args.includes('--own')) {
    track = ownTrack(data);
  } else {
    const ref = loadReference();
    if (!ref) {
      console.log(`${path.basename(file)}: the reference ${path.relative(root, REF_SECTIONS)} is not at hand (GR-M4 tools/unity2sections.mjs) — nothing compared`);
      exitCode++;
      continue;
    }
    track = referenceTrack(ref, trace.header.world || 0, data);
  }
  const r = match(trace, track);
  report(path.basename(file), r, trace, track);
  exitCode += r.differences;
}
if (!args.includes('--selftest') && !args.includes('--reference') && files.length == 0) {
  console.log('usage: node tools/matchtrack.mjs <trace.jsonl> [--own] [--tolerance 1] [--limit N] [-v] | --selftest | --reference [world]');
  process.exit(2);
}
process.exit(Math.min(exitCode, 255));
