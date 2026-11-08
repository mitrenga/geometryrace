#!/usr/bin/env node
/**
 * mkships — builds the ships into data/ships.json from mkships.spec.json:
 * for each ship the store facts (name, price, upgrade slots — the
 * mechanics of notes 14) and its mesh (`Mesh.toJSON`).
 *
 * The mesh comes from one of two places. A ship with `model` (the
 * operator's decision of 2026-09-16: the shapes of the original for the
 * licence preview) is read from the original's export (`reference` in the
 * spec: the AssetRipper project, outside git): the `mesh` child of the
 * `<model>-Model` prefab — its Unity mesh asset (the vertex buffer's
 * positions and normals, the index buffer, the submeshes) put through the
 * child's transform (rotation, scale, position; the model root is
 * identity once `PlayerControl.SetShipModel` parents it), so the mesh is
 * in the player's frame in world units like the game's own hulls; every
 * submesh is coloured by its material's tint (`_Color` — the ships'
 * textures are plain white) as vertex colours, the vertices deduplicated
 * within a submesh, every triangle wound to agree with its normals. Without
 * the export at hand such a ship cannot be built and the tool says so.
 * A ship without `model` is the game's own design: a lofted hull, wing
 * plates and fins made here — every face with its own three vertices,
 * every part a closed shell, every triangle wound outward.
 *
 * The output is deterministic; rerun after editing the spec and rerun
 * `regress --update` if the ship the fingerprints show changed shape
 * (the markup names the mesh, not its vertices — a change of shape alone
 * leaves the fingerprints as they are).
 *
 * usage: node tools/mkships.mjs [tools/mkships.spec.json]
 */
import '../app/svision/tools/nodeEnv.mjs';   // must come first: the import headers read window.srcVersion
import fs from 'node:fs';
import path from 'node:path';

import { guids, prefabParts, composeParts, hex, materialTint } from './unitymesh.mjs';
import { UnityGraph } from './unitylib.mjs';

const { Mesh } = await import('../app/svision/js/platform/scene3D/mesh.js');

const specFile = process.argv[2] || path.join(path.dirname(new URL(import.meta.url).pathname), 'mkships.spec.json');
const specDir = path.dirname(path.resolve(specFile));
const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));

/**
 * Collects flat triangles: each `add(a, b, c, inside)` is one face wound
 * so its normal points away from `inside` (a point inside the part).
 */
class Builder {
  constructor() {
    this.positions = [];
    this.normals = [];
    this.indices = [];
  }
  add(a, b, c, inside) {
    let n = normal(a, b, c);
    const cx = (a[0]+b[0]+c[0])/3, cy = (a[1]+b[1]+c[1])/3, cz = (a[2]+b[2]+c[2])/3;
    if (n[0]*(cx-inside[0])+n[1]*(cy-inside[1])+n[2]*(cz-inside[2]) < 0) {
      const t = b; b = c; c = t;
      n = [-n[0], -n[1], -n[2]];
    }
    const base = this.positions.length/3;
    for (const p of [a, b, c]) {
      this.positions.push(p[0], p[1], p[2]);
      this.normals.push(n[0], n[1], n[2]);
    }
    this.indices.push(base, base+1, base+2);
  }
  quad(a, b, c, d, inside) {
    this.add(a, b, c, inside);
    this.add(a, c, d, inside);
  }
  mesh(id) {
    return new Mesh(this.positions, this.normals, this.indices, {id: id});
  }
} // Builder

function normal(a, b, c) {
  const ux = b[0]-a[0], uy = b[1]-a[1], uz = b[2]-a[2];
  const vx = c[0]-a[0], vy = c[1]-a[1], vz = c[2]-a[2];
  const nx = uy*vz-uz*vy, ny = uz*vx-ux*vz, nz = ux*vy-uy*vx;
  const l = Math.sqrt(nx*nx+ny*ny+nz*nz) || 1;
  return [nx/l, ny/l, nz/l];
} // normal

/** The points of a ring: `sides` around an ellipse `w` × `h` centred (0, y, z), a vertex at the top. */
function ring(sides, w, h, y, z) {
  const pts = [];
  for (let k = 0; k < sides; k++) {
    const t = Math.PI/2+2*Math.PI*k/sides;
    pts.push([Math.cos(t)*w/2, y+Math.sin(t)*h/2, z]);
  }
  return pts;
} // ring

/** The hull: rings lofted, a nose point in front, a tail cap behind. */
function hull(b, h) {
  const rings = h.rings.map((r) => ring(h.sides, r[1], r[2], r[3], r[0]));
  const inside = [0, h.rings.reduce((s, r) => s+r[3], 0)/h.rings.length, (h.nose+h.tail)/2];
  const nose = [0, rings[0][0][1]-h.rings[0][2]/2+h.rings[0][2]/2, h.nose];   // on the axis of the first ring
  nose[1] = h.rings[0][3];
  for (let k = 0; k < h.sides; k++) {
    const r0 = rings[0];
    b.add(nose, r0[k], r0[(k+1)%h.sides], inside);
  }
  for (let i = 0; i+1 < rings.length; i++) {
    const a = rings[i], c = rings[i+1];
    for (let k = 0; k < h.sides; k++) {
      b.quad(a[k], a[(k+1)%h.sides], c[(k+1)%h.sides], c[k], inside);
    }
  }
  const last = rings[rings.length-1];
  const tailCentre = [0, h.rings[h.rings.length-1][3], h.tail];
  for (let k = 0; k < h.sides; k++) {
    b.add(tailCentre, last[(k+1)%h.sides], last[k], inside);
  }
} // hull

/**
 * A plate: a polygon (convex, in order) extruded by `thickness` — the
 * `map` puts a 2D point of the spec into 3D on either face.
 */
function plate(b, points, thickness, map) {
  const top = points.map((p) => map(p, thickness/2));
  const bottom = points.map((p) => map(p, -thickness/2));
  const n = points.length;
  const inside = [0, 0, 0];
  top.concat(bottom).forEach((p) => { inside[0] += p[0]/(2*n); inside[1] += p[1]/(2*n); inside[2] += p[2]/(2*n); });
  for (let i = 1; i+1 < n; i++) {
    b.add(top[0], top[i], top[i+1], inside);
    b.add(bottom[0], bottom[i+1], bottom[i], inside);
  }
  for (let i = 0; i < n; i++) {
    const j = (i+1)%n;
    b.quad(top[i], top[j], bottom[j], bottom[i], inside);
  }
} // plate

function shipMesh(ship) {
  const b = new Builder();
  hull(b, ship.hull);
  for (const w of ship.wings || []) {
    const sides = w.mirror ? [1, -1] : [1];
    for (const s of sides) {
      plate(b, w.points, w.thickness, (p, dy) => [s*p[0], w.y+dy, p[1]]);
    }
  }
  for (const f of ship.fins || []) {
    plate(b, f.points, f.thickness, (p, dx) => [f.x+dx, p[0], p[1]]);
  }
  return b.mesh('ship:'+ship.id);
} // shipMesh

// ------------------------------------------------- the original's models

const referenceDir = spec.reference ? path.resolve(specDir, spec.reference) : null;

/**
 * The mesh of an original ship model from the export (tools/unitymesh.mjs):
 * the `mesh` child of the `<model>-Model` prefab through its transform
 * (the model root is identity once `PlayerControl.SetShipModel` parents
 * it), in the player's frame, with the submeshes' material tints on the
 * vertices.
 * @param {Object} s - The spec entry (`model`).
 * @returns {{mesh: Mesh, reference: Object, colors: string[]}}
 */
function referenceShip(s) {
  if (!referenceDir || !fs.existsSync(referenceDir)) {
    throw new Error(`ship ${s.id}: model ${s.model} needs the export at ${referenceDir} (sources/README.md) — not at hand`);
  }
  const table = guids(referenceDir);
  const parts = prefabParts(table, path.join(referenceDir, 'Assets/GameObject', s.model+'-Model.prefab'), {root: 'mesh', skip: ['ShadowShip']});
  if (!parts.length) {
    throw new Error(`ship ${s.id}: no 'mesh' child with a mesh in ${s.model}-Model`);
  }
  const r = composeParts(parts, 'ship:'+s.id);
  const byTriangles = r.report.parts.slice().sort((a, b) => b.triangles-a.triangles);
  return {
    mesh: r.mesh,
    reference: {model: s.model, mesh: parts[0].mesh.name, vertices: parts[0].mesh.vertexCount, triangles: r.report.triangles, submeshes: r.report.parts},
    colors: [hex(byTriangles[0].tint), hex((byTriangles[1] || byTriangles[0]).tint)]
  };
} // referenceShip

/**
 * The wake of an original ship model: its two smoke particle systems
 * (`Smoke_Particles_Left/Right` under the model's root, beside `mesh`) —
 * where they sit in the player's frame and the tint of their material
 * (`<N>ShipSmoke`; notes 5). The playfield draws crystals falling off
 * there (decoration, the original's particles).
 * @param {Object} s - The spec entry (`model`).
 * @returns {{color: string, emitters: number[][]}}
 */
function referenceWake(s) {
  const table = guids(referenceDir);
  const g = new UnityGraph(path.join(referenceDir, 'Assets/GameObject', s.model+'-Model.prefab'), table);
  const emitters = [];
  let color = null;
  for (const go of g.gameObjects()) {
    const renderer = g.components(go).find((d) => d.type == 'ParticleSystemRenderer');
    if (!renderer || !/Particles/i.test(g.nameOf(go))) {
      continue;
    }
    const t = g.localTransform(go);
    emitters.push(t.position.map((v) => Mesh.num(Number(v))));
    const m = renderer.data.m_Materials && renderer.data.m_Materials[0] && renderer.data.m_Materials[0].guid ? table.get(renderer.data.m_Materials[0].guid) : null;
    if (m && !color) {
      color = hex(materialTint(m.file));
    }
  }
  if (emitters.length < 2 || !color) {
    throw new Error(`ship ${s.id}: no two smoke particle systems in ${s.model}-Model`);
  }
  return {color: color, emitters: emitters};
} // referenceWake

/**
 * The colours the original bursts on a crash: `ShipParticleColors.
 * particleColors` of the model (`PlayerCrash.Crash` makes one particle
 * system per colour, notes 11).
 * @param {Object} s - The spec entry (`model`).
 * @returns {string[]}
 */
function referenceCrashColors(s) {
  const table = guids(referenceDir);
  const g = new UnityGraph(path.join(referenceDir, 'Assets/GameObject', s.model+'-Model.prefab'), table);
  for (const go of g.gameObjects()) {
    for (const b of g.behaviours(go)) {
      if (b.script == 'ShipParticleColors' && Array.isArray(b.doc.data.particleColors)) {
        return b.doc.data.particleColors.map((c) => hex([Number(c.r), Number(c.g), Number(c.b)]));
      }
    }
  }
  throw new Error(`ship ${s.id}: no ShipParticleColors in ${s.model}-Model`);
} // referenceCrashColors

/** the wake of an own hull: the edge colour, behind the wing tips (the original's emitters, notes 5) */
const OWN_WAKE = (s) => ({color: s.edge, emitters: [[-1.85, 0.43, -3.82], [1.92, 0.43, -3.82]]});

const ships = spec.ships.map((s, index) => {
  let mesh, reference = null, colors = [s.color, s.edge], wake, crashColors;
  if (s.model) {
    const r = referenceShip(s);
    mesh = r.mesh;
    reference = r.reference;
    colors = r.colors;
    wake = referenceWake(s);
    crashColors = referenceCrashColors(s);
  } else {
    mesh = shipMesh(s);
    wake = OWN_WAKE(s);
    crashColors = [s.color, s.edge];
  }
  const bounds = mesh.bounds();
  return {
    id: s.id,
    index: index,
    name: s.name,
    price: s.price,
    default: !!s.default,
    upgrades: s.upgrades,
    color: colors[0],
    edge: colors[1],
    model: s.model || null,
    size: {width: Mesh.num(bounds.width), height: Mesh.num(bounds.height), length: Mesh.num(bounds.depth)},
    wake: wake,
    crashColors: crashColors,
    mesh: mesh.toJSON()
  };
});

// the facts into data/ships.json (appData.db, small), every mesh into
// assets/ships/<id>.json (`{id, mesh}` — fetched by the application when the
// ship is shown or flown, cached by the service worker; the tools attach
// them through tools/tracelib.mjs loadData)
const outFile = path.resolve(specDir, spec.output);
const assetsDir = path.resolve(specDir, spec.assets);
fs.mkdirSync(assetsDir, {recursive: true});
ships.forEach((s) => {
  fs.writeFileSync(path.join(assetsDir, s.id+'.json'), JSON.stringify({id: s.id, mesh: s.mesh})+'\n');
  s.mesh = null;
  s.asset = 'assets/ships/'+s.id+'.json';
});
const out = {note: spec.note, ships: ships};
fs.writeFileSync(outFile, JSON.stringify(out)+'\n');
console.log(`${path.relative(process.cwd(), outFile)} + ${path.relative(process.cwd(), assetsDir)}/: ${ships.length} ships — ${ships.map((s) => `${s.id}${s.model ? ' ('+s.model+')' : ''} ${s.size.width}x${s.size.height}x${s.size.length}`).join(', ')}`);
