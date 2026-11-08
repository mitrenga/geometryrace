#!/usr/bin/env node
/**
 * unity2sections — the track content of the original out of the
 * AssetRipper export into sources/extract/json/sections.json: for each
 * world (an active child of LevelManager/Levels with a LevelInfo) the
 * sections in hierarchy order — the script (ConstantSection,
 * RandomSection, SectionSequence), the Length in rows, the block prefabs
 * — and for each block prefab a world uses: its id and extent
 * (BlockDetails: StartLeft, EndRight), the ObstacleManager, every
 * collider of its obstacles in the frame of the block's root (centre,
 * size, rotation as a quaternion and as Unity's Euler angles, the tag
 * that decides whether it kills — notes 11), the power-up spawn points
 * (notes 12) and the animators with their fields (notes 11: MovingBlock,
 * FallingPillar, Mover, MoverDistanceBased, Rotation..., curves as key
 * arrays). The spec (unity2sections.spec.json) names the scripts.
 *
 * This is the reference matchtrack.mjs (GR-M6) compares the game's
 * generator against; the game itself never reads it. The output is
 * deterministic for the same export; its SHA-256 is printed (notes 22).
 *
 * usage: node tools/unity2sections.mjs [tools/unity2sections.spec.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { guidTable, UnityGraph, plainField, quatRotate, quatToEuler, num, writeJSON } from './unitylib.mjs';
import { decodePNG } from '../app/svision/tools/retro/png.mjs';

const specFile = process.argv[2] || path.join(path.dirname(new URL(import.meta.url).pathname), 'unity2sections.spec.json');
const specDir = path.dirname(path.resolve(specFile));
const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
const project = path.resolve(specDir, spec.project);

const guids = guidTable(project);
const scene = new UnityGraph(path.join(project, spec.scene), guids);

const prefabName = (ref) => {
  const n = scene.refName(ref);
  return typeof n == 'string' && n.startsWith('prefab:') ? n.slice(7) : n;
};

// ------------------------------------------------------------------ worlds

const levels = scene.find(spec.levels);
if (levels === undefined) {
  throw new Error('no '+spec.levels+' in the scene');
}
const worlds = [];
const used = new Set();
for (const level of scene.childrenOf(levels)) {
  if (!scene.isActive(level)) {
    continue;      // the torsos Level0–Level4: GetComponentsInChildren does not see them (notes 8)
  }
  const info = scene.behaviours(level).find((b) => b.script == spec.levelScript);
  if (!info) {
    continue;
  }
  const li = plainField(scene, info.doc.data);
  const world = {
    name: scene.nameOf(level),
    worldID: li.worldID,
    skyboxColor: li.skyboxColor,
    prefabs: (li.prefabsUsedInLevel || []).map((p) => String(p).replace(/^prefab:/, '')),
    sections: []
  };
  world.prefabs.forEach((p) => used.add(p));
  let index = 0;
  for (const child of scene.childrenOf(level)) {
    const sb = scene.behaviours(child).find((b) => spec.sectionScripts.includes(b.script));
    if (!sb) {
      continue;
    }
    const d = sb.doc.data;
    const section = {index: index++, name: scene.nameOf(child), type: sb.script, active: scene.isActive(child), length: Number(d.Length)};
    if (sb.script == 'ConstantSection') {
      section.blocks = [prefabName(d.block)];
      section.isInfinite = Number(d.isInfinite) == 1;
    } else if (sb.script == 'RandomSection') {
      section.blocks = (d.blocks || []).map(prefabName);
      section.randomizeXPosition = Number(d.randomizeXPosition) == 1;
    } else {
      section.blocks = (d.blockSequence || []).map(prefabName);
      section.rowsPerBlock = Number(d.rowsPerBlock);
      section.repeats = Number(d.repeats);
    }
    section.blocks.forEach((p) => used.add(p));
    world.sections.push(section);
  }
  worlds.push(world);
}

// ------------------------------------------------------------------ blocks

/** the names of the materials and meshes used by obstacle renderers, for the `materials` and `meshes` tables of the output */
const usedMaterials = new Set();
const usedMeshes = new Set();

/**
 * The material names of the MeshRenderer of a game object, shadows left
 * out (`shadow*` materials are the original's fake shadow quads).
 * @param {UnityGraph} g
 * @param {string} goId
 * @returns {string[]}
 */
function rendererMaterials(g, goId) {
  const r = g.components(goId).find((d) => d.type == 'MeshRenderer');
  return ((r && r.data.m_Materials) || []).map((m) => (m.guid && guids.get(m.guid) ? guids.get(m.guid).name : null)).filter((n) => n && !/^shadow/i.test(n));
} // rendererMaterials

/** The name of the mesh a game object's MeshFilter draws, null without one. */
function filterMesh(g, goId) {
  const f = g.components(goId).find((d) => d.type == 'MeshFilter');
  const m = f && f.data.m_Mesh && f.data.m_Mesh.guid ? guids.get(f.data.m_Mesh.guid) : null;
  return m ? m.name : null;
} // filterMesh

/**
 * The materials of the renderer drawn with a collider's object: the
 * object's own; else the siblings with a renderer whose names share the
 * longest prefix with the collider's (the original's `X_Parent/X_Collider`
 * + `X_Mesh`, `obstacleRotate02Pink` + `...PinkColliderLeft`; a generic
 * `collider` takes every sibling drawn); else the parent's own (a
 * collider on a child of the mesh); else the first renderer below the
 * object, else below a sibling. In Unity's order: with more materials than submeshes the last
 * submesh is drawn again with every extra material, so the last one shows.
 * @param {UnityGraph} g
 * @param {string} goId
 * @returns {string[]} the game objects drawn with the collider (one, or every part of a compound object)
 */
function renderedOf(g, goId) {
  const has = (id) => rendererMaterials(g, id).length > 0;
  if (has(goId)) {
    return [goId];
  }
  const parent = g.parentOf(goId);
  if (parent !== undefined && parent !== null) {
    // the siblings sharing the longest name prefix — all of them on a tie (`Tunnel03_Collider_big` beside `Tunnel03_Mesh00_big` and `Tunnel03_Mesh01_big`)
    const name = g.nameOf(goId);
    let best = [], bestLen = -1;
    for (const sib of g.childrenOf(parent)) {
      if (sib == goId || /Shadow/i.test(g.nameOf(sib)) || !has(sib)) {
        continue;
      }
      const other = g.nameOf(sib);
      let k = 0;
      while (k < name.length && k < other.length && name[k] == other[k]) {
        k++;
      }
      if (k > bestLen) {
        best = [sib];
        bestLen = k;
      } else if (k == bestLen) {
        best.push(sib);
      }
    }
    if (best.length) {
      return best;
    }
    if (has(parent)) {
      return [parent];
    }
  }
  // every renderer below (a letter of many parts, a tunnel of pieces), shadows left out
  const below = (id, skip, out) => {
    for (const child of g.childrenOf(id)) {
      if (child == skip || /Shadow/i.test(g.nameOf(child))) {
        continue;
      }
      if (has(child)) {
        out.push(child);
      }
      below(child, skip, out);
    }
    return out;
  };
  const own = below(goId, null, []);
  // else the renderers below a sibling (`gyroscopeRings/Ring01Col` + `PIVOT/Ring.01`)
  return own.length || parent === undefined || parent === null ? own : below(parent, goId, []);
} // renderedOf

/**
 * A material as the look of an obstacle: its texture, its tint (`_Color`)
 * and the texture's colours — the mean of its top, middle and bottom rows
 * (0–255): the original's obstacle textures are 32 x 512 vertical
 * gradients, light at the top and dark at the bottom, or 32 x 32 solids
 * (`*solid`); none is a pattern.
 * @param {string} name
 * @returns {Object} `{texture, tint, width, height, top, mid, bottom, solid, ramp}` — `ramp` 17 samples along v (0 = the bottom row, 1 = the top)
 */
function materialOf(name) {
  const ref = [...guids.values()].find((r) => r.kind == 'material' && r.name == name);
  const text = ref ? fs.readFileSync(ref.file, 'utf8') : '';
  const tint = /_Color:\s*\{r: ([-\d.e]+), g: ([-\d.e]+), b: ([-\d.e]+)/.exec(text);
  const tex = /_MainTex:\s*\n\s*m_Texture: \{fileID: \d+, guid: ([0-9a-f]{32})/.exec(text);
  const out = {texture: null, tint: tint ? [num(Number(tint[1])), num(Number(tint[2])), num(Number(tint[3]))] : [1, 1, 1], width: 0, height: 0, top: null, mid: null, bottom: null, solid: null, ramp: null};
  const t = tex && guids.get(tex[1]);
  if (t && t.kind == 'texture' && fs.existsSync(t.file)) {
    out.texture = t.name;
    const png = decodePNG(fs.readFileSync(t.file));
    out.width = png.width;
    out.height = png.height;
    const row = (y) => {
      const sum = [0, 0, 0];
      for (let x = 0; x < png.width; x++) {
        for (let k = 0; k < 3; k++) {
          sum[k] += png.rgba[(y*png.width+x)*4+k];
        }
      }
      return sum.map((v) => Math.round(v/png.width));
    };
    out.top = row(0);
    out.mid = row(Math.floor(png.height/2));
    out.bottom = row(png.height-1);
    out.solid = png.height <= 32;
    // the gradient along the texture's v, 17 samples from v 0 (the bottom row — Unity's v runs up) to v 1 (the top)
    out.ramp = [];
    for (let k = 0; k <= 16; k++) {
      out.ramp.push(row(Math.round((1-k/16)*(png.height-1))));
    }
  }
  return out;
} // materialOf

/** A vector in the block's frame rounded. */
const v = (a) => a.map(num);

function blockOf(name) {
  const file = path.join(project, 'Assets/GameObject', name+'.prefab');
  if (!fs.existsSync(file)) {
    return {missing: true};
  }
  const g = new UnityGraph(file, guids);
  const root = g.roots()[0];
  const block = {name: name, root: g.localTransform(root)};
  block.root.position = v(block.root.position);
  block.root.rotation = v(block.root.rotation);
  block.root.scale = v(block.root.scale);

  // the block's own scripts anywhere in it
  for (const go of g.gameObjects()) {
    for (const b of g.behaviours(go)) {
      if (b.script == 'BlockDetails') {
        const d = b.doc.data;
        block.id = Number(d.id);
        const sl = d.StartLeft && d.StartLeft.fileID ? g.gameObjectOf.get(d.StartLeft.fileID) : undefined;
        const er = d.EndRight && d.EndRight.fileID ? g.gameObjectOf.get(d.EndRight.fileID) : undefined;
        block.startLeft = sl !== undefined ? v(g.worldTransform(sl, root).position) : null;
        block.endRight = er !== undefined ? v(g.worldTransform(er, root).position) : null;
        if (block.startLeft && block.endRight) {
          block.width = num(Math.abs(block.endRight[0]-block.startLeft[0]));
          block.length = num(Math.abs(block.endRight[2]-block.startLeft[2]));
        }
      } else if (b.script == 'ObstacleManager' || b.script == 'ObstacleActivator') {
        block[b.script == 'ObstacleManager' ? 'obstacleManager' : 'obstacleActivator'] = Object.assign(
          {object: g.pathOf(go), children: g.childrenOf(go).length}, plainField(g, b.doc.data));
      }
    }
  }

  // colliders, spawn points, animators, nested prefabs, meshes
  block.colliders = [];
  block.spawnPoints = [];
  block.animators = [];
  block.nested = [];
  const meshes = {};
  let groundPlanes = 0;
  for (const go of g.gameObjects()) {
    const goPath = g.pathOf(go);
    const goDoc = g.get(go);
    if (/^GroundPlane/.test(g.nameOf(go))) {
      groundPlanes++;
    }
    for (const c of g.components(go)) {
      if (c.type == 'MeshFilter' && c.data.m_Mesh && c.data.m_Mesh.guid) {
        const m = guids.get(c.data.m_Mesh.guid);
        const mn = m ? m.name : 'guid:'+c.data.m_Mesh.guid;
        meshes[mn] = (meshes[mn] || 0)+1;
      }
      if (!spec.colliders.includes(c.type)) {
        continue;
      }
      const w = g.worldTransform(go, root);
      const d = c.data;
      const center = d.m_Center ? [Number(d.m_Center.x) || 0, Number(d.m_Center.y) || 0, Number(d.m_Center.z) || 0] : [0, 0, 0];
      const scaledCenter = [center[0]*w.scale[0], center[1]*w.scale[1], center[2]*w.scale[2]];
      const rotated = quatRotate(w.rotation, scaledCenter);
      const rec = {
        object: goPath,
        tag: g.tagOf(go),
        layer: Number(goDoc.data.m_Layer) || 0,
        active: g.isActive(go),
        enabled: Number(d.m_Enabled) == 1,
        trigger: Number(d.m_IsTrigger) == 1,
        type: c.type.replace('Collider', '').toLowerCase(),
        center: v([w.position[0]+rotated[0], w.position[1]+rotated[1], w.position[2]+rotated[2]]),
        rotation: v(w.rotation),
        euler: quatToEuler(w.rotation),
        scale: v(w.scale)
      };
      const as = w.scale.map(Math.abs);
      if (c.type == 'BoxCollider') {
        rec.size = v([Number(d.m_Size.x)*as[0], Number(d.m_Size.y)*as[1], Number(d.m_Size.z)*as[2]]);
      } else if (c.type == 'SphereCollider') {
        rec.radius = num(Number(d.m_Radius)*Math.max(as[0], as[1], as[2]));
      } else if (c.type == 'CapsuleCollider') {
        const dir = Number(d.m_Direction) || 0;   // 0 x, 1 y, 2 z
        const perp = [0, 1, 2].filter((i) => i != dir);
        rec.direction = dir;
        rec.radius = num(Number(d.m_Radius)*Math.max(as[perp[0]], as[perp[1]]));
        rec.height = num(Number(d.m_Height)*as[dir]);
      } else {
        rec.mesh = d.m_Mesh && d.m_Mesh.guid && guids.get(d.m_Mesh.guid) ? guids.get(d.m_Mesh.guid).name : null;
        rec.convex = Number(d.m_Convex) == 1;
      }
      // the materials of the renderer drawn with it (the look of the obstacle, notes 15)
      // what is drawn with the collider: its parts (mesh, materials, where the mesh is in the block's frame — the
      // collider's frame differs: `X_Collider` beside `X_Mesh`; `drawn` tells colliders sharing one renderer apart)
      rec.parts = renderedOf(g, go).filter((id) => filterMesh(g, id)).map((id) => {
        const dw = g.worldTransform(id, root);
        return {mesh: filterMesh(g, id), materials: rendererMaterials(g, id), transform: {position: v(dw.position), rotation: v(dw.rotation), scale: v(dw.scale)}, drawn: String(id)};
      });
      rec.materials = rec.parts.length ? rec.parts[0].materials : [];
      rec.parts.forEach((part) => {
        part.materials.forEach((m) => usedMaterials.add(m));
        usedMeshes.add(part.mesh);
      });
      block.colliders.push(rec);
    }
    for (const b of g.behaviours(go)) {
      if (b.script == spec.spawnScript) {
        const w = g.worldTransform(go, root);
        block.spawnPoints.push({object: goPath, position: v(w.position), energy: Number(b.doc.data.spawnEnergy) == 1});
      } else if (spec.animators.includes(b.script)) {
        const w = g.worldTransform(go, root);
        const parentId = g.parentOf(go);
        block.animators.push({
          script: b.script,
          object: goPath,
          tag: g.tagOf(go),
          enabled: Number(b.doc.data.m_Enabled) == 1,
          position: v(w.position),
          rotation: v(w.rotation),
          euler: quatToEuler(w.rotation),
          scale: v(w.scale),
          children: g.childrenOf(go).length,
          fields: plainField(g, b.doc.data)
        });
        void parentId;
      } else if (b.script == spec.nestedScript) {
        block.nested.push({object: goPath, prefab: g.refName(b.doc.data.originalPrefab)});
      }
    }
  }
  block.groundPlanes = groundPlanes;
  block.meshes = meshes;
  block.gameObjects = g.gameObjects().length;
  return block;
} // blockOf

const blocks = {};
for (const name of [...used].sort()) {
  blocks[name] = blockOf(name);
}

const materials = {};
for (const name of [...usedMaterials].sort()) {
  materials[name] = materialOf(name);
}

const out = {note: spec.note, source: {project: path.relative(specDir, project), scene: spec.scene}, worlds: worlds, blocks: blocks, materials: materials};
const outFile = path.resolve(specDir, spec.output);
const hash = writeJSON(outFile, out);

const totals = Object.values(blocks).reduce((t, b) => {
  t.colliders += (b.colliders || []).length;
  t.spawnPoints += (b.spawnPoints || []).length;
  t.animators += (b.animators || []).length;
  return t;
}, {colliders: 0, spawnPoints: 0, animators: 0});
console.log(`${path.relative(process.cwd(), outFile)}: ${worlds.length} worlds (${worlds.map((w) => w.name+' '+w.sections.length+' sections').join(', ')}), ${Object.keys(blocks).length} blocks, ${totals.colliders} colliders, ${totals.spawnPoints} spawn points, ${totals.animators} animators, ${Object.keys(materials).length} materials, sha256 ${hash}`);
