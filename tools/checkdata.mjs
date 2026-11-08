#!/usr/bin/env node
/**
 * checkdata — the game's own data (data/*.json) checked under Node:
 * every ship's mesh loads through Mesh.fromJSON and is sound (indices in
 * range and in threes, no degenerate triangle, unit normals, each face's
 * winding agrees with its normals, and closed — every edge shared by
 * exactly two triangles); the worlds are three with the mechanics of the
 * notes; the sections' blocks have the right extents, their obstacles and
 * spawn points lie inside, every row leaves a gap the ship fits through,
 * every section names a block that exists, every world ends in a
 * practically infinite section. And, where sources/extract/json/ is at
 * hand (it is outside git), that nothing was copied from the original
 * where the rules say own content: no block's obstacles coincide with a
 * reference block's colliders, no world repeats a reference sequence
 * (GR-M4 hotovo když). The ships are the exception since 2026-09-16 (the
 * operator's decision, the licence preview): a ship with `model` is the
 * original's model and must match it — its triangle count the reference
 * mesh's, its vertex colours from the submeshes — a ship without one must
 * not look like any reference model. The track likewise (mksections
 * --reference, `source: 'reference'` in data/sections.json): its blocks
 * and sequences must be the reference's conversion.
 *
 * The report is the number of checks and the number of differences; the
 * exit code is the number of differences.
 *
 * usage: node tools/checkdata.mjs [-v]
 */
import '../app/svision/tools/nodeEnv.mjs';   // must come first: the import headers read window.srcVersion
import fs from 'node:fs';
import path from 'node:path';

const { Mesh } = await import('../app/svision/js/platform/scene3D/mesh.js');

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const verbose = process.argv.includes('-v');
let checks = 0, differences = 0;

function check(name, ok, detail) {
  checks++;
  if (!ok) {
    differences++;
    console.log(`  DIFF ${name}${detail !== undefined ? ': '+detail : ''}`);
  } else if (verbose) {
    console.log(`  ok   ${name}`);
  }
} // check

const { attachAssets } = await import('./tracelib.mjs');
const json = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const global = json('data/global.json');
const data = attachAssets({ships: json('data/ships.json'), worlds: json('data/worlds.json')});   // the meshes and the tracks of assets/
const ships = data.ships.ships;
const worlds = data.worlds.worlds;
const sections = data.sections;
check('assets: every ship has its mesh file (assets/ships/<id>.json)', ships.every((s) => !!s.mesh && s.asset == 'assets/ships/'+s.id+'.json'));
check('assets: every world has its track file (assets/worlds/<id>.json)', !!sections && worlds.every((w) => !!sections.worlds[w.id]));
check('assets: data/ships.json carries no meshes (appData.db stays small)', JSON.stringify(json('data/ships.json')).length < 20000);

// ------------------------------------------------------------------- ships

const key = (p, i) => Mesh.num(p[i*3])+','+Mesh.num(p[i*3+1])+','+Mesh.num(p[i*3+2]);
if (!Mesh.faceArea) {
  /** The area of a triangle of a position array. */
  Mesh.faceArea = (p, a, b, c) => {
    const ux = p[b*3]-p[a*3], uy = p[b*3+1]-p[a*3+1], uz = p[b*3+2]-p[a*3+2];
    const vx = p[c*3]-p[a*3], vy = p[c*3+1]-p[a*3+1], vz = p[c*3+2]-p[a*3+2];
    return Math.hypot(uy*vz-uz*vy, uz*vx-ux*vz, ux*vy-uy*vx)/2;
  };
}

/**
 * The faults of a mesh: [] when sound. `smooth` allows a vertex normal
 * that merely lies on the face's side (the original's models are smoothed
 * where the own hulls are flat, one normal per face).
 */
function meshFaults(mesh, smooth) {
  const faults = [];
  const p = mesh.positions, n = mesh.normals, ix = mesh.indices;
  if (p.length % 3 || n.length != p.length) faults.push('positions/normals length');
  if (ix.length % 3) faults.push('indices not in threes');
  const vertices = p.length/3;
  const edges = new Map();
  let badIndex = 0, degenerate = 0, badNormal = 0, wrongWinding = 0;
  for (let t = 0; t+2 < ix.length; t += 3) {
    const a = ix[t], b = ix[t+1], c = ix[t+2];
    if (a >= vertices || b >= vertices || c >= vertices) { badIndex++; continue; }
    const fn = Mesh.faceNormal(p, a, b, c);
    const ka = key(p, a), kb = key(p, b), kc = key(p, c);
    if (ka == kb || kb == kc || ka == kc) { degenerate++; continue; }
    let sum = [0, 0, 0];
    for (const v of [a, b, c]) {
      const l = Math.hypot(n[v*3], n[v*3+1], n[v*3+2]);
      if (Math.abs(l-1) > 1e-3) badNormal++;
      if (!smooth && fn[0]*n[v*3]+fn[1]*n[v*3+1]+fn[2]*n[v*3+2] < 0.999) wrongWinding++;
      sum = [sum[0]+n[v*3], sum[1]+n[v*3+1], sum[2]+n[v*3+2]];
    }
    // a smoothed mesh: the face must at least look the way its three normals add up (mkships winds it
    // so); a seam of no visible area (under 1e-4 u², the original's models have a few) may flip in the
    // 4-decimal rounding of the JSON and does not count
    if (smooth && fn[0]*sum[0]+fn[1]*sum[1]+fn[2]*sum[2] < -0.05 && Mesh.faceArea(p, a, b, c) >= 1e-4) wrongWinding++;
    for (const [x, y] of [[ka, kb], [kb, kc], [kc, ka]]) {
      const k = x < y ? x+'|'+y : y+'|'+x;
      edges.set(k, (edges.get(k) || 0)+1);
    }
  }
  if (badIndex) faults.push(badIndex+' indices out of range');
  if (degenerate) faults.push(degenerate+' degenerate triangles');
  if (badNormal) faults.push(badNormal+' normals not unit');
  if (wrongWinding) faults.push(wrongWinding+(smooth ? ' faces wound against their normals' : ' vertices whose normal disagrees with the face'));
  let open = 0;
  edges.forEach((count) => { if (count != 2) open++; });
  if (open) faults.push(open+' edges not shared by exactly two triangles (not closed)');
  return faults;
} // meshFaults

const upgradeTypes = Object.keys(global.rules.upgrades.ranges);
check('ships: eight', ships.length == 8, ships.length);
check('ships: ids unique', new Set(ships.map((s) => s.id)).size == ships.length);
check('ships: exactly one default', ships.filter((s) => s.default).length == 1);
check('ships: prices ascend from 0', ships.every((s, i) => i == 0 ? s.price == 0 : s.price > ships[i-1].price));
const meshes = [];
for (const s of ships) {
  let mesh = null;
  try {
    mesh = Mesh.fromJSON(s.mesh);
  } catch (e) {
    check(`ship ${s.id}: mesh loads`, false, e.message);
    continue;
  }
  meshes.push({ship: s, mesh: mesh});
  check(`ship ${s.id}: mesh id`, mesh.id == 'ship:'+s.id, mesh.id);
  // the original's models are not closed shells (open edges are theirs); the own hulls must be
  const faults = meshFaults(mesh, !!s.model).filter((f) => !(s.model && /not closed/.test(f)));
  check(`ship ${s.id}: mesh sound (${mesh.triangleCount} triangles)`, faults.length == 0, faults.join('; '));
  const b = mesh.bounds();
  const c = global.rules.ship.collider;
  if (s.model) {
    // the original's models sit inside the player's box (the collider is longer than the hull)
    check(`ship ${s.id}: inside the player's box (${c.width} x ${c.length}) and coloured`, b.width <= c.width*2.1 && b.depth <= c.length && b.depth >= c.length*0.5 && !!mesh.colors, `${b.width} x ${b.height} x ${b.depth}`);
  } else {
    check(`ship ${s.id}: about the size of the player's box (${c.width} x ${c.length})`, b.width <= c.width*1.5 && b.depth <= c.length*1.1 && b.depth >= c.length*0.8, `${b.width} x ${b.height} x ${b.depth}`);
  }
  check(`ship ${s.id}: upgrades known`, s.upgrades.every((u) => upgradeTypes.includes(u.type) && u.min >= 0 && u.max > u.min && u.price > 0), JSON.stringify(s.upgrades));
  check(`ship ${s.id}: colours`, /^#[0-9a-f]{6}$/i.test(s.color) && /^#[0-9a-f]{6}$/i.test(s.edge));
  check(`ship ${s.id}: crash colours (ShipParticleColors, notes 11)`, Array.isArray(s.crashColors) && s.crashColors.length >= 2 && s.crashColors.every((c) => /^#[0-9a-f]{6}$/i.test(c)), JSON.stringify(s.crashColors));
  check(`ship ${s.id}: wake (colour, two emitters behind the wings)`, !!s.wake && /^#[0-9a-f]{6}$/i.test(s.wake.color) && Array.isArray(s.wake.emitters) && s.wake.emitters.length == 2 && s.wake.emitters.every((e) => e.length == 3 && e.every(Number.isFinite) && e[2] < 0), JSON.stringify(s.wake));
}

// ----------------------------------------------------------------- pickups

const pickupsFile = path.join(root, 'data/pickups.json');
check('pickups: data/pickups.json exists (mkpickups)', fs.existsSync(pickupsFile));
if (fs.existsSync(pickupsFile)) {
  const pickups = json('data/pickups.json').pickups;
  ['coin', 'multiplier', 'energy'].forEach((kind) => {
    let mesh = null;
    try {
      mesh = Mesh.fromJSON(pickups[kind].mesh);
    } catch (e) {
      check(`pickup ${kind}: mesh loads`, false, e.message);
      return;
    }
    const faults = meshFaults(mesh, true).filter((f) => !/not closed/.test(f));
    check(`pickup ${kind}: mesh ${mesh.id} sound and coloured (${mesh.triangleCount} triangles)`, mesh.id == 'pickup:'+kind && !!mesh.colors && faults.length == 0, faults.join('; '));
    const b = mesh.bounds();
    check(`pickup ${kind}: about the size of the capsule (r ${global.rules.pickups.capsule.radius})`, b.width < 12 && b.height < 14 && b.depth < 12 && b.height > 3, `${b.width} x ${b.height} x ${b.depth}`);
    const glow = (g) => !g || (/^#[0-9a-f]{6}$/i.test(g.color) && g.alpha > 0 && g.alpha <= 1 && g.radius > 0);
    const beam = pickups[kind].beam;
    check(`pickup ${kind}: beam to the sky (the original's *_ray quad, notes 12)`, !!beam && beam.height > 50 && glow(beam), JSON.stringify(beam));
    check(`pickup ${kind}: halo, when the prefab has one`, glow(pickups[kind].halo), JSON.stringify(pickups[kind].halo));
    // the layers of the crystal: a solid core (the x2 icon of the multiplier) under a translucent shell
    const layers = pickups[kind].layers || [];
    let layerFaults = [];
    layers.forEach((layer) => {
      try {
        const lm = Mesh.fromJSON(layer.mesh);
        if (lm.id != 'pickup:'+kind+':'+layer.material || !lm.colors || lm.triangleCount != layer.triangles) {
          layerFaults.push(layer.material);
        }
      } catch (e) {
        layerFaults.push(layer.material+' ('+e.message+')');
      }
    });
    check(`pickup ${kind}: ${layers.length} layers by material, solid first (${layers.map((l) => l.material+' '+l.opacity).join(', ')})`,
      layers.length >= 2 && layerFaults.length == 0 && layers[0].opacity == 1 && layers[layers.length-1].opacity < 1
      && layers.every((l, i) => i == 0 || l.opacity <= layers[i-1].opacity)
      && layers.reduce((n, l) => n+l.triangles, 0) == mesh.triangleCount, layerFaults.join('; '));
  });
}

// ------------------------------------------------------------------ worlds

check('worlds: three', worlds.length == 3, worlds.length);
check('worlds: ids unique', new Set(worlds.map((w) => w.id)).size == worlds.length);
worlds.forEach((w, i) => {
  check(`world ${w.id}: index ${i}`, w.index == i);
  check(`world ${w.id}: tiling 3 or 4 (notes 8)`, w.tiling == 3 || w.tiling == 4, w.tiling);
  check(`world ${w.id}: unlock ascends (notes 15)`, i == 0 ? w.distanceToWin == 0 && w.price == 0 : w.distanceToWin > worlds[i-1].distanceToWin && w.price > worlds[i-1].price);
  check(`world ${w.id}: fog start < end`, w.fog.start < w.fog.end);
  check(`world ${w.id}: beat (the music's tempo and start phase, notes 17)`, !!w.beat && w.beat.bpm >= 60 && w.beat.bpm <= 200 && w.beat.phase >= 0 && w.beat.phase < 1, JSON.stringify(w.beat));
  const colours = [w.colors.sky, w.colors.ground, w.colors.grid].concat(Object.values(w.colors.obstacle), Object.values(w.colors.pickup));
  check(`world ${w.id}: colours`, colours.every((c) => /^#[0-9a-f]{6}$/i.test(c)));
  check(`world ${w.id}: has sections`, !!sections.worlds[w.id]);
});

// ---------------------------------------------------------------- sections

if (sections.source == 'reference') {
  const names = Object.keys(sections.materials || {});
  check('sections: material looks (reference): colours hex, textures named', names.length > 0 && names.every((n) => /^#[0-9a-f]{6}$/.test(sections.materials[n].color) && /^#[0-9a-f]{6}$/.test(sections.materials[n].shade)), names.length);
  const used = new Set();
  sections.blocks.forEach((b) => (b.shapes || []).forEach((sh) => { if (sh.material) used.add(sh.material); (sh.parts || []).forEach((part) => part.materials.forEach((m) => used.add(m))); }));
  check('sections: every material look used by a shape', names.every((n) => used.has(n)), names.filter((n) => !used.has(n)).join(', '));
  check('sections: material ramps (17 colours along v)', names.every((n) => Array.isArray(sections.materials[n].ramp) && sections.materials[n].ramp.length == 17 && sections.materials[n].ramp.every((c) => /^#[0-9a-f]{6}$/.test(c))));
  const meshNames = Object.keys(sections.meshes || {});
  const usedMeshes = new Set();
  sections.blocks.forEach((b) => (b.shapes || []).forEach((sh) => (sh.parts || []).forEach((part) => usedMeshes.add(part.mesh))));
  check(`sections: ${meshNames.length} obstacle meshes (reference), every one used by a shape`, meshNames.length > 0 && meshNames.every((n) => usedMeshes.has(n)), meshNames.filter((n) => !usedMeshes.has(n)).join(', '));
  let vertices = 0;
  const bad = meshNames.filter((n) => {
    const g = sections.meshes[n];
    const count = g.positions.length/3;
    vertices += count;
    let mesh = null;
    try {
      mesh = Mesh.fromJSON({id: g.id, positions: g.positions, normals: g.normals, indices: g.indices});
    } catch (e) {
      return true;
    }
    return !(g.id == 'ob:'+n && count > 0 && g.normals.length == count*3 && g.sub.length == count && g.v.length == count && g.indices.length % 3 == 0 && g.indices.every((i) => i >= 0 && i < count) && g.sub.every((s) => s >= 0 && s < g.subMeshes) && g.v.every((v) => v >= 0 && v <= 1) && mesh.triangleCount > 0);
  });
  check(`sections: obstacle meshes sound (${vertices} vertices)`, bad.length == 0, bad.join(', '));
}

const KINDS = ['box', 'wall', 'pillar', 'sphere', 'gate'];
const ANIMS = ['tumble', 'fall', 'rise', 'slide', 'spin'];
const T = global.rules.track;
const SIZES = [[T.block.width, T.block.length], [T.entry.width, T.entry.length], [500, 500]];
const shipWidth = global.rules.ship.collider.width*10;   // room for the ship: its box plus a margin

/** The x-intervals an obstacle blocks at height 0..8 (the ship's level) at a given z. */
function blockedAt(o, z) {
  const half = o.d/2, spanZ = o.kind == 'sphere' ? o.w/2 : half;
  if (z < o.z-spanZ || z > o.z+spanZ) {
    return [];
  }
  if (o.kind == 'gate') {
    // the posts; the lintel is above the ship
    return [[o.x-o.w/2-o.d/2, o.x-o.w/2+o.d/2], [o.x+o.w/2-o.d/2, o.x+o.w/2+o.d/2]];
  }
  // a rotated box blocks its bounding extent — the safe side
  const r = Math.abs(o.ry || 0)*Math.PI/180;
  const ext = o.kind == 'sphere' ? o.w/2 : (o.w/2)*Math.cos(r)+(o.d/2)*Math.sin(r);
  return [[o.x-ext, o.x+ext]];
} // blockedAt

/** True when at z there is a free run at least `width` wide across the block. */
function passable(block, z, width) {
  const intervals = [];
  for (const o of block.obstacles) {
    if (o.y > 8) continue;
    blockedAt(o, z).forEach((iv) => intervals.push(iv));
  }
  intervals.sort((a, b) => a[0]-b[0]);
  let x = -block.width/2;
  for (const iv of intervals) {
    if (iv[0]-x >= width) return true;
    x = Math.max(x, iv[1]);
  }
  return block.width/2-x >= width;
} // passable

const blockIds = new Set();
const fromReference = sections.source == 'reference';   // the original's track (mksections --reference): shapes, not the own obstacles
check('sections: blocks unique', new Set(sections.blocks.map((b) => b.id)).size == sections.blocks.length);
for (const b of sections.blocks) {
  blockIds.add(b.id);
  if (fromReference) {
    check(`block ${b.id}: extent one of the original's (notes 8)`, SIZES.some((s) => s[0] == b.width && s[1] == b.length), `${b.width} x ${b.length}`);
    check(`block ${b.id}: obstacles per tick ≥ 1`, b.obstaclesPerTick >= 1);
    const LOOKS = ['box', 'wall', 'pillar', 'sphere'];
    // a capsule's s[2] is its axis (0 x, 1 y, 2 z), not a size
    check(`block ${b.id}: ${b.shapes.length} shapes with a look, sized`, b.shapes.every((sh) => LOOKS.includes(sh.look) && ['box', 'sphere', 'capsule'].includes(sh.kind) && sh.s.slice(0, sh.kind == 'capsule' ? 2 : 3).every((v) => v > 0)));
    check(`block ${b.id}: every shape's material in the world's table (notes 15)`, b.shapes.every((sh) => sh.material === null || sh.material === undefined || !!(sections.materials && sections.materials[sh.material])), b.shapes.filter((sh) => sh.material && !(sections.materials && sections.materials[sh.material])).map((sh) => sh.material).join(', '));
    const drawn = b.shapes.filter((sh) => sh.parts);
    check(`block ${b.id}: ${b.shapes.filter((sh) => sh.hidden).length} hidden shapes (drawn with another) carry no parts`, b.shapes.every((sh) => !sh.hidden || !sh.parts));
    const partOk = (part) => !!sections.meshes[part.mesh] && part.materials.length > 0 && part.materials.every((m) => !!sections.materials[m]) && part.offset && [part.offset.p, part.offset.q, part.offset.s].every((a) => a.every(Number.isFinite)) && part.offset.s.every((v) => v !== 0);
    check(`block ${b.id}: ${drawn.length} of ${b.shapes.length} shapes drawn by the original's meshes (${drawn.reduce((n, sh) => n+sh.parts.length, 0)} parts), placed and coloured`, drawn.every((sh) => sh.parts.length > 0 && sh.parts.every(partOk)));
    continue;                     // the original's prefabs reach over their block: no bound on the shapes' places
  }
  check(`block ${b.id}: extent one of the original's (notes 8)`, SIZES.some((s) => s[0] == b.width && s[1] == b.length), `${b.width} x ${b.length}`);
  check(`block ${b.id}: obstacles per tick ≥ 1`, b.obstaclesPerTick >= 1);
  const inside = b.obstacles.every((o) => Math.abs(o.x) <= b.width/2 && Math.abs(o.z) <= b.length/2 && o.y >= 0 && o.w > 0 && o.h > 0 && o.d > 0);
  check(`block ${b.id}: ${b.obstacles.length} obstacles inside, sized, on or above the ground`, inside);
  check(`block ${b.id}: kinds and animations known`, b.obstacles.every((o) => KINDS.includes(o.kind) && (!o.anim || ANIMS.includes(o.anim.type))));
  check(`block ${b.id}: spawn points inside`, b.spawnPoints.every((p) => Math.abs(p.x) <= b.width/2 && Math.abs(p.z) <= b.length/2));
  if (b.kind == 'entry' || b.kind == 'connector') {
    check(`block ${b.id}: no spawn points on an entry or connector (notes 12)`, b.spawnPoints.length == 0);
  } else {
    check(`block ${b.id}: spawn points with energy ones (notes 12)`, b.spawnPoints.length >= 8 && b.spawnPoints.filter((p) => p.energy).length >= 2, b.spawnPoints.length);
    check(`block ${b.id}: dynamic blocks animate, static ones do not`, (b.kind == 'dynamic') == b.obstacles.some((o) => o.anim));
  }
  let blockedZ = null;
  for (let z = -b.length/2; z <= b.length/2 && blockedZ === null; z += 5) {
    if (!passable(b, z, shipWidth)) blockedZ = z;
  }
  check(`block ${b.id}: a gap of ${shipWidth} u at every z`, blockedZ === null, 'blocked at z '+blockedZ);
}
for (const id of Object.keys(sections.worlds)) {
  const w = sections.worlds[id];
  check(`sections ${id}: every block exists`, w.sections.every((s) => s.blocks.every((b) => blockIds.has(b))));
  check(`sections ${id}: starts with a constant entry section`, w.sections[0].type == 'constant' && w.sections[0].length == 1 && /entry/i.test(w.sections[0].blocks[0]));
  check(`sections ${id}: ends practically infinite (notes 8)`, w.sections[w.sections.length-1].length >= 999);
  check(`sections ${id}: indices in order`, w.sections.every((s, i) => s.index == i));
  check(`sections ${id}: every block of the world is used`, sections.blocks.filter((b) => b.world == id).every((b) => w.sections.some((s) => s.blocks.includes(b.id))));
}

// -------------------------------------------------- against the reference

const refDir = path.join(root, 'sources/extract/json');
if (fs.existsSync(path.join(refDir, 'params.json')) && fs.existsSync(path.join(refDir, 'sections.json'))) {
  const params = JSON.parse(fs.readFileSync(path.join(refDir, 'params.json'), 'utf8')).params;
  const ref = JSON.parse(fs.readFileSync(path.join(refDir, 'sections.json'), 'utf8'));
  const refMeshes = [];
  for (const model of Object.values(params.shipModels.value)) {
    for (const m of model.meshes) {
      if (m.vertexCount) refMeshes.push(m);
    }
  }
  for (const {ship, mesh} of meshes) {
    const b = mesh.bounds();
    if (ship.model) {
      // the original's model: the same triangles as the reference mesh of the model's `mesh` child
      const model = params.shipModels.value[ship.model+'-Model'];
      const m = model && model.meshes.find((x) => x.object && /\/mesh$/.test(x.object) && x.indexCount);
      check(`ship ${ship.id}: the reference model ${ship.model} (${m ? m.mesh : '?'})`, !!m && m.indexCount/3 == mesh.triangleCount && mesh.vertexCount <= m.vertexCount*1.5, m ? `${m.indexCount/3} triangles, ${m.vertexCount} vertices vs ${mesh.triangleCount} / ${mesh.vertexCount}` : 'no reference mesh');
      continue;
    }
    const same = refMeshes.filter((m) => m.vertexCount == mesh.vertexCount || (Math.abs(m.extent[0]*2*0.02-b.width) < 0.05 && Math.abs(m.extent[1]*2*0.02-b.height) < 0.05 && Math.abs(m.extent[2]*2*0.02-b.depth) < 0.05));
    check(`ship ${ship.id}: not a reference model (${refMeshes.length} compared)`, same.length == 0, same.map((m) => m.mesh).join(', '));
  }
  if (fromReference) {
    // the original's track must be the reference's conversion, block by block and sequence by sequence
    const { referenceTrack } = await import('./tracelib.mjs');
    worlds.forEach((w, i) => {
      const t = referenceTrack(ref, i, {worlds: {worlds: worlds}});
      const ours = sections.blocks.filter((b) => b.world == w.id);
      check(`world ${w.id}: the reference's ${Object.keys(t.blocks).length} blocks`, ours.length == Object.keys(t.blocks).length && ours.every((b) => t.blocks[b.id] && t.blocks[b.id].shapes.length == b.shapes.length && t.blocks[b.id].spawnPoints.length == b.spawnPoints.length), ours.length);
      const seq = (list) => list.map((s) => s.type[0]+s.length+':'+s.blocks.join(',')).join(' ');
      check(`world ${w.id}: the reference's section sequence`, seq(sections.worlds[w.id].sections) == seq(t.worlds[t.worldId].sections));
    });
  }
  const refBlocks = Object.values(ref.blocks).filter((b) => b.colliders);
  for (const b of fromReference ? [] : sections.blocks) {
    let worst = {name: '', share: 0};
    for (const rb of refBlocks) {
      let hits = 0;
      for (const o of b.obstacles) {
        if (rb.colliders.some((c) => Math.abs(c.center[0]-o.x) < 2 && Math.abs(c.center[2]-o.z) < 2)) hits++;
      }
      const share = b.obstacles.length ? hits/b.obstacles.length : 0;
      if (share > worst.share) worst = {name: rb.name, share: share};
    }
    check(`block ${b.id}: obstacles do not coincide with a reference block (${refBlocks.length} compared)`, worst.share < 0.2, `${Math.round(worst.share*100)} % with ${worst.name}`);
  }
  for (const id of fromReference ? [] : Object.keys(sections.worlds)) {
    const own = sections.worlds[id].sections.map((s) => s.type[0]+s.length).join(' ');
    const copies = ref.worlds.filter((w) => w.sections.map((s) => (s.type == 'ConstantSection' ? 'c' : 'r')+s.length).join(' ') == own);
    check(`sections ${id}: not a reference sequence`, copies.length == 0, copies.map((w) => w.name).join(', '));
  }
} else {
  console.log('  (no sources/extract/json — the comparison with the reference is skipped)');
}

console.log(`checkdata: ${checks} checks, ${differences} differences`);
process.exit(differences);
