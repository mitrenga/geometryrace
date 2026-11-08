/**
 * unitymesh — the meshes of the original's prefabs as svision meshes
 * (the operator's decision of 2026-09-16: the shapes of the original for
 * the licence preview). Reads the AssetRipper export (outside git): a
 * Unity mesh asset — the vertex buffer's positions and normals, the index
 * buffer, the submeshes — and a prefab's MeshFilters with their transform
 * chains and materials, and composes them into one {@link Mesh} in the
 * prefab's frame with every submesh's material tint (`_Color`) on its
 * vertices. Used by mkships.mjs (the `mesh` child of a ship model) and
 * mkpickups.mjs (the parts of a pickup).
 *
 * Nothing here decides what to take: the callers name the prefab and the
 * parts, the data files say why (`model` in the specs).
 *
 * @module tools/unitymesh
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseUnityFile, guidTable, quatRotate, quatMultiply } from './unitylib.mjs';

const { Mesh } = await import('../app/svision/js/platform/scene3D/mesh.js');

/** The float32s of a Unity hex blob (little-endian), `dims` per vertex at `byteOffset` in every `stride` bytes. */
export function hexFloats(hex, byteOffset, count, stride, dims) {
  const buf = Buffer.from(hex, 'hex');
  const out = [];
  for (let i = 0; i < count; i++) {
    for (let d = 0; d < dims; d++) {
      out.push(buf.readFloatLE(i*stride+byteOffset+d*4));
    }
  }
  return out;
} // hexFloats

/** The tint of a material (.mat): `_Color` r, g, b (0–1); white when it has none. */
export function materialTint(file) {
  const m = /_Color: \{r: ([-\d.e]+), g: ([-\d.e]+), b: ([-\d.e]+)/.exec(fs.readFileSync(file, 'utf8'));
  return m ? [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])] : [1, 1, 1];
} // materialTint

/** `{x, y, z, w}` or an array as an array of numbers. */
export const xyz = (o) => (Array.isArray(o) ? o.map(Number) : [o.x, o.y, o.z, o.w].filter((v) => v !== undefined).map(Number));

/**
 * The guid table of the export, once.
 * @param {string} projectDir - The ExportedProject directory.
 * @returns {Map}
 */
const tables = new Map();
export function guids(projectDir) {
  if (!tables.has(projectDir)) {
    tables.set(projectDir, guidTable(projectDir));
  }
  return tables.get(projectDir);
} // guids

/**
 * A Unity mesh asset: its vertices (in its own frame) and the triangles
 * of every submesh (absolute vertex indices, Unity's winding).
 * @param {Map} table - guids().
 * @param {string} guid - The mesh's guid.
 * @returns {{name: string, vertexCount: number, positions: number[][], normals: number[][], subMeshes: number[][]}}
 */
export function readMesh(table, guid) {
  const ref = table.get(guid);
  if (!ref || ref.kind != 'mesh') {
    throw new Error('unitymesh: mesh '+guid+' not in the export');
  }
  const md = parseUnityFile(ref.file).find((d) => d.type == 'Mesh').data;
  const vd = md.m_VertexData;
  const count = Number(vd.m_VertexCount), stride = Number(vd.m_DataSize)/count;
  const ch = vd.m_Channels;
  const P = hexFloats(vd._typelessdata, Number(ch[0].offset), count, stride, 3);
  const N = hexFloats(vd._typelessdata, Number(ch[1].offset), count, stride, 3);
  // a short index buffer reads as a number (the YAML parser's scalar): the hex is in the file
  const ibHex = typeof md.m_IndexBuffer == 'string' ? md.m_IndexBuffer : (/m_IndexBuffer: ([0-9a-f]+)/.exec(fs.readFileSync(ref.file, 'utf8')) || [])[1] || '';
  const ib = Buffer.from(ibHex, 'hex');
  // the first texture coordinates (channel 3): what a gradient texture is sampled by
  const uvCh = ch[3] && Number(ch[3].dimension) == 2 ? ch[3] : null;
  const T = uvCh ? hexFloats(vd._typelessdata, Number(uvCh.offset), count, stride, 2) : null;
  const positions = [], normals = [], uvs = T ? [] : null;
  for (let i = 0; i < count; i++) {
    positions.push([P[i*3], P[i*3+1], P[i*3+2]]);
    normals.push([N[i*3], N[i*3+1], N[i*3+2]]);
    if (T) {
      uvs.push([T[i*2], T[i*2+1]]);
    }
  }
  const subMeshes = md.m_SubMeshes.map((sub) => {
    const first = Number(sub.firstByte)/2, n = Number(sub.indexCount), out = [];
    for (let t = 0; t < n; t++) {
      out.push(ib.readUInt16LE((first+t)*2));
    }
    return out;
  });
  return {name: ref.name, vertexCount: count, positions: positions, normals: normals, uvs: uvs, subMeshes: subMeshes};
} // readMesh

/**
 * A mesh by name as an obstacle's geometry for assets/worlds/<id>.json:
 * in its own frame (the shape's offset places it), vertices deduplicated
 * within a submesh, every triangle wound to agree with its normals, and
 * per vertex the submesh index (`sub`, which material of the renderer)
 * and the texture's v (`v`, where on the gradient) — the colours come
 * from the materials at load time (Playfield.obstacleMesh).
 * @param {Map} table - guids().
 * @param {string} name - The mesh's name in the export.
 * @returns {{id: string, positions: number[], normals: number[], indices: number[], sub: number[], v: number[], subMeshes: number}}
 */
export function obstacleGeometry(table, name) {
  let guid = null;
  for (const [g, r] of table) {
    if (r.kind == 'mesh' && r.name == name) {
      guid = g;
      break;
    }
  }
  if (guid === null) {
    throw new Error('unitymesh: mesh '+name+' not in the export');
  }
  const m = readMesh(table, guid);
  const positions = [], normals = [], indices = [], sub = [], v = [];
  m.subMeshes.forEach((tris, si) => {
    const map = new Map();
    const vertex = (i) => {
      if (!map.has(i)) {
        map.set(i, positions.length/3);
        positions.push(Mesh.num(m.positions[i][0]), Mesh.num(m.positions[i][1]), Mesh.num(m.positions[i][2]));
        normals.push(Mesh.num(m.normals[i][0]), Mesh.num(m.normals[i][1]), Mesh.num(m.normals[i][2]));
        sub.push(si);
        v.push(m.uvs ? Math.round(Math.max(0, Math.min(1, m.uvs[i][1]))*1000)/1000 : 0.5);
      }
      return map.get(i);
    };
    for (let t = 0; t+2 < tris.length; t += 3) {
      let a = tris[t], b = tris[t+1], c = tris[t+2];
      const fn = faceNormal(m.positions[a], m.positions[b], m.positions[c]);
      const nn = [0, 1, 2].map((k) => m.normals[a][k]+m.normals[b][k]+m.normals[c][k]);
      if (fn[0]*nn[0]+fn[1]*nn[1]+fn[2]*nn[2] < 0) {
        const x = b; b = c; c = x;
      }
      indices.push(vertex(a), vertex(b), vertex(c));
    }
  });
  return {id: 'ob:'+name, positions: positions, normals: normals, indices: indices, sub: sub, v: v, subMeshes: m.subMeshes.length};
} // obstacleGeometry

/**
 * The parts of a prefab: every MeshFilter with its mesh, its materials'
 * tints and the chain of transforms from it up to (not including) the
 * prefab's root — the root is where the game puts the object.
 * @param {Map} table - guids().
 * @param {string} prefabFile
 * @param {Object} [options] - `root`: the name of the object to take the parts under (the whole prefab otherwise); `skip`: names of objects left out; `ignorePosition`: names of objects whose position is left out of the chain (an animated child).
 * @returns {Object[]} `[{name, mesh, tints, chain: [{q, pos, scale}] leaf first}]`
 */
export function prefabParts(table, prefabFile, options) {
  options = options || {};
  const docs = parseUnityFile(prefabFile);
  const byId = new Map(docs.map((d) => [String(d.fileID), d]));
  const nameOf = (goId) => { const go = byId.get(String(goId)); return go ? go.data.m_Name : '?'; };
  const transforms = docs.filter((d) => d.type == 'Transform');
  const transformOf = (goId) => transforms.find((t) => String(t.data.m_GameObject.fileID) == String(goId));
  const skip = new Set(options.skip || []);
  const ignore = new Set(options.ignorePosition || []);
  const parts = [];
  docs.filter((d) => d.type == 'MeshFilter').forEach((mf) => {
    const goId = mf.data.m_GameObject.fileID;
    const name = nameOf(goId);
    if (skip.has(name) || !mf.data.m_Mesh || !mf.data.m_Mesh.guid) {
      return;
    }
    // the chain up to the root, and whether it passes through `root`
    const chain = [];
    let t = transformOf(goId), under = !options.root;
    while (t && Number(t.data.m_Father.fileID) !== 0) {
      const n = nameOf(t.data.m_GameObject.fileID);
      if (n == options.root) {
        under = true;
      }
      chain.push({name: n, q: xyz(t.data.m_LocalRotation), pos: ignore.has(n) ? [0, 0, 0] : xyz(t.data.m_LocalPosition), scale: xyz(t.data.m_LocalScale)});
      t = byId.get(String(t.data.m_Father.fileID));
    }
    if (!under) {
      return;
    }
    const renderer = docs.find((d) => d.type == 'MeshRenderer' && String(d.data.m_GameObject.fileID) == String(goId));
    const tints = ((renderer && renderer.data.m_Materials) || []).map((m) => {
      const ref = m.guid ? table.get(m.guid) : null;
      return ref ? {name: ref.name, tint: materialTint(ref.file)} : {name: '?', tint: [1, 1, 1]};
    });
    parts.push({name: name, mesh: readMesh(table, mf.data.m_Mesh.guid), tints: tints, chain: chain});
  });
  return parts;
} // prefabParts

/** A point through a chain of transforms, leaf first: scaled, turned, moved by each. */
function through(chain, v) {
  let p = v;
  for (const t of chain) {
    p = quatRotate(t.q, [p[0]*t.scale[0], p[1]*t.scale[1], p[2]*t.scale[2]]);
    p = [p[0]+t.pos[0], p[1]+t.pos[1], p[2]+t.pos[2]];
  }
  return p;
} // through

/** A direction through a chain: turned only. */
function turned(chain, n) {
  let d = n;
  for (const t of chain) {
    d = quatRotate(t.q, d);
  }
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  return [d[0]/l, d[1]/l, d[2]/l];
} // turned

function faceNormal(a, b, c) {
  const u = [b[0]-a[0], b[1]-a[1], b[2]-a[2]], v = [c[0]-a[0], c[1]-a[1], c[2]-a[2]];
  const n = [u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]];
  const l = Math.hypot(n[0], n[1], n[2]) || 1;
  return [n[0]/l, n[1]/l, n[2]/l];
} // faceNormal

/**
 * The parts composed into one mesh in the prefab's frame: every submesh's
 * material tint on its vertices (deduplicated within a submesh), every
 * triangle wound to agree with its vertex normals.
 * @param {Object[]} parts - prefabParts().
 * @param {string} id - The mesh id.
 * @returns {{mesh: Mesh, report: Object}}
 */
export function composeParts(parts, id) {
  const positions = [], normals = [], colors = [], indices = [];
  const report = {parts: [], triangles: 0, vertices: 0};
  parts.forEach((part) => {
    const world = part.mesh.positions.map((p) => through(part.chain, p));
    const dirs = part.mesh.normals.map((n) => turned(part.chain, n));
    part.mesh.subMeshes.forEach((sub, si) => {
      const tint = (part.tints[si] || part.tints[0] || {tint: [1, 1, 1]}).tint;
      const map = new Map();
      const vertex = (i) => {
        if (!map.has(i)) {
          map.set(i, positions.length/3);
          positions.push(world[i][0], world[i][1], world[i][2]);
          normals.push(dirs[i][0], dirs[i][1], dirs[i][2]);
          colors.push(tint[0], tint[1], tint[2]);
        }
        return map.get(i);
      };
      let tris = 0;
      for (let t = 0; t+2 < sub.length; t += 3) {
        let a = sub[t], b = sub[t+1], c = sub[t+2];
        const fn = faceNormal(world[a], world[b], world[c]);
        const nn = [dirs[a][0]+dirs[b][0]+dirs[c][0], dirs[a][1]+dirs[b][1]+dirs[c][1], dirs[a][2]+dirs[b][2]+dirs[c][2]];
        if (fn[0]*nn[0]+fn[1]*nn[1]+fn[2]*nn[2] < 0) {
          const x = b; b = c; c = x;
        }
        indices.push(vertex(a), vertex(b), vertex(c));
        tris++;
      }
      report.parts.push({name: part.name, mesh: part.mesh.name, material: (part.tints[si] || {name: '?'}).name, tint: tint, triangles: tris});
      report.triangles += tris;
    });
  });
  report.vertices = positions.length/3;
  return {mesh: new Mesh(positions, normals, indices, {id: id, colors: colors}), report: report};
} // composeParts

/** A tint as a hex colour. */
export function hex(t) {
  return '#'+t.map((v) => Math.round(Math.max(0, Math.min(1, v))*255).toString(16).padStart(2, '0')).join('');
} // hex

export { quatMultiply, path };
