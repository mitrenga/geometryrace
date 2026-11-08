/**
 * unitylib — reads the Unity YAML that AssetRipper exports (scenes,
 * prefabs, meshes, project settings) into plain objects, and walks the
 * object graph: game objects by path, transforms up to the root, the
 * script a MonoBehaviour is an instance of (by the guid of its .cs.meta),
 * the prefab or mesh a reference points to, animation curves as key
 * arrays. Shared by unity2params.mjs and unity2sections.mjs (GR-M4); it
 * reads sources/extract/ only — nothing here goes into data/.
 *
 * The parser covers what Unity writes and nothing more: block mappings,
 * sequences (Unity puts `- ` items at the indent of their key), flow
 * mappings `{x: 1, y: 2}` and flow sequences `[]`, quoted and plain
 * scalars, documents headed `--- !u!<class> &<fileID>`.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ---------------------------------------------------------------- scalars

const NUMBER = /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

/**
 * A plain scalar: a number where it reads as one (not a guid, not a hex
 * blob — those are long), a string otherwise, quotes removed.
 * @param {string} s
 * @param {string} [key]
 * @returns {*}
 */
export function scalar(s, key) {
  s = s.trim();
  if (s === '') {
    return '';
  }
  if ((s[0] == "'" && s.endsWith("'")) || (s[0] == '"' && s.endsWith('"'))) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (key == 'fileID') {
    return Number(s);
  }
  if (key == 'guid' || s.length > 24 || (s.length >= 16 && /^[0-9a-f]+$/.test(s))) {
    return s;      // a guid, a hex blob (Unity's int[] and byte[]), not a number
  }
  if (NUMBER.test(s)) {
    return Number(s);
  }
  return s;
} // scalar

/**
 * A flow collection: `{a: 1, b: {c: 2}}` or `[1, 2]`.
 * @param {string} s
 * @returns {*}
 */
export function flow(s) {
  let i = 0;
  const peek = () => s[i];
  const skip = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const readScalar = (stops) => {
    let start = i;
    if (s[i] == "'" || s[i] == '"') {
      const q = s[i++];
      while (i < s.length && s[i] != q) i++;
      i++;
      return s.slice(start, i);
    }
    while (i < s.length && !stops.includes(s[i])) i++;
    return s.slice(start, i);
  };
  const value = (stops) => {
    skip();
    if (peek() == '{') {
      i++;
      const obj = {};
      skip();
      while (peek() != '}') {
        skip();
        const key = readScalar([':']).trim();
        i++;   // ':'
        obj[key] = scalar(value([',', '}']), key);
        skip();
        if (peek() == ',') i++;
        skip();
      }
      i++;
      return obj;
    }
    if (peek() == '[') {
      i++;
      const arr = [];
      skip();
      while (peek() != ']') {
        arr.push(scalar(value([',', ']'])));
        skip();
        if (peek() == ',') i++;
        skip();
      }
      i++;
      return arr;
    }
    return readScalar(stops);
  };
  const v = value([]);
  return typeof v == 'string' ? scalar(v) : v;
} // flow

/**
 * A value on the right of `key: ` — a flow collection or a scalar.
 */
function inlineValue(s, key) {
  const t = s.trim();
  if (t[0] == '{' || t[0] == '[') {
    return flow(t);
  }
  return scalar(t, key);
} // inlineValue

// ------------------------------------------------------------------ parser

/**
 * The lines of a document split into `{indent, text}`; blank lines dropped.
 */
function tokenize(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') {
      continue;
    }
    let indent = 0;
    while (raw[indent] == ' ') indent++;
    out.push({indent: indent, text: raw.slice(indent)});
  }
  return out;
} // tokenize

/**
 * Parses a block node starting at line `i` with the given indent; returns
 * `{value, next}`. `firstText` overrides the text of the first line (the
 * rest of a `- ` item that opens a mapping).
 */
function parseNode(lines, i, indent, firstText) {
  const line = lines[i];
  const text = firstText !== undefined ? firstText : line.text;
  if (text.startsWith('- ') || text === '-') {
    return parseSequence(lines, i, indent, firstText);
  }
  return parseMapping(lines, i, indent, firstText);
} // parseNode

function parseMapping(lines, i, indent, firstText) {
  const obj = {};
  let first = true;
  while (i < lines.length) {
    const line = lines[i];
    const text = first && firstText !== undefined ? firstText : line.text;
    if (!first && line.indent != indent) {
      break;
    }
    if (!first && (text.startsWith('- ') || text === '-')) {
      break;
    }
    first = false;
    const m = /^([^:]+?):(?:\s(.*))?$/.exec(text);
    if (!m) {
      // a stray line — keep it readable
      obj['#'+i] = text;
      i++;
      continue;
    }
    const key = m[1].trim();
    const rest = m[2] === undefined ? '' : m[2];
    if (rest.trim() !== '') {
      obj[key] = inlineValue(rest, key);
      i++;
      continue;
    }
    // empty value: a nested block at a deeper indent, a sequence at the same
    // indent, or nothing
    const next = lines[i+1];
    if (next && next.indent > indent) {
      const r = parseNode(lines, i+1, next.indent);
      obj[key] = r.value;
      i = r.next;
    } else if (next && next.indent == indent && (next.text.startsWith('- ') || next.text === '-')) {
      const r = parseSequence(lines, i+1, indent);
      obj[key] = r.value;
      i = r.next;
    } else {
      obj[key] = '';
      i++;
    }
  }
  return {value: obj, next: i};
} // parseMapping

function parseSequence(lines, i, indent, firstText) {
  const arr = [];
  let first = true;
  while (i < lines.length) {
    const line = lines[i];
    const text = first && firstText !== undefined ? firstText : line.text;
    if (line.indent != indent || !(text.startsWith('- ') || text === '-')) {
      break;
    }
    first = false;
    const item = text === '-' ? '' : text.slice(2);
    if (item.trim() === '') {
      const next = lines[i+1];
      if (next && next.indent > indent) {
        const r = parseNode(lines, i+1, next.indent);
        arr.push(r.value);
        i = r.next;
      } else {
        arr.push('');
        i++;
      }
      continue;
    }
    if (/^[^:{\[]+?:(\s|$)/.test(item)) {
      // the item opens a mapping whose other keys sit at indent + 2
      const r = parseMapping(lines, i, indent+2, item);
      arr.push(r.value);
      i = r.next;
      continue;
    }
    arr.push(inlineValue(item));
    i++;
  }
  return {value: arr, next: i};
} // parseSequence

/**
 * A Unity YAML file as documents: `[{fileID, classID, type, data}]`,
 * `type` the class name (GameObject, Transform, MonoBehaviour, ...).
 * @param {string} file
 * @returns {Object[]}
 */
export function parseUnityFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const docs = [];
  const parts = text.split(/^--- /m);
  for (let p = 1; p < parts.length; p++) {
    const part = parts[p];
    const nl = part.indexOf('\n');
    const head = part.slice(0, nl);
    const hm = /^!u!(\d+) &(-?\d+)/.exec(head);
    if (!hm) {
      continue;
    }
    const lines = tokenize(part.slice(nl+1));
    if (!lines.length) {
      continue;
    }
    const type = lines[0].text.replace(/:$/, '');
    const r = lines.length > 1 ? parseNode(lines, 1, lines[1].indent) : {value: {}};
    docs.push({fileID: Number(hm[2]), classID: Number(hm[1]), type: type, data: r.value});
  }
  return docs;
} // parseUnityFile

// -------------------------------------------------------------------- guids

/**
 * The guid tables of an exported project: guid -> `{kind, name}` for the
 * scripts (Assets/Scripts/**\/*.cs.meta), prefabs (Assets/GameObject) and
 * meshes (Assets/Mesh).
 * @param {string} projectDir - .../ExportedProject
 * @returns {Map}
 */
export function guidTable(projectDir) {
  const table = new Map();
  const add = (dir, kind, strip) => {
    if (!fs.existsSync(dir)) {
      return;
    }
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        add(full, kind, strip);
      } else if (entry.name.endsWith(strip+'.meta')) {
        const m = /^guid: ([0-9a-f]{32})/m.exec(fs.readFileSync(full, 'utf8'));
        if (m) {
          table.set(m[1], {kind: kind, name: entry.name.slice(0, -(strip.length+5)), file: full.slice(0, -5)});
        }
      }
    }
  };
  add(path.join(projectDir, 'Assets/Scripts'), 'script', '.cs');
  add(path.join(projectDir, 'Assets/GameObject'), 'prefab', '.prefab');
  add(path.join(projectDir, 'Assets/Mesh'), 'mesh', '.asset');
  add(path.join(projectDir, 'Assets/Material'), 'material', '.mat');
  add(path.join(projectDir, 'Assets/Texture2D'), 'texture', '.png');
  return table;
} // guidTable

// -------------------------------------------------------------------- graph

/**
 * The object graph of one file: documents by fileID, game objects with
 * their transforms and components, paths, and a way from a MonoBehaviour
 * to its script name.
 */
export class UnityGraph {

  /**
   * @param {string} file - A .unity or .prefab file.
   * @param {Map} guids - guidTable().
   */
  constructor(file, guids) {
    this.file = file;
    this.guids = guids;
    this.docs = parseUnityFile(file);
    this.byId = new Map();
    for (const d of this.docs) {
      this.byId.set(d.fileID, d);
    }
    // transform of a game object, game object of a transform
    this.transformOf = new Map();
    this.gameObjectOf = new Map();
    for (const d of this.docs) {
      if (d.type == 'Transform' || d.type == 'RectTransform') {
        const go = d.data.m_GameObject && d.data.m_GameObject.fileID;
        this.transformOf.set(go, d);
        this.gameObjectOf.set(d.fileID, go);
      }
    }
  } // constructor

  /** @returns {Object} The document of a fileID, or undefined. */
  get(id) {
    return this.byId.get(id);
  } // get

  /** The name of the script a MonoBehaviour document is an instance of ('?' if unknown). */
  scriptName(doc) {
    const ref = doc.data.m_Script;
    const g = ref && this.guids.get(ref.guid);
    return g ? g.name : '?';
  } // scriptName

  /** What a `{fileID, guid}` reference points to: `prefab:Name`, `mesh:Name`, `script:Name`, or the fileID. */
  refName(ref) {
    if (!ref || typeof ref != 'object') {
      return ref;
    }
    if (ref.guid) {
      const g = this.guids.get(ref.guid);
      return g ? g.kind+':'+g.name : 'guid:'+ref.guid;
    }
    if (ref.fileID === 0) {
      return null;
    }
    const d = this.byId.get(ref.fileID);
    if (d && d.type == 'GameObject') {
      return 'object:'+this.pathOf(d.fileID);
    }
    if (d && (d.type == 'Transform' || d.type == 'RectTransform')) {
      return 'object:'+this.pathOf(this.gameObjectOf.get(d.fileID));
    }
    if (d && d.type == 'MonoBehaviour') {
      return 'script:'+this.scriptName(d)+'@'+this.pathOf(d.data.m_GameObject && d.data.m_GameObject.fileID);
    }
    if (d) {
      return d.type.toLowerCase()+'@'+this.pathOf(d.data.m_GameObject && d.data.m_GameObject.fileID);
    }
    return 'id:'+ref.fileID;
  } // refName

  /** The components of a game object (documents), in order. */
  components(goId) {
    const go = this.byId.get(goId);
    if (!go || !Array.isArray(go.data.m_Component)) {
      return [];
    }
    return go.data.m_Component.map((c) => this.byId.get(c.component.fileID)).filter((d) => d);
  } // components

  /** The MonoBehaviours of a game object with their script names: `[{script, doc}]`. */
  behaviours(goId) {
    return this.components(goId).filter((d) => d.type == 'MonoBehaviour').map((d) => ({script: this.scriptName(d), doc: d}));
  } // behaviours

  /** The parent game object of a game object (null at a root). */
  parentOf(goId) {
    const t = this.transformOf.get(goId);
    if (!t || !t.data.m_Father || t.data.m_Father.fileID === 0) {
      return null;
    }
    return this.gameObjectOf.get(t.data.m_Father.fileID);
  } // parentOf

  /** The children game objects of a game object, in hierarchy order. */
  childrenOf(goId) {
    const t = this.transformOf.get(goId);
    if (!t || !Array.isArray(t.data.m_Children)) {
      return [];
    }
    return t.data.m_Children.map((c) => this.gameObjectOf.get(c.fileID)).filter((id) => id !== undefined);
  } // childrenOf

  /** The name of a game object. */
  nameOf(goId) {
    const go = this.byId.get(goId);
    return go ? String(go.data.m_Name) : '?';
  } // nameOf

  /** The path of a game object: names from the root, '/' separated. */
  pathOf(goId) {
    const names = [];
    let id = goId, guard = 0;
    while (id !== null && id !== undefined && guard++ < 64) {
      names.unshift(this.nameOf(id));
      id = this.parentOf(id);
    }
    return names.join('/');
  } // pathOf

  /** The root game objects, in hierarchy order (by m_RootOrder). */
  roots() {
    const roots = [];
    for (const d of this.docs) {
      if ((d.type == 'Transform' || d.type == 'RectTransform') && (!d.data.m_Father || d.data.m_Father.fileID === 0)) {
        roots.push({order: Number(d.data.m_RootOrder) || 0, go: this.gameObjectOf.get(d.fileID)});
      }
    }
    roots.sort((a, b) => a.order-b.order);
    return roots.map((r) => r.go);
  } // roots

  /** The game object of a path (`A/B/C`), or undefined. Among the roots, the first active one wins. */
  find(pathString) {
    const parts = pathString.split('/');
    let candidates = this.roots();
    let found;
    for (const part of parts) {
      found = undefined;
      for (const id of candidates) {
        if (this.nameOf(id) == part && (found === undefined || (!this.isActive(found) && this.isActive(id)))) {
          found = id;
        }
      }
      if (found === undefined) {
        return undefined;
      }
      candidates = this.childrenOf(found);
    }
    return found;
  } // find

  /** All game objects (fileIDs). */
  gameObjects() {
    return this.docs.filter((d) => d.type == 'GameObject').map((d) => d.fileID);
  } // gameObjects

  isActive(goId) {
    const go = this.byId.get(goId);
    return !!go && Number(go.data.m_IsActive) == 1;
  } // isActive

  tagOf(goId) {
    const go = this.byId.get(goId);
    return go ? String(go.data.m_TagString) : '';
  } // tagOf

  /** The local transform of a game object: `{position, rotation (quaternion), scale}` as arrays. */
  localTransform(goId) {
    const t = this.transformOf.get(goId);
    if (!t) {
      return {position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1]};
    }
    const p = t.data.m_LocalPosition || {}, r = t.data.m_LocalRotation || {}, s = t.data.m_LocalScale || {};
    return {
      position: [Number(p.x) || 0, Number(p.y) || 0, Number(p.z) || 0],
      rotation: [Number(r.x) || 0, Number(r.y) || 0, Number(r.z) || 0, r.w === undefined ? 1 : Number(r.w)],
      scale: [s.x === undefined ? 1 : Number(s.x), s.y === undefined ? 1 : Number(s.y), s.z === undefined ? 1 : Number(s.z)]
    };
  } // localTransform

  /**
   * The transform of a game object in the frame of an ancestor (`stopAt`,
   * a game object whose own transform is not applied; null = the file's
   * root frame): position, rotation as a quaternion, and the accumulated
   * scale (component-wise — the colliders of the original are scaled by
   * their objects' scales along their own axes; no shear is modelled).
   */
  worldTransform(goId, stopAt) {
    const chain = [];
    let id = goId, guard = 0;
    while (id !== null && id !== undefined && id !== stopAt && guard++ < 64) {
      chain.unshift(this.localTransform(id));
      id = this.parentOf(id);
    }
    let position = [0, 0, 0], rotation = [0, 0, 0, 1], scale = [1, 1, 1];
    for (const t of chain) {
      const scaled = [t.position[0]*scale[0], t.position[1]*scale[1], t.position[2]*scale[2]];
      const rotated = quatRotate(rotation, scaled);
      position = [position[0]+rotated[0], position[1]+rotated[1], position[2]+rotated[2]];
      rotation = quatMultiply(rotation, t.rotation);
      scale = [scale[0]*t.scale[0], scale[1]*t.scale[1], scale[2]*t.scale[2]];
    }
    return {position: position, rotation: rotation, scale: scale};
  } // worldTransform

} // UnityGraph

// -------------------------------------------------------------- quaternions

/** q1 * q2 (Unity order: q1 then q2 applied... the product rotates by q2 first, then q1). */
export function quatMultiply(a, b) {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [
    aw*bx+ax*bw+ay*bz-az*by,
    aw*by-ax*bz+ay*bw+az*bx,
    aw*bz+ax*by-ay*bx+az*bw,
    aw*bw-ax*bx-ay*by-az*bz
  ];
} // quatMultiply

/** A vector rotated by a quaternion. */
export function quatRotate(q, v) {
  const [qx, qy, qz, qw] = q;
  const [vx, vy, vz] = v;
  // t = 2 * cross(q.xyz, v); v' = v + qw * t + cross(q.xyz, t)
  const tx = 2*(qy*vz-qz*vy), ty = 2*(qz*vx-qx*vz), tz = 2*(qx*vy-qy*vx);
  return [
    vx+qw*tx+(qy*tz-qz*ty),
    vy+qw*ty+(qz*tx-qx*tz),
    vz+qw*tz+(qx*ty-qy*tx)
  ];
} // quatRotate

/** Unity's Euler angles (degrees, Z-X-Y order as Unity reports them) of a quaternion. */
export function quatToEuler(q) {
  const [x, y, z, w] = q;
  // Unity: rotation = Ry * Rx * Rz (applied z, then x, then y)
  const sinX = 2*(w*x-y*z);
  let ex, ey, ez;
  if (Math.abs(sinX) >= 0.999999) {
    ex = Math.sign(sinX)*Math.PI/2;
    ey = Math.atan2(2*(w*y-x*z), 1-2*(y*y+z*z));   // simplified at the pole
    ez = 0;
  } else {
    ex = Math.asin(sinX);
    ey = Math.atan2(2*(w*y+x*z), 1-2*(x*x+y*y));
    ez = Math.atan2(2*(w*z+x*y), 1-2*(x*x+z*z));
  }
  const deg = (a) => Math.round(a*180/Math.PI*1000)/1000+0;
  return [deg(ex), deg(ey), deg(ez)];
} // quatToEuler

// -------------------------------------------------------------- utilities

/** A Unity AnimationCurve as `[{time, value, inSlope, outSlope}]` (null if not a curve). */
export function curveKeys(curve) {
  if (!curve || !Array.isArray(curve.m_Curve)) {
    return null;
  }
  return curve.m_Curve.map((k) => ({time: Number(k.time), value: Number(k.value), inSlope: Number(k.inSlope), outSlope: Number(k.outSlope)}));
} // curveKeys

/** A hex blob of little-endian int32s (Unity's int[] in YAML) as numbers. */
export function hexInts(s) {
  const out = [];
  s = String(s);
  for (let i = 0; i+8 <= s.length; i += 8) {
    const b = s.slice(i, i+8);
    const v = parseInt(b.slice(6, 8)+b.slice(4, 6)+b.slice(2, 4)+b.slice(0, 2), 16);
    out.push(v > 0x7FFFFFFF ? v-0x100000000 : v);
  }
  return out;
} // hexInts

/** A number rounded to four decimals, -0 made 0. */
export function num(v) {
  return Math.round(Number(v)*10000)/10000+0;
} // num

/** `{x, y, z}` (or `{r, g, b, a}`) as an array of rounded numbers. */
export function vec(o) {
  if (!o || typeof o != 'object') {
    return o;
  }
  if ('r' in o) {
    return [num(o.r), num(o.g), num(o.b), num(o.a)];
  }
  const out = [num(o.x), num(o.y), num(o.z)];
  if ('w' in o) {
    out.push(num(o.w));
  }
  return out;
} // vec

/** Writes JSON with one space of indent and reports its SHA-256. */
export function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const text = JSON.stringify(value, null, 1)+'\n';
  fs.writeFileSync(file, text);
  return crypto.createHash('sha256').update(text).digest('hex');
} // writeJSON

/**
 * A field of a MonoBehaviour's data made plain: references named, curves
 * as keys, vectors as arrays; Unity's own `m_*` keys dropped unless
 * `keepUnity` (the settings files have nothing else).
 */
export function plainField(graph, value, key, keepUnity) {
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => plainField(graph, v, undefined, keepUnity));
  }
  if (typeof value == 'object') {
    if ('fileID' in value) {
      return graph.refName(value);
    }
    if (Array.isArray(value.m_Curve)) {
      return curveKeys(value);
    }
    if ('x' in value || 'r' in value) {
      return vec(value);
    }
    const out = {};
    for (const k of Object.keys(value)) {
      if ((k.startsWith('m_') && !keepUnity) || k == 'serializedVersion') {
        continue;
      }
      out[k] = plainField(graph, value[k], k, keepUnity);
    }
    return out;
  }
  if (typeof value == 'number') {
    return num(value);
  }
  return value;
} // plainField
