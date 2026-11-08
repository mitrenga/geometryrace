const { Quat } = await import('./svision/js/platform/scene3D/quat.js?ver='+window.srcVersion);
const { Track } = await import('./track.js?ver='+window.srcVersion);
// begin code

/**
 * The rules of the game — the core loop of GR-M5 after the notes
 * (sources/docs/decompile_notes.md; the chapter of each rule is named in
 * data/global.json `rules`, which is where every number comes from — no
 * literal of the original in here). One tick is one `FixedUpdate` of the
 * original: Δt = 0.02 s (notes 3), in this order (notes 6, 6a, 10):
 *
 * 1. the energy factor — full above 6.25 % of the energy, then down with it;
 * 2. the steering input −1..1, smoothed exponentially into `pressTime`
 *    (a second, faster pass for a gamepad);
 * 3. the roll of the ship towards the smoothed input, damped by the run-up
 *    multiplier, and the yaw and pitch that follow the roll;
 * 4. the move: the sideways ratio eases towards the input (faster back to
 *    zero), the sideways speed is the ratio times the run-up and the
 *    energy factor, the forward speed is the constant speed times the
 *    energy factor — the speed never grows (notes 9);
 * 5. the camera behind the ship (notes 6a): x eased after the ship, height
 *    and distance fixed, rolled with the raw input, yawed at a point the
 *    ship is steering away from;
 * 6. the energy: nothing for the first 6 s, then a constant drain (divided
 *    by the ship's battery upgrade); below zero the run ends without an
 *    explosion (notes 10);
 * 7. the height: the ship sinks slowly under a quarter of the energy and
 *    rises back above it;
 * 8. the run-up multiplier for the next tick from the Hermite curve of the
 *    original (0.2 for the first 54 % of 2.5 s, then up to 1).
 *
 * The state machine: `playing` → `crash` (an explosion on an obstacle, or
 * the energy gone — the ship then just stops) → `over` one second later
 * (notes 2). A crash with an explosion freezes the ship and the camera (the
 * original deactivates the player); the energy running out keeps the loop
 * going with a zero energy factor, so the tilts fade and the camera settles.
 *
 * The track (GR-M6) is a {@link Track}: the rows of blocks generated
 * ahead of the ship from the world's section sequence (data/sections.json,
 * notes 8), their obstacles switched on a few per tick and animated, and
 * the collision of the ship's trigger box (3.2 × 0.5 × 10 u, rotated with
 * the ship — notes 5, 11) with them: a hit is the crash with the
 * explosion. The generator runs once per render frame in the original
 * (`LevelManager.Update`); here `tick(input, dt)` runs it after the tick
 * unless `input.frame` is false — the match tool groups the ticks of a
 * frame by the trace.
 *
 * The pickups (GR-M7, notes 12, 13): the track spawns them with its
 * blocks and hands over the ones the ship's trigger box or the magnet
 * sphere (a ship with the Magnet upgrade) touches after the move — in the
 * physics step of the original's tick, after `PlayerEnergy.FixedUpdate`,
 * so `energyFixed` in the state is the energy as that left it, before
 * the tick's pickups (what a trace records). A coin adds ⌈1 × credit
 * multiplier⌉ coins; a multiplier raises the credit multiplier by one up
 * to 6 and (re)starts its timer of 5 s × the ship's Multiplier upgrade —
 * the timer runs down a tick at a time from the tick of the pickup (the
 * coroutine after `WaitForFixedUpdate` takes its first step at once) and
 * under zero the multiplier is 1 again; an energy pickup fills the tank.
 * The score is the distance (notes 13); the coins of the run go to the
 * player's total at the end (GR-M8). The ship's upgrades come in as
 * multipliers (`battery`, `coins`, `multiplier`, `magnet` — notes 14).
 *
 * No DOM, no Math.random(): the only randomness is `options.random`, a
 * byte source (0..255) the worker builds from the seed. `tick(input, dt)`
 * takes the input as `{left, right}` booleans (the keys and touch halves,
 * −1/0/+1) or `{steer}` −1..1 (a gamepad axis, or a trace), `pad` for the
 * gamepad's faster smoothing, and an optional `dt` for the match mode — the
 * fixed step of the rules otherwise. Every intermediate the original keeps
 * is in the state (`input`, `camera`), so `matchstate` can compare it.
 */
export class Game {

  /**
   * @param {Object} data - The game's data: `{global, ships, worlds, sections}` of data/*.json (GR-M4); `global.rules` is required.
   * @param {Object} options - `random`: the byte source of randomness; `playerName`; `shipId`; `world`; the ship's upgrade multipliers (notes 14; 1 by default): `battery` 1–2, `coins` 1–3 (the coins' spawn amount), `multiplier` 1–3 (the credit multiplier's time), `magnet` 1–2 (0 or none: no magnet); `track: false` runs without a track (matchstate: the original's track is not in a GR-M5 trace); `trackData` replaces data/sections.json (`{blocks, worlds}` — matchtrack's reference); `rng` replaces the generator's randomness (`{rangeFloat, rangeInt, chance}` — matchtrack's recorded values).
   */
  constructor(data, options) {
    this.data = data || {};
    if (!this.data.global || !this.data.global.rules) {
      throw new Error('Game: data.global.rules is missing (data/global.json)');
    }
    this.rules = this.data.global.rules;
    this.dt = (this.data.global.tick && this.data.global.tick.dt) || 0.02;
    this.random = options.random;
    this.playerName = options.playerName || '';
    this.battery = options.battery || 1;
    this.upgrades = {coins: options.coins || 1, multiplier: options.multiplier || 1, magnet: options.magnet || 0};
    this.tickCount = 0;
    this.time = 0;                // game seconds since the start (the run-up clock, the energy's safe time)
    this.done = false;
    this.phase = 'playing';       // 'playing' | 'crash' | 'over'
    this.crashTime = 0;           // seconds since the crash
    this.crashReason = null;      // 'explosion' | 'energy'
    // the ship and the world: the default ship of data/ships.json and the
    // first world until the store and the world menu come (GR-M8)
    var ships = (this.data.ships && this.data.ships.ships) || [];
    var defaultShip = ships.find((s) => s.default) || ships[0] || null;
    this.shipId = options.shipId || (defaultShip ? defaultShip.id : null);
    this.world = options.world || 0;
    this.events = [];             // what the tick did (sounds later): names

    var R = this.rules;
    this.ship = {x: 0, y: R.ship.y, z: R.ship.startZ, roll: 0, yaw: 0, pitch: 0, visible: true};
    this.speed = R.ship.speed;
    this.energy = 1;
    this.energyFixed = 1;         // the energy as PlayerEnergy.FixedUpdate left it, before the tick's pickups
    this.energyEmpty = false;     // the crash for the energy has fired
    this.lowEnergy = false;       // under the warning threshold (the HUD blinks, the ship sinks)
    this.coins = 0;               // creditsThisRace
    this.multiplier = 1;          // the credit multiplier 1..6 (PowerupManager)
    this.multiplierTimer = 0;     // actualTimerMultiplier: seconds left while it runs, then a little under zero
    this.multiplierOn = false;    // doubleCreditTimerStarted
    this.collected = {coin: 0, multiplier: 0, energy: 0};
    this.lastPickup = null;       // {kind, amount, tick} of the last one, for the HUD's message
    this.pickupsThisTick = [];    // the pickups collected in the tick, as the track handed them over (the match tools)
    // the intermediates of PlayerControl (notes 6)
    this.input = {touch: 0, pressTime: 0, visualPressTime: 0, tilt: 0, ratio: 0, velocityX: 0, inputMultiplier: 0, energyFactor: 1, booster: false};
    // the camera (notes 6a): behind the ship, pitched down a little, its own eased roll
    this.camera = {x: R.camera.offset[0], y: R.camera.height, z: R.ship.startZ+R.camera.dz, roll: 0, yaw: 0, pitch: R.camera.pitch, tilt: 0};
    this.track = null;
    this.hit = null;              // what the ship crashed into: {block, shape}
    if (options.track !== false) {
      this.makeTrack(options.trackData || this.data.sections, options.rng);
    }
  } // constructor

  // ------------------------------------------------------------------ helpers

  /**
   * A number 0..1 from the byte source.
   * @returns {number}
   */
  rnd() {
    return this.random()/256;
  } // rnd

  /**
   * The generator's randomness from the byte source, in the shape of the
   * original's `Random.Range`: two bytes make 16 bits.
   * @returns {Object} `{rangeFloat(min, max), rangeInt(min, max)}` — `max` excluded for the int.
   */
  rangeSource() {
    var next = () => (this.random()*256+this.random())/65536;
    return {
      rangeFloat: (min, max) => min+next()*(max-min),
      rangeInt: (min, max) => min+Math.floor(next()*(max-min)),
      chance: () => next()
    };
  } // rangeSource

  /**
   * Unity's `Mathf.Lerp`: a + (b − a) × t with t clamped to 0..1.
   * @param {number} a
   * @param {number} b
   * @param {number} t
   * @returns {number}
   */
  static lerp(a, b, t) {
    return a+(b-a)*(t < 0 ? 0 : t > 1 ? 1 : t);
  } // lerp

  /**
   * Clamps a value to 0..1 (`Mathf.Lerp(0, 1, t)` of the original).
   * @param {number} t
   * @returns {number}
   */
  static clamp01(t) {
    return t < 0 ? 0 : t > 1 ? 1 : t;
  } // clamp01

  /**
   * A signed angle in −180..180 from one in 0..360.
   * @param {number} a
   * @returns {number}
   */
  static signedAngle(a) {
    a = (a%360+360)%360;
    return a > 180 ? a-360 : a;
  } // signedAngle

  // ---------------------------------------------------------------- the track

  /**
   * The track of the world: its blocks and section sequence
   * (data/sections.json by the world's id, or the data handed in), the
   * world's tiling (data/worlds.json), the generator's randomness, and the
   * first block placed (`LevelManager.StartGame`).
   * @param {Object} sections - `{blocks: [...] | {id: def}, worlds: {id: {sections}}}`
   * @param {Object} [rng] - `{rangeFloat, rangeInt}`; the byte source's otherwise.
   */
  makeTrack(sections, rng) {
    if (!sections || !sections.blocks || !sections.worlds) {
      throw new Error('Game: data.sections is missing (data/sections.json)');
    }
    var worlds = (this.data.worlds && this.data.worlds.worlds) || [];
    var world = worlds[this.world] || {id: Object.keys(sections.worlds)[0], tiling: 4};
    var sequence = sections.worlds[world.id] || sections.worlds[this.world];
    if (!sequence) {
      throw new Error('Game: no sections for world '+world.id);
    }
    var blocks = {};
    if (Array.isArray(sections.blocks)) {
      sections.blocks.forEach((b) => { blocks[b.id] = b; });
    } else {
      blocks = sections.blocks;
    }
    this.track = new Track({blocks: blocks, sections: sequence.sections, tiling: world.tiling, rules: this.rules.track, rng: rng || this.rangeSource(),
      pickups: this.rules.pickups, coinsMultiplier: this.upgrades.coins});
    this.track.start(this.ship);
  } // makeTrack

  /**
   * The ship's trigger box in the world (notes 5: 3.2 × 0.5 × 10 u, its
   * centre 0.4 u above the pivot, turned with the ship).
   * @returns {Object} `{c, q, h}`
   */
  shipBox() {
    var C = this.rules.ship.collider, s = this.ship;
    var q = Quat.fromEuler(s.pitch, s.yaw, s.roll, 'zxy');
    var up = Quat.rotate(q, [0, C.centerY, 0]);
    return {c: [s.x+up[0], s.y+up[1], s.z+up[2]], q: q, h: [C.width/2, C.height/2, C.length/2]};
  } // shipBox

  /**
   * The magnet's sphere (notes 5: 10 u, 12.3 u ahead of the pivot, turned
   * with the ship; its radius times the Magnet upgrade), or null for a ship
   * without the upgrade.
   * @returns {Object|null} `{c, r}`
   */
  magnetSphere() {
    var m = this.upgrades.magnet;
    if (!(m > 0)) {
      return null;
    }
    var M = this.rules.ship.magnet, s = this.ship;
    var q = Quat.fromEuler(s.pitch, s.yaw, s.roll, 'zxy');
    var ahead = Quat.rotate(q, [0, 0, M.ahead]);
    return {c: [s.x+ahead[0], s.y+ahead[1], s.z+ahead[2]], r: M.radius*m};
  } // magnetSphere

  // ------------------------------------------------------------------ the run

  /**
   * The end of the run (`PlayerCrash.Crash`, notes 2, 10): with an
   * explosion the ship disappears and everything freezes; without one (the
   * energy gone) the ship stays and the loop goes on with a zero factor.
   * @param {boolean} explosion
   */
  crash(explosion) {
    if (this.phase != 'playing') {
      return;
    }
    this.phase = 'crash';
    this.crashTime = 0;
    this.crashReason = explosion ? 'explosion' : 'energy';
    this.events.push(explosion ? 'crash' : 'energyOut');
    if (explosion) {
      this.ship.visible = false;
    }
  } // crash

  /**
   * One tick: one FixedUpdate of the original.
   * @param {Object} input - `{left, right}` booleans, or `{steer}` −1..1; `pad` true for a gamepad's smoothing.
   * @param {number} [dt] - The step in seconds; the rules' fixed step by default.
   * @returns {Object} The state of the frame (the shape of Playfield.emptyState()).
   */
  tick(input, dt) {
    dt = dt || this.dt;
    this.tickCount++;
    this.events = [];
    this.pickupsThisTick = [];
    input = input || {};

    if (this.phase == 'crash' || this.phase == 'over') {
      this.crashTime += dt;
      if (this.phase == 'crash' && this.crashTime >= this.rules.crash.deathDelay-1e-9) {
        this.phase = 'over';
        this.done = true;
        this.events.push('gameOver');
      }
      if (this.crashReason == 'explosion') {
        return this.state();        // the player is deactivated: nothing moves
      }
    }

    // the run-up multiplier (PlayerControl.InputMultiplier): the curve over
    // the first 2.5 s, then 1 — read before the tick advances the clock
    var R = this.rules, S = R.steer, I = this.input;
    I.inputMultiplier = this.time < S.startTime ? Track.curve(S.startCurve, this.time/S.startTime) : 1;

    // 1. the energy factor (notes 6 step 1, 10)
    I.energyFactor = Game.clamp01(this.energy/R.energy.weak);

    // 2. the input, smoothed (notes 6 step 3; notes 7)
    var touch = typeof input.steer == 'number' ? input.steer : (input.right ? 1 : 0)-(input.left ? 1 : 0);
    touch = Math.max(-1, Math.min(1, touch));
    I.touch = touch;
    I.pressTime = Game.lerp(I.pressTime, touch, S.smooth*dt);
    I.visualPressTime = Game.lerp(I.visualPressTime, touch, S.smooth*dt);
    if (input.pad) {
      I.pressTime = Game.lerp(I.pressTime, touch, S.smoothPad*dt);
      I.visualPressTime = Game.lerp(I.visualPressTime, touch, S.smoothPad*dt);
    }
    // `Mathf.Approximately(pressTime, 0)` of the original only catches an
    // exact zero at these magnitudes; the same here
    if (Math.abs(I.pressTime) < 1e-38) {
      I.pressTime = 0;
    }

    // 3. the roll and what follows it (PlayerControl.Rotate)
    var T = R.tilt;
    I.tilt = Game.lerp(I.tilt, -I.visualPressTime*T.angle*I.energyFactor, T.speed*dt);
    I.tilt *= I.inputMultiplier;
    this.ship.roll = I.tilt;
    this.ship.yaw = -I.tilt*T.yaw;
    this.ship.pitch = Math.abs(I.tilt)*T.pitch;

    // 4. the move (PlayerControl.Move; no 3D Touch pressure on Android)
    var target = -I.pressTime*S.target*I.energyFactor;
    I.ratio = Game.lerp(I.ratio, target, (target === 0 ? S.ratioSmoothToZero : S.ratioSmooth)*dt);
    var booster = Math.abs(target) > S.boosterThreshold;
    if (booster != I.booster) {
      I.booster = booster;
      this.events.push(booster ? 'boosterOn' : 'boosterOff');
    }
    I.velocityX = -I.ratio*I.energyFactor*I.inputMultiplier*S.velocityFactor*dt;
    this.ship.x += I.velocityX;
    this.ship.z += I.energyFactor*this.speed*dt;

    // 5. the camera (CameraMover.UpdateCamera, called from Move)
    this.moveCamera(dt);

    // 6. the energy (PlayerEnergy.FixedUpdate)
    var E = R.energy;
    if (this.time >= E.safeTime-1e-9) {
      this.energy -= E.drain*dt/this.battery;
    }
    this.energyFixed = this.energy;
    if (this.energy < 0 && !this.energyEmpty) {
      this.energyEmpty = true;
      this.crash(false);
    }
    var low = this.energy < E.low;
    if (low != this.lowEnergy) {
      this.lowEnergy = low;
      this.events.push(low ? 'lowEnergy' : 'energyOk');
    }

    // 7. the height (ShipPosition.ShipGoDowm): sinking under the threshold, rising above it
    if (this.energy < E.low) {
      this.ship.y = Game.lerp(this.ship.y, E.sinkTo, E.sinkRate*dt);
    } else if (this.energy > E.low) {
      this.ship.y = Game.lerp(this.ship.y, R.ship.y, E.riseRate*dt);
    }

    // the credit multiplier's timer (the coroutine after WaitForFixedUpdate, notes 12)
    this.runMultiplier(dt);

    // the track: the obstacles switched on and moved (their FixedUpdates),
    // the physics step's triggers (notes 11 — an obstacle; notes 12 — the
    // pickups), then the frame's generator (LevelManager.Update — after
    // the ticks of a render frame)
    if (this.phase == 'playing' && this.track) {
      this.track.tick(this.ship, dt);
      var box = this.shipBox();
      var hit = this.track.hit(box);
      if (hit) {
        this.hit = {block: hit.block.id, shape: hit.shape.shape};
        this.crash(true);
      } else {
        this.track.collect(box, this.magnetSphere()).forEach((p) => this.applyPickup(p, dt));
      }
      if (input.frame !== false && this.phase == 'playing') {
        this.track.frameUpdate(this.ship);
      }
    }

    this.time += dt;
    return this.state();
  } // tick

  /**
   * One step of the credit multiplier's timer: down by the step while it
   * runs; under zero the multiplier is 1 again and the timer stops where it
   * is (`startCountingDownCreditMultiplier`).
   * @param {number} dt
   */
  runMultiplier(dt) {
    if (!this.multiplierOn) {
      return;
    }
    this.multiplierTimer -= dt;
    if (this.multiplierTimer < 0) {
      this.multiplier = 1;
      this.multiplierOn = false;
      this.events.push('multiplierOff');
    }
  } // runMultiplier

  /**
   * A pickup collected (`PowerupManager.ApplyPowerup` → the powerup's,
   * notes 12): a coin, a multiplier, an energy.
   * @param {Object} p - `{kind, c, block}` as the track hands it over.
   * @param {number} dt - The tick's step (the timer's first step).
   */
  applyPickup(p, dt) {
    var P = this.rules.pickups, amount = 0;
    switch (p.kind) {
      case 'coin':
        amount = Math.ceil(P.coinValue*this.multiplier);
        this.coins += amount;
        break;
      case 'multiplier':
        if (this.multiplier < P.multiplierMax) {
          this.multiplier++;
        }
        this.multiplierTimer = P.multiplierTime*this.upgrades.multiplier-dt;
        this.multiplierOn = true;
        amount = this.multiplier;
        break;
      case 'energy':
        this.energy = 1;
        amount = 1;
        break;
    }
    this.collected[p.kind]++;
    this.pickupsThisTick.push(p);
    this.lastPickup = {kind: p.kind, amount: amount, tick: this.tickCount};
    this.events.push('pickup:'+p.kind);
  } // applyPickup

  /**
   * The camera of the original (notes 6a): its x eased after the ship's,
   * the height and the distance behind fixed, the roll eased towards the
   * raw input times the run-up, the yaw a quaternion lerp towards the look
   * at a point the ship is moving away from.
   * @param {number} dt
   */
  moveCamera(dt) {
    var K = this.rules.camera, c = this.camera, s = this.ship, I = this.input;
    c.x = Game.lerp(c.x, s.x+K.offset[0], K.lerp*dt);
    c.y = K.height;
    c.z = s.z+K.dz;
    c.tilt = Game.lerp(c.tilt, I.touch*K.maxRoll, K.rollSpeed*dt);
    c.roll = c.tilt*I.inputMultiplier;
    var lookX = s.x-I.velocityX*K.lookBack;
    var forward = [lookX-c.x, 0, s.z-c.z];
    var current = Quat.fromEuler(c.pitch, c.yaw, c.roll, 'zxy');
    var wanted = Quat.lookRotation(forward);
    var e = Quat.toEuler(Quat.lerp(current, wanted, K.yawSpeed*dt), 'zxy');
    c.yaw = Game.signedAngle(e[1]);
  } // moveCamera

  /**
   * The state of the frame: what the playfield draws and the HUD shows,
   * and every intermediate `matchstate` compares.
   * @returns {Object}
   */
  state() {
    var s = this.ship;
    return {
      tick: this.tickCount,
      time: Math.round(this.time*1e6)/1e6,
      phase: this.phase,
      shipId: this.shipId,
      world: this.world,
      ship: {x: s.x, y: s.y, z: s.z, roll: s.roll, yaw: s.yaw, pitch: s.pitch, visible: s.visible},
      crash: this.phase == 'playing' ? null : {time: Math.round(this.crashTime*1e6)/1e6, reason: this.crashReason},
      camera: {x: this.camera.x, y: this.camera.y, z: this.camera.z, roll: this.camera.roll, yaw: this.camera.yaw, pitch: this.camera.pitch},
      input: Object.assign({}, this.input),
      speed: this.speed,
      energy: this.energy,
      energyFixed: this.energyFixed,
      lowEnergy: this.lowEnergy,
      distance: Math.trunc(Math.trunc(s.z)/10),
      coins: this.coins,
      multiplier: {value: this.multiplier, timer: this.multiplierTimer, on: this.multiplierOn, time: this.rules.pickups.multiplierTime*this.upgrades.multiplier},
      collected: Object.assign({}, this.collected),
      lastPickup: this.lastPickup,
      track: this.track ? {section: this.track.section, generated: this.track.generated.length, active: this.track.active.length, spawned: this.track.spawned.length} : null,
      blocks: this.track ? this.track.blocks() : [],
      obstacles: this.track ? this.track.obstacles(s) : [],
      pickups: this.track ? this.track.pickups(s) : []
    };
  } // state

} // Game
