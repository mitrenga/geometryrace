#!/usr/bin/env node
/**
 * mkpickups — the meshes of the pickups (the coin, the multiplier, the
 * energy) into data/pickups.json from the original's prefabs (`Credit1`,
 * `DoubleCredits_second`, `Energy` — notes 12; the operator's decision of
 * 2026-09-16: the original's shapes for the licence preview), through
 * tools/unitymesh.mjs: every part of the prefab with a mesh, composed
 * through its transform chain into the prefab's frame — the root is the
 * spawn point at the rules' height (notes 12: `PowerupSpawnPoint` y 6)
 * — with its material's tint on the vertices. The glow and ray quads
 * (billboards with additive materials) and the particles are left out;
 * the energy's `main` child is the one `MoverDistanceBased` lowers from
 * 100 u, so its position is left out of the chain and the game's height
 * of the visual (`pickups[].y` of the state) places it instead.
 *
 * usage: node tools/mkpickups.mjs
 */
import '../app/svision/tools/nodeEnv.mjs';   // must come first: the import headers read window.srcVersion
import fs from 'node:fs';
import path from 'node:path';
import { guids, prefabParts, composeParts, hex } from './unitymesh.mjs';
import { UnityGraph, parseUnityFile, num } from './unitylib.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const referenceDir = path.join(root, 'sources/extract/assetripper/1.9.7/ExportedProject');
if (!fs.existsSync(referenceDir)) {
  console.log(`mkpickups: the export ${path.relative(root, referenceDir)} is not at hand (sources/README.md) — nothing built; data/pickups.json stays as it is`);
  process.exit(1);
}
const table = guids(referenceDir);

/** kind -> the prefab and what to leave out */
const PREFABS = {
  coin: {prefab: 'Credit1', skip: ['glow', 'ray', 'Particles']},
  multiplier: {prefab: 'DoubleCredits_second', skip: ['glow', 'ray', 'Particles']},
  energy: {prefab: 'Energy', skip: ['glow', 'ray', 'Particles'], ignorePosition: ['main']}
};

/**
 * The alpha of a material's `_TintColor` — how much of the crystal shows
 * through it (notes 12): a shell is about 0.2, a core or an icon 0.6.
 * @param {string} name
 * @returns {number} 0..1, 1 without the material
 */
function materialAlpha(name) {
  const ref = [...table.values()].find((r) => r.kind == 'material' && r.name == name);
  if (!ref) {
    return 1;
  }
  const m = /_TintColor: \{r: [-\d.e]+, g: [-\d.e]+, b: [-\d.e]+, a: ([-\d.e]+)/.exec(fs.readFileSync(ref.file, 'utf8'));
  return m ? Number(m[1]) : 1;
} // materialAlpha

/**
 * The glows of a pickup's prefab — the quads the mesh leaves out
 * (`glow`, `ray`): a `*_ray` material is the beam to the sky (the quad
 * stands on end, so its length is the local x of the scale), a `*_glow`
 * one the halo around the crystal. Their colour is the material's
 * `_TintColor` (an additive particle shader), its alpha the strength
 * (notes 12).
 * @param {string} prefabFile
 * @returns {{beam: Object|null, halo: Object|null}}
 */
function glowsOf(prefabFile) {
  const out = {beam: null, halo: null};
  const docs = parseUnityFile(prefabFile);
  const g = new UnityGraph(prefabFile, table);
  for (const go of g.gameObjects()) {
    const renderer = g.components(go).find((d) => d.type == 'MeshRenderer');
    const name = (renderer && renderer.data.m_Materials && renderer.data.m_Materials[0] && renderer.data.m_Materials[0].guid && table.get(renderer.data.m_Materials[0].guid)) || null;
    if (!name || !/_(ray|glow)$/i.test(name.name)) {
      continue;
    }
    const t = g.localTransform(go);
    const scale = t.scale.map((v) => Math.abs(Number(v)));
    const tint = /_TintColor: \{r: ([-\d.e]+), g: ([-\d.e]+), b: ([-\d.e]+), a: ([-\d.e]+)/.exec(fs.readFileSync(name.file, 'utf8'));
    const color = tint ? hex([Number(tint[1]), Number(tint[2]), Number(tint[3])]) : '#ffffff';
    const alpha = tint ? Math.round(Number(tint[4])*1000)/1000 : 1;
    if (/_ray$/i.test(name.name)) {
      // the beam: tallest one wins (a prefab has more than one)
      if (!out.beam || scale[0] > out.beam.height) {
        out.beam = {material: name.name, color: color, alpha: alpha, height: num(scale[0]), radius: num(Math.max(scale[1], scale[2])/2)};
      }
    } else if (!out.halo || scale[0] > out.halo.radius*2) {
      out.halo = {material: name.name, color: color, alpha: alpha, radius: num(Math.max(scale[0], scale[2])/2), y: num(Number(t.position[1]))};
    }
  }
  void docs;
  return out;
} // glowsOf

const pickups = {};
const lines = [];
Object.keys(PREFABS).forEach((kind) => {
  const P = PREFABS[kind];
  const parts = prefabParts(table, path.join(referenceDir, 'Assets/GameObject', P.prefab+'.prefab'), {skip: P.skip, ignorePosition: P.ignorePosition});
  const r = composeParts(parts, 'pickup:'+kind);
  const b = r.mesh.bounds();
  const glows = glowsOf(path.join(referenceDir, 'Assets/GameObject', P.prefab+'.prefab'));
  // the layers of the crystal: one mesh per material, so the translucent shell shows the core
  // (and the x2 icon) inside it as the original does — its shell materials carry an alpha of
  // about 0.2, its cores and icons 0.6 (notes 12). A core is drawn solid, a shell at its alpha.
  const groups = new Map();
  parts.forEach((part) => {
    const name = (part.tints[0] || {name: '?'}).name;
    if (!groups.has(name)) {
      groups.set(name, []);
    }
    groups.get(name).push(part);
  });
  const layers = [...groups.keys()].map((name) => {
    const g = composeParts(groups.get(name), 'pickup:'+kind+':'+name);
    const alpha = materialAlpha(name);
    return {material: name, opacity: alpha >= 0.5 ? 1 : num(alpha), triangles: g.report.triangles, mesh: g.mesh.toJSON()};
  }).sort((x, y) => y.opacity-x.opacity);
  pickups[kind] = {prefab: P.prefab, parts: r.report.parts.map((p) => p.name+'/'+p.material), size: {width: b.width, height: b.height, depth: b.depth}, beam: glows.beam, halo: glows.halo, layers: layers, mesh: r.mesh.toJSON()};
  lines.push(`${kind} (${P.prefab}): ${r.report.parts.length} parts, ${r.report.triangles} triangles, ${r.report.vertices} vertices, ${b.width.toFixed(1)} x ${b.height.toFixed(1)} x ${b.depth.toFixed(1)} u, y ${b.y.toFixed(2)}..${(b.y+b.height).toFixed(2)}, beam ${glows.beam ? glows.beam.height.toFixed(0)+' u '+glows.beam.color : 'none'}, halo ${glows.halo ? glows.halo.radius.toFixed(0)+' u '+glows.halo.color : 'none'}`);
});

const out = {
  note: 'The meshes of the pickups from the original\'s prefabs (mkpickups.mjs, tools/unitymesh.mjs; notes 12) — the operator\'s decision of 2026-09-16 for the licence preview: shapes and material tints as vertex colours, in the frame of the spawn point (the root of the prefab; the energy\'s falling child at height 0, the game lowers it). The look is playfield.js: every pickup turns about y with the game\'s clock and beats with the music (the original\'s RotateAround and PulsingBlock), `beam` is its ray to the sky and `halo` the glow around it (the quads the mesh leaves out, their material\'s _TintColor; notes 12) — decoration. `layers` is the crystal by material (a solid core or icon, a translucent shell over it — the original\'s alphas), what playfield.js draws; `mesh` is them in one, the fallback.',
  pickups: pickups
};
const outFile = path.join(root, 'data/pickups.json');
fs.writeFileSync(outFile, JSON.stringify(out)+'\n');
console.log(`${path.relative(process.cwd(), outFile)}: ${lines.join('; ')}`);
