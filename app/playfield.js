const { Mat4 } = await import('./svision/js/platform/scene3D/mat4.js?ver='+window.srcVersion);
const { Quat } = await import('./svision/js/platform/scene3D/quat.js?ver='+window.srcVersion);
const { Mesh } = await import('./svision/js/platform/scene3D/mesh.js?ver='+window.srcVersion);
// begin code

/**
 * The picture of one frame: from the state the game returns from a tick,
 * the description of a Scene3D — the camera behind the ship, the ground
 * plane with its grid under it, the active blocks and their obstacles, the
 * ship itself — as plain data: `{background, camera, items}` with every
 * mesh named by its id, no Mesh object in it. No DOM, no Scene3D: the same
 * code runs in the worker (which posts the frame to the model), in the game
 * and in the tools (regress). `Playfield.build(scene, frame, meshes)` puts
 * a frame into a Scene3D on the model's side, resolving the ids in the
 * library `meshes` (`Playfield.meshes(data)` — the generators of Mesh and
 * the ships of data/ships.json, each under `ship:<id>`; the colours of the
 * world come from data/worlds.json — GR-M4).
 *
 * Units are the original's (10 u = 1 m, notes 5): the ship at y 6, the
 * camera 4.5 above and 20 behind it, FOV 35° (notes 6a), the horizon at
 * 1000 u (notes 8). The camera is the state's (`state.camera`: position
 * and the pitch, yaw and roll the game eases every tick, notes 6a); a state
 * without one (the menu's rest) gets the camera at its start offset. The
 * world's fog (data/worlds.json, the original's linear 400–1000 u, notes
 * 5) goes into the scene as `fog`. GR-M6: the active blocks of the state
 * as ground tiles with a grid each (a state without blocks — the menu's
 * rest — gets one tile under the ship), the active obstacles as the
 * shapes the track gives (a box, a sphere, a capsule with its look:
 * cube, pillar, wall, gate, sphere), placed by the full transform the
 * animations leave them in, the ship of the state — hidden after an
 * explosion. GR-M7: the pickups of the state (track.js) in the world's
 * pickup colours — a coin is a disc standing on edge, a multiplier a cube
 * on its corner, an energy a can hanging high that comes down as the ship
 * nears (the height the track gives) — all turning with the game's clock
 * (decoration only: the original's `RotateAround` per frame is not state).
 * 2026-09-16 (the operator): the ship's wake — crystals falling off behind
 * the wings while it flies (`WAKE`, the original's two smoke particle
 * systems, `ship.wake` of data/ships.json) — and the energy pickup's beam
 * to the sky and the halo around it (`BEAM`, the original's `*_ray` and
 * `*_glow` quads of data/pickups.json — flat, facing the camera, with a
 * light running up the beam), the crystal in the layers of its materials
 * (a solid core or x2 icon inside a translucent shell), the beat of the pickups with the music (`PULSE`,
 * the original's `PulsingBlock` on the phase of the world's tempo) and
 * the shards of an explosion (`EXPLOSION`, the original's crash particles
 * in the ship's colours); all decoration, made
 * from the clock and the state, nothing random.
 * GR-M8 look (the operator's decision of 2026-09-16): the pickups are the
 * meshes of the original's prefabs (data/pickups.json) when the data has
 * them, the obstacles are the original's meshes (the reference track
 * names the parts drawn with every shape — mesh, materials, place in
 * the shape's frame; `sections.meshes` has the geometry, `sections.materials`
 * the looks — a vertex's colour is its material's texture gradient at the
 * vertex's v times the tint, so a checkered cube, a two-tone column and
 * a shaded triangle come out as in the original; `obstacleMesh`), the own
 * track's shapes primitives in the world's colour by look, and shadows: every obstacle's and the ship's
 * own mesh projected onto the ground along the scene's light
 * (`shadowOf`, `SHADOWS`) — the shape of what casts them, to the right
 * and back of it, the farther the higher it floats (the original fakes
 * them with dark quads; the shapes are truer to the light).
 */
export class Playfield {

  /** the camera of the original: offset from the ship at rest, pitch and field of view (notes 5, 6a); the game moves it from data/global.json `rules.camera` */
  static get CAMERA() {
    return {dy: 4.5, dz: -20, pitch: 5, fov: 35, near: 0.3, far: 1000, lookAhead: 100};
  } // CAMERA

  /** the lights of the original's scene (notes 15): one white directional light of intensity 1.2 — it travels [0.68, −0.65, −0.35] in the game's frame (from the scene's light rotation: ahead, above and to the left of the ship, the shadows fall to the right and back — confirmed by the operator 2026-09-16), x mirrored here — and an ambient of 0.75; on svision's 0–15 scale (15 = 1.0) the directional light is clamped to 15 */
  static get LIGHTS() {
    return [
      {type: 'directional', direction: [-0.677, -0.65, -0.345], color: '#ffffff', intensity: 15},
      {type: 'ambient', color: '#ffffff', intensity: 11}
    ];
  } // LIGHTS

  /** the ground: the tile under the ship and the pitch of its grid (blocks are 500 x 1000 u, notes 8) */
  static get GROUND() {
    return {width: 1500, depth: 1400, grid: 100, y: 0};
  } // GROUND

  /** the pickups' look: the sizes of the disc, the cube and the can (the stand-ins without data/pickups.json), and the turn in degrees per second */
  static get PICKUPS() {
    return {coin: [8, 1.5, 8], multiplier: 5, energy: [5, 9, 5], spin: 120};
  } // PICKUPS

  /** the shadows: the original fakes them with dark quads (`ShadowShip`, `shadowBox01`); here every object's own mesh is projected onto the ground along the scene's light (`shadowMatrix`), so a shadow has the shape of what casts it — `light` = the light in the game's (Unity's) frame, the direction it travels (LIGHTS is the same light mirrored into the scene); `y` the height of the shadow plane over the ground, `floating` how high an object may float to still cast one, `shipHeight` the height the ship is projected from and `shipAhead` how far ahead of it the shadow lies (the original's `ShadowShip` quad sits under the ship with its blob drawn ahead in the texture; the ground right under the ship is below the camera's view) */
  static get SHADOWS() {
    return {y: 0.15, color: '#161d2d', opacity: 0.4, floating: 20, light: [0.677, -0.65, -0.345], shipHeight: 4, shipAhead: 12};
  } // SHADOWS

  /**
   * The planar projection onto the shadow plane along the light (column
   * major, the game's frame): a point goes down the light's direction until
   * it meets y = SHADOWS.y. Multiplied in front of an item's transform it
   * turns the item into its shadow.
   * @returns {number[]} 16 numbers.
   */
  static shadowMatrix() {
    var SH = Playfield.SHADOWS, L = SH.light, y0 = SH.y;
    var kx = L[0]/L[1], kz = L[2]/L[1];        // x and z travel per unit of descent
    return [
      1, 0, 0, 0,
      -kx, 0, -kz, 0,
      0, 0, 1, 0,
      kx*y0, y0, kz*y0, 1
    ];
  } // shadowMatrix

  /**
   * The shadow of a mesh item: the same mesh, its transform projected onto
   * the ground, dark, translucent, unlit — drawn before the objects, on
   * the ground tiles.
   * @param {string} mesh - The mesh id.
   * @param {number[]} transform - The item's transform in the game's frame (16 numbers, before the mirror).
   * @returns {Object} A mesh item (mirrored into the scene).
   */
  static shadowOf(mesh, transform) {
    var SH = Playfield.SHADOWS;
    return {type: 'mesh', mesh: mesh, transform: Playfield.mirror(Mat4.multiply(Playfield.shadowMatrix(), transform)),
      fill: SH.color, color: SH.color, opacity: SH.opacity, shading: 'none'};
  } // shadowOf

  /**
   * The look of the obstacles: `brightness` lifts their colours (the
   * original's materials carry a 0.59 grey tint that reads dark under our
   * light; the operator asked for lighter obstacles 2026-09-16) — applied
   * to the meshes' vertex colours and to the primitives' fill, not to the
   * pickups or the ship.
   */
  static get OBSTACLES() {
    return {brightness: 3};
  } // OBSTACLES

  /** A CSS hex colour lifted by a factor, channels clamped. */
  static brighten(color, factor) {
    var rgb = Playfield.rgb(color);
    return '#'+rgb.map((v) => Math.round(Math.min(1, v*factor)*255).toString(16).padStart(2, '0')).join('');
  } // brighten

  /**
   * The wake of the ship: crystals falling off behind the wings (the
   * original's two smoke particle systems, 250 a second for 0.1 s in a
   * 17.7° cone — notes 5; here longer-lived and fewer so they read as
   * crystals, the operator's ask of 2026-09-16). `count` per emitter,
   * `life` s, `size` u at birth (shrinking to nothing), `spread` u/s
   * sideways, `fall` u/s² down, `lag` u/s behind the ship on top of the
   * ship's own speed. Decoration: made from the clock and the ship's
   * place, no state, no randomness (a hash of the particle's index).
   */
  static get WAKE() {
    return {count: 12, life: 0.2, size: 0.22, spread: 3, fall: 10, lag: 0};
  } // WAKE

  /**
   * The glow of a pickup: the original's `*_ray` quad is a beam to the
   * sky and its `*_glow` one a halo around the crystal, both additive
   * (data/pickups.json `beam`, `halo`; notes 12) — flat quads that face
   * the camera, not solids, so they read as light and not as a cylinder
   * or a ball (the operator, 2026-09-16). `beam` is the intensity 0–15 of
   * the standing bar, `wave` that of the shorter one running up it
   * (`waveHeight` of the beam's height, `waveSpeed` u/s — the animation
   * of the original's ray), `halo` that of the disc, `alpha` what the
   * material's alpha counts for.
   */
  static get BEAM() {
    return {beam: 7, wave: 11, waveHeight: 0.1, waveSpeed: 170, halo: 7, alpha: 3};
  } // BEAM

  /**
   * The beat of a pickup: the original's `PulsingBlock` scales it by the
   * phase of the music (`maxScaleDifference` 0.75 on a unit scale, the
   * curve of the prefab — notes 12, 17; the world's tempo is
   * data/worlds.json `beat`). `keys` are the curve's [time, value,
   * inSlope, outSlope], read as a Hermite spline.
   */
  static get PULSE() {
    return {scale: 0.75, keys: [[0, 0, 2, 2], [0.015, 1, -0.2423, -0.2423], [0.6091, 0.1494, -0.706, -0.706], [1, 0, 0, 0]]};
  } // PULSE

  /**
   * The explosion of a crash: the original bursts one particle system per
   * colour of the ship (`ShipParticleColors`, data/ships.json
   * `crashColors`) half way from the ship to the camera and lets it live
   * 6 s (`PlayerCrash.Crash`, notes 11) — the run is over in a second, so
   * `life` is the second. `count` shards per colour, `speed` u/s at the
   * start (a shard keeps a share of it from its hash), `fall` u/s² down,
   * `size` u at birth, `spin` degrees a second.
   */
  static get EXPLOSION() {
    return {count: 16, life: 1, speed: 95, fall: 70, size: 0.85, spin: 540};
  } // EXPLOSION

  /**
   * The phase of the music, 0–1: the world's tempo and start phase
   * (data/worlds.json `beat`, notes 17) — what the original's
   * `SoundManager.GetPhase` gives `PulsingBlock`.
   * @param {Object} state
   * @returns {number}
   */
  phase(state) {
    var w = this.worlds[state.world || 0], beat = w && w.beat;
    if (!beat) {
      return ((state.time || 0)%1+1)%1;
    }
    var t = (state.time || 0)*beat.bpm/60+beat.phase;
    return t-Math.floor(t);
  } // phase

  /**
   * The pulse at a phase: the original's curve (`PULSE.keys`) as a
   * Hermite spline, 0–1, times `scale` on top of 1.
   * @param {number} phase - 0..1
   * @returns {number} the scale, 1..1+scale
   */
  static pulse(phase) {
    var K = Playfield.PULSE.keys, v = 0;
    for (var i = 0; i+1 < K.length; i++) {
      if (phase >= K[i][0] && phase <= K[i+1][0]) {
        var dt = K[i+1][0]-K[i][0], u = dt > 0 ? (phase-K[i][0])/dt : 0, u2 = u*u, u3 = u2*u;
        v = (2*u3-3*u2+1)*K[i][1]+(u3-2*u2+u)*K[i][3]*dt+(-2*u3+3*u2)*K[i+1][1]+(u3-u2)*K[i+1][2]*dt;
        break;
      }
    }
    return 1+Playfield.PULSE.scale*Math.max(0, v);
  } // pulse

  /**
   * The mesh of a glow in a colour, unit sized in the x–y plane and drawn
   * from both sides (it is turned to face the camera): `bar` a rectangle
   * whose colour fades to nothing at its sides and ends, `disc` a circle
   * bright at the middle and nothing at the rim. Additively the faded
   * parts add nothing, so the shape has soft edges without a texture.
   * Made once per shape and colour (`glow:<shape>:<colour>`).
   * @param {string} shape - 'bar' | 'disc'
   * @param {string} color
   * @returns {string} the mesh id
   */
  glowMesh(shape, color) {
    var id = 'glow:'+shape+':'+color;
    if (this.meshes[id]) {
      return id;
    }
    var c = Playfield.rgb(color), positions = [], normals = [], colors = [], indices = [];
    var vertex = (x, y, k) => {
      positions.push(x, y, 0);
      normals.push(0, 0, 1);
      colors.push(c[0]*k, c[1]*k, c[2]*k);
      return positions.length/3-1;
    };
    // both windings: a quad turned to the camera must show whichever side it happens to present
    var face = (a, b, d) => indices.push(a, b, d, a, d, b);
    if (shape == 'disc') {
      var segments = 16, middle = vertex(0, 0, 1), rim = [];
      for (var i = 0; i <= segments; i++) {
        var a = 2*Math.PI*i/segments;
        rim.push(vertex(Math.cos(a)/2, Math.sin(a)/2, 0));
      }
      for (var r = 0; r < segments; r++) {
        face(middle, rim[r], rim[r+1]);
      }
    } else {
      // three columns and three rows: the light sits along the middle of both
      var grid = [], xs = [-0.5, 0, 0.5], ys = [-0.5, 0, 0.5], weight = [0, 1, 0];
      for (var row = 0; row < 3; row++) {
        for (var col = 0; col < 3; col++) {
          grid.push(vertex(xs[col], ys[row], weight[col]*weight[row]));
        }
      }
      for (var y = 0; y < 2; y++) {
        for (var x = 0; x < 2; x++) {
          var q = y*3+x;
          face(grid[q], grid[q+1], grid[q+3]);
          face(grid[q+1], grid[q+4], grid[q+3]);
        }
      }
    }
    this.meshes[id] = new Mesh(positions, normals, indices, {id: id, colors: colors});
    return id;
  } // glowMesh

  /** A hash of an integer as 0..1 (the same everywhere): decoration's stand-in for randomness. */
  static hash(n) {
    var x = Math.sin(n*12.9898+78.233)*43758.5453;
    return x-Math.floor(x);
  } // hash

  /** the colours when no world is at hand (data/worlds.json is the rule, this the fallback): the first world's */
  static get COLORS() {
    return {
      sky: '#018b85',
      ground: '#882d2d',
      grid: '#a03a3a',
      cube: '#4f7675',
      pillar: '#934237',
      wall: '#848380',
      ship: '#f2d21e',
      shipEdge: '#40c8c8'
    };
  } // COLORS

  /**
   * @param {Object} [data] - The game's data (`{ships, worlds, sections}` of data/*.json and assets/; `sections.materials` = the looks of the reference's obstacle materials, `sections.meshes` the geometry of its obstacle meshes); null under the skeleton.
   */
  constructor(data) {
    this.data = data || {};
    this.meshes = Playfield.meshes(this.data);
    this.ships = {};
    ((this.data.ships && this.data.ships.ships) || []).forEach((ship) => { this.ships[ship.id] = ship; });
    this.worlds = (this.data.worlds && this.data.worlds.worlds) || [];
    this.materials = (this.data.sections && this.data.sections.materials) || {};
    this.geometry = (this.data.sections && this.data.sections.meshes) || {};
  } // constructor

  /**
   * The mesh of an obstacle of the reference track, coloured by its
   * materials — made once per mesh and material list, kept in the library
   * (`ob:<mesh>:<materials>`). A vertex takes the material of its submesh
   * (Unity's order: the last submesh is drawn again with every extra
   * material, so it shows the last one) at its texture v on the material's
   * ramp (data: `materials[name].ramp`, v 0 the bottom of the texture).
   * @param {string} name - The mesh's name (`sections.meshes`).
   * @param {string[]} materials - The renderer's material names in order.
   * @returns {string|null} the mesh id, null without the geometry
   */
  obstacleMesh(name, materials) {
    var geometry = this.geometry[name];
    if (!geometry || !materials || !materials.length) {
      return null;
    }
    var id = 'ob:'+name+':'+materials.join(',');
    if (this.meshes[id]) {
      return id;
    }
    var subs = geometry.subMeshes || 1, last = materials.length-1;
    var ramps = [];
    for (var k = 0; k < subs; k++) {
      var m = materials[k < subs-1 ? Math.min(k, last) : last];
      var look = this.materials[m];
      ramps.push((look && look.ramp && look.ramp.length ? look.ramp : [look && look.color || '#ffffff']).map(Playfield.rgb));
    }
    var colors = new Float32Array(geometry.positions.length), lift = Playfield.OBSTACLES.brightness;
    for (var i = 0; i < geometry.sub.length; i++) {
      var ramp = ramps[Math.min(geometry.sub[i], subs-1)];
      var t = Math.max(0, Math.min(1, geometry.v[i]))*(ramp.length-1), lo = Math.floor(t), f = t-lo, hi = Math.min(lo+1, ramp.length-1);
      for (var c = 0; c < 3; c++) {
        colors[i*3+c] = Math.min(1, (ramp[lo][c]*(1-f)+ramp[hi][c]*f)*lift);
      }
    }
    this.meshes[id] = Playfield.rightHanded({id: id, positions: geometry.positions, normals: geometry.normals, indices: geometry.indices, colors: colors});
    return id;
  } // obstacleMesh

  /** A CSS hex colour as [r, g, b] 0–1 (white when it is not one). */
  static rgb(color) {
    var hex = /^#([0-9a-f]{6})$/i.exec(color || '');
    if (!hex) {
      return [1, 1, 1];
    }
    return [parseInt(hex[1].substr(0, 2), 16)/255, parseInt(hex[1].substr(2, 2), 16)/255, parseInt(hex[1].substr(4, 2), 16)/255];
  } // rgb

  /**
   * A state with nothing happening in it: the ship at the start, at rest,
   * full energy, no obstacles (`Game.tick` returns the same shape).
   * @returns {Object}
   */
  static emptyState() {
    return {
      tick: 0,
      time: 0,              // game seconds
      phase: 'playing',     // 'playing' | 'crash' | 'over' (notes 2)
      shipId: null,         // the id of the ship in data/ships.json (null: the dart placeholder)
      world: 0,             // the index of the world in data/worlds.json
      ship: {x: 0, y: 6, z: 0, roll: 0, yaw: 0, pitch: 0, visible: true},   // position in world units, angles in degrees (the original's left-handed frame)
      camera: null,         // {x, y, z, roll, yaw, pitch} of the game's camera (notes 6a); null: at rest behind the ship
      input: null,          // the intermediates of the steering (game.js), for matchstate
      speed: 0,             // u/s along +z
      energy: 1,            // 0..1
      lowEnergy: false,     // under the warning threshold (notes 10)
      distance: 0,          // metres, the score (notes 13)
      coins: 0,             // the coins of the run (notes 12, 13)
      multiplier: {value: 1, timer: 0, on: false, time: 5},   // the credit multiplier and its timer (notes 12)
      collected: {coin: 0, multiplier: 0, energy: 0},
      lastPickup: null,     // {kind, amount, tick} of the last pickup, for the HUD's message
      track: null,          // {section, generated, active, spawned} of the track (game.js)
      blocks: [],           // [{id, x, z, width, length}] the active blocks (track.js), centres in the original's frame
      obstacles: [],        // [{kind: 'box' | 'sphere' | 'capsule', look, c: [x, y, z], s: [w, h, d], q: [x, y, z, w]}] the active shapes (track.js)
      pickups: [],          // [{kind: 'coin' | 'multiplier' | 'energy', c: [x, y, z], y}] the pickups in reach, y the visual's height (track.js)
      crash: null           // {time s, reason 'explosion' | 'energy'} once the run is over (game.js), null while it plays
    };
  } // emptyState

  /**
   * The mesh library: unit primitives scaled by the items' transforms, the
   * ships of data/ships.json (`ship:<id>`, `Mesh.fromJSON`) and the dart
   * placeholder — 10 u long and 3.2 u wide (the original's collider,
   * notes 5), pointing along +z, flat shaded — for a state without a
   * ship. Every mesh has a fixed id, so the markup of a frame is the same
   * in the browser and under Node.
   * @param {Object} [data] - The game's data; its `ships` add to the library.
   * @returns {Object} id -> Mesh
   */
  static meshes(data) {
    var meshes = {
      ground: Mesh.plane(1, 1, {id: 'ground'}),
      cube: Mesh.box(1, 1, 1, {id: 'cube'}),
      pillar: Mesh.cylinder(0.5, 1, {id: 'pillar', segments: 12}),
      sphere: Mesh.sphere(0.5, {id: 'sphere', segments: 12, rings: 6}),
      crystal: Mesh.sphere(0.5, {id: 'crystal', segments: 4, rings: 2}),    // an octahedron: the wake's crystals
      ship: Playfield.shipMesh()
    };
    (((data || {}).ships && data.ships.ships) || []).forEach((ship) => {
      if (ship.mesh) {
        meshes['ship:'+ship.id] = Playfield.rightHanded(ship.mesh);
      }
    });
    // the pickups of the original's prefabs (data/pickups.json, mkpickups): a mesh per material
    // (`pickup:<kind>:<material>` — the solid core and the translucent shell over it), the whole
    // crystal in one as the fallback (`pickup:<kind>`)
    var pickups = ((data || {}).pickups && data.pickups.pickups) || {};
    Object.keys(pickups).forEach((kind) => {
      if (pickups[kind].mesh) {
        meshes['pickup:'+kind] = Playfield.rightHanded(pickups[kind].mesh);
      }
      (pickups[kind].layers || []).forEach((layer) => {
        meshes['pickup:'+kind+':'+layer.material] = Playfield.rightHanded(layer.mesh);
      });
    });
    return meshes;
  } // meshes

  /**
   * A mesh of the original (Unity's left-handed frame) as the scene draws
   * it. `mirror` conjugates an item's transform (S M S) so the logic's
   * left-handed world shows right-handed with +x on the right; that also
   * mirrors the mesh's own shape — so the vertices come pre-mirrored
   * (x negated, normals too, the winding turned to keep the faces outward):
   * S M S (S v) = S M v, the mesh's true place.
   * @param {Object} json - Mesh JSON (`{id, positions, normals, indices, colors?}`).
   * @returns {Mesh}
   */
  static rightHanded(json) {
    var positions = Array.prototype.slice.call(json.positions), normals = Array.prototype.slice.call(json.normals), indices = Array.prototype.slice.call(json.indices);
    for (var i = 0; i < positions.length; i += 3) {
      positions[i] = -positions[i];
      normals[i] = -normals[i];
    }
    for (var t = 0; t+2 < indices.length; t += 3) {
      var b = indices[t+1];
      indices[t+1] = indices[t+2];
      indices[t+2] = b;
    }
    return new Mesh(positions, normals, indices, {id: json.id, colors: json.colors || null});
  } // rightHanded

  /**
   * The default ship of data/ships.json (the first marked so, else the first), or null.
   * @returns {Object|null}
   */
  defaultShip() {
    var ships = (this.data.ships && this.data.ships.ships) || [];
    return ships.find((s) => s.default) || ships[0] || null;
  } // defaultShip

  /**
   * The fog of a world (data/worlds.json `fog`, the original's 400–1000 u):
   * `{start, end}` in the sky's colour, or null without data.
   * @param {number} world
   * @returns {Object|null}
   */
  fog(world) {
    var w = this.worlds[world || 0];
    return w && w.fog ? {start: w.fog.start, end: w.fog.end} : null;
  } // fog

  /**
   * The colours of a world: data/worlds.json by the state's world index,
   * the fallback palette without data.
   * @param {number} world
   * @returns {Object} `{sky, ground, grid, obstacle: {kind: colour}, pickup: {...}}`
   */
  colors(world) {
    var w = this.worlds[world || 0];
    if (w && w.colors) {
      return w.colors;
    }
    var C = Playfield.COLORS;
    return {sky: C.sky, ground: C.ground, grid: C.grid, obstacle: {box: C.cube, cube: C.cube, pillar: C.pillar, wall: C.wall, sphere: C.cube}, pickup: {}};
  } // colors

  /**
   * The ship: five points — the nose, the two wing tips, the top of the
   * fin, the keel — as eight flat triangles with their own vertices, so
   * every face has its own normal.
   * @returns {Mesh}
   */
  static shipMesh() {
    var nose = [0, 0, 5], left = [-1.6, 0, -5], right = [1.6, 0, -5], top = [0, 1, -3.5], keel = [0, -0.5, -3.5], tail = [0, 0, -4];
    // counter-clockwise seen from outside
    var faces = [
      [nose, top, left], [nose, right, top], [nose, left, keel], [nose, keel, right],
      [top, tail, left], [top, right, tail], [keel, left, tail], [keel, tail, right]
    ];
    var positions = [], normals = [], indices = [];
    faces.forEach((f, i) => {
      f.forEach((p) => positions.push(p[0], p[1], p[2]));
      var n = Mesh.faceNormal(positions, i*3, i*3+1, i*3+2);
      for (var k = 0; k < 3; k++) {
        normals.push(n[0], n[1], n[2]);
      }
      indices.push(i*3, i*3+1, i*3+2);
    });
    return new Mesh(positions, normals, indices, {id: 'ship'});
  } // shipMesh

  /**
   * A transform of the original's left-handed frame into the right-handed
   * scene: x mirrored on both sides (Sx · M · Sx) — the shapes are symmetric
   * in their own x, so nothing else changes.
   * @param {number[]} m - Column-major.
   * @returns {number[]}
   */
  static mirror(m) {
    var out = m.slice();
    for (var col = 0; col < 4; col++) {
      for (var row = 0; row < 4; row++) {
        if ((col === 0) !== (row === 0)) {
          out[col*4+row] = -m[col*4+row];
        }
      }
    }
    return out;
  } // mirror

  /**
   * A capsule drawn as a cylinder: `s` = [2r, height, axis]; the unit
   * cylinder stands along y, so the scale puts its height on the axis.
   * @param {number[]} s
   * @returns {number[]}
   */
  static capsuleScale(s) {
    var d = s[0], h = Math.max(s[1], d), axis = s[2]|0;
    var scale = [d, d, d];
    scale[axis] = h;
    return scale;
  } // capsuleScale

  /**
   * The scene's camera from the game's: position, and the pitch, yaw and
   * roll (degrees, Unity's order z-x-y) turned into a target point and an
   * up vector — mirrored into the right-handed scene like everything else.
   * @param {Object} cam - `{x, y, z, roll, yaw, pitch}` in the original's frame.
   * @returns {Object} A Scene3D camera.
   */
  static sceneCamera(cam) {
    var K = Playfield.CAMERA, r = Math.PI/180;
    var p = (cam.pitch || 0)*r, yw = (cam.yaw || 0)*r, rl = (cam.roll || 0)*r;
    // forward = Ry(yaw) · Rx(pitch) · (0, 0, 1); up = Ry · Rx · Rz(roll) · (0, 1, 0)
    var f = [Math.cos(p)*Math.sin(yw), -Math.sin(p), Math.cos(p)*Math.cos(yw)];
    var u0 = [-Math.sin(rl), Math.cos(rl), 0];
    var u1 = [u0[0], u0[1]*Math.cos(p)-u0[2]*Math.sin(p), u0[1]*Math.sin(p)+u0[2]*Math.cos(p)];
    var u = [u1[0]*Math.cos(yw)+u1[2]*Math.sin(yw), u1[1], -u1[0]*Math.sin(yw)+u1[2]*Math.cos(yw)];
    var position = [-cam.x, cam.y, cam.z];
    return {
      type: 'perspective',
      fov: K.fov,
      near: K.near,
      far: K.far,
      position: position,
      target: [position[0]-f[0]*K.lookAhead, position[1]+f[1]*K.lookAhead, position[2]+f[2]*K.lookAhead],
      up: [-u[0], u[1], u[2]]
    };
  } // sceneCamera

  /**
   * The frame of a state: the camera, the sky and its fog, the ground under
   * the ship with its grid, the obstacles, the ship.
   * @param {Object} state - See emptyState().
   * @returns {Object} `{background, fog, camera, items}`
   */
  frame(state) {
    var C = this.colors(state.world), G = Playfield.GROUND, K = Playfield.CAMERA;
    // the state is in the original's left-handed coordinates (Unity: +x to
    // the right when looking along +z); the scene is right-handed (GL: +x
    // to the left from behind), so x and the rotations about y and z are
    // mirrored here (and in sceneCamera) and nowhere else — the game keeps
    // the original's numbers
    var s = {x: -state.ship.x, y: state.ship.y, z: state.ship.z, roll: -(state.ship.roll || 0), yaw: -(state.ship.yaw || 0), pitch: state.ship.pitch || 0};
    var items = [];

    // the ground: the active blocks as tiles with a grid each, or one tile
    // under the ship when the state has no track (the menu's rest)
    var blocks = state.blocks && state.blocks.length ? state.blocks : [{x: 0, z: s.z+G.depth/2-200, width: G.width, length: G.depth}];
    blocks.forEach((b) => {
      var bx = -b.x, x0 = bx-b.width/2, x1 = bx+b.width/2, z0 = b.z-b.length/2, z1 = b.z+b.length/2;
      items.push({type: 'mesh', mesh: 'ground', transform: {position: [bx, G.y, b.z], scale: [b.width, 1, b.length]}, fill: C.ground, color: C.ground});
      var gy = G.y+0.05;
      for (var x = x0; x <= x1+1e-6; x += G.grid) {
        items.push({type: 'line', x1: x, y1: gy, z1: z0, x2: x, y2: gy, z2: z1, color: C.grid, intensity: 8});
      }
      for (var z = z0; z <= z1+1e-6; z += G.grid) {
        items.push({type: 'line', x1: x0, y1: gy, z1: z, x2: x1, y2: gy, z2: z, color: C.grid, intensity: 8});
      }
    });

    // the obstacles: the shapes of the track, their mesh by look, placed by
    // the transform the animation left them in — mirrored into the scene
    // the shadows first (they lie on the ground, the obstacles and the ship
    // are drawn over them): every obstacle near the ground projected along
    // the light, and the ship — its own mesh, the one the state names
    var SH = Playfield.SHADOWS;
    // an obstacle: the original's meshes where the shape draws them (each part's transform = the shape's frame x the
    // part's offset), a primitive scaled to the shape when it has none the data knows
    var self = this;
    var obstacleDrawn = (o) => {
      var draws = [];
      (o.parts || []).forEach((part) => {
        var id = self.obstacleMesh(part.mesh, part.materials);
        if (id) {
          draws.push({mesh: id, transform: Mat4.multiply(Quat.compose(o.c, o.q, [1, 1, 1]), Quat.compose(part.offset.p, part.offset.q, part.offset.s)), colored: true});
        }
      });
      if (!draws.length) {
        draws.push({mesh: o.kind == 'sphere' ? 'sphere' : o.look == 'pillar' || o.kind == 'capsule' ? 'pillar' : 'cube',
          transform: Quat.compose(o.c, o.q, o.kind == 'capsule' ? Playfield.capsuleScale(o.s) : o.s), colored: false});
      }
      return draws;
    };
    (state.obstacles || []).forEach((o) => {
      if (!o.hidden && o.c[1]-o.s[1]/2 <= SH.floating) {
        obstacleDrawn(o).forEach((d) => items.push(Playfield.shadowOf(d.mesh, d.transform)));
      }
    });
    var shipDef = state.shipId !== null && state.shipId !== undefined ? this.ships[state.shipId] : this.defaultShip();
    var shipMeshId = shipDef && this.meshes['ship:'+shipDef.id] ? 'ship:'+shipDef.id : 'ship';
    if (state.ship.visible !== false) {
      items.push(Playfield.shadowOf(shipMeshId, Quat.compose([state.ship.x, SH.shipHeight, state.ship.z+SH.shipAhead], Quat.fromEuler(state.ship.pitch || 0, state.ship.yaw || 0, state.ship.roll || 0, 'zxy'), [1, 1, 1])));
    }

    (state.obstacles || []).forEach((o) => {
      if (o.hidden) {
        return;                       // drawn with another shape (one renderer, many colliders)
      }
      obstacleDrawn(o).forEach((d) => {
        if (d.colored) {
          // the original's mesh in its materials' colours (the vertices carry them)
          items.push({type: 'mesh', mesh: d.mesh, transform: Playfield.mirror(d.transform), fill: 'none', color: '#ffffff'});
          return;
        }
        // the colour: the original's material of the obstacle (the reference track), the world's colour by look otherwise
        var material = o.material ? self.materials[o.material] : null;
        var color = Playfield.brighten(material ? material.color : C.obstacle[o.look] || C.obstacle.box, Playfield.OBSTACLES.brightness);
        items.push({type: 'mesh', mesh: d.mesh, transform: Playfield.mirror(d.transform), fill: color, color: color});
      });
    });

    // the pickups: turning with the clock — the meshes of the original's
    // prefabs (data/pickups.json) with their own colours, the stand-in
    // shapes in the world's pickup colours without them
    var PK = Playfield.PICKUPS, spin = ((state.time || 0)*PK.spin)%360, turn = Quat.axisAngle([0, 1, 0], spin);
    var B = Playfield.BEAM, beat = Playfield.pulse(this.phase(state)), pickupData = (this.data.pickups && this.data.pickups.pickups) || {};
    var beams = [];
    (state.pickups || []).forEach((p) => {
      var color = C.pickup[p.kind] || C.obstacle.box, mesh, q, scale;
      var def = pickupData[p.kind] || {};
      // the beam to the sky and the halo of the original, additive and turned to face the camera —
      // drawn after everything else (they add to what is behind them), and left out from within
      // (a glow seen from inside is a wall of colour across the view, never what the original shows)
      var eye = state.camera || {x: state.ship.x, z: state.ship.z+Playfield.CAMERA.dz};
      var away = Math.sqrt((p.c[0]-eye.x)*(p.c[0]-eye.x)+(p.c[2]-eye.z)*(p.c[2]-eye.z));
      var facing = Quat.fromEuler(0, Math.atan2(eye.x-p.c[0], eye.z-p.c[2])*180/Math.PI, 0, 'zxy');
      if (def.beam && away > def.beam.radius) {
        var bar = this.glowMesh('bar', def.beam.color), strength = Math.min(1, def.beam.alpha*B.alpha);
        var width = def.beam.radius*2*beat;
        beams.push({type: 'mesh', mesh: bar, transform: Playfield.mirror(Quat.compose([p.c[0], def.beam.height/2, p.c[2]], facing, [width, def.beam.height, 1])),
          fill: 'none', color: def.beam.color, intensity: B.beam*strength*beat, shading: 'none', blend: 'add'});
        // the light running up the beam, over and over: what makes it live (the original animates its ray)
        var waveHeight = def.beam.height*B.waveHeight, waveY = ((state.time || 0)*B.waveSpeed)%def.beam.height;
        beams.push({type: 'mesh', mesh: bar, transform: Playfield.mirror(Quat.compose([p.c[0], waveY, p.c[2]], facing, [width*1.6, waveHeight, 1])),
          fill: 'none', color: def.beam.color, intensity: B.wave*strength, shading: 'none', blend: 'add'});
      }
      if (def.halo && away > def.halo.radius) {
        var disc = this.glowMesh('disc', def.halo.color), size = def.halo.radius*2*beat;
        beams.push({type: 'mesh', mesh: disc, transform: Playfield.mirror(Quat.compose([p.c[0], p.y+def.halo.y, p.c[2]], facing, [size, size, 1])),
          fill: 'none', color: def.halo.color, intensity: B.halo*Math.min(1, def.halo.alpha*B.alpha), shading: 'none', blend: 'add'});
      }
      // the crystal by layers: the solid core (the x2 icon of the multiplier) and the translucent
      // shell over it, as the original's materials have them — the shell last, it is see-through
      if (def.layers && def.layers.length && this.meshes['pickup:'+p.kind+':'+def.layers[0].material]) {
        def.layers.forEach((layer) => {
          items.push({type: 'mesh', mesh: 'pickup:'+p.kind+':'+layer.material, transform: Playfield.mirror(Quat.compose([p.c[0], p.y, p.c[2]], turn, [beat, beat, beat])),
            fill: 'none', color: color, opacity: layer.opacity});
        });
        return;
      }
      if (this.meshes['pickup:'+p.kind]) {
        items.push({type: 'mesh', mesh: 'pickup:'+p.kind, transform: Playfield.mirror(Quat.compose([p.c[0], p.y, p.c[2]], turn, [beat, beat, beat])), fill: 'none', color: color});
        return;
      }
      switch (p.kind) {
        case 'coin':
          // the disc: the cylinder laid along z, then turned about y
          mesh = 'pillar';
          q = Quat.multiply(turn, Quat.axisAngle([1, 0, 0], 90));
          scale = PK.coin;
          break;
        case 'multiplier':
          mesh = 'cube';
          q = Quat.multiply(turn, Quat.axisAngle([0, 0, 1], 45));
          scale = PK.multiplier;
          break;
        default:
          mesh = 'pillar';
          q = turn;
          scale = PK.energy;
      }
      items.push({type: 'mesh', mesh: mesh, transform: Playfield.mirror(Quat.compose([p.c[0], p.y, p.c[2]], q, scale.map((v) => v*beat))), fill: color, color: color});
    });

    // the ship of the state (data/ships.json; the default ship for a state
    // without one, the menu's) or the dart, rolled and yawed as the state
    // says (degrees, notes 6); gone after an explosion
    var ship = state.shipId !== null && state.shipId !== undefined ? this.ships[state.shipId] : this.defaultShip();
    if (state.ship.visible !== false) {
      var shipMesh = ship && this.meshes['ship:'+ship.id] ? 'ship:'+ship.id : 'ship';
      var P = Playfield.COLORS;
      // a mesh with vertex colours (the original's models, mkships `model`) is drawn by them: fill 'none' (webGL2Layout)
      var colored = !!(this.meshes[shipMesh] && this.meshes[shipMesh].colors);
      items.push({type: 'mesh', mesh: shipMesh, transform: {position: [s.x, s.y, s.z], rotation: [s.pitch, s.yaw, s.roll]},
        fill: colored ? 'none' : ship ? ship.color : P.ship, color: ship ? ship.color : P.shipEdge});

      // the wake: crystals off the wings while the ship flies at full energy (the original stops its
      // particles when energyFactor < 1, notes 10) — each one's age from the clock and its index
      var W = Playfield.WAKE, wake = ship && ship.wake, speed = state.speed || 0, factor = state.input ? state.input.energyFactor : 1;
      if (wake && state.phase == 'playing' && speed > 0 && factor >= 1) {
        // in the original's frame (state.ship, not the mirrored `s`): the item is mirrored once, at the end
        var o = state.ship, pose = Quat.fromEuler(o.pitch || 0, o.yaw || 0, o.roll || 0, 'zxy');
        wake.emitters.forEach((e, k) => {
          var at = Quat.rotate(pose, e);
          for (var i = 0; i < W.count; i++) {
            var n = k*W.count+i;
            var age = ((state.time || 0)+W.life*i/W.count)%W.life, left = 1-age/W.life;
            var dx = (Playfield.hash(n)*2-1)*W.spread*age, dy = (Playfield.hash(n+100)*2-1)*W.spread*age*0.5-W.fall*age*age;
            var size = W.size*left;
            if (size < 0.02) {
              continue;
            }
            var turn = Quat.axisAngle([1, 1, 0], age*720+n*45);
            items.push({type: 'mesh', mesh: 'crystal', transform: Playfield.mirror(Quat.compose([o.x+at[0]+dx, o.y+at[1]+dy, o.z+at[2]-(speed+W.lag)*age], turn, [size, size*1.6, size])),
              fill: wake.color, color: wake.color, shading: 'none'});
          }
        });
      }
    }

    // the camera: the game's, or at rest behind the ship (the original's start offset, notes 5)
    var cam = state.camera || {x: state.ship.x, y: state.ship.y+K.dy, z: state.ship.z+K.dz, roll: 0, yaw: 0, pitch: K.pitch};

    // the explosion of a crash: shards in the ship's particle colours, from half way to the camera
    // (the original's PlayerCrash, notes 11) — their flight from the time since the crash, no state
    var X = Playfield.EXPLOSION, crash = state.crash;
    if (crash && crash.reason == 'explosion' && crash.time < X.life) {
      var o = state.ship, at = [(o.x+cam.x)/2, (o.y+cam.y)/2, (o.z+cam.z)/2];
      var shades = (ship && ship.crashColors && ship.crashColors.length ? ship.crashColors : [Playfield.COLORS.ship]);
      var age = crash.time, left = 1-age/X.life, size = X.size*left;
      if (size > 0.05) {
        shades.forEach((shade, k) => {
          for (var i = 0; i < X.count; i++) {
            var n = k*X.count+i;
            // a direction over the whole sphere, its speed a share of the burst's
            var u = Playfield.hash(n)*2-1, a = Playfield.hash(n+50)*2*Math.PI, r = Math.sqrt(Math.max(0, 1-u*u));
            var speed = X.speed*(0.35+0.65*Playfield.hash(n+150));
            var d = [r*Math.cos(a)*speed*age, u*speed*age-X.fall*age*age, r*Math.sin(a)*speed*age];
            var turnShard = Quat.fromEuler(age*X.spin*(1+Playfield.hash(n+200)), age*X.spin, 0, 'zxy');
            items.push({type: 'mesh', mesh: 'crystal', transform: Playfield.mirror(Quat.compose([at[0]+d[0], at[1]+d[1], at[2]+d[2]], turnShard, [size, size, size])),
              fill: shade, color: shade, shading: 'none'});
          }
        });
      }
    }

    beams.forEach((b) => items.push(b));

    return {
      background: C.sky,
      fog: this.fog(state.world),
      lights: Playfield.LIGHTS,
      camera: Playfield.sceneCamera(cam),
      items: items
    };
  } // frame

  /**
   * Puts a frame into a scene: clears it, sets the background, the fog and
   * the camera, pushes the items with their meshes resolved from the library.
   * The worker's playfield makes the obstacles' coloured meshes and the
   * glows as it names them (`ob:<mesh>:<materials>`, `glow:<shape>:<colour>`);
   * given the model's playfield, the same are made here on first sight,
   * from the same data.
   * @param {Scene3D} scene
   * @param {Object} frame - As frame() returns it.
   * @param {Object|Playfield} library - id -> Mesh (Playfield.meshes()), or the playfield whose library it is.
   * @returns {Scene3D} The scene.
   */
  static build(scene, frame, library) {
    var playfield = library instanceof Playfield ? library : null;
    var meshes = playfield ? playfield.meshes : library;
    scene.clear();
    scene.setBackground(frame.background);
    scene.setFog(frame.fog || null);
    if (frame.lights) {
      scene.setLights(frame.lights);
    }
    scene.setCamera(frame.camera);
    frame.items.forEach((item) => {
      if (item.type == 'mesh') {
        var mesh = meshes[item.mesh];
        if (!mesh && playfield && item.mesh.indexOf('ob:') === 0) {
          var at = item.mesh.indexOf(':', 3);
          if (at > 0 && playfield.obstacleMesh(item.mesh.slice(3, at), item.mesh.slice(at+1).split(','))) {
            mesh = meshes[item.mesh];
          }
        } else if (!mesh && playfield && item.mesh.indexOf('glow:') === 0) {
          var parts = item.mesh.split(':');
          playfield.glowMesh(parts[1], parts[2]);
          mesh = meshes[item.mesh];
        }
        if (!mesh) {
          throw new Error('Playfield: unknown mesh '+item.mesh);
        }
        var style = Object.assign({}, item);
        delete style.type;
        delete style.mesh;
        scene.mesh(mesh, style);
      } else {
        scene.push(Object.assign({}, item));
      }
    });
    return scene;
  } // build

} // Playfield
