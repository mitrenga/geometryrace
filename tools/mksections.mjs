#!/usr/bin/env node
/**
 * mksections — generates the game's own track into assets/worlds/<id>.json
 * from mksections.spec.json: for each world its blocks (an entry block, a
 * connector where the world has one, static and dynamic blocks, each a
 * recipe run with the seeded randomness — rows of boxes with a gap, a
 * slalom of walls, gates, spheres, a grid — with animations on the dynamic
 * ones) and its section sequence (constant / random sections with a
 * Length in rows, a repeated static/dynamic tail and a practically
 * infinite last section, the shape of the original's sequences, notes 8).
 * Every row leaves a gap the ship fits through; checkdata.mjs verifies
 * that, the bounds, and that no block coincides with the reference.
 *
 * The output is deterministic for the spec (the seed is in it): the
 * generator is mulberry32 as the worker uses it. No Math.random().
 *
 * `--reference` (the operator's decision of 2026-09-16: the original's
 * track for the licence preview) writes the original's blocks and section
 * sequences instead: sources/extract/json/sections.json (GR-M4
 * unity2sections, outside git) converted by tools/tracelib.mjs
 * `referenceTrack` the way matchtrack runs it — every prefab's colliders
 * as shapes (box, sphere, capsule) with their activation slot and
 * animator, its spawn points, the world's sections — plus a `look` for
 * the playfield's colours by the shape's proportions (cube, pillar, wall,
 * sphere) and the world of every block. The file then says
 * `source: 'reference'`, and checkdata.mjs compares it with the reference
 * instead of demanding a difference. Without the reference at hand the
 * tool says so and writes nothing.
 *
 * usage: node tools/mksections.mjs [tools/mksections.spec.json] [--reference]
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadReference, referenceTrack } from './tracelib.mjs';
import { guids, obstacleGeometry } from './unitymesh.mjs';

const args = process.argv.slice(2);
const specFile = args.find((a) => !a.startsWith('--')) || path.join(path.dirname(new URL(import.meta.url).pathname), 'mksections.spec.json');
const specDir = path.dirname(path.resolve(specFile));
const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));

/** mulberry32 → 0..1 */
function seeded(seed) {
  let a = seed >>> 0;
  return function() {
    a = (a+0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t+Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0)/4294967296;
  };
} // seeded

const rnd = seeded(spec.seed);
const between = (a, b) => a+rnd()*(b-a);
const int = (a, b) => Math.floor(between(a, b+1));         // a..b inclusive
const pick = (arr) => arr[Math.floor(rnd()*arr.length)];
const r1 = (v) => Math.round(v*10)/10;

/** the free slots of a row: `slots` positions across the block, `keep` adjacent ones left free (the gap) */
function slotsAcross(width, slots, gapSlots) {
  const pitch = width/slots;
  const gapStart = int(0, slots-gapSlots);
  const xs = [];
  for (let s = 0; s < slots; s++) {
    if (s >= gapStart && s < gapStart+gapSlots) {
      continue;
    }
    xs.push(-width/2+pitch*(s+0.5));
  }
  const gapX = -width/2+pitch*(gapStart+gapSlots/2);
  return {xs: xs, pitch: pitch, gapX: gapX};
} // slotsAcross

const ROW_MARGIN = 60;   // the first and last rows stay this far from the block's ends

/** the z of `rows` rows spread along a block of `length` */
function rowZs(length, rows) {
  const zs = [];
  const span = length-2*ROW_MARGIN;
  for (let r = 0; r < rows; r++) {
    zs.push(r1(-length/2+ROW_MARGIN+span*(r+0.5)/rows+between(-12, 12)));
  }
  return zs;
} // rowZs

// ----------------------------------------------------------------- recipes

const recipes = {

  /** rows of boxes, each row a few of them with a gap at least 3 slots wide */
  rows(block, o) {
    const zs = rowZs(block.length, o.rows);
    zs.forEach((z, i) => {
      const slots = 10, gap = int(3, 4);
      const s = slotsAcross(block.width, slots, gap);
      const count = int(3, Math.min(6, s.xs.length));
      const chosen = shuffle(s.xs).slice(0, count);
      for (const x of chosen) {
        const size = r1(between(o.size[0], o.size[1]));
        block.obstacles.push({kind: 'box', x: r1(x+between(-8, 8)), y: 0, z: z, w: size, h: r1(size*between(0.8, 1.6)), d: size, ry: pick([0, 0, 0, 15, -15, 30])});
      }
      block.gaps.push({z: z, x: s.gapX, width: s.pitch*gap});
    });
  },

  /** a slalom: a wall from one side, then from the other, the gap at the free end */
  slalom(block, o) {
    const zs = rowZs(block.length, o.rows);
    zs.forEach((z, i) => {
      const side = i%2 == 0 ? -1 : 1;
      const len = r1(block.width*between(0.55, 0.7));
      const x = side*(block.width/2-len/2);
      block.obstacles.push({kind: 'wall', x: r1(x), y: 0, z: z, w: len, h: r1(between(14, 24)), d: r1(between(8, 12)), ry: 0});
      block.gaps.push({z: z, x: -side*(block.width/2-(block.width-len)/2), width: block.width-len});
    });
  },

  /** rows of low walls with a gap in each */
  walls(block, o) {
    const zs = rowZs(block.length, o.rows);
    zs.forEach((z) => {
      const gap = r1(between(60, 110));
      const gapX = r1(between(-block.width/2+gap/2+20, block.width/2-gap/2-20));
      const left = gapX-gap/2+block.width/2, right = block.width/2-(gapX+gap/2);
      const h = r1(between(12, 26));
      if (left > 10) {
        block.obstacles.push({kind: 'wall', x: r1(-block.width/2+left/2), y: 0, z: z, w: r1(left), h: h, d: 10, ry: 0});
      }
      if (right > 10) {
        block.obstacles.push({kind: 'wall', x: r1(block.width/2-right/2), y: 0, z: z, w: r1(right), h: h, d: 10, ry: 0});
      }
      block.gaps.push({z: z, x: gapX, width: gap});
    });
  },

  /** gates: two posts and a lintel to fly under, with boxes beside them */
  gates(block, o) {
    const zs = rowZs(block.length, o.rows);
    zs.forEach((z) => {
      const span = r1(between(70, 110));
      const x = r1(between(-block.width/2+span, block.width/2-span));
      const post = r1(between(10, 16)), height = r1(between(30, 44));
      block.obstacles.push({kind: 'gate', x: x, y: 0, z: z, w: span, h: height, d: post, ry: 0});
      // boxes elsewhere in the row
      const n = int(1, 3);
      for (let i = 0; i < n; i++) {
        let bx;
        do {
          bx = r1(between(-block.width/2+20, block.width/2-20));
        } while (Math.abs(bx-x) < span/2+30);
        const size = r1(between(12, 24));
        block.obstacles.push({kind: 'box', x: bx, y: 0, z: r1(z+between(-10, 10)), w: size, h: size, d: size, ry: 0});
      }
      block.gaps.push({z: z, x: x, width: span-post});
    });
  },

  /** rows of spheres of a few sizes */
  spheres(block, o) {
    const zs = rowZs(block.length, o.rows);
    zs.forEach((z) => {
      const slots = 8, gap = 3;
      const s = slotsAcross(block.width, slots, gap);
      const count = int(3, Math.min(5, s.xs.length));
      for (const x of shuffle(s.xs).slice(0, count)) {
        const r = r1(between(8, 18));
        block.obstacles.push({kind: 'sphere', x: r1(x+between(-6, 6)), y: 0, z: z, w: r*2, h: r*2, d: r*2, ry: 0});
      }
      block.gaps.push({z: z, x: s.gapX, width: s.pitch*gap});
    });
  },

  /** a regular grid of small pillars with one column left free per row band */
  grid(block, o) {
    const zs = rowZs(block.length, o.rows);
    zs.forEach((z) => {
      const slots = 9, gap = 3;
      const s = slotsAcross(block.width, slots, gap);
      for (const x of s.xs) {
        block.obstacles.push({kind: 'pillar', x: r1(x), y: 0, z: z, w: 10, h: r1(between(20, 40)), d: 10, ry: 0});
      }
      block.gaps.push({z: z, x: s.gapX, width: s.pitch*gap});
    });
  },

  /** the entry: a wide block with a few big shapes near the sides, the middle free */
  entry(block, o) {
    for (let i = 0; i < o.obstacles; i++) {
      const side = i%2 == 0 ? -1 : 1;
      const size = r1(between(30, 60));
      const kind = pick(['box', 'pillar', 'sphere']);
      // a sphere is round (its collision shape is a sphere of its width — track.js)
      const h = kind == 'sphere' ? size : r1(size*between(0.8, 2));
      block.obstacles.push({kind: kind, x: r1(side*between(block.width/2-size-120, block.width/2-size)), y: 0, z: r1(-block.length/2+ROW_MARGIN+(block.length-2*ROW_MARGIN)*(i+0.5)/o.obstacles), w: size, h: h, d: size, ry: 0});
    }
    block.gaps.push({z: 0, x: 0, width: block.width-2*(60+120)});
  }
}; // recipes

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length-1; i > 0; i--) {
    const j = Math.floor(rnd()*(i+1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
} // shuffle

/** animations on a dynamic block: `count` obstacles of a suitable kind get one */
function animate(block, type, count) {
  const suits = {tumble: ['box'], fall: ['pillar', 'box'], rise: ['box', 'pillar', 'sphere'], slide: ['wall', 'box', 'sphere'], spin: ['sphere', 'box', 'gate']};
  const candidates = shuffle(block.obstacles.filter((ob) => !ob.anim && suits[type].includes(ob.kind)));
  for (const ob of candidates.slice(0, count)) {
    switch (type) {
      case 'tumble':
        // rolls about an edge of its world bounds (notes 11), so it stands square
        ob.ry = 0;
        ob.anim = {type: 'tumble', direction: pick(['left', 'right', 'forward', 'back']), speed: pick([50, 90, 130, 180]), repeat: rnd() < 0.8};
        break;
      case 'fall':
        if (ob.kind == 'box') {
          ob.kind = 'pillar';
          ob.h = r1(between(40, 70));
          ob.w = ob.d = r1(between(10, 14));
        }
        ob.anim = {type: 'fall', direction: pick(['left', 'right', 'forward', 'back']), zOffset: 600, degrees: 90};
        break;
      case 'rise':
        ob.anim = {type: 'rise', dy: -(ob.h+2), zOffset: pick([500, 800]), curve: 0.55};
        break;
      case 'slide':
        ob.anim = {type: 'slide', axis: 'x', amplitude: r1(between(40, 90)), period: r1(between(2, 4)), phase: r1(rnd())};
        break;
      case 'spin':
        ob.anim = {type: 'spin', speed: pick([30, 60, -45, 90])};
        break;
    }
  }
} // animate

/** spawn points in the gaps of the rows: at y 6, a few marked for energy (notes 12) */
function spawnPoints(block, o) {
  const points = int(o.points[0], o.points[1]);
  const energy = int(o.energy[0], o.energy[1]);
  const gaps = shuffle(block.gaps);
  const out = [];
  for (let i = 0; i < points; i++) {
    const g = gaps[i%gaps.length];
    out.push({x: r1(g.x+between(-g.width/4, g.width/4)), z: r1(g.z+between(-25, 25)), energy: i < energy});
  }
  // in row order, so the file reads as the track does
  return out.sort((a, b) => a.z-b.z);
} // spawnPoints

function makeBlock(id, world, kind, size, o) {
  const block = {id: id, world: world.id, kind: kind, width: size.width, length: size.length, obstaclesPerTick: 1, obstacles: [], gaps: []};
  recipes[o.recipe](block, o);
  for (const type of ['tumble', 'fall', 'rise', 'slide', 'spin']) {
    if (o[type]) {
      animate(block, type, o[type]);
    }
  }
  block.obstacles.sort((a, b) => a.z-b.z || a.x-b.x);
  block.spawnPoints = kind == 'entry' || kind == 'connector' ? [] : spawnPoints(block, world.spawn);
  block.obstaclesPerTick = block.obstacles.length > 60 ? 5 : 1;
  delete block.gaps;
  return block;
} // makeBlock

const blocks = [];
const worlds = {};
for (const w of spec.worlds) {
  const ids = {entry: null, connector: null, static: [], dynamic: []};
  ids.entry = w.prefix+'-entry';
  blocks.push(makeBlock(ids.entry, w, 'entry', spec.entry, w.entry));
  if (w.connector) {
    ids.connector = w.prefix+'-connector';
    blocks.push(makeBlock(ids.connector, w, 'connector', spec.connector, w.connector));
  }
  w.static.forEach((o, i) => {
    const id = `${w.prefix}-static-${String(i+1).padStart(2, '0')}`;
    ids.static.push(id);
    blocks.push(makeBlock(id, w, 'static', spec.block, o));
  });
  w.dynamic.forEach((o, i) => {
    const id = `${w.prefix}-dynamic-${String(i+1).padStart(2, '0')}`;
    ids.dynamic.push(id);
    blocks.push(makeBlock(id, w, 'dynamic', spec.block, o));
  });

  const sections = [];
  const random = (list, length) => ({type: 'random', length: length, blocks: list.slice()});
  for (const step of w.sequence) {
    if (step == 'entry') {
      sections.push({type: 'constant', length: 1, blocks: [ids.entry]});
    } else if (step == 'connector') {
      sections.push({type: 'constant', length: 1, blocks: [ids.connector]});
    } else if (step == 'static') {
      sections.push(random(ids.static, 2));
    } else if (step.startsWith('dynamic:')) {
      sections.push(random([ids.dynamic[Number(step.slice(8))]], 1));
    } else if (step == 'repeat') {
      for (let p = 0; p < w.repeat.pairs; p++) {
        sections.push(random(ids.static, p < w.repeat.pairs-2 ? w.repeat.static : 1));
        sections.push(random(ids.dynamic, w.repeat.dynamic));
      }
      sections.push(random(ids[w.repeat.final], w.repeat.finalLength));
    }
  }
  sections.forEach((s, i) => { s.index = i; });
  worlds[w.id] = {sections: sections};
}

const outFile = path.resolve(specDir, spec.output);

if (args.includes('--reference')) {
  const ref = loadReference();
  if (!ref) {
    console.log('mksections --reference: sources/extract/json/sections.json is not at hand (GR-M4 tools/unity2sections.mjs) — nothing written');
    process.exit(1);
  }
  const worldsData = JSON.parse(fs.readFileSync(path.resolve(specDir, '../data/worlds.json'), 'utf8'));
  const refBlocks = [], refWorlds = {}, refMaterials = {}, refMeshes = {};
  // the obstacle meshes come from the export itself (unity2sections.spec.json names the project)
  const exportSpec = JSON.parse(fs.readFileSync(path.join(specDir, 'unity2sections.spec.json'), 'utf8'));
  const table = guids(path.resolve(specDir, exportSpec.project));
  const geometry = {};
  const stats = {shapes: 0, animated: 0, points: 0};
  /** the look of a shape for the playfield's colours: by its kind and proportions */
  const lookOf = (sh) => {
    if (sh.kind == 'sphere') return 'sphere';
    if (sh.kind == 'capsule') return 'pillar';
    const [w, h, d] = sh.s;
    if (h > 1.8*Math.max(w, d)) return 'pillar';
    if (Math.max(w, d) > 2.5*Math.min(w, d) && Math.max(w, d) > 1.5*h) return 'wall';
    return 'box';
  };
  worldsData.worlds.forEach((w, i) => {
    const t = referenceTrack(ref, i, {worlds: worldsData});
    Object.keys(t.blocks).forEach((name) => {
      const b = t.blocks[name];
      b.shapes.forEach((sh) => {
        // a collider under a mirrored transform comes with negative sizes: the extent is what counts
        sh.s = sh.s.map((v, k) => (sh.kind == 'capsule' && k == 2 ? v : Math.abs(v)));
        sh.look = lookOf(sh);
        delete sh.object;
      });
      b.world = w.id;
      b.kind = /Entry/i.test(name) ? 'entry' : /Empty|Connector/i.test(name) ? 'connector' : b.shapes.some((sh) => sh.anim) ? 'dynamic' : 'static';
      refBlocks.push(b);
      stats.shapes += b.shapes.length;
      stats.animated += b.shapes.filter((sh) => sh.anim).length;
      stats.points += b.spawnPoints.length;
    });
    const sections = t.worlds[t.worldId].sections;
    sections.forEach((sec, k) => { sec.index = k; });
    refWorlds[w.id] = {sections: sections};
    refMaterials[w.id] = t.materials;
    stats.materials = (stats.materials || 0)+Object.keys(t.materials).length;
    refMeshes[w.id] = {};
    t.meshNames.forEach((name) => {
      if (!geometry[name]) {
        geometry[name] = obstacleGeometry(table, name);
      }
      refMeshes[w.id][name] = geometry[name];
    });
    stats.meshes = (stats.meshes || 0)+t.meshNames.length;
    stats.vertices = (stats.vertices || 0)+t.meshNames.reduce((n, name) => n+geometry[name].positions.length/3, 0);
  });
  const note = 'The original\'s track: its blocks (the colliders of every prefab as shapes with their activation slot and animator, the spawn points, notes 8, 11, 12) and section sequence of the world, converted from the reference sources/extract/json/sections.json by tools/mksections.mjs --reference through tools/tracelib.mjs (the operator\'s decision of 2026-09-16 for the licence preview). `parts` of a shape are the original\'s meshes drawn with the collider — each its mesh, its renderer\'s materials in order and where it sits relative to the shape (tracelib.relativeTransform); `meshes` holds the geometry of those meshes (unitymesh.obstacleGeometry: vertices with their submesh and texture v) and `materials` the looks of the materials (notes 15: texture x tint — the textures are vertical gradients or solids; `ramp` the colours along v, `color` the middle, `shade` the bottom) — Playfield colours a mesh from them. `material` is the visible one (the last of the renderer\'s), `look` the playfield\'s fallback mesh and colour key by the shape\'s proportions. The own track of mksections.spec.json is the fallback (run the tool without --reference).';
  writeWorlds(note, 'reference', refBlocks, refWorlds, refMaterials, refMeshes);
  console.log(`${path.relative(process.cwd(), outFile)}: the reference — ${refBlocks.length} blocks, ${stats.shapes} shapes (${stats.animated} animated), ${stats.points} spawn points, ${stats.materials} material looks, ${stats.meshes} meshes (${stats.vertices} vertices); sections ${Object.keys(refWorlds).map((k) => k+' '+refWorlds[k].sections.length).join(', ')}`);
  process.exit(0);
}

writeWorlds(spec.note, 'own', blocks, worlds);

/**
 * The track as the application loads it: one file per world in
 * assets/worlds/<id>.json (`{note, source, world, blocks, sections,
 * materials, meshes}` — the world's blocks, its sequence and, from the
 * reference, the looks of its obstacle materials and the geometry of its
 * obstacle meshes; the tools compose them back into one
 * `{blocks, worlds}` through tools/tracelib.mjs loadData). `output` of the
 * spec names the directory.
 */
function writeWorlds(note, source, allBlocks, allWorlds, allMaterials, allMeshes) {
  fs.mkdirSync(outFile, {recursive: true});
  for (const f of fs.readdirSync(outFile)) {
    if (f.endsWith('.json')) fs.unlinkSync(path.join(outFile, f));
  }
  Object.keys(allWorlds).forEach((id) => {
    const used = new Set();
    allWorlds[id].sections.forEach((sec) => sec.blocks.forEach((b) => used.add(b)));
    const file = path.join(outFile, id+'.json');
    const out = {note: note, source: source, world: id, blocks: allBlocks.filter((b) => b.world == id || used.has(b.id)), sections: allWorlds[id].sections};
    if (allMaterials && allMaterials[id]) {
      out.materials = allMaterials[id];
    }
    if (allMeshes && allMeshes[id]) {
      out.meshes = allMeshes[id];
    }
    fs.writeFileSync(file, JSON.stringify(out)+'\n');
  });
} // writeWorlds
const obstacles = blocks.reduce((n, b) => n+b.obstacles.length, 0);
const animated = blocks.reduce((n, b) => n+b.obstacles.filter((o) => o.anim).length, 0);
const points = blocks.reduce((n, b) => n+b.spawnPoints.length, 0);
console.log(`${path.relative(process.cwd(), outFile)}: ${blocks.length} blocks, ${obstacles} obstacles (${animated} animated), ${points} spawn points; sections ${Object.keys(worlds).map((k) => k+' '+worlds[k].sections.length).join(', ')}`);
