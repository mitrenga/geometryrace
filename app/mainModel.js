const { AbstractModel } = await import('./svision/js/abstractModel.js?ver='+window.srcVersion);
const { AbstractEntity } = await import('./svision/js/abstractEntity.js?ver='+window.srcVersion);
const { ModuleWorker } = await import('./svision/js/moduleWorker.js?ver='+window.srcVersion);
const { SceneEntity } = await import('./svision/js/platform/scene3D/sceneEntity.js?ver='+window.srcVersion);
const { TextEntity } = await import('./svision/js/platform/canvas2D/textEntity.js?ver='+window.srcVersion);
const { ZXDialogEntity } = await import('./svision/js/platform/canvas2D/zx/zxDialogEntity.js?ver='+window.srcVersion);
const { ZXPlayerNameEntity } = await import('./svision/js/platform/canvas2D/zx/zxPlayerNameEntity.js?ver='+window.srcVersion);
const { NoticeEntity } = await import('./noticeEntity.js?ver='+window.srcVersion);
const { MenuModel } = await import('./menuModel.js?ver='+window.srcVersion);
const { Playfield } = await import('./playfield.js?ver='+window.srcVersion);
const { AudioManager } = await import('./audioManager.js?ver='+window.srcVersion);
// begin code

/**
 * The game screen. The game runs in the worker (gameWorker.js, glued out
 * of its modules by svision's ModuleWorker — the Mesh of svision, the
 * playfield, the game, the worker) at the original's fixed step (50 Hz)
 * and posts every frame as data: the state (for the HUD) and the picture
 * the playfield composed (for the scene). This model puts the picture into
 * the Scene3D of a SceneEntity over the whole desktop (`Playfield.build`,
 * the meshes resolved from its own library), lays the HUD out on the 2D
 * overlay — the energy bar, the distance, the coins, the credit multiplier
 * with its timer while it runs, and a message for a second after a pickup
 * (GR-M7, the contents of the original's HUD, notes 12, 18), the record of
 * the world under the distance and NEW RECORD! once it falls (GR-M8,
 * `GameManager.Update`) — routes the controls to the worker and ends the
 * game: when the worker reports `gameOver` (an explosion, or the energy
 * gone — a second after the crash, notes 2) the run is booked into the
 * progress (`app.finishGame`: the coins to the total, the record of the
 * world), the player is asked for a name when there is none yet
 * (ZXPlayerNameEntity), the score goes to the hall of fame under it, and a
 * notice shows the distance, the record or NEW RECORD!, the coins of the
 * run and the total — the `RestartMenu` of the original in the game's own
 * words (notes 18); Enter or Escape goes back to the menu. The run starts
 * with the progress's world and active ship and the ship's upgrade
 * multipliers (`init` of the worker, GR-M8). The seed of the game's
 * randomness goes to the worker with `init` from the first day.
 *
 * Controls (ZADANI chap. 5): steer left / right — keyboard (arrows, A/D)
 * and gamepad map to the actions; a touch steers by the half of the screen
 * it is in, in the lower three quarters of it (`PlayerInput.mobileInput`,
 * notes 7), follows the finger, and the actions sent are the union of all
 * touches. Escape (Exit), the pause key (space) and losing the window's
 * focus pause the game behind a notice: Enter continues, Escape quits to
 * the menu.
 *
 * Sound (GR-M9): everything the game plays is a recording of the
 * original (the operator, 2026-09-16 — study only, ZADANI chap. 7 and 8;
 * nothing is synthesized, so a missing file means silence, not a
 * substitute). `openAudio` opens what `app.ensureSfx` and
 * `app.ensureMusic` brought: the bus `sfx` is the one `pickupAudio`
 * source of the original's SoundManager — the pickup, the explosion (a
 * crash and the energy out alike, `PlayerCrash.Crash`), the boosters and
 * the countdown's ping play on it, each cutting the one before, at the
 * pitch of the pickup ladder (`AudioManager.PITCH`, `PlayPickupSfx`:
 * play, then step up while at most 1.8; back to 1 after two seconds
 * without a pickup) — and `music` is the track of the world. The events
 * of a frame (WORKER-PROTOCOL.md `sounds`) go through `playSounds`; the
 * ones the original has no sound for (the low energy, the multiplier
 * running out, the end of the boosters) pass silently. The music
 * behaves as the original's SoundManager (notes 17): it starts 0.3 s
 * into the run and loops, it holds in a pause (rate 0), it slows down
 * with the energy under a quarter (rate = energy / 0.25, notes 10) and
 * it fades out over half a second at the end.
 *
 * Coming back from a pause is the countdown of the original
 * (`UnpauseCounting` with `GameManager.ResumeGame`, notes 2): the music
 * starts again at once while the game still stands, three digits count
 * down, each shrinking over 0.55 s (the original lerps the scale, our
 * pixel font steps it) with a ping on its first frame, a fourth ping
 * when they are done, and the game itself goes on after 1.8 s. Every
 * ping puts the pickup ladder back to 1, as the original's
 * `ResetPickupAudioPitch` does. A pause pauses the buses, the end of the run stops
 * the engine and the warning, leaving for the menu closes everything (the
 * menu is silent, R-024). The tools' stand-in application has no manager
 * (`hasAudio`).
 */
export class MainModel extends AbstractModel {

  /** the modules the worker is glued from, in dependency order (also config/compile.json `standalone`) */
  static get WORKER_SOURCES() {
    return [
      'svision/js/platform/scene3D/vec3.js',
      'svision/js/platform/scene3D/mat4.js',
      'svision/js/platform/scene3D/quat.js',
      'svision/js/platform/scene3D/mesh.js',
      'playfield.js',
      'track.js',
      'game.js',
      'gameWorker.js'
    ];
  } // WORKER_SOURCES

  /** the HUD: colours, the energy bar's size, the multiplier bar's size (desktop units), how long a pickup's message stays (ticks) */
  static get HUD() {
    return {text: '#ffffff', dim: '#8fb3e6', bar: '#2e8b57', barLow: '#e0524a', barBack: '#16243d', barWidth: 160, barHeight: 8,
      multiplier: '#7bf27b', multiplierWidth: 120, inset: 8, messageTicks: 50};
  } // HUD

  /** the messages of the pickups (the original's infoText in the game's own words, notes 12) */
  static get MESSAGES() {
    return {coin: (n) => 'COINS +'+n, multiplier: (n) => 'COIN MULTIPLIER X'+n, energy: () => 'ENERGY RESTORED!'};
  } // MESSAGES

  /** the music (notes 17): the delay of its start into the run (ms), the fade at the end (s) and the stop of the tune after it (ms), the energy under which it slows (notes 10) */
  static get MUSIC() { return {startDelay: 300, fade: 0.5, stopDelay: 500, lowEnergy: 0.25}; }

  /**
   * The countdown out of a pause (`UnpauseCounting`, notes 2): three
   * digits, one every 550 ms (the original's counter runs to 0.99 at
   * 1.8 a second), the game back after 1800 ms, and the digit at this
   * height in pixels of the 5x5 font before it shrinks (20 x 5 = 100 of the
   * desktop's 360).
   */
  static get COUNTDOWN() { return {digits: 3, step: 550, resume: 1800, scale: 20, color: '#ffffff'}; }

  /** the touch zones: a touch steers only in the lower part of the screen (notes 7: under 75 % of the height) */
  static get TOUCH_TOP() { return 0.25; }

  /**
   * @param {GameApp} app
   */
  constructor(app) {
    super(app);
    this.id = 'MainModel';
    this.playfield = new Playfield(app.gameData());
    this.view = null;
    this.hud = {bar: null, barBack: null, distance: null, record: null, coins: null, multiplier: null, multiplierBar: null, multiplierBack: null, message: null, fps: null};
    var p = app.progress;
    this.record = p ? p.record(p.world) : 0;    // the record of the world at the start (targetDistance; 0: none to beat)
    this.newRecordTick = -1;                     // the tick NEW RECORD! came up, or -1
    this.finished = null;                        // what finishGame returned
    this.askingName = false;                     // the name dialog is open before the game-over notice
    this.ready = false;
    this.frame = null;              // the last frame message
    this.drawnTick = -1;
    this.gameOver = false;
    this.fps = {frames: 0, workerFrames: 0, since: false};
    this.touches = {};              // identifier -> action
    this.touchActions = {left: false, right: false};
    this.paused = false;
    this.pitch = {factor: 1, tick: -1};   // the pickup ladder: the pitch of the effects' source after the last pickup, the tick of it
    this.musicRate = 1;             // the track's rate as last sent
    this.musicOver = false;         // the music faded at the end
    this.countdown = null;          // {since, pings} while the countdown out of a pause runs
  } // constructor

  init() {
    super.init();

    this.desktopEntity.bkColor = false;   // the 3D picture shows through the overlay
    var w = this.desktopWidth, h = this.desktopHeight;
    var H = MainModel.HUD;

    // the viewport into the world: the whole desktop
    this.view = new SceneEntity(this.desktopEntity, 0, 0, w, h, '#ffffff', false);
    this.desktopEntity.addEntity(this.view);
    Playfield.build(this.view.scene, this.playfield.frame(Playfield.emptyState()), this.playfield);

    // the HUD on the overlay: the energy bar top left, the distance in the
    // middle, the coins top right (the layout of the original's HUD is not
    // copied; its contents are, notes 18)
    this.hud.barBack = new AbstractEntity(this.desktopEntity, 0, 0, H.barWidth, H.barHeight, false, H.barBack);
    this.desktopEntity.addEntity(this.hud.barBack);
    this.hud.bar = new AbstractEntity(this.desktopEntity, 0, 0, H.barWidth, H.barHeight, false, H.bar);
    this.desktopEntity.addEntity(this.hud.bar);
    this.hud.energy = new TextEntity(this.desktopEntity, this.app.fonts.fonts5x5, 0, 0, H.barWidth, 8, 'ENERGY', H.dim, false, {});
    this.desktopEntity.addEntity(this.hud.energy);
    this.hud.distance = new TextEntity(this.desktopEntity, this.app.fonts.fonts5x5, 0, 0, 200, 12, '0 M', H.text, false, {align: 'center', scale: 2});
    this.desktopEntity.addEntity(this.hud.distance);
    // the record of the world under the distance (the original's RecordMeters, notes 13, 18) — only when there is one
    this.hud.record = new TextEntity(this.desktopEntity, this.app.fonts.fonts5x5, 0, 0, 200, 8, this.record > 0 ? 'RECORD '+this.record+' M' : '', H.dim, false, {align: 'center'});
    this.hud.record.hide = !(this.record > 0);
    this.desktopEntity.addEntity(this.hud.record);
    this.hud.coins = new TextEntity(this.desktopEntity, this.app.fonts.fonts5x5, 0, 0, 120, 12, '0 COINS', H.text, false, {align: 'right', scale: 2});
    this.desktopEntity.addEntity(this.hud.coins);
    // the credit multiplier under the coins: "X2" and the bar of its timer, only while it runs (notes 12)
    this.hud.multiplier = new TextEntity(this.desktopEntity, this.app.fonts.fonts5x5, 0, 0, H.multiplierWidth, 8, '', H.multiplier, false, {align: 'right'});
    this.desktopEntity.addEntity(this.hud.multiplier);
    this.hud.multiplierBack = new AbstractEntity(this.desktopEntity, 0, 0, H.multiplierWidth, 4, false, H.barBack);
    this.desktopEntity.addEntity(this.hud.multiplierBack);
    this.hud.multiplierBar = new AbstractEntity(this.desktopEntity, 0, 0, H.multiplierWidth, 4, false, H.multiplier);
    this.desktopEntity.addEntity(this.hud.multiplierBar);
    // the pickup's message under the distance for a second
    this.hud.message = new TextEntity(this.desktopEntity, this.app.fonts.fonts5x5, 0, 0, 240, 8, '', H.dim, false, {align: 'center'});
    this.desktopEntity.addEntity(this.hud.message);
    // the digit of the countdown out of a pause, in the middle of the screen (the height follows the scale: placeCountdown)
    this.hud.countdown = new TextEntity(this.desktopEntity, this.app.fonts.fonts5x5, 0, 0, w, (this.app.fonts.fonts5x5.charsHeight+this.app.fonts.fonts5x5.lineSpacing)*MainModel.COUNTDOWN.scale, '', MainModel.COUNTDOWN.color, false, {align: 'center', scale: MainModel.COUNTDOWN.scale});
    this.hud.countdown.hide = true;
    this.desktopEntity.addEntity(this.hud.countdown);
    this.hud.multiplier.hide = this.hud.multiplierBack.hide = this.hud.multiplierBar.hide = this.hud.message.hide = true;

    if (this.app.devModeName !== false) {
      this.hud.fps = new TextEntity(this.desktopEntity, this.app.fonts.fonts5x5, 0, 0, 120, 8, '', H.dim, false, {align: 'right'});
      this.desktopEntity.addEntity(this.hud.fps);
    }

    this.layoutEntities();
    this.app.inputEventsManager.sendEventsActiveKeys('Press');
    this.startWorker(this.app.gameData());     // opens the audio once the music of the world is at hand
  } // init

  shutdown() {
    super.shutdown();
    this.sendWorkerMessage({id: 'reset'});
    if (this.hasAudio()) {
      this.app.audioManager.closeAllBuses();
    }
  } // shutdown

  // ------------------------------------------------------------------- sound

  /**
   * Whether this game makes a sound: there is a manager (the stand-in
   * application of the tools has none).
   * @returns {boolean}
   */
  hasAudio() {
    return !!this.app.audioManager;
  } // hasAudio

  /**
   * Opens the buses, the music bus over the world's track when there is
   * one (the manager picks the handler as the bus opens), starts the
   * engine when the music will not play, and the music 0.3 s later.
   * @param {PCMSample|null} track - The decoded track of the world, or null for the tune.
   */
  openAudio(track) {
    if (!this.hasAudio()) {
      return;
    }
    var am = this.app.audioManager;
    if (am.hasSamples()) {
      this.sendEvent(0, {id: 'openAudioBus', bus: am.constructor.sfxBus, options: {muted: this.app.muted.sounds}});
    }
    am.track = track || null;
    this.musicRate = 1;
    this.musicOver = false;
    if (!am.track) {
      return;                                  // no track of this world: no music, and nothing to start
    }
    this.sendEvent(0, {id: 'openAudioBus', bus: am.constructor.musicBus, options: {muted: this.app.muted.music}});
    this.sendEvent(MainModel.MUSIC.startDelay, {id: 'playSound', bus: am.constructor.musicBus, sound: 'music', options: {repeat: true}});
  } // openAudio

   /**
   * The music's speed by the energy (notes 10: under a quarter the pitch
   * is energy / 0.25, above it 1) — the track's rate.
   * @param {number} energy
   */
  paceMusic(energy) {
    if (!this.hasAudio() || this.musicOver) {
      return;
    }
    var am = this.app.audioManager;
    if (!am.trackPlays()) {
      return;
    }
    var low = MainModel.MUSIC.lowEnergy;
    var rate = energy < low ? Math.max(0, Math.min(1, energy/low)) : 1;
    rate = Math.round(rate*1000)/1000;
    if (rate !== this.musicRate) {
      this.musicRate = rate;
      am.rateBus(am.constructor.musicBus, rate);
    }
  } // paceMusic

  /**
   * The music key: the track muted or back.
   */
  toggleMusic() {
    this.app.muted.music = !this.app.muted.music;
    this.sendEvent(0, {id: 'muteAudioBus', bus: this.app.audioManager.constructor.musicBus, muted: this.app.muted.music});
  } // toggleMusic

  /**
   * The music out at the end of the run: the fade of the original
   * (`TurnFadeOnDeath`, notes 17), and no start that is still pending.
   */
  stopMusic() {
    if (!this.hasAudio()) {
      return;
    }
    var am = this.app.audioManager;
    this.cancelEvent('playSound');
    this.musicOver = true;
    am.fadeBus(am.constructor.musicBus, MainModel.MUSIC.fade);
  } // stopMusic

  /**
   * The sounds a frame started (WORKER-PROTOCOL.md `sounds`) onto the one
   * effects source of the original, at the pitch of the pickup ladder
   * (notes 17, `SoundManager.PlayPickupSfx`: a pickup plays at the pitch
   * the source has, which then steps +0.05 while it is at most 1.8; back
   * to 1 after 2 s without one). The events the original has no sound
   * for — the low energy, the multiplier running out, the end of the
   * boosters, the game over — pass silently, and so does everything when
   * the clips are not there.
   * @param {string[]} names
   * @param {number} tick - The frame's tick.
   */
  playSounds(names, tick) {
    if (!this.hasAudio() || !this.app.audioManager.sfxPlays()) {
      return;
    }
    var am = this.app.audioManager, bus = am.constructor.sfxBus;
    var has = {};
    names.forEach((name) => { has[name] = true; });
    var play = (sound, rate) => this.sendEvent(0, {id: 'playSound', bus: bus, sound: sound, options: {rate: rate}});

    // the pitch of the source now: back at 1 after 2 s without a pickup
    var current = (this.pitch.tick >= 0 && tick-this.pitch.tick <= AudioManager.PITCH.resetTicks) ? this.pitch.factor : 1;

    if (has.boosterOn) {
      play('pingLast', current);                 // BOOSTERS_ON (PlayerControl), at the source's pitch
    }

    // the pickups: one a tick at most (the last one named wins), then the step up
    var pickup = ['pickup:energy', 'pickup:multiplier', 'pickup:coin'].filter((n) => has[n])[0];
    if (pickup) {
      play('pickup', current);
      this.pitch.factor = AudioManager.nextPitch(current);
      this.pitch.tick = tick;
    }

    // the end: the explosion, the original's for the energy out as well (PlayerCrash.Crash)
    if (has.crash || has.energyOut) {
      play('explosion', current);
      this.stopMusic();
    }
  } // playSounds

  /**
   * Places the entities by the desktop size — on init and on every resize
   * (`fit: 'cover'`: the desktop grows to the window).
   */
  layoutEntities() {
    var w = this.desktopWidth, h = this.desktopHeight;
    var H = MainModel.HUD, inset = H.inset;

    this.view.width = w;
    this.view.height = h;

    this.hud.energy.x = inset;
    this.hud.energy.y = inset;
    this.hud.energy.invalidate();
    this.hud.barBack.x = inset;
    this.hud.barBack.y = inset+8;
    this.hud.bar.x = inset;
    this.hud.bar.y = inset+8;

    this.hud.distance.x = (w-200) >> 1;
    this.hud.distance.y = inset;
    this.hud.distance.invalidate();
    this.hud.record.x = (w-200) >> 1;
    this.hud.record.y = inset+14;
    this.hud.record.invalidate();
    this.hud.coins.x = w-inset-120;
    this.hud.coins.y = inset;
    this.hud.coins.invalidate();
    this.hud.multiplier.x = w-inset-H.multiplierWidth;
    this.hud.multiplier.y = inset+16;
    this.hud.multiplier.invalidate();
    this.hud.multiplierBack.x = this.hud.multiplierBar.x = w-inset-H.multiplierWidth;
    this.hud.multiplierBack.y = this.hud.multiplierBar.y = inset+26;
    this.hud.message.x = (w-240) >> 1;
    this.hud.message.y = inset+(this.record > 0 ? 24 : 16);
    this.hud.message.invalidate();

    this.hud.countdown.width = w;
    this.placeCountdown();

    if (this.hud.fps) {
      this.hud.fps.x = w-inset-120;
      this.hud.fps.y = h-inset-8;
      this.hud.fps.invalidate();
    }
  } // layoutEntities

  // ------------------------------------------------------------------ worker

  /**
   * Glues the worker from its modules and starts it; the worker is kept on
   * the app so a later game does not build it again.
   * @param {Object} data - The game's data (`{ships, worlds, sections}` — none in the skeleton).
   */
  startWorker(data) {
    var options = MainModel.runOptions(this.app.progress);
    var init = () => {
      this.ready = true;
      this.sendWorkerMessage(Object.assign({id: 'init', seed: this.app.gameSeed(), data: data, playerName: this.app.playerName || ''}, options));
    };
    // the assets of the run first (assets/worlds, assets/ships — the original's
    // PrecacheLevel): the world's track and the ship's mesh, then the data composed again
    var world = this.app.progress ? this.app.progress.worldDef(this.app.progress.world) : null;
    var ready = () => {
      if (this.app.ensureWorld && this.app.ensureShip) {
        // the track, the ship's mesh, then the music of the world (decoded, or not there: the tune)
        this.app.ensureWorld(world ? world.id : null, () => this.app.ensureShip(options.shipId, () => {
          data = this.app.gameData();
          this.playfield = new Playfield(data);
          var music = (ok) => {
            this.openAudio(ok && world ? this.app.assets.music[world.id] : null);
            init();
          };
          if (this.app.ensureMusic && this.app.ensureSfx && this.hasAudio()) {
            // the original's effects (once), then the music of the world
            this.app.ensureSfx(() => this.app.ensureMusic(world ? world.id : null, music));
          } else {
            music(false);
          }
        }));
      } else {
        this.openAudio(null);
        init();
      }
    };
    if (this.app.worker) {
      this.app.worker.onmessage = (event) => this.handleWorkerMessage(event);
      ready();
      return;
    }
    ModuleWorker.create(this.app, MainModel.WORKER_SOURCES).then((worker) => {
      this.app.worker = worker;
      worker.onmessage = (event) => this.handleWorkerMessage(event);
      worker.onerror = (event) => this.app.showErrorMessage('game worker: '+event.message, 'restart');
      ready();
    }).catch((error) => this.app.showErrorMessage(error.message, 'restart'));
  } // startWorker

  /**
   * What the progress brings into a run (GR-M8, notes 14, 15): the
   * selected world, the active ship and its upgrade multipliers — the
   * `init` fields of the worker (WORKER-PROTOCOL.md); nothing without a
   * progress (the defaults of the game).
   * @param {Progress|null} progress
   * @returns {Object}
   */
  static runOptions(progress) {
    if (!progress) {
      return {};
    }
    var m = progress.multipliers();
    return {world: progress.world, shipId: progress.activeShip, battery: m.battery, coins: m.coins, multiplier: m.multiplier, magnet: m.magnet};
  } // runOptions

  sendWorkerMessage(event) {
    if (this.app.worker && this.ready) {
      this.app.worker.postMessage(event);
    }
  } // sendWorkerMessage

  handleWorkerMessage(event) {
    var data = event.data;
    switch (data.id) {
      case 'frame':
        this.frame = data;
        this.fps.workerFrames++;
        this.app.score = data.state.distance;
        if (Array.isArray(data.sounds) && data.sounds.length) {
          this.playSounds(data.sounds, data.tick);
        }
        this.paceMusic(data.state.energy);
        if (data.gameOver && !this.gameOver) {
          this.gameOver = true;
          this.sendEvent(0, {id: 'gameOver'});
        }
        break;
    }
  } // handleWorkerMessage

  /**
   * Puts the last frame into the scene and the HUD, once per frame.
   */
  drawFrame() {
    if (!this.frame || this.frame.tick == this.drawnTick) {
      return;
    }
    this.drawnTick = this.frame.tick;
    Playfield.build(this.view.scene, this.frame.scene, this.playfield);
    this.refreshHUD(this.frame.state);
  } // drawFrame

  /**
   * The HUD from a state: the energy bar (red under a quarter, the
   * original's warning threshold, notes 10), the distance, the coins, the
   * credit multiplier with the fill of its timer while it runs, the last
   * pickup's message for a second (notes 12).
   * @param {Object} state
   */
  refreshHUD(state) {
    var H = MainModel.HUD;
    var energy = Math.max(0, Math.min(1, state.energy));
    this.hud.bar.width = Math.round(H.barWidth*energy);
    this.hud.bar.bkColor = energy < 0.25 ? H.barLow : H.bar;
    this.hud.distance.setText(state.distance+' M');
    this.hud.coins.setText(state.coins+' COINS');
    var m = state.multiplier;
    var on = !!(m && m.on && m.value > 1);
    this.hud.multiplier.hide = this.hud.multiplierBack.hide = this.hud.multiplierBar.hide = !on;
    if (on) {
      this.hud.multiplier.setText('X'+m.value);
      this.hud.multiplierBar.width = Math.max(1, Math.round(H.multiplierWidth*Math.max(0, Math.min(1, m.timer/m.time))));
    }
    // NEW RECORD! once, when the distance passes the record of the world (GameManager.Update; none to pass at 0)
    if (this.record > 0 && this.newRecordTick < 0 && state.distance > this.record) {
      this.newRecordTick = state.tick;
    }
    var p = state.lastPickup;
    var show = !!(p && state.tick-p.tick < H.messageTicks);
    var text = show ? (MainModel.MESSAGES[p.kind] || (() => ''))(p.amount) : '';
    if (this.newRecordTick >= 0 && state.tick-this.newRecordTick < H.messageTicks) {
      text = 'NEW RECORD!';
      show = true;
    }
    this.hud.message.hide = !show;
    if (show) {
      this.hud.message.setText(text);
    }
  } // refreshHUD

  // ---------------------------------------------------------------- controls

  /**
   * A key of the keyboard or gamepad mapped to a game action.
   * @param {string} key
   * @returns {string|false}
   */
  actionOfKey(key) {
    var k = key.length == 1 ? key.toUpperCase() : key;
    var kb = this.app.controls.keyboard;
    if (kb.left === k || k == 'A') {
      return 'left';
    }
    if (kb.right === k || k == 'D') {
      return 'right';
    }
    switch (key) {
      case 'GamepadLeft': return 'left';
      case 'GamepadRight': return 'right';
    }
    return false;
  } // actionOfKey

  /**
   * The action of the zone a touch is in (notes 7): the left half of the
   * screen steers left, the right half right; a touch in the top quarter
   * does nothing.
   * @param {Object} event - With x, y in desktop units.
   * @returns {string|false}
   */
  touchAction(event) {
    if (event.y < this.desktopHeight*MainModel.TOUCH_TOP) {
      return false;
    }
    return event.x < this.desktopWidth/2 ? 'left' : 'right';
  } // touchAction

  /**
   * Sends the actions as the touches hold them — only the ones that changed.
   */
  sendTouches() {
    var held = {left: false, right: false};
    Object.keys(this.touches).forEach((id) => {
      if (this.touches[id]) {
        held[this.touches[id]] = true;
      }
    });
    Object.keys(held).forEach((action) => {
      if (held[action] != this.touchActions[action]) {
        this.touchActions[action] = held[action];
        this.sendWorkerMessage({id: 'controls', action: action, value: held[action]});
      }
    });
  } // sendTouches

  handleEvent(event) {
    if (super.handleEvent(event)) {
      return true;
    }
    switch (event.id) {
      case 'resizeModel':
        this.layoutEntities();
        return true;

      case 'blurWindow':
        this.pauseGame(true);
        return true;

      case 'continueGame':
        // the countdown of the original stands between the pause and the game (notes 2)
        this.startCountdown();
        return true;

      case 'errorAudioBus':
        this.app.showErrorMessage(event.error, 'ignore');
        return true;

      case 'gameOver':
        this.showGameOver();
        return true;

      case 'keyPress':
        var k = event.key.length == 1 ? event.key.toUpperCase() : event.key;
        if (k == 'Escape' || k == 'GamepadExit' || k == this.app.controls.keyboard.pause) {
          this.pauseGame();
          return true;
        }
        if (event.key == 'Touch') {
          this.touches[event.identifier] = this.touchAction(event);
          // bound to an entity, so the input manager reports the touch's moves
          this.app.inputEventsManager.touchesMap[event.identifier] = this.view;
          this.sendTouches();
          return true;
        }
        if (event.key == 'RetryTouch') {
          return true;
        }
        if (k == this.app.controls.keyboard.sounds && this.hasAudio()) {
          this.app.muted.sounds = !this.app.muted.sounds;
          this.sendEvent(0, {id: 'muteAudioBus', bus: 'sounds', muted: this.app.muted.sounds});
          return true;
        }
        if (k == this.app.controls.keyboard.music && this.hasAudio()) {
          this.toggleMusic();
          return true;
        }
        var action = this.actionOfKey(event.key);
        if (action) {
          this.sendWorkerMessage({id: 'controls', action: action, value: true});
          return true;
        }
        break;

      case 'keyMove':
        if (event.key == 'Touch' && (event.identifier in this.touches)) {
          this.touches[event.identifier] = this.touchAction(event);
          this.sendTouches();
          return true;
        }
        break;

      case 'keyRelease':
        if (event.key == 'Touch') {
          delete this.touches[event.identifier];
          this.sendTouches();
          return true;
        }
        if (event.key == 'RetryTouch') {
          this.touches = {};
          this.sendTouches();
          return true;
        }
        var released = this.actionOfKey(event.key);
        if (released) {
          this.sendWorkerMessage({id: 'controls', action: released, value: false});
          return true;
        }
        break;

      case 'exitGame':
        this.app.setModel('MenuModel');
        return true;
    }
    return false;
  } // handleEvent

  /**
   * The end of the run (`GameManager.GameOver`, notes 2, 13): the run
   * booked into the progress (the coins, the record — saved), then the
   * player's name asked for when there is none, then the notice.
   */
  showGameOver() {
    if (this.desktopEntity.modalEntity) {
      this.desktopEntity.modalEntity.closeEntity();
    }
    var state = this.frame ? this.frame.state : null;
    this.finished = this.app.finishGame ? this.app.finishGame(state ? state.distance : 0, state ? state.coins : 0) : null;
    if (!this.app.playerName) {
      // the name for the hall of fame: the library's dialog; the notice follows when it closes (loopModel)
      this.askingName = true;
      var p = MenuModel.dialogProperties();
      var dx = (this.desktopWidth-p.width) >> 1, dy = (this.desktopHeight-p.height) >> 1;
      this.desktopEntity.addModalEntity(new ZXDialogEntity(this.desktopEntity, dx, dy, p.width, p.height, 'YOUR NAME FOR THE HALL OF FAME', p,
        (dialog) => new ZXPlayerNameEntity(dialog, dialog.innerX, dialog.innerY, dialog.innerWidth, dialog.innerHeight, false, p)));
      return;
    }
    this.showGameOverNotice();
  } // showGameOver

  /**
   * The notice of the end (the `RestartMenu` of the original, notes 18):
   * how it ended, the name and the distance (the score, notes 13), NEW
   * RECORD! or the record of the world, the coins of the run and the
   * total; the score goes to the hall of fame under the name (nothing
   * without one). Enter or Escape leaves for the menu.
   */
  showGameOverNotice() {
    var state = this.frame ? this.frame.state : null;
    var distance = state ? state.distance : 0, coins = state ? state.coins : 0;
    var reason = state && state.input && state.energy < 0 ? 'OUT OF ENERGY' : 'CRASHED';
    var name = String(this.app.playerName || '').trim();
    this.app.saveScore(name, distance);
    var lines = [reason, (name ? name.toUpperCase()+': ' : '')+distance+' M'];
    var f = this.finished;
    if (f) {
      lines.push(f.newRecord ? 'NEW RECORD!' : f.record > 0 ? 'RECORD '+f.record+' M' : 'YOUR FIRST RECORD HERE');
      lines.push('COINS +'+coins+' - '+f.total+' IN ALL');
    } else {
      lines.push('COINS +'+coins);
    }
    var x = (this.desktopWidth-NoticeEntity.WIDTH) >> 1, y = (this.desktopHeight-NoticeEntity.HEIGHT) >> 1;
    this.desktopEntity.addModalEntity(new NoticeEntity(this.desktopEntity, x, y, 'GAME OVER', lines, {id: 'exitGame'},
      {escapeEvent: {id: 'exitGame'}, hint: 'ENTER - BACK TO MENU'}));
  } // showGameOverNotice

  // --------------------------------------------------------------- countdown

  /**
   * Puts the countdown's digit in the middle of the desktop at its
   * current scale: the entity has to be as tall as the glyph, or the
   * raster is painted into a cache that cuts it off.
   */
  placeCountdown() {
    var fonts = this.app.fonts.fonts5x5, scale = this.hud.countdown.options.scale;
    this.hud.countdown.x = 0;
    this.hud.countdown.height = (fonts.charsHeight+fonts.lineSpacing)*scale;
    this.hud.countdown.y = (this.desktopHeight-fonts.charsHeight*scale) >> 1;
    this.hud.countdown.invalidate();
  } // placeCountdown

  /**
   * Starts the countdown out of a pause (`GameManager.ResumeGame`): the
   * audio goes on at once — the music plays while the game still stands —
   * and the worker waits for `updateCountdown` to reach 1.8 s.
   */
  startCountdown() {
    this.countdown = {since: -1, pings: -1};
    if (this.hasAudio()) {
      this.sendEvent(0, {id: 'continueAllAudioBuses'});
    }
    this.updateCountdown(this.app.now);
  } // startCountdown

  /**
   * The ping of a digit (`SoundManager.PlaySfx(COUNT_PING)`) — and the
   * pickup ladder back to 1 (`ResetPickupAudioPitch`); silent without
   * the clip.
   */
  playCountPing() {
    this.pitch = {factor: 1, tick: -1};
    if (!this.hasAudio() || !this.app.audioManager.sfxPlays()) {
      return;
    }
    var am = this.app.audioManager;
    this.sendEvent(0, {id: 'playSound', bus: am.constructor.sfxBus, sound: 'ping', options: false});
  } // playCountPing

  /**
   * One frame of the countdown: the digit that is due, shrunk by how far
   * it has come (the original lerps the scale to zero over the digit, the
   * pixel font steps it), a ping as each digit comes up and one more when
   * the last is gone, and the game itself back at 1.8 s.
   * @param {number} timestamp - The frame's clock.
   */
  updateCountdown(timestamp) {
    var C = MainModel.COUNTDOWN;
    if (this.countdown.since < 0) {
      this.countdown.since = timestamp;
    }
    var elapsed = timestamp-this.countdown.since;
    var index = Math.floor(elapsed/C.step);

    // the pings: one as every digit comes up, one more when they are done
    var due = Math.min(C.digits, index);
    while (this.countdown.pings < due) {
      this.countdown.pings++;
      this.playCountPing();
    }

    if (index < C.digits) {
      var progress = Math.min(1, (elapsed-index*C.step)/C.step);
      var scale = Math.max(1, Math.round(C.scale*(1-progress)));
      this.hud.countdown.hide = false;
      this.hud.countdown.setText(String(C.digits-index));
      if (scale != this.hud.countdown.options.scale) {
        this.hud.countdown.options.scale = scale;
        this.hud.countdown.cleanCache();
      }
      this.placeCountdown();
    } else {
      this.hud.countdown.hide = true;
    }

    if (elapsed >= C.resume) {
      this.countdown = null;
      this.paused = false;
      this.sendWorkerMessage({id: 'continue'});
    }
  } // updateCountdown

  /**
   * Pauses the worker behind a notice; Enter continues, Escape quits.
   * While the countdown runs the player cannot pause (the original hides
   * the button, `UnpauseCounting.Pause`), but losing the window forces it
   * (`OnApplicationPause`, notes 2): the countdown is dropped and starts
   * over on the next Enter.
   * @param {boolean} [force] - Pause even during the countdown.
   */
  pauseGame(force) {
    if (this.desktopEntity.modalEntity || this.gameOver || !this.ready) {
      return;
    }
    if (this.countdown) {
      if (!force) {
        return;
      }
      this.countdown = null;
      this.hud.countdown.hide = true;
    }
    this.paused = true;
    this.sendWorkerMessage({id: 'pause'});
    if (this.hasAudio()) {
      this.sendEvent(0, {id: 'pauseAllAudioBuses'});
    }
    var x = (this.desktopWidth-NoticeEntity.WIDTH) >> 1, y = (this.desktopHeight-NoticeEntity.HEIGHT) >> 1;
    this.desktopEntity.addModalEntity(new NoticeEntity(this.desktopEntity, x, y, 'PAUSED', ['THE GAME WAITS'], {id: 'continueGame'},
      {escapeEvent: {id: 'exitGame'}, hint: 'ENTER CONTINUES - ESC QUITS'}));
  } // pauseGame

  /**
   * Dev-mode indicator "xx/yy FPS": frames drawn a second and 'frame'
   * messages from the worker a second (the fixed 50 Hz game tick).
   */
  updateFps(timestamp) {
    if (!this.hud.fps) {
      return;
    }
    this.fps.frames++;
    if (this.fps.since === false) {
      this.fps.since = timestamp;
      return;
    }
    var elapsed = timestamp-this.fps.since;
    if (elapsed >= 1000) {
      var draw = Math.round(this.fps.frames*1000/elapsed);
      var worker = Math.round(this.fps.workerFrames*10000/elapsed)/10;
      var layout = this.app.layout;
      this.hud.fps.setText(draw+'/'+worker+' FPS  R'+(Math.round(layout.ratio*100)/100)+' P'+(Math.round((layout.pixelRatio || 1)*100)/100));
      this.fps.frames = 0;
      this.fps.workerFrames = 0;
      this.fps.since = timestamp;
    }
  } // updateFps

  loopModel(timestamp) {
    super.loopModel(timestamp);
    if (this.countdown) {
      this.updateCountdown(timestamp);
    }
    if (this.desktopEntity.modalEntity) {
      this.desktopEntity.modalEntity.loopEntity(timestamp);
    } else if (this.askingName) {
      // the name dialog closed (OK or CANCEL): the notice of the end
      this.askingName = false;
      this.showGameOverNotice();
    }
    this.drawFrame();
    this.updateFps(timestamp);
    this.drawModel();
  } // loopModel

} // MainModel
