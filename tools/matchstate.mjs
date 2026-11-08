#!/usr/bin/env node
/**
 * matchstate — the state of the remake, tick by tick, against a trace of
 * the instrumented original (METHODOLOGY: match; the acceptance test of
 * GR-M5 and, with `--track`, of GR-M7). The trace is a JSON-lines file
 * from sources/traces/ (the format in tools/trace/README.md): a header,
 * then one record per `FixedUpdate` of the original with its input, its
 * step and everything `PlayerControl`, `PlayerEnergy` and `CameraMover`
 * hold after it. The game runs headless through GameWorker, each tick fed
 * the frame's input and `dt`, and the fields below are compared within a
 * tolerance: the report is the number of comparisons and the number
 * outside the tolerance (the exit code), the first divergence of every
 * field with `-v`.
 *
 * Fields and tolerances (the original runs in float32, the game in doubles;
 * the exponential smoothings contract, so the error does not grow, but a
 * position adds up 2000 times):
 *   x, y, z (ship), cx, cz (camera)     0.05 u
 *   rx, ry, rz, crz, cry (Euler °)      0.05°
 *   e (energy), im, ef, pt, vpt, ratio, tilt, vx   1e-3
 * `--tolerance k` scales all of them.
 *
 * Without `--track` the game runs without a track (a GR-M5 trace has no
 * track in it): the ship, the camera and the energy drain. `--track` runs
 * it on the **reference blocks** of sources/extract/json/sections.json
 * (outside git; `--own` the game's own data/sections.json) with the
 * recorded randomness replayed (tools/tracelib.mjs) — then the pickups
 * are there and the GR-M7 fields are compared too:
 *   cr (coins of the run), cm (credit multiplier)   exact
 *   ct (the multiplier's timer, while it runs)      1e-3
 *   pk (the pickups collected): kind and place (0.05 u), one by one
 * The original writes a record at the end of `FixedUpdate`, before the
 * physics step that collects the pickups of that tick, so `e` is compared
 * with the energy before the tick's pickups (`energyFixed`) and `cr`,
 * `cm`, `ct`, `pk` of record f with the game's tick f − 1 (notes 12).
 *
 * `--rules` compares data/global.json `rules` with the reference
 * sources/extract/json/params.json (GR-M4, outside git — notes 22): the
 * constants the game reads must be the ones the original serialises —
 * and, GR-M8, the mechanics of the store and the worlds in data/ships.json
 * and data/worlds.json (the prices, the default ship, the upgrade slots,
 * the distances to win — notes 14, 15; the names and the shapes are the
 * game's own). It needs the reference at hand and says so when it is not.
 *
 * `--selftest` writes a trace from the game itself (a run with a scripted
 * input, once without a track and once on the own track with the
 * randomness logged and the pickups in it) and matches it back: it proves
 * the plumbing — the format, the field mapping, the shift of the pickup
 * fields, the tolerance — and nothing about the original.
 *
 * `--world N` (0..2) runs the trace in another world than its header says
 * (GR-M8: a trace per world — the sections and the tiling differ, the
 * mechanics do not); `--battery`, `--coins`, `--multiplier`, `--magnet`
 * the upgrade multipliers of the ship that flew it (notes 14) when the
 * header has none.
 *
 * usage: node tools/matchstate.mjs <trace.jsonl> [--track [--own]] [--world N] [--tolerance 1] [--limit N] [--battery 1] [--coins 1] [--multiplier 1] [--magnet 0] [-v]
 *        node tools/matchstate.mjs --rules
 *        node tools/matchstate.mjs --selftest
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { root, REF_PARAMS, loadData, readTrace, hasTrack, hasPickups, tracedRng, loggingRng, loadReference, referenceTrack, ownTrack, feedTrace, frameClock } from './tracelib.mjs';

const { GameWorker } = await import('../app/gameWorker.js');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i+1] : def; };
const valued = ['--tolerance', '--limit', '--battery', '--coins', '--multiplier', '--magnet', '--world'];
const files = args.filter((a, i) => !a.startsWith('-') && !valued.includes(args[i-1]));
const verbose = args.includes('-v');
const scale = parseFloat(opt('--tolerance', '1'));
const limit = parseInt(opt('--limit', '0'), 10);
const withTrack = args.includes('--track');
const own = args.includes('--own');
const worldOverride = opt('--world', null);
const data = loadData();

/** trace field → [path in the state, tolerance, unit, shift: the field of record f is the game's tick f − 1] */
const FIELDS = {
  x: ['ship.x', 0.05, 'u'], y: ['ship.y', 0.05, 'u'], z: ['ship.z', 0.05, 'u'],
  rx: ['ship.pitch', 0.05, '°'], ry: ['ship.yaw', 0.05, '°'], rz: ['ship.roll', 0.05, '°'],
  cx: ['camera.x', 0.05, 'u'], cz: ['camera.z', 0.05, 'u'],
  cry: ['camera.yaw', 0.05, '°'], crz: ['camera.roll', 0.05, '°'],
  e: ['energyFixed', 1e-3, ''],
  im: ['input.inputMultiplier', 1e-3, ''], ef: ['input.energyFactor', 1e-3, ''],
  pt: ['input.pressTime', 1e-3, ''], vpt: ['input.visualPressTime', 1e-3, ''],
  ratio: ['input.ratio', 1e-3, ''], tilt: ['input.tilt', 1e-3, ''], vx: ['input.velocityX', 1e-3, ''],
  cr: ['coins', 0, '', true], cm: ['multiplier.value', 0, '', true], ct: ['multiplier.timer', 1e-3, 's', true]
};
const ANGLES = ['rx', 'ry', 'rz', 'cry', 'crz'];
const TOL = 0.05;

const get = (o, p) => p.split('.').reduce((v, k) => (v == null ? undefined : v[k]), o);
const signed = (a) => { a = ((a%360)+360)%360; return a > 180 ? a-360 : a; };

/**
 * The world a trace runs in: `--world`, else its header's.
 * @param {Object} header
 * @returns {number}
 */
function traceWorld(header) {
  return worldOverride !== null ? parseInt(worldOverride, 10) : (header.world || 0);
} // traceWorld

/**
 * Runs the game through the trace's frames and compares.
 * @param {{header: Object, frames: Object[]}} trace
 * @param {Object|null} track - `{blocks, worlds}` to run on, or null for no track.
 * @returns {{checks: number, differences: number, firsts: Object, frames: number}}
 */
function match(trace, track) {
  const h = trace.header;
  let checks = 0, differences = 0;
  const firsts = {};
  const diff = (kind, detail) => {
    differences++;
    if (!firsts[kind]) {
      firsts[kind] = detail;
    }
  };
  const replay = track ? tracedRng(trace.frames, (d) => diff('rng', d)) : null;
  if (replay && replay.untagged) {
    console.log(`  the trace has ${replay.untagged} random values without a call site (a GR-M5 tracer?) — the track cannot be replayed from it`);
  }
  const worker = new GameWorker(() => {});
  worker.handleMessage({id: 'init', seed: h.seed || 0, data: data, headless: true, track: track ? undefined : false,
    world: traceWorld(h), shipId: h.shipId, battery: parseFloat(opt('--battery', h.battery || 1)),
    coins: parseFloat(opt('--coins', h.coins || 1)), multiplier: parseFloat(opt('--multiplier', h.multiplier || 1)), magnet: parseFloat(opt('--magnet', h.magnet || 0)),
    trackData: track ? {blocks: track.blocks, worlds: track.worlds} : undefined, rng: replay ? replay.rng : undefined,
    setup: h.noCrash ? (g) => { g.track.hit = () => null; } : undefined});   // `noCrash`: the selftest's trace only (its driver cannot dodge)
  const game = worker.game;
  let previous = game.state();              // the state of tick f − 1 for the shifted fields
  let previousPickups = [];                 // the pickups the game collected in tick f − 1
  const pickupFields = !!track && hasPickups(trace.frames);
  const fed = feedTrace(worker, trace.frames, {limit: limit, dt: h.dt, onTick: (f, last) => {
    const s = last.state;
    Object.keys(FIELDS).forEach((k) => {
      if (typeof f[k] != 'number') {
        return;
      }
      const [p, tol, , shifted] = FIELDS[k];
      if (shifted && !track) {
        return;                             // the coins and the multiplier need the track's pickups
      }
      if (k == 'ct' && !(f.cm > 1)) {
        return;                             // the timer only while the multiplier runs (it keeps its last value otherwise)
      }
      let ours = get(shifted ? previous : s, p), theirs = f[k];
      if (ANGLES.includes(k)) {
        ours = signed(ours);
        theirs = signed(theirs);
      }
      checks++;
      let d = Math.abs(ours-theirs);
      if (ANGLES.includes(k) && d > 180) {
        d = 360-d;
      }
      if (d > tol*scale) {
        diff(k, {frame: f.f, tick: s.tick, ours: ours, theirs: theirs, d: d});
      }
    });
    if (pickupFields && Array.isArray(f.pk)) {
      // the pickups collected in the physics step of the original's tick f − 1 = the game's tick f − 1
      const theirs = f.pk, ours = previousPickups;
      checks++;
      if (theirs.length !== ours.length) {
        diff('pk', {frame: f.f, traced: theirs.map((p) => p.t), ours: ours.map((p) => p.kind), problem: 'the counts differ'});
      } else {
        theirs.forEach((t, i) => {
          const o = ours[i];
          checks += 2;
          if (t.t !== o.kind) {
            diff('pk', {frame: f.f, i: i, traced: t.t, ours: o.kind});
          }
          const d = Math.hypot(t.x-o.c[0], t.z-o.c[2]);
          if (d > TOL*scale) {
            diff('pk', {frame: f.f, i: i, kind: t.t, traced: [t.x, t.z], ours: [o.c[0], o.c[2]], d: d});
          }
        });
      }
    }
    if (f.ev && f.ev.length && verbose) {
      console.log(`  frame ${f.f}: events ${f.ev.join(', ')} (game phase ${s.phase})`);
    }
    previous = s;
    previousPickups = game.pickupsThisTick || [];
  }});
  if (replay) {
    checks += replay.checks();
    if (replay.left()) {
      checks++;
      diff('rng', {problem: `${replay.left()} random values left over in the trace (the game asked for ${replay.asked()})`});
    }
  }
  return {checks: checks, differences: differences, firsts: firsts, frames: fed, pickups: pickupFields};
} // match

/**
 * Writes a trace from the game itself — the plumbing test: without a
 * track, or on the own track with the randomness logged and the pickups
 * collected in it (a steer towards the coins).
 * @param {string} file
 * @param {boolean} onTrack
 */
function selfTrace(file, onTrack) {
  let last = null;
  const worker = new GameWorker((msg) => { if (msg.id == 'frame') last = msg; });
  const seed = 0xC0DE;
  const logging = onTrack ? loggingRng(GameWorker.seededSource(seed)) : null;
  // on the track the obstacle collisions are off: the run is about the pickups, and the driver below cannot dodge
  worker.handleMessage({id: 'init', seed: seed, data: data, headless: true, track: onTrack ? undefined : false, rng: logging ? logging.rng : undefined,
    setup: onTrack ? (game) => { game.track.hit = () => null; } : undefined});
  const game = worker.game;
  const clock = frameClock(0.02);
  const out = [JSON.stringify({trace: 'gr', version: 'selftest', kind: onTrack ? 'collect' : 'fly', dt: 0.02, world: 0, battery: 1, steering: 'touch', seed: seed, noCrash: onTrack})];
  const steps = onTrack ? [[1500, 'seek']] : [[50, 0], [60, -1], [40, 1], [60, 0], [30, 0.5], [60, 0]];
  let f = 0, time = 0, placed = 0;
  // what the original's record holds: the fields before the tick's physics — the previous tick's coins, multiplier, timer, pickups
  let before = {cr: 0, cm: 1, ct: 0, pk: []};
  steps.forEach(([ticks, steer]) => {
    for (let i = 0; i < ticks && !game.done; i++) {
      const input = steer === 'seek' ? seekCoin(game) : steer;
      worker.handleMessage({id: 'tick', input: {steer: input}, frame: clock.lastOfFrame(time)});
      const s = last.state;
      f++;
      time += 0.02;
      const rec = {f: f, t: s.time, dt: 0.02, fc: clock.fc(time), in: input, pad: 0,
        x: s.ship.x, y: s.ship.y, z: s.ship.z, rx: s.ship.pitch, ry: (s.ship.yaw+360)%360, rz: (s.ship.roll+360)%360,
        cx: s.camera.x, cy: s.camera.y, cz: s.camera.z, crx: s.camera.pitch, cry: (s.camera.yaw+360)%360, crz: (s.camera.roll+360)%360,
        e: s.energyFixed, im: s.input.inputMultiplier, ef: s.input.energyFactor, pt: s.input.pressTime, vpt: s.input.visualPressTime,
        ratio: s.input.ratio, tilt: s.input.tilt, vx: s.input.velocityX, rnd: [], rs: [], ev: [], blk: []};
      if (onTrack) {
        rec.rnd = logging.log.map((r) => r.value);
        rec.rs = logging.log.map((r) => r.site);
        logging.log.length = 0;
        rec.blk = game.track.generated.slice(placed).map((g) => ({n: g.id, id: 0, s: g.section, x: g.x, z: g.z, a: 0, fc: rec.fc,
          pu: game.track.spawned.filter((p) => p.n == g.n).map((p) => ({t: p.kind, x: p.x, y: 6, z: p.z}))}));
        placed = game.track.generated.length;
        rec.cr = before.cr;
        rec.cm = before.cm;
        rec.ct = before.ct;
        rec.pk = before.pk;
        before = {cr: s.coins, cm: s.multiplier.value, ct: s.multiplier.timer, pk: (game.pickupsThisTick || []).map((p) => ({t: p.kind, x: p.c[0], y: p.c[1], z: p.c[2]}))};
      }
      out.push(JSON.stringify(rec));
    }
  });
  fs.writeFileSync(file, out.join('\n')+'\n');
} // selfTrace

/**
 * The selftest's driver: a steer towards the nearest pickup ahead.
 * @param {Game} game
 * @returns {number}
 */
function seekCoin(game) {
  const ship = game.ship;
  const cands = game.track.active.flatMap((b) => b.pickups).filter((p) => p.c[2] > ship.z+60 && p.c[2] < ship.z+900);
  cands.sort((a, b) => a.c[2]-b.c[2]);
  return cands[0] ? Math.max(-1, Math.min(1, (cands[0].c[0]-ship.x)/10)) : 0;
} // seekCoin

/**
 * data/global.json `rules` against the reference params.json.
 * @returns {{checks: number, differences: number}}
 */
function rules() {
  if (!fs.existsSync(REF_PARAMS)) {
    console.log('rules: the reference sources/extract/json/params.json is not at hand (GR-M4 tools/unity2params.mjs) — nothing compared');
    return {checks: 0, differences: 0};
  }
  const P = JSON.parse(fs.readFileSync(REF_PARAMS, 'utf8')).params;
  const R = data.global.rules;
  const pc = P.player.value.scripts.PlayerControl, pe = P.player.value.scripts.PlayerEnergy;
  const cm = P.camera.value.scripts.CameraMover, cam = P.camera.value.components.Camera;
  const es = P.energySlider.value.scripts.EnergySlider;
  const fog = P.renderSettings.value;
  const world0 = data.worlds && data.worlds.worlds[0];
  const defs = P.gameManager.value.scripts.PowerupManager.powerupDefinitionList;
  const def = (type) => defs.find((d) => d.type == type);
  const pickups = P.pickups.value;
  const capsule = (name) => pickups[name].components.find((c) => c.type == 'CapsuleCollider');
  const magnet = P.magnet.value;
  const modelScale = pc.modelScale || 0.02;
  // GR-M8: the store's ship definitions in its order, the prices of GTM (notes 14, 19), the worlds' menu (notes 15)
  const TYPES = ['battery', 'magnet', 'coins', 'multiplier'];
  const ENUM = ['FirstShip', 'SecondShip', 'ThirdShip', 'FourthShip', 'Ship_05', 'Ship_06', 'Ship_07', 'Ship_08'];
  const gtm = P.gtm.value;
  const refShips = P.shipStore.value.scripts.ShipStoreBuildier.shipDefinitionList.map((ref) => P.ships.value[ref.replace('prefab:', '')].scripts.ShipDefinition);
  const ownShips = ((data.ships && data.ships.ships) || []).slice().sort((a, b) => a.index-b.index);
  const refWorlds = P.worldMenu.value.map((w) => w.scripts.WorldItemInteraction);
  const ownWorlds = (data.worlds && data.worlds.worlds) || [];
  const worldPrice = (id) => (gtm.constants && gtm.constants['WorldPrice-'+id] !== undefined) ? gtm.constants['WorldPrice-'+id] : gtm.defaults['WorldPrice-'+id];
  const pairs = [
    ['tick.dt', data.global.tick.dt, P.time.value['Fixed Timestep']],
    ['ship.speed', R.ship.speed, pc.speed],
    ['ship.y', R.ship.y, P.player.value.transform.position[1]],
    ['ship.startZ', R.ship.startZ, P.player.value.transform.position[2]],
    ['steer.velocityFactor (steerSpeed)', R.steer.velocityFactor, pc.steerSpeed],
    ['steer.target = tilt.angle (tiltAngle)', R.steer.target, pc.tiltAngle],
    ['tilt.angle', R.tilt.angle, pc.tiltAngle],
    ['tilt.speed', R.tilt.speed, pc.tiltSpeed],
    ['tilt.yaw', R.tilt.yaw, pc.yaw],
    ['tilt.pitch', R.tilt.pitch, pc.pitch],
    ['steer.smooth (timeRisesMultiplier)', R.steer.smooth, pc.timeRisesMultiplier],
    ['energy.weak = empty × lowEnergyPercentage / 100', R.energy.weak, es.empty*pc.lowEnergyPercentage/100],
    ['energy.low (empty)', R.energy.low, es.empty],
    ['energy.drain (goDown)', R.energy.drain, pe.goDown],
    ['energy.safeTime', R.energy.safeTime, pe.safeTime],
    ['camera.lerp (speedLerp)', R.camera.lerp, cm.speedLerp],
    ['camera.maxRoll (maxHorizontalAngle)', R.camera.maxRoll, cm.maxHorizontalAngle],
    ['camera.rollSpeed (tiltSpeed)', R.camera.rollSpeed, cm.tiltSpeed],
    ['camera.yawSpeed (YRotationSpeed)', R.camera.yawSpeed, cm.YRotationSpeed],
    ['camera.dz (−zDistance)', R.camera.dz, -cm.zDistance],
    ['camera.fov', R.camera.fov, cam['field of view']],
    ['camera.near', R.camera.near, cam['near clip plane']],
    ['camera.far', R.camera.far, cam['far clip plane']],
    ['camera.offset = camera − player at rest', R.camera.offset, P.camera.value.transform.position.map((v, i) => Math.round((v-P.player.value.transform.position[i])*100)/100)],
    ['camera.height = 6 + offset.y', R.camera.height, 6+P.camera.value.transform.position[1]-P.player.value.transform.position[1]],
    ['steer.startCurve keys', R.steer.startCurve.map((k) => [Math.round(k[0]*100)/100, k[1], k[2], k[3]]), pc.startMultiplierCurve.map((k) => [Math.round(k.time*100)/100, k.value, k.inSlope, k.outSlope])],
    ['steer.startTime', R.steer.startTime, 2.5],
    ['worlds[0].fog', world0 ? [world0.fog.start, world0.fog.end] : null, [fog.m_LinearFogStart, fog.m_LinearFogEnd]],
    // GR-M7: the pickups (notes 12), the upgrades' ranges (notes 14), the magnet (notes 5)
    ['pickups.energyPerBlock (Battery amountPerSection)', R.pickups.energyPerBlock, def(0).amountPerSection],
    ['pickups.multiplierPerBlock (Multiplier amountPerSection)', R.pickups.multiplierPerBlock, def(3).amountPerSection],
    ['pickups.coinsPerBlock (GTM coinAmmountPerSection)', R.pickups.coinsPerBlock, P.gtm.value.coinAmmountPerSection !== undefined ? P.gtm.value.coinAmmountPerSection : def(2).amountPerSection],
    ['pickups.coinValue (Credit1 bonusAmount)', R.pickups.coinValue, pickups.Credit1.scripts.BonusCredits.bonusAmount],
    ['pickups.capsule radius / height', [R.pickups.capsule.radius, R.pickups.capsule.height], [capsule('Credit1').m_Radius, capsule('Credit1').m_Height]],
    ['pickups.capsule.center coin / multiplier / energy', [R.pickups.capsule.center.coin, R.pickups.capsule.center.multiplier, R.pickups.capsule.center.energy], [capsule('Credit1').m_Center, capsule('DoubleCredits_second').m_Center, capsule('Energy').m_Center]],
    ['pickups.energyFall (Energy MoverDistanceBased)', [R.pickups.energyFall.from, R.pickups.energyFall.over, R.pickups.energyFall.curve], [-pickups.Energy.scripts.MoverDistanceBased.distance[1], pickups.Energy.scripts.MoverDistanceBased.Zoffset, pickups.Energy.scripts.MoverDistanceBased.motionCurve.map((k) => [Math.round(k.time*100)/100, k.value, k.inSlope, k.outSlope])]],
    ['upgrades.ranges battery / magnet / coins / multiplier', [R.upgrades.ranges.battery, R.upgrades.ranges.magnet, R.upgrades.ranges.coins, R.upgrades.ranges.multiplier], [[def(0).minValue, def(0).maxValue], [def(1).minValue, def(1).maxValue], [def(2).minValue, def(2).maxValue], [def(3).minValue, def(3).maxValue]]],
    ['ship.magnet radius / ahead (× modelScale)', [R.ship.magnet.radius, R.ship.magnet.ahead], [Math.round(magnet.components.SphereCollider.m_Radius*modelScale*100)/100, Math.round(magnet.transform.position[2]*modelScale*100)/100]],
    // GR-M8: the store (notes 14) and the worlds (notes 15) — the mechanics of data/ships.json and data/worlds.json
    ['ships: count', ownShips.length, refShips.length],
    ['ships: the default ship (ownByDefault)', ownShips.map((s) => !!s.default), refShips.map((d) => !!d.ownByDefault)],
    ['ships: prices in the store\'s order (GTM ShipPrice-*)', ownShips.map((s) => s.price), refShips.map((d, i) => gtm.defaults['ShipPrice-'+ENUM[i]])],
    ['ships: upgrade slots (type, min, max, base price)', ownShips.map((s) => (s.upgrades || []).map((u) => [u.type, u.min, u.max, u.price])), refShips.map((d) => d.upgradeList.map((u) => [TYPES[u.type], u.minValue, u.maxValue, u.price]))],
    ['upgrades.levelsToMax (UpgradeToMultiplierAdapter)', R.upgrades.levelsToMax, 20],
    ['upgrades.priceGrowth (Upgrade.GetPrice)', R.upgrades.priceGrowth, 1.2],
    ['worlds: count', ownWorlds.length, refWorlds.length],
    ['worlds: distanceToWin', ownWorlds.map((w) => w.distanceToWin), refWorlds.map((w) => w.distanceToWin)],
    ['worlds: price (GTM WorldPrice-N)', ownWorlds.map((w) => w.price), refWorlds.map((w) => worldPrice(w.worldID))]
  ];
  let checks = 0, differences = 0;
  pairs.forEach(([name, ours, theirs]) => {
    checks++;
    const same = JSON.stringify(ours) === JSON.stringify(theirs);
    if (!same) {
      differences++;
      console.log(`  DIFF ${name}: rules ${JSON.stringify(ours)}, reference ${JSON.stringify(theirs)}`);
    } else if (verbose) {
      console.log(`  ok   ${name} = ${JSON.stringify(ours)}`);
    }
  });
  return {checks: checks, differences: differences};
} // rules

// ------------------------------------------------------------------- main

/** the track to run a trace on: the reference of its world, or the own data */
function trackFor(trace, name) {
  if (!withTrack) {
    return null;
  }
  if (own) {
    return ownTrack(data);
  }
  const ref = loadReference();
  if (!ref) {
    console.log(`${name}: the reference sources/extract/json/sections.json is not at hand (GR-M4 tools/unity2sections.mjs) — --own runs on the game's own track`);
    return false;
  }
  return referenceTrack(ref, traceWorld(trace.header), data);
} // trackFor

function report(name, r, trace) {
  console.log(`${name}: ${r.frames} frames (${trace.header.kind || '?'}, ${trace.header.version || '?'}), ${r.checks} checks, ${r.differences} differences${r.pickups ? ' (with the pickups)' : ''}`);
  if (verbose || r.differences) {
    Object.keys(r.firsts).forEach((k) => {
      const f = r.firsts[k];
      if (FIELDS[k]) {
        console.log(`  ${k} (${FIELDS[k][0]}): first out of tolerance at frame ${f.frame}: ours ${f.ours}, theirs ${f.theirs}, Δ ${f.d.toPrecision(4)}${FIELDS[k][2]}`);
      } else {
        console.log(`  ${k}: first difference ${JSON.stringify(f)}`);
      }
    });
  }
} // report

let exitCode = 0;
if (args.includes('--rules')) {
  const r = rules();
  console.log(`rules: ${r.checks} checks, ${r.differences} differences`);
  exitCode += r.differences;
}
if (args.includes('--selftest')) {
  const plain = path.join(os.tmpdir(), 'gr-selftest.jsonl');
  selfTrace(plain, false);
  let trace = readTrace(plain);
  let r = match(trace, null);
  console.log(`selftest: ${r.frames} frames, ${r.checks} checks, ${r.differences} differences (${path.relative(root, plain)}, no track)`);
  if (r.differences) report('selftest', r, trace);
  exitCode += r.differences;
  const onTrack = path.join(os.tmpdir(), 'gr-selfcollect.jsonl');
  selfTrace(onTrack, true);
  trace = readTrace(onTrack);
  r = match(trace, ownTrack(data));
  console.log(`selftest: ${r.frames} frames, ${r.checks} checks, ${r.differences} differences (${path.relative(root, onTrack)}, own track, ${trace.frames.reduce((n, f) => n+(f.pk || []).length, 0)} pickups collected)`);
  if (r.differences) report('selftest', r, trace);
  exitCode += r.differences;
}
for (const file of files) {
  const trace = readTrace(file);
  const name = path.basename(file);
  if (!trace.frames.length) {
    console.log(`${name}: no frame records`);
    exitCode++;
    continue;
  }
  if (withTrack && !hasTrack(trace.frames)) {
    console.log(`${name}: no call sites or blocks in the trace (a GR-M5 tracer?) — the track cannot be replayed; run without --track`);
    exitCode++;
    continue;
  }
  const track = trackFor(trace, name);
  if (track === false) {
    exitCode++;
    continue;
  }
  const r = match(trace, track);
  report(name, r, trace);
  if (!withTrack && hasPickups(trace.frames) && trace.frames.some((f) => (f.pk || []).length)) {
    console.log('  (the trace has pickups collected: --track compares the coins, the multiplier and the pickups too)');
  }
  exitCode += r.differences;
}
if (!args.includes('--rules') && !args.includes('--selftest') && files.length == 0) {
  console.log('usage: node tools/matchstate.mjs <trace.jsonl> [--track [--own]] [--world N] [--tolerance 1] [--limit N] [--battery 1] [--coins 1] [--multiplier 1] [--magnet 0] [-v] | --rules | --selftest');
  process.exit(2);
}
process.exit(Math.min(exitCode, 255));
