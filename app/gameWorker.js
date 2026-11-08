const { Playfield } = await import('./playfield.js?ver='+window.srcVersion);
const { Game } = await import('./game.js?ver='+window.srcVersion);
// begin code

/**
 * The game program of the worker. It is glued at run time out of this
 * module and the ones it needs (svision `ModuleWorker`, the list in
 * `MainModel.WORKER_SOURCES`: the Mesh of svision, the playfield, the
 * game), ticks at the original's fixed step — `FixedUpdate` at 50 Hz,
 * Δt = 0.02 s (notes 3) — and posts the frame: the state of the game and
 * the picture the playfield composed from it, as data the model puts into
 * its Scene3D. The same class runs under Node for the tools:
 * `new GameWorker(post)` with `handleMessage()` and `tick()`, no timers
 * (app/WORKER-PROTOCOL.md).
 *
 * The clock is an accumulator over `performance.now()`: as many ticks as
 * the wall clock owes, at most 8 after a sleep, then the last frame is
 * posted. The randomness is seeded from the first day: the `init` message
 * carries the seed (the tools pass a fixed one, the game the clock or
 * `?devSeed=N`), `random` is the byte source built from it (mulberry32,
 * METHODOLOGY) and the only source of randomness the game gets
 * (`options.random` of {@link Game}). No `Math.random()`. In the match
 * mode (`tools/matchstate.mjs`, `tools/matchtrack.mjs`) a headless `tick`
 * message carries the frame's input and `dt` from the trace instead of the
 * held actions, and `init` may carry the reference track (`trackData`) and
 * the recorded randomness (`rng`).
 */
export class GameWorker {

  /**
   * One tick in milliseconds: the fixed step of the rules (data/global.json
   * `tick.dt`, the original's 0.02 s — notes 3), 20 ms before a game exists.
   * @returns {number}
   */
  tickMs() {
    return (this.game ? this.game.dt : 0.02)*1000;
  } // tickMs

  /**
   * @param {Function} post - Sends a message to the model (`postMessage`).
   */
  constructor(post) {
    this.post = post;
    this.data = null;
    this.playfield = new Playfield();
    this.game = null;
    this.state = Playfield.emptyState();
    this.seed = 0;
    this.random = null;             // the byte source of the game's randomness
    this.tickCount = 0;
    this.actions = {left: false, right: false, steer: 0, pad: false};   // steer: a gamepad axis −1..1 (GR-M9)
    this.running = false;
    this.paused = false;
    this.timer = null;
    this.lastTime = 0;
    this.accumulator = 0;
    this.frame = null;
    this.headless = false;
  } // constructor

  /**
   * mulberry32 as a byte source: `seededSource(seed)()` is 0..255.
   * @param {number} seed
   * @returns {Function}
   */
  static seededSource(seed) {
    var a = seed >>> 0;
    return function() {
      a = (a+0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t+Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 8) & 0xFF;
    };
  } // seededSource

  /**
   * A message from the model (or a tool).
   * @param {Object} msg
   */
  handleMessage(msg) {
    switch (msg.id) {
      case 'init':
        // the data, the seed; the game starts at once
        this.data = msg.data || null;
        this.playfield = new Playfield(this.data);
        this.seed = msg.seed >>> 0;
        this.headless = !!msg.headless;
        this.random = GameWorker.seededSource(this.seed);
        this.game = new Game(this.data, {random: this.random, playerName: msg.playerName || '', shipId: msg.shipId, world: msg.world,
          battery: msg.battery, coins: msg.coins, multiplier: msg.multiplier, magnet: msg.magnet,
          track: msg.track, trackData: msg.trackData, rng: msg.rng});
        if (typeof msg.setup === 'function') {
          msg.setup(this.game);                       // the tools: a state to start from
        }
        this.state = this.game.state();
        this.tickCount = 0;
        this.frame = null;
        this.paused = false;
        this.actions = {left: false, right: false, steer: 0, pad: false};
        if (!this.headless) {
          this.start();
        }
        break;
      case 'controls':
        if (msg.action == 'steer') {
          this.actions.steer = +msg.value || 0;      // a gamepad axis: continuous
          this.actions.pad = true;
        } else if (msg.action in this.actions) {
          this.actions[msg.action] = !!msg.value;
          this.actions.pad = false;
        }
        break;
      case 'pause':
        this.paused = true;
        break;
      case 'continue':
        this.paused = false;
        break;
      case 'reset':
        this.stop();
        this.game = null;
        this.random = null;
        break;
      case 'tick':
        // headless: exactly one tick, posted; `input` and `dt` (a trace's
        // frame) replace the held actions and the fixed step; `frame: false`
        // holds the track's per-frame generator back (matchtrack groups
        // the ticks of a render frame)
        if (this.game) {
          var input = msg.input || this.gameInput();
          if (msg.frame === false) {
            input = Object.assign({frame: false}, input);
          }
          this.tick(input, msg.dt);
          this.postFrame();
        }
        break;
    }
  } // handleMessage

  /**
   * The actions as the game takes them: the keys' −1/0/+1 as `{left,
   * right}`, a gamepad axis as `{steer, pad}` when it was the last to move.
   * @returns {Object}
   */
  gameInput() {
    var a = this.actions;
    if (a.pad) {
      return {steer: a.steer, pad: true};
    }
    return {left: a.left, right: a.right};
  } // gameInput

  /**
   * One tick: the game's tick with the actions as held (or a given input),
   * the frame composed by the playfield.
   * @param {Object} [input] - Replaces the held actions (the match mode).
   * @param {number} [dt] - Replaces the fixed step (the match mode).
   */
  tick(input, dt) {
    this.tickCount++;
    this.state = this.game.tick(input || this.gameInput(), dt);
    this.frame = {
      id: 'frame',
      tick: this.tickCount,
      state: this.state,
      scene: this.playfield.frame(this.state),
      gameOver: this.game.done,
      sounds: this.game.events.slice()
    };
  } // tick

  postFrame() {
    if (!this.frame) {
      return;
    }
    var f = this.frame;
    this.frame = null;
    this.post(f);
    if (f.gameOver && !this.headless && this.running) {
      this.stop();
    }
  } // postFrame

  // -------------------------------------------------------------------- clock

  start() {
    this.running = true;
    this.lastTime = 0;
    this.accumulator = 0;
    this.tick();
    this.postFrame();
    this.loop();
  } // start

  stop() {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  } // stop

  /**
   * The fixed-step loop: as many ticks as the wall clock owes, then sleep
   * until the next one is due. A pause stops the ticks, not the clock.
   */
  loop() {
    if (!this.running) {
      return;
    }
    var now = performance.now();
    if (this.lastTime) {
      this.accumulator += now-this.lastTime;
    }
    this.lastTime = now;
    if (this.paused) {
      this.accumulator = 0;
    } else {
      var ticks = 0, tickMs = this.tickMs();
      while (this.accumulator >= tickMs && ticks < 8 && this.running) {
        this.tick();
        this.accumulator -= tickMs;
        ticks++;
      }
      if (ticks === 8) {
        this.accumulator = 0;   // the tab was asleep: do not catch up
      }
      this.postFrame();
    }
    var self = this;
    this.timer = setTimeout(function() { self.loop(); }, Math.max(1, this.tickMs()-this.accumulator));
  } // loop

} // GameWorker

// In the worker the program wires itself up; under Node (the tools) and on
// the main thread (should anyone import this) it stays a class.
if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof self.document === 'undefined') {
  var gameWorker = new GameWorker(function(msg) { self.postMessage(msg); });
  self.onmessage = function(event) { gameWorker.handleMessage(event.data); };
}
