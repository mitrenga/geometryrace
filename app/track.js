const { Quat } = await import('./svision/js/platform/scene3D/quat.js?ver='+window.srcVersion);
// begin code

/**
 * The track: the rows of blocks the ship flies over, the obstacles on
 * them and the collisions with them — GR-M6, after the notes
 * (sources/docs/decompile_notes.md chap. 8 the generator, 11 the
 * collisions and the moving obstacles). The numbers of the rules come from
 * data/global.json `rules.track`; the blocks and the section sequences
 * from data/sections.json (the game's own content, GR-M4) or, for
 * `tools/matchtrack.mjs`, from the reference converted into the same
 * shape. No DOM, no Math.random(): the randomness is the `rng` handed in
 * (`rangeFloat(min, max)`, `rangeInt(min, max)` — `max` excluded, as the
 * original's `Random.Range(int)`), which the tool replaces with the values
 * the instrumented original recorded.
 *
 * The generator (`LevelManager`, notes 8): a **row** is three blocks of one
 * prefab side by side; it is started when the end of the last row is
 * nearer than the horizon (1000 u) and built **one block per frame**
 * (`frameUpdate`, the original's `Update` — the tools call it after the
 * ticks of one render frame, the game after every tick). The row's x
 * offset is the previous row's middle block plus, in a random section, a
 * random multiple of the block width over the world's tiling; the section
 * sequence advances when a section has produced its `length` rows and
 * starts over at the end. Rows are recycled sideways when the ship
 * leaves the middle block (a block jumps three widths across), and the
 * first row is dropped once the ship has passed it. Every generated block
 * goes into `generated` — what `matchtrack` compares.
 *
 * The obstacles: a block's shapes start inactive and are switched on
 * `obstaclesPerTick` children per tick from the block's activation
 * (`ObstacleManager`). A shape is a box (with a rotation), a sphere or a
 * capsule in the block's frame; the own kinds (`box`, `wall`, `pillar`,
 * `sphere`, `gate`) are turned into shapes by {@link Track.prepare}. The
 * animations run per tick while the shape is active: `tumble` (a box
 * rolling over an edge at a speed in °/s, snapped every 90°, repeated or
 * not — `MovingBlock`), `fall` (a pillar toppling by a curve of the ship's
 * distance — `FallingPillar`), `mover` (an offset by a curve of the ship's
 * distance — `MoverDistanceBased`; the own `rise` is one that starts sunk),
 * `slide` (a sine along an axis), `wave` (curves of a running phase —
 * `Mover`), `spin` (about a pivot, °/s or per frame — `RotateAround`).
 *
 * The collision (`PlayerControl.OnTriggerEnter`, notes 11): the ship's
 * trigger box, rotated with the ship, against every active shape near it —
 * box × box by the separating axes, sphere × box by the nearest point,
 * a capsule as spheres along its axis.
 *
 * The pickups (GR-M7, notes 12): every block has spawn points (`{x, z,
 * energy}` in its frame, at the ship's height); when a block is placed
 * (`PowerupSpawner.SpawnPowerUp` inside `generateBlock`) each point rolls
 * `rng.chance()` (`Random.Range(0, 1)`) in the point order — an energy
 * point once against 2 / E, a common point against 1 / N for a multiplier
 * and, missing that, against 4.5 · m / N for a coin (E, N the counts of
 * the block's points, m the ship's Coins upgrade). A pickup is a capsule
 * (r 10, 39.13 long along z, its centre offset by kind) standing at the
 * point; it is collected by the ship's trigger box or the magnet sphere
 * (`PickupMagnet`, a ship with the upgrade), and vanishes. `spawned` is
 * every pickup placed, block by block — what `matchtrack` compares; the
 * effects are the game's (game.js).
 */
export class Track {

  /**
   * @param {Object} options
   *   `blocks` — id → block definition (data/sections.json `blocks`, or shapes ready-made);
   *   `sections` — the world's sequence `[{type: 'constant' | 'random', length, blocks: [id]}]`;
   *   `tiling` — the world's tiling of the random x offset (4/4/3, notes 8);
   *   `rules` — data/global.json `rules.track`;
   *   `rng` — `{rangeFloat(min, max), rangeInt(min, max), chance()}` (`chance` 0..1 for the spawner);
   *   `pickups` — data/global.json `rules.pickups` (none: no pickups);
   *   `coinsMultiplier` — the ship's Coins upgrade 1–3 (the coins' spawn amount, notes 12, 14);
   *   `startSection` — 0 by default.
   */
  constructor(options) {
    this.rules = options.rules;
    this.horizon = this.rules.horizon;
    this.tiling = options.tiling || 4;
    this.rng = options.rng;
    this.pickupRules = options.pickups || null;
    this.coinsMultiplier = options.coinsMultiplier || 1;
    this.spawned = [];            // every pickup placed: {n (block), kind, x, z}
    this.defs = {};
    Object.keys(options.blocks).forEach((id) => { this.defs[id] = Track.prepare(options.blocks[id]); });
    this.sections = options.sections.map((s) => ({type: s.type, length: s.length, blocks: s.blocks, infinite: !!s.infinite, rows: 0}));
    this.startSection = options.startSection || 0;
    this.section = this.startSection;
    this.active = [];             // the active blocks in the order LevelManager keeps them
    this.lastRowZ = 0;            // the end of the last row (lastBlockRowZPos)
    this.generating = false;
    this.counter = 0;
    this.posX = 0;                // posToGenerate.x: the ship's x when the row started
    this.rowOffset = 0;
    this.nextBlock = null;
    this.rowSection = null;
    this.generated = [];          // every block placed: {n, id, x, z, section, row}
    this.dropped = 0;
    this.frames = 0;
  } // constructor

  // ------------------------------------------------------------ the blocks

  /**
   * A block definition made ready: its obstacles (the own kinds) turned
   * into collision shapes in the block's frame, grouped into the children
   * the activation switches on together. A definition that already has
   * `shapes` (the reference converted by matchtrack: `{kind, c, s, q, r,
   * child, anim}`, `child` −1 for a shape the activation never touches) is
   * taken as it is.
   * The spawn points come along as `{x, z, energy}` in the block's frame
   * (data/sections.json `spawnPoints`; the reference's converted by
   * matchtrack) — y is the rules' height (`PowerupSpawnPoint.Awake`).
   * @param {Object} def - `{id, width, length, obstaclesPerTick, obstacles | shapes, spawnPoints}`
   * @returns {Object} `{id, width, length, perTick, shapes, children, points}`
   */
  static prepare(def) {
    var shapes = [];
    if (def.shapes) {
      def.shapes.forEach((s, i) => {
        shapes.push(Object.assign({look: s.kind, child: i, q: Quat.identity()}, s));
      });
    } else {
      (def.obstacles || []).forEach((o, i) => {
        var q = Quat.fromEuler(0, o.ry || 0, 0, 'zxy');
        var anim = o.anim ? Track.ownAnimation(o) : null;
        var push = (kind, c, s) => shapes.push({kind: kind, look: o.kind, c: c, s: s, r: kind == 'sphere' ? s[0]/2 : 0, q: q, child: i, anim: anim});
        switch (o.kind) {
          case 'sphere':
            push('sphere', [o.x, o.y+o.h/2, o.z], [o.w, o.h, o.d]);
            break;
          case 'gate': {
            // two posts d wide at the ends of the span w, a lintel d thick across the top
            var dx = Quat.rotate(q, [o.w/2, 0, 0]);
            push('box', [o.x-dx[0], o.y+o.h/2, o.z-dx[2]], [o.d, o.h, o.d]);
            push('box', [o.x+dx[0], o.y+o.h/2, o.z+dx[2]], [o.d, o.h, o.d]);
            push('box', [o.x, o.y+o.h+o.d/2, o.z], [o.w+o.d, o.d, o.d]);
            break;
          }
          default:                // box, wall, pillar
            push('box', [o.x, o.y+o.h/2, o.z], [o.w, o.h, o.d]);
        }
      });
    }
    shapes.forEach((s) => {
      // the radius of the bounding sphere, for the quick distance test
      s.bound = s.kind == 'sphere' ? s.r : s.kind == 'capsule' ? s.s[1]/2 : Math.sqrt(s.s[0]*s.s[0]+s.s[1]*s.s[1]+s.s[2]*s.s[2])/2;
    });
    var children = Math.max(0, ...shapes.map((s) => s.child+1));
    var points = (def.spawnPoints || []).map((p) => ({x: p.x, z: p.z, energy: !!p.energy}));
    return {id: def.id, width: def.width, length: def.length, perTick: def.obstaclesPerTick || 1, shapes: shapes, children: children, points: points};
  } // prepare

  /**
   * The own animation sugar of data/sections.json into the general forms.
   * @param {Object} o - An obstacle with `anim`.
   * @returns {Object}
   */
  static ownAnimation(o) {
    var a = o.anim;
    switch (a.type) {
      case 'rise':
        // sunk by dy at rest, up to its place as the ship comes within zOffset; `curve` c: linear up to c of the way
        return {type: 'mover', offset: [0, a.dy, 0], distance: [0, -a.dy, 0], zOffset: a.zOffset,
          curve: typeof a.curve == 'number' ? [[0, 0, 0, 0], [a.curve, 1, 0, 0]] : a.curve};
      case 'fall':
        return {type: 'fall', direction: a.direction, zOffset: a.zOffset, degrees: a.degrees, curve: a.curve || [[0, 0, 0, 0], [0.8, 1, 0, 0]]};
      case 'spin':
        return {type: 'spin', speed: a.speed, perFrame: !!a.perFrame, pivot: a.pivot || [o.x, 0, o.z]};
      default:                    // tumble, slide as they are
        return Object.assign({}, a);
    }
  } // ownAnimation

  /**
   * A block instance placed at (x, z): the shapes at rest in the world,
   * inactive, their animations not started.
   * @param {Object} def - As prepare() returns it.
   * @param {number} x
   * @param {number} z
   * @returns {Object}
   */
  static instantiate(def, x, z) {
    var block = {id: def.id, def: def, x: x, z: z, width: def.width, length: def.length, activated: 0, shapes: [], pickups: []};
    def.shapes.forEach((s) => {
      var rest = [x+s.c[0], s.c[1], z+s.c[2]];
      var i = {shape: s, rest: rest, c: rest.slice(), q: s.q.slice(), active: false, anim: null};
      block.shapes.push(i);
      if (s.child < 0) {
        Track.activate(i);        // outside the activation's reach: on from the start (the reference's entry blocks)
      }
    });
    return block;
  } // instantiate

  /**
   * Moves a placed block sideways (the recycling), shapes and all.
   * @param {Object} block
   * @param {number} dx
   */
  static shift(block, dx) {
    block.x += dx;
    block.pickups.forEach((p) => {
      p.c[0] += dx;
      p.box[0] += dx;
    });
    block.shapes.forEach((i) => {
      i.rest[0] += dx;
      i.c[0] += dx;
      if (i.anim) {
        if (i.anim.pivot) i.anim.pivot[0] += dx;
        if (i.anim.base) i.anim.base.c[0] += dx;
        if (i.anim.start) i.anim.start[0] += dx;
      }
    });
  } // shift

  // --------------------------------------------------------- the generator

  /**
   * The end of the last row of blocks.
   * @returns {number}
   */
  lastEnd() {
    if (!this.active.length) {
      return this.lastRowZ;
    }
    var last = this.active[this.active.length-1];
    return last.z+last.length/2;
  } // lastEnd

  /**
   * The width and length of a section's blocks (its first prefab's).
   * @param {Object} section
   * @returns {Object} The block definition.
   */
  sectionBlock(section) {
    return this.defs[section.blocks[0]];
  } // sectionBlock

  /**
   * `LevelManager.StartGame`: the first block of the first row.
   * @param {Object} ship - `{x, z}`
   */
  start(ship) {
    this.generateBlocks(ship);
  } // start

  /**
   * One `LevelManager.Update`: the sideways recycling, one block of a row
   * when the horizon needs it, one block dropped behind the ship.
   * @param {Object} ship - `{x, z}`
   */
  frameUpdate(ship) {
    this.frames++;
    this.recycle(ship);
    if (this.active.length) {
      if (this.lastEnd() < this.horizon+ship.z || this.generating) {
        this.generateBlocks(ship);
      }
      this.drop(ship);
    }
    this.active.forEach((b) => b.shapes.forEach((i) => {
      if (i.active && i.anim && i.anim.type == 'spin' && i.anim.perFrame) {
        Track.spin(i, i.anim.speed);
      }
    }));
  } // frameUpdate

  /**
   * `GenerateBlocks`: starts a row when none is in progress, places one
   * block, closes the row after the third.
   * @param {Object} ship
   */
  generateBlocks(ship) {
    if (!this.generating) {
      this.startRow(ship);
    }
    this.generateBlock();
    this.counter++;
    if (this.counter > 1) {
      this.generating = false;
    }
    if (!this.generating) {
      this.lastRowZ = this.lastEnd();
      this.checkSection();
    }
  } // generateBlocks

  /**
   * `startGeneratingNewRow` with the section's `StartNewBlockRow`,
   * `SetTiling` and `GetBlockID`: the randomness in the original's order
   * (a float offset that is overwritten, the tiling step, the prefab).
   * @param {Object} ship
   */
  startRow(ship) {
    var section = this.sections[this.section];
    var def = this.sectionBlock(section);
    var W = def.width;
    var random = section.type == 'random';
    if (random) {
      this.rng.rangeFloat(-W/2, W/2);          // RandomSection.StartNewBlockRow: overwritten by SetTiling, but the generator moves on
    }
    section.rows++;
    var centerX = this.active.length <= 1 ? 0 : this.active[this.active.length-2].x;
    if (random) {
      // SetTiling: float32 as the original — the step and the count of steps
      var step = Math.fround(W/this.tiling);
      var n = Math.trunc(Math.fround(W/2)/step);
      var k = this.rng.rangeInt(-n, n);
      this.rowOffset = k*step;
    } else {
      this.rowOffset = 0;
    }
    this.rowOffset += centerX-ship.x;
    this.nextBlock = random ? this.defs[section.blocks[this.rng.rangeInt(0, section.blocks.length)]] : def;
    this.rowSection = section;
    this.counter = -1;
    this.posX = ship.x;
    this.generating = true;
  } // startRow

  /**
   * `generateBlock` + `setBlockPosition`: the block at its x in the row
   * and the z after the last row, activated.
   */
  generateBlock() {
    var def = this.nextBlock;
    var x = this.posX+this.counter*def.width+this.rowOffset;
    var z = this.lastRowZ+def.length/2;
    var block = Track.instantiate(def, x, z);
    this.active.push(block);
    this.generated.push({n: this.generated.length+1, id: def.id, x: x, z: z, section: this.section, row: this.rowSection.rows, i: this.counter});
    this.spawn(block);
  } // generateBlock

  /**
   * `PowerupSpawner.SpawnPowerUp` for a block just placed: the pickups of
   * its spawn points by the rolls of `rng.chance()` (notes 12; the order of
   * the rolls is the original's — the match tools replay it).
   * @param {Object} block
   */
  spawn(block) {
    var P = this.pickupRules, points = block.def.points;
    if (!P || !points.length || !this.rng.chance) {
      return;
    }
    var energyPoints = points.filter((p) => p.energy).length;
    var commonPoints = points.length-energyPoints;
    var n = this.generated.length;
    points.forEach((p) => {
      var kind = null;
      if (p.energy) {
        if (this.rng.chance() < P.energyPerBlock/energyPoints) {
          kind = 'energy';
        }
      } else if (this.rng.chance() < P.multiplierPerBlock/commonPoints) {
        kind = 'multiplier';
      } else if (this.rng.chance() < P.coinsPerBlock*this.coinsMultiplier/commonPoints) {
        kind = 'coin';
      }
      if (kind) {
        var c = [block.x+p.x, P.spawnY, block.z+p.z];
        var off = P.capsule.center[kind] || [0, 0, 0];
        block.pickups.push({kind: kind, c: c, box: [c[0]+off[0], c[1]+off[1], c[2]+off[2]], collected: false});
        this.spawned.push({n: n, kind: kind, x: c[0], z: c[2]});
      }
    });
  } // spawn

  /**
   * `checkSectionStataus`: on to the next section when this one has its
   * rows, back to the start after the last.
   */
  checkSection() {
    var section = this.sections[this.section];
    var completed = section.type == 'random' ? section.rows >= section.length : (!section.infinite && section.rows >= section.length);
    if (completed) {
      if (this.section == this.sections.length-1) {
        this.section = this.startSection;
      } else if (this.section+1 < this.sections.length) {
        this.section++;
      }
      section.rows = 0;
    }
  } // checkSection

  /**
   * `checkActiveBlockPosition`: for every full row, when the ship is past
   * the middle block's edge the far block jumps three widths across and
   * the row's order rotates.
   * @param {Object} ship
   */
  recycle(ship) {
    var A = this.active;
    if (A.length%3 !== 0 || A.length < 3 || this.generating) {
      return;
    }
    for (var r = 0; r < A.length/3; r++) {
      var mid = A[1+r*3];
      var half = Math.trunc(Math.trunc(mid.width)/2);   // (int)GetWidth() / 2
      var direction = ship.x > mid.x+half ? 1 : ship.x < mid.x-half ? -1 : 0;
      if (direction === 0) {
        continue;
      }
      var first = r*3, last = first+2, block;
      if (direction == 1) {
        block = A[first];
        for (var i = first; i < last; i++) {
          A[i] = A[i+1];
        }
        A[last] = block;
      } else {
        block = A[last];
        for (var j = last; j > first; j--) {
          A[j] = A[j-1];
        }
        A[first] = block;
      }
      Track.shift(block, direction*3*block.width);
    }
  } // recycle

  /**
   * `tryDeleteSections`: the first block goes once the ship has passed its end.
   * @param {Object} ship
   */
  drop(ship) {
    var first = this.active[0];
    if (first && ship.z > first.z+first.length/2) {
      this.active.shift();
      this.dropped++;
    }
  } // drop

  // ---------------------------------------------------------- the tick

  /**
   * One FixedUpdate of the blocks: the activation of the next children of
   * every block (`ObstacleManager.FixedUpdate`), then the animations.
   * @param {Object} ship - `{x, y, z}`
   * @param {number} dt
   */
  tick(ship, dt) {
    this.active.forEach((block) => {
      var def = block.def;
      if (block.activated < def.children) {
        var upto = Math.min(def.children, block.activated+def.perTick);
        block.shapes.forEach((i) => {
          if (!i.active && i.shape.child >= block.activated && i.shape.child < upto) {
            Track.activate(i);
          }
        });
        block.activated = upto;
      }
      block.shapes.forEach((i) => {
        if (i.active && i.anim) {
          Track.animate(i, ship, dt);
        }
      });
    });
  } // tick

  /**
   * A shape switched on: at rest, its animation state fresh (`OnEnable`).
   * @param {Object} i - The shape instance.
   */
  static activate(i) {
    var s = i.shape;
    i.active = true;
    i.c = s.anim && s.anim.type == 'mover' && s.anim.offset
      ? [i.rest[0]+s.anim.offset[0], i.rest[1]+s.anim.offset[1], i.rest[2]+s.anim.offset[2]]
      : i.rest.slice();
    i.q = s.q.slice();
    i.anim = null;
    if (!s.anim) {
      return;
    }
    var a = Object.assign({}, s.anim);
    switch (a.type) {
      case 'tumble':
      case 'fall':
        a.angle = 0;
        a.stopped = false;
        a.base = {c: i.c.slice(), q: i.q.slice()};
        Track.pivot(i, a);
        break;
      case 'mover':
        a.start = i.c.slice();
        break;
      case 'slide':
        a.start = i.c.slice();
        a.t = a.phase || 0;
        break;
      case 'wave':
        a.start = i.c.slice();
        a.t = a.startPhase || 0;
        break;
      case 'spin':
        a.angle = 0;
        a.start = i.c.slice();
        a.q0 = i.q.slice();
        a.pivot = a.pivot ? [i.rest[0]-s.c[0]+a.pivot[0], a.pivot[1], i.rest[2]-s.c[2]+a.pivot[2]] : i.c.slice();
        break;
    }
    i.anim = a;
  } // activate

  /**
   * The edge a box rolls or topples about, from its world bounds
   * (`MovingBlock.chooseRotationPoint`, `FallingPillar.setRotationPoint`):
   * left — the bottom left front corner, about +Z; right — bottom right
   * front, about −Z; forward — bottom middle back, about +X; back —
   * bottom middle front, about −X.
   * @param {Object} i
   * @param {Object} a - The animation state; gets `pivot`, `axis`, `sign`.
   */
  static pivot(i, a) {
    var b = Track.bounds(i);
    switch (a.direction) {
      case 'left':
        a.pivot = [b.min[0], b.min[1], b.min[2]];
        a.axis = [0, 0, 1];
        a.sign = 1;
        break;
      case 'right':
        a.pivot = [b.max[0], b.min[1], b.min[2]];
        a.axis = [0, 0, 1];
        a.sign = -1;
        break;
      case 'forward':
        a.pivot = [(b.min[0]+b.max[0])/2, b.min[1], b.max[2]];
        a.axis = [1, 0, 0];
        a.sign = 1;
        break;
      default:                    // back
        a.pivot = [(b.min[0]+b.max[0])/2, b.min[1], b.min[2]];
        a.axis = [1, 0, 0];
        a.sign = -1;
    }
  } // pivot

  /**
   * The world axis-aligned bounds of a shape as it stands.
   * @param {Object} i
   * @returns {{min: number[], max: number[]}}
   */
  static bounds(i) {
    var s = i.shape, e;
    if (s.kind == 'sphere') {
      e = [s.r, s.r, s.r];
    } else {
      var m = Quat.toMat4(i.q), h = [s.s[0]/2, s.s[1]/2, s.s[2]/2];
      if (s.kind == 'capsule') {
        h = Track.capsuleHalf(s);
      }
      e = [0, 1, 2].map((row) => Math.abs(m[row])*h[0]+Math.abs(m[4+row])*h[1]+Math.abs(m[8+row])*h[2]);
    }
    return {min: [i.c[0]-e[0], i.c[1]-e[1], i.c[2]-e[2]], max: [i.c[0]+e[0], i.c[1]+e[1], i.c[2]+e[2]]};
  } // bounds

  /**
   * The half extents of a capsule's box: `s` = [2r, height, axis 0|1|2].
   * @param {Object} s
   * @returns {number[]}
   */
  static capsuleHalf(s) {
    var r = s.s[0]/2, h = Math.max(s.s[1], 2*r)/2, axis = s.s[2]|0;
    var half = [r, r, r];
    half[axis] = h;
    return half;
  } // capsuleHalf

  /**
   * Unity's `AnimationCurve.Evaluate`: cubic Hermite between the keys
   * `[time, value, inSlope, outSlope]`, flat beyond the ends.
   * @param {number[][]} keys
   * @param {number} t
   * @returns {number}
   */
  static curve(keys, t) {
    if (t <= keys[0][0]) {
      return keys[0][1];
    }
    var last = keys[keys.length-1];
    if (t >= last[0]) {
      return last[1];
    }
    var i = 1;
    while (keys[i][0] < t) {
      i++;
    }
    var k0 = keys[i-1], k1 = keys[i];
    var span = k1[0]-k0[0];
    var s = (t-k0[0])/span, s2 = s*s, s3 = s2*s;
    var m0 = (k0[3] || 0)*span, m1 = (k1[2] || 0)*span;
    return (2*s3-3*s2+1)*k0[1]+(s3-2*s2+s)*m0+(s3-s2)*m1+(-2*s3+3*s2)*k1[1];
  } // curve

  /**
   * Unity's `Mathf.Repeat`.
   * @param {number} t
   * @param {number} length
   * @returns {number}
   */
  static repeat(t, length) {
    return t-Math.floor(t/length)*length;
  } // repeat

  /**
   * One tick of a shape's animation.
   * @param {Object} i
   * @param {Object} ship
   * @param {number} dt
   */
  static animate(i, ship, dt) {
    var a = i.anim;
    switch (a.type) {
      case 'tumble': {
        // MovingBlock: on by speed·dt about the edge, snapped past 90° and, repeating, on from the new edge
        if (a.stopped) {
          return;
        }
        a.angle += a.speed*dt;
        var t = Quat.rotateAround(a.base.c, a.base.q, a.pivot, a.axis, a.sign*a.angle);
        i.c = t.position;
        i.q = t.rotation;
        if (a.angle > 90) {
          var d = Quat.rotateAround(a.base.c, a.base.q, a.pivot, a.axis, a.sign*90);
          i.c = d.position;
          i.q = d.rotation;
          a.base = {c: i.c.slice(), q: i.q.slice()};
          if (a.repeat) {
            a.angle = 0;
            Track.pivot(i, a);
          } else {
            a.stopped = true;
          }
        }
        break;
      }
      case 'fall': {
        // FallingPillar: the angle is a curve of how far the ship has come within zOffset
        if (ship.z > i.c[2]-a.zOffset) {
          var dz = i.c[2]-ship.z;
          if (dz > 0) {
            var f = Track.repeat((a.zOffset-dz)/a.zOffset, 1);
            a.angle = Track.curve(a.curve, f)*a.degrees;
          }
          var r = Quat.rotateAround(a.base.c, a.base.q, a.pivot, a.axis, a.sign*a.angle);
          i.c = r.position;
          i.q = r.rotation;
        }
        break;
      }
      case 'mover': {
        // MoverDistanceBased: an offset by a curve of the distance, only while the ship is within zOffset and before
        var dz2 = i.c[2]-ship.z;
        if (dz2 > 0 && dz2 < a.zOffset) {
          var f2 = Track.curve(a.curve, Track.repeat((a.zOffset-dz2)/a.zOffset, 1));
          i.c = [a.start[0]+a.distance[0]*f2, a.start[1]+a.distance[1]*f2, a.start[2]+a.distance[2]*f2];
        }
        break;
      }
      case 'slide': {
        // a sine along an axis: amplitude either way, `period` seconds, `phase` a fraction of it
        a.t += dt/a.period;
        var off = a.amplitude*Math.sin(2*Math.PI*a.t);
        var axis = a.axis == 'y' ? 1 : a.axis == 'z' ? 2 : 0;
        i.c = a.start.slice();
        i.c[axis] += off;
        break;
      }
      case 'wave': {
        // Mover: curves of a running phase, each repeating over twice its last key, times a scaler
        a.t += dt;
        var c = a.start.slice();
        ['x', 'y', 'z'].forEach((k, n) => {
          var keys = a.curves[k];
          if (keys && keys.length && a.scaler[n]) {
            var last = keys[keys.length-1][0]*2;
            c[n] += Track.curve(keys, Track.repeat(a.t, last))*a.scaler[n];
          }
        });
        i.c = c;
        break;
      }
      case 'spin':
        if (!a.perFrame) {
          Track.spin(i, a.speed*dt);
        }
        break;
    }
  } // animate

  /**
   * RotateAround about the vertical axis through the pivot, by so many degrees more.
   * @param {Object} i
   * @param {number} degrees
   */
  static spin(i, degrees) {
    var a = i.anim;
    a.angle += degrees;
    var r = Quat.rotateAround(a.start, a.q0, a.pivot, [0, 1, 0], a.angle);
    i.c = r.position;
    i.q = r.rotation;
  } // spin

  // ------------------------------------------------------- the collision

  /**
   * The first active shape the ship's box overlaps, or null.
   * @param {Object} box - `{c, q, h}`: the centre, the rotation and the half extents of the ship's trigger box.
   * @returns {Object|null} `{block, shape}`
   */
  hit(box) {
    var reach = Math.sqrt(box.h[0]*box.h[0]+box.h[1]*box.h[1]+box.h[2]*box.h[2]);
    var R = Quat.toMat4(box.q);
    for (var b = 0; b < this.active.length; b++) {
      var block = this.active[b];
      if (block.z-block.length/2 > box.c[2]+reach+50 || block.z+block.length/2 < box.c[2]-reach-50) {
        continue;
      }
      for (var k = 0; k < block.shapes.length; k++) {
        var i = block.shapes[k];
        if (!i.active) {
          continue;
        }
        var dx = i.c[0]-box.c[0], dy = i.c[1]-box.c[1], dz = i.c[2]-box.c[2];
        if (dx*dx+dy*dy+dz*dz > (reach+i.shape.bound)*(reach+i.shape.bound)) {
          continue;
        }
        if (Track.overlaps(box, R, i)) {
          return {block: block, shape: i};
        }
      }
    }
    return null;
  } // hit

  /**
   * Does the ship's box overlap a shape?
   * @param {Object} box - `{c, q, h}`
   * @param {number[]} R - The box's rotation matrix (Quat.toMat4).
   * @param {Object} i - The shape instance.
   * @returns {boolean}
   */
  static overlaps(box, R, i) {
    var s = i.shape;
    switch (s.kind) {
      case 'sphere':
        return Track.sphereInBox(i.c, s.r, box, R);
      case 'capsule': {
        // spheres along the axis, a radius apart at most
        var half = Track.capsuleHalf(s), axis = s.s[2]|0, r = s.s[0]/2;
        var len = half[axis]-r;
        var dir = [0, 0, 0];
        dir[axis] = 1;
        dir = Quat.rotate(i.q, dir);
        var n = Math.max(1, Math.ceil(2*len/Math.max(r, 1e-6)));
        for (var k = 0; k <= n; k++) {
          var t = len == 0 ? 0 : -len+2*len*k/n;
          if (Track.sphereInBox([i.c[0]+dir[0]*t, i.c[1]+dir[1]*t, i.c[2]+dir[2]*t], r, box, R)) {
            return true;
          }
        }
        return false;
      }
      default:
        return Track.boxesOverlap(box.c, box.h, R, i.c, [s.s[0]/2, s.s[1]/2, s.s[2]/2], Quat.toMat4(i.q));
    }
  } // overlaps

  /**
   * A sphere against an oriented box: the nearest point of the box.
   * @param {number[]} c - The sphere's centre.
   * @param {number} r
   * @param {Object} box - `{c, h}`
   * @param {number[]} R - The box's rotation matrix.
   * @returns {boolean}
   */
  static sphereInBox(c, r, box, R) {
    var d = [c[0]-box.c[0], c[1]-box.c[1], c[2]-box.c[2]];
    var dist2 = 0;
    for (var a = 0; a < 3; a++) {
      // the box's a-th axis is column a of R
      var p = d[0]*R[a*4]+d[1]*R[a*4+1]+d[2]*R[a*4+2];
      var e = Math.max(0, Math.abs(p)-box.h[a]);
      dist2 += e*e;
    }
    return dist2 <= r*r;
  } // sphereInBox

  /**
   * Two oriented boxes by the separating axis theorem (the 15 axes).
   * @param {number[]} ca - Centre of a.
   * @param {number[]} ha - Half extents of a.
   * @param {number[]} Ra - Rotation matrix of a (column-major; column i is axis i).
   * @param {number[]} cb
   * @param {number[]} hb
   * @param {number[]} Rb
   * @returns {boolean}
   */
  static boxesOverlap(ca, ha, Ra, cb, hb, Rb) {
    var A = [[Ra[0], Ra[1], Ra[2]], [Ra[4], Ra[5], Ra[6]], [Ra[8], Ra[9], Ra[10]]];
    var B = [[Rb[0], Rb[1], Rb[2]], [Rb[4], Rb[5], Rb[6]], [Rb[8], Rb[9], Rb[10]]];
    var dot = (u, v) => u[0]*v[0]+u[1]*v[1]+u[2]*v[2];
    var cross = (u, v) => [u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]];
    var d = [cb[0]-ca[0], cb[1]-ca[1], cb[2]-ca[2]];
    var separated = (axis) => {
      var l = dot(axis, axis);
      if (l < 1e-12) {
        return false;             // parallel edges: no new axis
      }
      var ra = 0, rb = 0, k;
      for (k = 0; k < 3; k++) {
        ra += ha[k]*Math.abs(dot(A[k], axis));
        rb += hb[k]*Math.abs(dot(B[k], axis));
      }
      return Math.abs(dot(d, axis)) > ra+rb;
    };
    for (var i = 0; i < 3; i++) {
      if (separated(A[i]) || separated(B[i])) {
        return false;
      }
    }
    for (var p = 0; p < 3; p++) {
      for (var q = 0; q < 3; q++) {
        if (separated(cross(A[p], B[q]))) {
          return false;
        }
      }
    }
    return true;
  } // boxesOverlap

  // --------------------------------------------------------- the pickups

  /**
   * The pickups the ship's box or the magnet's sphere touches this tick
   * (`OnTriggerEnter` of the player and of `PickupMagnet`, notes 12) —
   * taken off the track and returned, in the track's order.
   * @param {Object} box - `{c, q, h}`: the ship's trigger box.
   * @param {Object} [magnet] - `{c, r}`: the magnet's sphere, or null.
   * @returns {Object[]} `[{kind, c, block}]`
   */
  collect(box, magnet) {
    var P = this.pickupRules;
    if (!P) {
      return [];
    }
    var out = [];
    var R = Quat.toMat4(box.q);
    var r = P.capsule.radius, half = P.capsule.height/2-r;
    var shape = {kind: 'capsule', s: [2*r, P.capsule.height, 2]};
    var near = box.c[2]-P.capsule.height-(magnet ? magnet.r : 0)-20, far = box.c[2]+P.capsule.height+(magnet ? magnet.r : 0)+20;
    this.active.forEach((block) => {
      if (block.z-block.length/2 > far || block.z+block.length/2 < near) {
        return;
      }
      block.pickups.forEach((p) => {
        if (p.collected || p.box[2] < near || p.box[2] > far) {
          return;
        }
        var taken = Track.overlaps(box, R, {shape: shape, c: p.box, q: Quat.identity()});
        if (!taken && magnet) {
          // the sphere against the capsule: the nearest point of the axis segment
          var t = Math.max(-half, Math.min(half, magnet.c[2]-p.box[2]));
          var dx = magnet.c[0]-p.box[0], dy = magnet.c[1]-p.box[1], dz = magnet.c[2]-(p.box[2]+t);
          taken = dx*dx+dy*dy+dz*dz <= (magnet.r+r)*(magnet.r+r);
        }
        if (taken) {
          p.collected = true;
          out.push({kind: p.kind, c: p.c.slice(), block: block.id});
        }
      });
      block.pickups = block.pickups.filter((p) => !p.collected);
    });
    return out;
  } // collect

  /**
   * The pickups near the ship for the frame: the kind, the collider's
   * place, and the visual's height — an energy pickup hangs high and comes
   * down as the ship approaches (`MoverDistanceBased`, notes 12), the
   * others sit at the ship's height.
   * @param {Object} ship
   * @returns {Object[]} `[{kind, c, y}]`
   */
  pickups(ship) {
    var P = this.pickupRules, out = [];
    if (!P) {
      return out;
    }
    var F = P.energyFall;
    this.active.forEach((b) => b.pickups.forEach((p) => {
      if (p.c[2] > ship.z-100 && p.c[2] < ship.z+this.horizon) {
        var y = p.c[1];
        if (p.kind == 'energy' && F) {
          var dz = p.c[2]-ship.z;
          var f = dz >= F.over ? 0 : dz <= 0 ? 1 : Track.curve(F.curve, Track.repeat((F.over-dz)/F.over, 1));
          y = F.from-(F.from-p.c[1])*f;
        }
        out.push({kind: p.kind, c: p.c.slice(), y: y});
      }
    }));
    return out;
  } // pickups

  // ------------------------------------------------------------ the state

  /**
   * The active blocks for the frame.
   * @returns {Object[]} `[{id, x, z, width, length}]`
   */
  blocks() {
    return this.active.map((b) => ({id: b.id, x: b.x, z: b.z, width: b.width, length: b.length}));
  } // blocks

  /**
   * The active shapes near the ship for the frame: behind it a little,
   * ahead to the horizon.
   * @param {Object} ship
   * @returns {Object[]} `[{kind, look, material, c, s, q, parts?, hidden?}]` — `material` the original's material name (the reference track), null on the own track; `parts` [{mesh, materials, offset}] the original's meshes drawn with the shape (assets/worlds `meshes`), their materials and their places in the shape's frame; `hidden` a shape whose renderers other shapes draw (a tunnel of many colliders) — collides, is not drawn
   */
  obstacles(ship) {
    var out = [];
    this.active.forEach((b) => b.shapes.forEach((i) => {
      if (i.active && i.c[2] > ship.z-100 && i.c[2] < ship.z+this.horizon) {
        var o = {kind: i.shape.kind, look: i.shape.look, material: i.shape.material || null, c: i.c.slice(), s: i.shape.s.slice(), q: i.q.slice()};
        if (i.shape.parts) {
          o.parts = i.shape.parts;
        }
        if (i.shape.hidden) {
          o.hidden = true;
        }
        out.push(o);
      }
    }));
    return out;
  } // obstacles

} // Track
