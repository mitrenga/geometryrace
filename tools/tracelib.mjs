/**
 * tracelib — what the match tools share (GR-M7): the game's data, the
 * traces of the instrumented original (tools/trace/README.md), the
 * reference track of sources/extract/json/sections.json converted into
 * the shape app/track.js takes, the recorded randomness replayed by call
 * site, and the loop that feeds a trace's frames into the headless worker.
 * Nothing here decides what a difference is — that is the tools' (matchstate
 * the state and the pickups collected, matchtrack the blocks and the
 * pickups spawned).
 *
 * The call sites of `Random.Range` as GRPatch names them (notes 4): the
 * three of a row's start (`RandomSection.StartNewBlockRow` — a float that
 * is overwritten, `SetTiling`, `GetBlockID`) and the power-up spawner's
 * (`PowerupSpawner.spawn`, one or two per spawn point of every placed
 * block, notes 12). The game asks for them through `rng`
 * (`rangeFloat`, `rangeInt`, `chance`), and the replay checks that every
 * ask meets a value of the site it should — the order of the generator
 * and the spawner is part of what is matched.
 */
import '../app/svision/tools/nodeEnv.mjs';   // must come first: the import headers read window.srcVersion
import fs from 'node:fs';
import path from 'node:path';
import { quatMultiply, quatRotate } from './unitylib.mjs';

export const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const REF_SECTIONS = path.join(root, 'sources/extract/json/sections.json');
export const REF_PARAMS = path.join(root, 'sources/extract/json/params.json');

/** the call sites by what the game asks for */
export const SITES = {
  row: 'RandomSection.StartNewBlockRow',
  tiling: 'RandomSection.SetTiling',
  block: 'RandomSection.GetBlockID',
  spawn: 'PowerupSpawner.spawn'
};
/** a trace's pickup type letters (GRTracer) ↔ the game's kinds */
export const PICKUP_KINDS = {coin: 'coin', multiplier: 'multiplier', energy: 'energy', c: 'coin', m: 'multiplier', e: 'energy'};

/**
 * The game's data (data/*.json).
 * @returns {{global: Object, ships: Object, worlds: Object, sections: Object, pickups: Object}} — the meshes and the tracks attached from assets/ (attachAssets)
 */
export function loadData() {
  const json = (file) => {
    const p = path.join(root, 'data', file+'.json');
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
  };
  const data = {global: json('global'), ships: json('ships'), worlds: json('worlds'), sections: null, pickups: json('pickups')};
  attachAssets(data);
  return data;
} // loadData

/**
 * The assets the application fetches on demand, attached the way it does:
 * every ship's mesh (assets/ships/<id>.json) onto the ship, the worlds'
 * tracks (assets/worlds/<id>.json) composed into `sections`
 * (`{source, blocks, worlds: {id: {sections}}, materials, meshes}` — the
 * looks of the reference's obstacle materials and the geometry of its
 * obstacle meshes, by name).
 * @param {Object} data - `{ships, worlds, ...}`; changed in place.
 * @returns {Object} data
 */
export function attachAssets(data) {
  const read = (rel) => {
    const p = path.join(root, rel);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
  };
  ((data.ships && data.ships.ships) || []).forEach((s) => {
    const a = read('assets/ships/'+s.id+'.json');
    if (a) {
      s.mesh = a.mesh;
    }
  });
  const sections = {source: null, blocks: [], worlds: {}, materials: {}, meshes: {}};
  const seen = new Set();
  ((data.worlds && data.worlds.worlds) || []).forEach((w) => {
    const t = read('assets/worlds/'+w.id+'.json');
    if (!t) {
      return;
    }
    sections.source = sections.source === null || sections.source == t.source ? t.source : 'mixed';
    Object.assign(sections.materials, t.materials || {});
    Object.assign(sections.meshes, t.meshes || {});
    t.blocks.forEach((b) => {
      if (!seen.has(b.id)) {
        seen.add(b.id);
        sections.blocks.push(b);
      }
    });
    sections.worlds[w.id] = {sections: t.sections};
  });
  data.sections = Object.keys(sections.worlds).length ? sections : null;
  return data;
} // loadData

/**
 * Reads a trace: the header, the frame records, the marker lines.
 * @param {string} file
 * @returns {{header: Object, frames: Object[], marks: Object[]}}
 */
export function readTrace(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '');
  let header = {};
  const frames = [], marks = [];
  lines.forEach((l) => {
    let o;
    try { o = JSON.parse(l); } catch (e) { return; }
    if (o.trace) {
      header = o;
    } else if (o.mark) {
      marks.push(o);
    } else if (typeof o.f == 'number') {
      frames.push(o);
    }
  });
  return {header: header, frames: frames, marks: marks};
} // readTrace

/**
 * Does the trace carry the GR-M6 tracer's fields (the call sites of the
 * randomness, the blocks placed)? Without them the track cannot be replayed.
 * @param {Object[]} frames
 * @returns {boolean}
 */
export function hasTrack(frames) {
  return frames.some((f) => f.rs && f.rs.length) || frames.some((f) => f.blk && f.blk.length);
} // hasTrack

/**
 * Does the trace carry the GR-M7 tracer's pickup fields (`pu` on the blocks, `pk`, `cr`)?
 * @param {Object[]} frames
 * @returns {boolean}
 */
export function hasPickups(frames) {
  return frames.some((f) => typeof f.cr == 'number' || (f.blk || []).some((b) => Array.isArray(b.pu)));
} // hasPickups

// ------------------------------------------------------------ the randomness

/**
 * The recorded randomness replayed in the shape app/track.js asks for it.
 * Every value with a known call site goes into one queue in trace order;
 * `rangeFloat` takes the next and expects the row site, `rangeInt` one of
 * the two int sites, `chance` the spawner's — a value of another site, or
 * none left, is reported through `onDifference(kind, detail)` and counted.
 * @param {Object[]} frames
 * @param {Function} onDifference - `(detail) => void`
 * @returns {{rng: Object, asked: Function, left: Function, checks: Function, untagged: number}}
 */
export function tracedRng(frames, onDifference) {
  const queue = [];
  let untagged = 0;
  const known = Object.values(SITES);
  frames.forEach((f) => {
    (f.rnd || []).forEach((v, i) => {
      const site = f.rs ? f.rs[i] : '?';
      if (site == '?') {
        untagged++;
      }
      if (known.includes(site)) {
        queue.push({site: site, value: v, frame: f.f});
      }
    });
  });
  let asked = 0, checks = 0;
  const take = (sites, what) => {
    asked++;
    checks++;
    const next = queue.shift();
    if (!next) {
      onDifference({ask: asked, site: what, problem: 'the trace has no more random values'});
      return 0;
    }
    if (!sites.includes(next.site)) {
      onDifference({ask: asked, site: what, traced: next.site, frame: next.frame});
    }
    return next.value;
  };
  return {
    rng: {
      rangeFloat: () => take([SITES.row], SITES.row),
      rangeInt: () => take([SITES.tiling, SITES.block], SITES.tiling+' | '+SITES.block),
      chance: () => take([SITES.spawn], SITES.spawn)
    },
    asked: () => asked,
    left: () => queue.length,
    checks: () => checks,
    untagged: untagged
  };
} // tracedRng

/**
 * A logging randomness for the selftests: the game's own values from a
 * seeded source, each remembered with the site the patched original would
 * name — so a trace written from the game replays through tracedRng().
 * @param {Function} source - A byte source (GameWorker.seededSource).
 * @returns {{rng: Object, log: Object[]}} `log`: `[{site, value}]` since it was last emptied.
 */
export function loggingRng(source) {
  const next = () => (source()*256+source())/65536;
  const log = [];
  let asked = 0;
  return {
    rng: {
      rangeFloat: (min, max) => { const v = min+next()*(max-min); log.push({site: SITES.row, value: v}); asked = 1; return v; },
      rangeInt: (min, max) => { const v = min+Math.floor(next()*(max-min)); log.push({site: asked == 1 ? SITES.tiling : SITES.block, value: v}); asked++; return v; },
      chance: () => { const v = next(); log.push({site: SITES.spawn, value: v}); return v; }
    },
    log: log
  };
} // loggingRng

// ------------------------------------------------------------ the reference

/** the animator scripts of the reference that app/track.js models, and their form */
const ANIMATORS = {
  MovingBlock: (f) => ({type: 'tumble', direction: ['left', 'right', 'forward', 'back'][f.Direction|0], speed: f.speed, repeat: !!f.repeat}),
  FallingPillar: (f) => ({type: 'fall', direction: ['left', 'right', 'forward', 'back'][f.Direction|0], zOffset: f.Zoffset, degrees: f.DegreesToRotate, curve: keys(f.motionCurve)}),
  MoverDistanceBased: (f) => ({type: 'mover', distance: f.distance, zOffset: f.Zoffset, curve: keys(f.motionCurve)}),
  Mover: (f) => ({type: 'wave', curves: {x: keys(f.XmovingCurve), y: keys(f.YmovingCurve), z: keys(f.ZmovingCurve)}, scaler: f.DistanceScaler, startPhase: f.startPhase || 0}),
  RotateAround: (f, a) => ({type: 'spin', speed: f.speed, perFrame: true, pivot: a.position})
};
const COLLIDING = ['Obstackle', 'ObstacleCollider'];   // the tags PlayerControl.OnTriggerEnter crashes on (notes 11)
const keys = (curve) => (curve || []).map((k) => [k.time, k.value, k.inSlope || 0, k.outSlope || 0]);

/**
 * The reference (sources/extract/json/sections.json), or null when it is not at hand.
 * @returns {Object|null}
 */
export function loadReference() {
  return fs.existsSync(REF_SECTIONS) ? JSON.parse(fs.readFileSync(REF_SECTIONS, 'utf8')) : null;
} // loadReference

/**
 * The reference of one world as app/track.js takes it: the section
 * sequence and every block it uses with its colliders as shapes, its
 * animators as animations and its spawn points (`{x, z, energy}` in the
 * block's frame — the y is the rules', notes 12).
 * @param {Object} ref - sources/extract/json/sections.json
 * @param {number} world - 0..2 (the reference's worldID − 1).
 * @param {Object} data - The game's data (the world's id comes from data/worlds.json).
 * @returns {{blocks: Object, worlds: Object, worldId: string, report: Object}}
 */
export function referenceTrack(ref, world, data) {
  const w = ref.worlds.find((x) => x.worldID == world+1) || ref.worlds[world];
  if (!w) {
    throw new Error('tracelib: no reference world '+world);
  }
  const sections = w.sections.filter((s) => s.active !== false).map((s) => ({
    type: s.type == 'ConstantSection' ? 'constant' : 'random', length: s.length, blocks: s.blocks, infinite: !!s.isInfinite
  }));
  const names = new Set();
  sections.forEach((s) => s.blocks.forEach((b) => names.add(b)));
  const blocks = {};
  const report = {blocks: 0, shapes: 0, skipped: {}, animated: 0, notModelled: {}, byBlock: {}, spawnPoints: 0};
  const usedMaterials = new Set(), usedMeshes = new Set();
  names.forEach((name) => {
    const b = ref.blocks[name];
    if (!b) {
      throw new Error('tracelib: reference block '+name+' missing');
    }
    const om = b.obstacleManager;
    const container = om ? om.object+'/' : null;
    const children = [];
    const shapes = [];
    const animators = (b.animators || []).filter((a) => ANIMATORS[a.script] && a.enabled !== false);
    const drawnSeen = new Set();
    const others = {};
    (b.animators || []).forEach((a) => { if (!ANIMATORS[a.script]) others[a.script] = (others[a.script]||0)+1; });
    b.colliders.forEach((c) => {
      if (!c.active || !c.enabled || c.trigger || !COLLIDING.includes(c.tag) || !['box', 'sphere', 'capsule'].includes(c.type)) {
        const why = c.type == 'mesh' ? 'mesh' : !COLLIDING.includes(c.tag) ? 'tag '+c.tag : c.trigger ? 'trigger' : 'inactive';
        report.skipped[why] = (report.skipped[why]||0)+1;
        return;
      }
      // the child of the ObstacleManager's object this collider sits under: its activation slot
      let child = -1;
      if (container && c.object.startsWith(container)) {
        const key = c.object.slice(container.length).split('/')[0];
        child = children.indexOf(key);
        if (child < 0) {
          child = children.push(key)-1;
        }
      }
      // the look: the material the original draws the obstacle with — the last of its renderer's (unity2sections: Unity draws the last submesh again with every extra material)
      const material = (c.materials || []).length ? c.materials[c.materials.length-1] : null;
      const shape = {kind: c.type, c: c.center.slice(), q: c.rotation.slice(), child: child, anim: null, material: material, object: c.object};
      if (material) {
        usedMaterials.add(material);
      }
      // the original's meshes drawn with the collider (the parts of a compound object), each placed relative
      // to the collider's frame (they move with the shape) — every renderer once per block: a tunnel of many
      // sphere colliders is one mesh (`drawn` = the renderer's object); a shape with nothing left to draw is hidden
      const parts = (c.parts || []).filter((part) => part.mesh && part.materials.length && !drawnSeen.has(part.drawn));
      if (parts.length) {
        shape.parts = parts.map((part) => {
          drawnSeen.add(part.drawn);
          part.materials.forEach((m) => usedMaterials.add(m));
          usedMeshes.add(part.mesh);
          return {mesh: part.mesh, materials: part.materials.slice(), offset: relativeTransform(c.center, c.rotation, part.transform)};
        });
      } else if ((c.parts || []).length) {
        shape.hidden = true;            // its renderers are drawn with earlier shapes: collides, is not drawn
      }
      if (c.type == 'box') {
        shape.s = c.size.slice();
      } else if (c.type == 'sphere') {
        shape.r = c.radius;
        shape.s = [2*c.radius, 2*c.radius, 2*c.radius];
      } else {
        shape.r = c.radius;
        shape.s = [2*c.radius, c.height, c.direction|0];
      }
      // the nearest animator on this object or above it
      let best = null, bestD = Infinity;
      animators.forEach((a) => {
        if (c.object != a.object && !c.object.startsWith(a.object+'/')) {
          return;
        }
        const d = Math.hypot(c.center[0]-a.position[0], c.center[1]-a.position[1], c.center[2]-a.position[2]);
        if (d < bestD) {
          best = a;
          bestD = d;
        }
      });
      if (best && bestD < 60+Math.max(...shape.s.slice(0, 2))) {
        shape.anim = ANIMATORS[best.script](best.fields || {}, best);
        report.animated++;
      }
      shapes.push(shape);
    });
    const spawnPoints = (b.spawnPoints || []).map((p) => ({x: p.position[0], z: p.position[2], energy: !!p.energy}));
    blocks[name] = {id: name, width: b.width, length: b.length, obstaclesPerTick: om ? (om.ObstaclesPerFixedUpdate || 1) : 1, shapes: shapes, spawnPoints: spawnPoints};
    report.blocks++;
    report.shapes += shapes.length;
    report.spawnPoints += spawnPoints.length;
    report.byBlock[name] = {shapes: shapes.length, children: children.length, animated: shapes.filter((s) => s.anim).length, spawnPoints: spawnPoints.length, others: others};
    Object.keys(others).forEach((k) => { report.notModelled[k] = (report.notModelled[k]||0)+others[k]; });
  });
  const worldId = data.worlds && data.worlds.worlds[world] ? data.worlds.worlds[world].id : String(world);
  const worlds = {};
  worlds[worldId] = {sections: sections};
  const materials = {};
  [...usedMaterials].sort().forEach((name) => { materials[name] = materialLook(ref.materials && ref.materials[name]); });
  report.materials = Object.keys(materials).length;
  report.meshes = usedMeshes.size;
  return {blocks: blocks, worlds: worlds, worldId: worldId, materials: materials, meshNames: [...usedMeshes].sort(), report: report};
} // referenceTrack

/**
 * A transform relative to a shape's frame (its centre and rotation, unit
 * scale — the shape's sizes are absolute): where the mesh sits when the
 * shape is at the origin unturned, so the animation of the shape carries
 * the mesh along.
 * @param {number[]} c - The shape's centre in the block's frame.
 * @param {number[]} q - The shape's rotation [x, y, z, w].
 * @param {{position: number[], rotation: number[], scale: number[]}} t - The mesh's transform in the block's frame.
 * @returns {{p: number[], q: number[], s: number[]}}
 */
export function relativeTransform(c, q, t) {
  const inv = [-q[0], -q[1], -q[2], q[3]];
  const d = [t.position[0]-c[0], t.position[1]-c[1], t.position[2]-c[2]];
  const r3 = (v) => Math.round(v*1000)/1000;
  return {p: quatRotate(inv, d).map(r3), q: quatMultiply(inv, t.rotation).map((v) => Math.round(v*10000)/10000), s: t.scale.map(r3)};
} // relativeTransform

/**
 * The look of an obstacle material as the playfield draws it: the
 * original's shader is texture x `_Color` (notes 15), its textures are
 * vertical gradients (light at the top, dark at the bottom) or solids —
 * `color` is the middle of the texture times the tint, `shade` its bottom.
 * @param {Object|undefined} m - unity2sections `materials[name]`: `{texture, tint, top, mid, bottom, solid}`.
 * @returns {{color: string, shade: string, solid: boolean, texture: string|null, ramp: string[]}} — `ramp` the colours along the texture's v, 0 (the bottom of the texture) to 1 (the top)
 */
export function materialLook(m) {
  const tint = (m && m.tint) || [1, 1, 1];
  const hex = (rgb) => '#'+rgb.map((v, k) => Math.max(0, Math.min(255, Math.round(v*tint[k]))).toString(16).padStart(2, '0')).join('');
  const mid = m && m.mid ? m.mid : [255, 255, 255];
  const bottom = m && m.bottom ? m.bottom : mid;
  const ramp = m && m.ramp ? m.ramp.map(hex) : [hex(mid)];
  return {color: hex(mid), shade: hex(bottom), solid: !m || m.solid !== false, texture: m ? m.texture : null, ramp: ramp};
} // materialLook

/**
 * The game's own track data in the same shape (`--own`, the selftests).
 * @param {Object} data
 * @returns {{blocks: Object, worlds: Object, report: null}}
 */
export function ownTrack(data) {
  const blocks = {};
  data.sections.blocks.forEach((b) => { blocks[b.id] = b; });
  return {blocks: blocks, worlds: data.sections.worlds, report: null};
} // ownTrack

// ------------------------------------------------------------ the replay

/**
 * Feeds a trace's frames into a headless worker, one `tick` per record
 * with its input and `dt`, the track's per-frame generator held back
 * until the last tick of a render frame (`fc`); `onTick(record, frame,
 * index)` sees every posted frame. Stops at the game's end or the limit.
 * @param {GameWorker} worker - Initialised.
 * @param {Object[]} frames - The trace's records.
 * @param {Object} options - `limit` (0: all), `dt` (the header's), `onTick`.
 * @returns {number} The records fed.
 */
export function feedTrace(worker, frames, options) {
  const n = options.limit > 0 ? Math.min(options.limit, frames.length) : frames.length;
  let last = null;
  const post = worker.post;
  worker.post = (msg) => { if (msg.id == 'frame') last = msg; post(msg); };
  let fed = 0;
  for (let i = 0; i < n; i++) {
    const f = frames[i], next = frames[i+1];
    const input = {steer: typeof f.in == 'number' ? f.in : 0, pad: !!f.pad};
    const sameFrame = next && typeof f.fc == 'number' && next.fc === f.fc;
    worker.handleMessage({id: 'tick', input: input, dt: f.dt || options.dt || undefined, frame: !sameFrame});
    fed++;
    if (options.onTick) {
      options.onTick(f, last, i);
    }
    if (worker.game.done) {
      break;
    }
  }
  worker.post = post;
  return fed;
} // feedTrace

/**
 * The frame counter of a selftest: 60 render frames a second over the
 * 50 Hz ticks, so records carry one or two ticks; `fc(time)` is the
 * render frame of a tick's end, `lastOfFrame(time)` whether the next
 * tick starts another.
 * @param {number} dt
 * @returns {{fc: Function, lastOfFrame: Function}}
 */
export function frameClock(dt) {
  return {
    fc: (time) => Math.floor(time*60),
    lastOfFrame: (time) => Math.floor((time+dt)*60) !== Math.floor(time*60)
  };
} // frameClock
