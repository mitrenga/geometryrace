#!/usr/bin/env node
/**
 * unity2params — the parameters of the original as serialized in the
 * AssetRipper export (scene, prefabs, project settings) and the packaged
 * Google Tag Manager container, into sources/extract/json/params.json —
 * the reference the match tools (GR-M5+) and the notes' numbers rest on.
 * The spec (unity2params.spec.json) says what to read: an object of the
 * scene with the scripts and components on it, a set of prefabs by name,
 * a settings file, a document type, the GTM container. This only reads;
 * nothing is typed in by hand, and nothing of it goes into data/ — the
 * game's own content is data/*.json (checkdata.mjs keeps them apart).
 *
 * The output is deterministic for the same export: the spec file's
 * `output` is rewritten and its SHA-256 printed (the number goes to
 * decompile_notes.md chap. 22).
 *
 * usage: node tools/unity2params.mjs [tools/unity2params.spec.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseUnityFile, guidTable, UnityGraph, plainField, hexInts, num, vec, writeJSON } from './unitylib.mjs';

const specFile = process.argv[2] || path.join(path.dirname(new URL(import.meta.url).pathname), 'unity2params.spec.json');
const specDir = path.dirname(path.resolve(specFile));
const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
const project = path.resolve(specDir, spec.project);

const guids = guidTable(project);
const graphs = new Map();
const graphOf = (file) => {
  const full = file == 'scene' ? path.join(project, spec.scene) : path.join(project, file);
  if (!graphs.has(full)) {
    graphs.set(full, new UnityGraph(full, guids));
  }
  return graphs.get(full);
};

/** The plain fields of a document's data: all but Unity's own, or the ones listed. */
function fields(graph, doc, wanted, decode, strip) {
  const out = {};
  const keys = Array.isArray(wanted) ? wanted : Object.keys(doc.data).filter((k) => !k.startsWith('m_') && k != 'serializedVersion');
  for (const key of keys) {
    if (!(key in doc.data)) {
      out[key] = null;
      continue;
    }
    let v = doc.data[key];
    if (decode && decode[key] == 'hexInts') {
      v = hexInts(v);
    } else {
      v = plainField(graph, v, key);
    }
    if (strip && v && typeof v == 'object') {
      v = stripKeys(v, strip);
    }
    out[key] = v;
  }
  return out;
} // fields

function stripKeys(v, strip) {
  if (Array.isArray(v)) {
    return v.map((e) => stripKeys(e, strip));
  }
  if (v && typeof v == 'object') {
    const out = {};
    for (const k of Object.keys(v)) {
      if (!strip.includes(k)) {
        out[k] = stripKeys(v[k], strip);
      }
    }
    return out;
  }
  return v;
} // stripKeys

/** A game object as the spec asks: its transform, the scripts, the components. */
function objectEntry(graph, goId, entry) {
  const out = {path: graph.pathOf(goId), active: graph.isActive(goId), tag: graph.tagOf(goId)};
  if (entry.transform) {
    out.transform = graph.localTransform(goId);
    out.transform.position = out.transform.position.map(num);
    out.transform.rotation = out.transform.rotation.map(num);
    out.transform.scale = out.transform.scale.map(num);
  }
  if (entry.scripts) {
    out.scripts = {};
    for (const b of graph.behaviours(goId)) {
      if (entry.scripts == '*' || entry.scripts.includes(b.script)) {
        const f = fields(graph, b.doc, entry.fields, entry.decode, entry.strip);
        out.scripts[b.script] = out.scripts[b.script] ? [].concat(out.scripts[b.script], [f]) : f;
      }
    }
    for (const s of entry.scripts == '*' ? [] : entry.scripts) {
      if (!(s in out.scripts)) {
        out.scripts[s] = null;   // asked for, not on the object
      }
    }
  }
  if (entry.components) {
    out.components = {};
    for (const c of graph.components(goId)) {
      if (entry.components.includes(c.type)) {
        const f = {};
        for (const k of Object.keys(c.data)) {
          if (k == 'm_GameObject' || k == 'm_ObjectHideFlags' || k == 'm_PrefabParentObject' || k == 'm_PrefabInternal' || k == 'serializedVersion' || k == 'm_Material') {
            continue;
          }
          f[k] = plainField(graph, c.data[k], k);
        }
        out.components[c.type] = f;
      }
    }
  }
  return out;
} // objectEntry

/** The meshes referenced by the MeshFilters of a prefab: name, vertex count, extents. */
function meshInfo(graph) {
  const out = [];
  for (const d of graph.docs) {
    if (d.type != 'MeshFilter' || !d.data.m_Mesh || !d.data.m_Mesh.guid) {
      continue;
    }
    const g = guids.get(d.data.m_Mesh.guid);
    const info = {object: graph.pathOf(d.data.m_GameObject.fileID), mesh: g ? g.name : d.data.m_Mesh.guid};
    if (g && g.kind == 'mesh' && fs.existsSync(g.file)) {
      const md = parseUnityFile(g.file).find((x) => x.type == 'Mesh');
      if (md) {
        info.vertexCount = Number(md.data.m_VertexData && md.data.m_VertexData.m_VertexCount);
        info.subMeshes = Array.isArray(md.data.m_SubMeshes) ? md.data.m_SubMeshes.length : 0;
        info.indexCount = Array.isArray(md.data.m_SubMeshes) ? md.data.m_SubMeshes.reduce((n, s) => n+Number(s.indexCount), 0) : 0;
        if (md.data.m_LocalAABB) {
          info.center = vec(md.data.m_LocalAABB.m_Center);
          info.extent = vec(md.data.m_LocalAABB.m_Extent);
        }
      }
    }
    out.push(info);
  }
  return out;
} // meshInfo

const out = {note: spec.note, source: {project: path.relative(specDir, project), scene: spec.scene}, params: {}};
let count = 0;

for (const entry of spec.entries) {
  let result;
  switch (entry.kind) {
    case 'text':
      result = fs.readFileSync(path.join(project, entry.file), 'utf8').trim();
      break;
    case 'settings': {
      const docs = parseUnityFile(path.join(project, entry.file));
      result = {};
      for (const doc of docs) {
        for (const key of entry.fields) {
          if (key in doc.data) {
            let v = plainField(null, doc.data[key], key, true);
            const only = entry.only && entry.only[key];
            if (only && Array.isArray(v)) {
              v = v.filter((e) => Object.keys(only).every((k) => only[k].includes(e[k])));
            }
            result[key] = v;
          }
        }
      }
      break;
    }
    case 'document': {
      const graph = graphOf(entry.file);
      const doc = graph.docs.find((d) => d.type == entry.type);
      result = doc ? fields(graph, doc, entry.fields) : null;
      break;
    }
    case 'object': {
      const graph = graphOf(entry.file);
      const go = graph.find(entry.object);
      result = go === undefined ? null : objectEntry(graph, go, entry);
      break;
    }
    case 'objects': {
      const graph = graphOf(entry.file);
      result = entry.objects.map((p) => {
        const go = graph.find(p);
        return go === undefined ? {path: p, missing: true} : objectEntry(graph, go, entry);
      });
      break;
    }
    case 'prefabs': {
      const re = new RegExp(entry.glob);
      const names = [...guids.values()].filter((g) => g.kind == 'prefab' && re.test(g.name)).map((g) => g.name).sort();
      result = {};
      for (const name of names) {
        const graph = graphOf('Assets/GameObject/'+name+'.prefab');
        const root = graph.roots()[0];
        const r = {};
        if (entry.scripts) {
          r.scripts = {};
          for (const go of graph.gameObjects()) {
            for (const b of graph.behaviours(go)) {
              if (entry.scripts.includes(b.script)) {
                const f = fields(graph, b.doc, entry.fields, entry.decode, entry.strip);
                f['@object'] = graph.pathOf(go);
                r.scripts[b.script] = r.scripts[b.script] ? [].concat(r.scripts[b.script], [f]) : f;
              }
            }
          }
        }
        if (entry.components) {
          r.components = [];
          for (const go of graph.gameObjects()) {
            for (const c of graph.components(go)) {
              if (entry.components.includes(c.type)) {
                const f = {'@object': graph.pathOf(go), type: c.type};
                for (const k of Object.keys(c.data)) {
                  if (!['m_GameObject', 'm_ObjectHideFlags', 'm_PrefabParentObject', 'm_PrefabInternal', 'serializedVersion', 'm_Material'].includes(k)) {
                    f[k] = plainField(graph, c.data[k], k);
                  }
                }
                r.components.push(f);
              }
            }
          }
        }
        if (entry.meshes) {
          r.meshes = meshInfo(graph);
        }
        r.root = graph.localTransform(root);
        result[name] = r;
      }
      break;
    }
    case 'gtm': {
      const json = JSON.parse(fs.readFileSync(path.join(project, entry.file), 'utf8'));
      const cv = json.containerVersion;
      result = {container: cv.container.publicId, version: cv.containerVersionId, exportTime: json.exportTime, constants: {}, defaults: {}, experiments: {}};
      for (const v of cv.variable || []) {
        const p = {};
        for (const par of v.parameter || []) {
          p[par.key] = par.value !== undefined ? par.value : par;
        }
        if (v.type == 'c') {
          const s = String(p.value);
          result.constants[v.name] = /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : s;
        } else if (v.type == 'vc' && p.collection) {
          // a JS-ish object literal with single quotes and trailing commas
          const text = String(p.collection).replace(/'/g, '"').replace(/,\s*}/g, '}');
          try {
            const coll = JSON.parse(text);
            for (const k of Object.keys(coll)) {
              const s = String(coll[k]);
              result.defaults[k] = /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : s;
            }
          } catch (e) {
            result.defaults[v.name] = String(p.collection);
          }
        } else if (v.type == 'gae') {
          result.experiments[v.name] = {variations: p.variations || null, trafficCoverage: p.trafficCoverage};
        }
      }
      break;
    }
    default:
      throw new Error('unknown kind '+entry.kind);
  }
  out.params[entry.id] = {note: entry.note, value: result};
  count++;
}

const outFile = path.resolve(specDir, spec.output);
const hash = writeJSON(outFile, out);
console.log(`${path.relative(process.cwd(), outFile)}: ${count} entries, sha256 ${hash}`);
