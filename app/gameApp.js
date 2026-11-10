const { Version } = await import('./version.js?ver='+window.srcVersion);
const { AbstractApp } = await import('./svision/js/abstractApp.js?ver='+window.srcVersion);
const { ZXFonts8x8 } = await import('./svision/js/platform/canvas2D/zx/zxFonts8x8.js?ver='+window.srcVersion);
const { Fonts5x5 } = await import('./svision/js/platform/canvas2D/fonts5x5.js?ver='+window.srcVersion);
const { Fonts3x3 } = await import('./svision/js/platform/canvas2D/fonts3x3.js?ver='+window.srcVersion);
const { BootModel } = await import('./bootModel.js?ver='+window.srcVersion);
const { MenuModel } = await import('./menuModel.js?ver='+window.srcVersion);
const { MainModel } = await import('./mainModel.js?ver='+window.srcVersion);
const { NoticeEntity } = await import('./noticeEntity.js?ver='+window.srcVersion);
const { Progress } = await import('./progress.js?ver='+window.srcVersion);
const { AudioManager } = await import('./audioManager.js?ver='+window.srcVersion);
const { Tool } = await import('./svision/js/tool.js?ver='+window.srcVersion);
// begin code

/**
 * The application shell (GR-M3 skeleton, the shape of asteroids and Manic
 * Miner): BootModel -> MenuModel -> MainModel (the game). Built on the 3D
 * platform from the start (R-032): the world is a Scene3D in a SceneEntity,
 * everything else — HUD, menu, dialogs — is canvas2D on the 2D overlay,
 * so the dialogs of the library (ZXPlayerNameEntity, ZXVolumeEntity,
 * ZXSettingsEntity) work unchanged over the 3D picture.
 *
 * The game worker is built by MainModel and kept on `this.worker`; the
 * seed of its randomness is `gameSeed()` (the clock, or `?devSeed=N` in dev
 * mode). The sound is `audioManager.js` over the original's own
 * recordings (GR-M9, `ensureSfx` and `ensureMusic`; nothing synthesized,
 * so without the files the game is silent): the game opens its buses,
 * the menu never does (R-024), the volume dialogs try the level on
 * their own. The hall of fame (`hallOfFame`, the ten best
 * of the server, one per name) comes with appData.db and after every saved
 * game (GR-M8); the score of a game is its distance in metres (notes 13).
 *
 * The player's progress (GR-M8, app/progress.js: the coins, the ships
 * bought with their upgrade levels, the active ship, the worlds bought
 * with their records, the selected world) lives in localStorage under
 * `<prefix>.progress` as the versioned JSON of `Progress.toJSON()`: read
 * once the game's data is at hand (`loadProgress`, before the menu),
 * written after every purchase, choice and finished run (`saveProgress`).
 * The server never sees it (ZADANI chap. 3: local only; the server keeps
 * the hall of fame). `finishGame` books a run over into it.
 *
 * The big data stays out of localStorage (the operator's remark of
 * 2026-09-16: the meshes of the original's ships and the tracks of its
 * worlds would not fit the 5 MB): appData.db brings only the small files
 * (global, worlds, the ships' store facts, the pickups' meshes), the
 * meshes of the ships (assets/ships/<id>.json) and the tracks of the
 * worlds (assets/worlds/<id>.json) are static files fetched when a ship is
 * shown or flown and a world is flown (`ensureShip`, `ensureWorld`), kept
 * in memory for the session (`assets`) and cached by the service worker
 * for the next one — the way the original precaches a level before the
 * run (`LevelManager.PrecacheLevel`, notes 2). `gameData()` composes what
 * is loaded into the shape the playfield and the worker take. The music
 * of a world (assets/music/<id>.m4a, the original's track — the
 * operator's decision of 2026-09-16, study only) is fetched and decoded
 * the same way before the run (`ensureMusic`, through the audio
 * manager); without it the run plays the bank's own tune.
 */
export class GameApp extends AbstractApp {

  constructor(platform, importPath, wsURL, devModeName, appIconSprite) {
    super(platform, 'bodyApp', importPath, wsURL);

    this.version = Version;
    this.title = window.appName || 'GEOMETRY RACE';
    this.copyright = '© 2026 L. MITRENGA, CC BY-NC-SA 4.0';
    this.devModeName = devModeName;
    this.appIconSprite = appIconSprite;

    // the sound (GR-M9): the effect buses of the game on the SOUNDS level, the tune on MUSIC
    this.audioManager = new AudioManager(this);
    this.muted = {sounds: false, music: false};

    // the fonts of the overlay: the 5x5 font of the HUD and the dialogs'
    // buttons, the ZX 8x8 fonts the library's dialogs are laid out for
    this.fonts = {
      zxFonts8x8Mono: new ZXFonts8x8(this, false),
      zxFonts8x8: new ZXFonts8x8(this, true),
      fonts5x5: new Fonts5x5(this),
      fonts3x3: new Fonts3x3(this)
    };
    this.fonts.fonts5x5.addSpace('␣', {width: 2, breaking: false, stretch: true});
    this.fonts.zxFonts8x8.addSpace('␣', {width: 3, breaking: false, stretch: false});

    // the controls (ZADANI chap. 5): steer left / right — the original has
    // nothing else in a run. The touch layout is the halves of the screen
    // (its zones are decided in GR-M5 with the input model, the icons in GR-M9)
    this.controlsOptions = {
      keyboard: {
        device: 'keyboard',
        keys: [
          {action: 'left', label: 'STEER LEFT'},
          {action: 'right', label: 'STEER RIGHT'},
          {action: 'pause', label: 'PAUSE'},
          {action: 'sounds', label: 'MUTE SOUNDS'},
          {action: 'music', label: 'MUTE MUSIC'}
        ]
      },
      gamepads: {
        device: 'gamepads',
        keys: [
          {action: 'left', label: 'STEER LEFT', eventKey: 'GamepadLeft'},
          {action: 'right', label: 'STEER RIGHT', eventKey: 'GamepadRight'},
          {action: 'up', label: 'MENU UP', eventKey: 'GamepadUp'},
          {action: 'down', label: 'MENU DOWN', eventKey: 'GamepadDown'},
          {action: 'ok', label: 'OK', eventKey: 'GamepadOK'},
          {action: 'exit', label: 'EXIT / PAUSE', eventKey: 'GamepadExit'}
        ]
      },
      touchscreen: {
        device: 'touchscreen',
        types: {
          keys: ['halves'],
          // the halves of the screen steer (notes 7); a touch works in the
          // lower three quarters of it (MainModel.TOUCH_TOP)
          halves: {
            left: {type: 'button', control: false, action: 'left', actions: false, sprite: 'left'},
            right: {type: 'button', control: false, action: 'right', actions: false, sprite: 'right'}
          }
        },
        icons: {
          left: {width: 39, height: 23, frames: 1, directions: 1, sprite: [[
            '---------------------------------------',
            '---------------------------------------',
            '---------------------------------------',
            '----------------#----------------------',
            '---------------##----------------------',
            '-------------####----------------------',
            '------------#####----------------------',
            '----------#######----------------------',
            '---------########----------------------',
            '-------############################----',
            '------#############################----',
            '----###############################----',
            '------#############################----',
            '-------############################----',
            '---------########----------------------',
            '----------#######----------------------',
            '------------#####----------------------',
            '-------------####----------------------',
            '---------------##----------------------',
            '----------------#----------------------',
            '---------------------------------------',
            '---------------------------------------',
            '---------------------------------------'
          ]]},
          right: {width: 39, height: 23, frames: 1, directions: 1, sprite: [[
            '---------------------------------------',
            '---------------------------------------',
            '---------------------------------------',
            '----------------------#----------------',
            '----------------------##---------------',
            '----------------------####-------------',
            '----------------------#####------------',
            '----------------------#######----------',
            '----------------------########---------',
            '----############################-------',
            '----#############################------',
            '----###############################----',
            '----#############################------',
            '----############################-------',
            '----------------------########---------',
            '----------------------#######----------',
            '----------------------#####------------',
            '----------------------####-------------',
            '----------------------##---------------',
            '----------------------#----------------',
            '---------------------------------------',
            '---------------------------------------',
            '---------------------------------------'
          ]]}
        }
      }
    };

    this.controls = {
      keyboard: this.getControls('keyboard'),
      mouse: this.getControls('mouse'),
      touchscreen: this.getControls('touchscreen'),
      gamepads: this.getControls('gamepads')
    };

    this.score = 0;
    this.hiScore = false;
    this.hallOfFame = [];              // [{name, score}] from best down, the server's ten
    this.playerName = Tool.readCookie('playerName', '');
    this.progress = null;              // Progress, once the data is at hand (loadProgress)
    this.assets = {ships: {}, worlds: {}, music: {}, sfx: null, pending: {}};   // the fetched assets by id (sfx: true/false once tried), and the callbacks waiting for one
    this.globalData = false;
    this.id = 'GameApp';
    this.fetchDataId = '';
    this.setModel('LoadingModel');
    this.loadAppData();
  } // constructor

  getControls(device) {
    var result = {};

    switch (device) {
      case 'keyboard':
        result = {left: 'ArrowLeft', right: 'ArrowRight', pause: ' ', sounds: 'N', music: 'M'};
        break;
      case 'mouse':
        result = {enable: false};
        break;
      case 'touchscreen':
        result = {supported: false, type: 'halves'};
        break;
      case 'gamepads':
        result = {supported: false, devices: {}};
        break;
    }

    switch (device) {
      case 'keyboard':
      case 'mouse':
      case 'touchscreen':
        var cfgString = Tool.readCookie(device, false);
        if (cfgString !== false) {
          try {
            var cfg = JSON.parse(cfgString);
            Object.keys(cfg).forEach((item) => {
              result[item] = cfg[item];
              if (device == 'touchscreen' && !(result[item] in this.controlsOptions.touchscreen.types)) {
                result[item] = this.controlsOptions.touchscreen.types.keys[0];
              }
            });
          } catch (error) {
            console.error(error.message);
          }
        }
        break;
      case 'gamepads':
        var devicesString = Tool.readCookie('gamepads', false);
        if (devicesString !== false) {
          try {
            var devices = JSON.parse(devicesString);
          } catch (error) {
            console.error(error.message);
          } finally {
            if (Array.isArray(devices)) {
              devices.forEach((id) => {
                var deviceString = Tool.readCookie(id, false);
                if (deviceString !== false) {
                  try {
                    var device = JSON.parse(deviceString);
                  } catch (error) {
                    console.error(error.message);
                  } finally {
                    result.devices[id] = device;
                  }
                }
              });
            }
          }
        }
        break;
    }
    return result;
  } // getControls

  setModel(model) {
    if (model == 'MenuModel' && this.globalData === false) {
      // the fetch may still be pending or has failed: as a last resort try the
      // data cached in localStorage before bothering the user
      if (!this.loadGlobalDataFromStorage()) {
        this.showErrorMessage('Game data could not be loaded.', 'retry');
        return;
      }
    }
    if (model == 'MenuModel' && this.progress === null) {
      this.loadProgress();
    }
    var needResizeApp = false;
    var selectionItem = 0;
    if (this.model) {
      this.model.shutdown();
      needResizeApp = true;
    }
    switch (model) {
      case 'LoadingModel':
        this.model = new BootModel(this);
        break;
      case 'MenuModel':
        this.model = new MenuModel(this, selectionItem);
        break;
      case 'MainModel':
        this.model = new MainModel(this);
        break;
    } // switch
    this.model.init();
    if (needResizeApp) {
      this.resizeApp();
    }
  } // setModel

  startGame() {
    this.score = 0;
    this.setModel('MainModel');
  } // startGame

  applyGlobalData(global) {
    this.globalData = global;
  } // applyGlobalData

  /**
   * The key of the progress in localStorage.
   * @returns {string}
   */
  static progressKey() {
    return window.appPrefix+'.progress';
  } // progressKey

  /**
   * The player's progress from localStorage (a fresh one without a saved
   * one, or one of another version — Progress.fromJSON), once the game's
   * data is there; null while it is not (the playfield's fallbacks then).
   * @returns {Progress|null}
   */
  loadProgress() {
    var data = this.gameData();
    if (!data.global || !data.ships || !data.worlds) {
      this.progress = null;
      return null;
    }
    var saved = null;
    try {
      var stored = localStorage.getItem(GameApp.progressKey());
      saved = stored !== null ? JSON.parse(stored) : null;
    } catch (error) {
      console.error(error.message);
    }
    this.progress = Progress.fromJSON(saved, data);
    return this.progress;
  } // loadProgress

  /**
   * The progress into localStorage.
   */
  saveProgress() {
    if (!this.progress) {
      return;
    }
    try {
      localStorage.setItem(GameApp.progressKey(), JSON.stringify(this.progress.toJSON()));
    } catch (error) {
      console.error(error.message);
    }
  } // saveProgress

  /**
   * A run over (`GameManager.GameOver`, notes 13): its coins to the total,
   * its distance the record of the world when longer, saved. The hall of
   * fame is separate (`saveScore`: it needs the player's name).
   * @param {number} distance - Metres.
   * @param {number} coins - The coins of the run.
   * @returns {Object|null} `{record, newRecord, total}` — the record before, whether it fell, the coins now; null without a progress.
   */
  finishGame(distance, coins) {
    if (!this.progress) {
      return null;
    }
    var r = this.progress.finishRun(distance, coins);
    this.saveProgress();
    return {record: r.record, newRecord: r.newRecord, total: this.progress.coins};
  } // finishGame

  /**
   * A finished game into the hall of fame (saveGame.db): the name and the
   * score (the distance in metres); the answer refreshes the high score and
   * the ten best. Nothing is sent without a name or a score, or offline.
   * @param {string} name - The player's name.
   * @param {number} score
   */
  saveScore(name, score) {
    name = String(name || '').trim();
    if (!name || !(score > 0)) {
      return;
    }
    var receiver = {
      id: this.id+'Save',
      fetchDataId: '',
      setData: (data) => {
        if (data.data.hiScore) {
          this.hiScore = data.data.hiScore;
        }
        if (Array.isArray(data.data.hallOfFame) && data.data.hallOfFame.length) {
          this.hallOfFame = data.data.hallOfFame;
        }
      },
      errorData: (error) => console.error(error.message ? error.message : error)
    };
    receiver.fetchDataId = this.fetchData('saveGame.db', false, {name: name, score: score}, receiver);
  } // saveScore

  /**
   * The seed of the game's randomness (METHODOLOGY): the clock, or in dev
   * mode a pinned one (`?devSeed=49374`, `Tool.devParam`, R-058) so a run
   * can be repeated.
   * @returns {number} uint32
   */
  gameSeed() {
    var pinned = Number(Tool.devParam('devSeed', 0));
    if (Number.isFinite(pinned) && pinned > 0) {
      return pinned >>> 0;
    }
    return Date.now() >>> 0;
  } // gameSeed

  /**
   * The data of the game (data/ships.json, worlds.json, pickups.json —
   * GR-M4) delivered by appData.db and cached in localStorage by
   * setGlobalData(), the global data (data/global.json with the `rules`
   * the game reads, GR-M5), and what of the assets is at hand: the ships'
   * meshes attached, the loaded worlds composed into `sections`
   * (`{source, blocks, worlds: {id: {sections}}, materials, meshes}`, null with none). Null
   * where missing (before the first answer of the server): the playfield
   * then draws the dart and the fallback colours.
   * @returns {Object} `{global, ships, worlds, sections, pickups}`
   */
  gameData() {
    var result = {ships: null, worlds: null, pickups: null};
    result.global = this.globalData || null;
    Object.keys(result).forEach((key) => {
      var stored = localStorage.getItem(window.appPrefix+'.'+key);
      if (stored !== null) {
        try {
          result[key] = JSON.parse(stored);
        } catch (error) {
          console.error(error.message);
        }
      }
    });
    // the assets at hand: the meshes onto the ships, the tracks composed into `sections`
    if (result.ships && result.ships.ships) {
      result.ships.ships.forEach((ship) => {
        var a = this.assets.ships[ship.id];
        ship.mesh = a ? a.mesh : null;
      });
    }
    var sections = {source: null, blocks: [], worlds: {}, materials: {}, meshes: {}}, seen = {};
    Object.keys(this.assets.worlds).forEach((id) => {
      var t = this.assets.worlds[id];
      sections.source = t.source;
      Object.assign(sections.materials, t.materials || {});
      Object.assign(sections.meshes, t.meshes || {});
      t.blocks.forEach((b) => {
        if (!seen[b.id]) {
          seen[b.id] = true;
          sections.blocks.push(b);
        }
      });
      sections.worlds[id] = {sections: t.sections};
    });
    result.sections = Object.keys(sections.worlds).length ? sections : null;
    return result;
  } // gameData

  /**
   * Fetches a static asset once (a JSON file next to the page) and hands it
   * to everyone waiting; from memory the second time.
   * @param {string} kind - 'ships' | 'worlds' (the store in `assets`).
   * @param {string} id
   * @param {Function} done - `(asset|null) => void`, at once when it is in memory.
   */
  loadAsset(kind, id, done) {
    if (this.assets[kind][id]) {
      done(this.assets[kind][id]);
      return;
    }
    var key = kind+'/'+id;
    if (this.assets.pending[key]) {
      this.assets.pending[key].push(done);
      return;
    }
    this.assets.pending[key] = [done];
    var finish = (asset) => {
      var waiting = this.assets.pending[key] || [];
      delete this.assets.pending[key];
      if (asset) {
        this.assets[kind][id] = asset;
      }
      waiting.forEach((cb) => cb(asset || null));
    };
    fetch('assets/'+key+'.json?ver='+window.srcVersion).then((response) => {
      if (!response.ok) {
        throw new Error('assets/'+key+'.json: '+response.status);
      }
      return response.json();
    }).then(finish).catch((error) => {
      console.error(error.message);
      finish(null);
    });
  } // loadAsset

  /**
   * The mesh of a ship at hand (assets/ships/<id>.json).
   * @param {string} id
   * @param {Function} done - `(ok) => void`
   */
  ensureShip(id, done) {
    if (!id) {
      done(false);
      return;
    }
    this.loadAsset('ships', id, (a) => done(!!a));
  } // ensureShip

  /**
   * The track of a world at hand (assets/worlds/<id>.json).
   * @param {string} id
   * @param {Function} done - `(ok) => void`
   */
  ensureWorld(id, done) {
    if (!id) {
      done(false);
      return;
    }
    this.loadAsset('worlds', id, (a) => done(!!a));
  } // ensureWorld

  /**
   * The formats of the music, in the order to try them: AAC (`.m4a`,
   * Chrome, Safari, the phones) where the browser says it plays it, Ogg
   * Vorbis (`.ogg`, Firefox and the open Chromium builds without AAC)
   * otherwise — the operator makes both (README).
   * @returns {string[]} Extensions.
   */
  static musicFormats() {
    var can = (type) => {
      try {
        return !!document.createElement('audio').canPlayType(type);
      } catch (error) {
        return false;
      }
    };
    var aac = can('audio/mp4; codecs="mp4a.40.2"'), ogg = can('audio/ogg; codecs="vorbis"');
    if (aac && !ogg) {
      return ['m4a', 'ogg'];
    }
    if (ogg && !aac) {
      return ['ogg', 'm4a'];
    }
    return ['m4a', 'ogg'];
  } // musicFormats

  /**
   * The music of a world decoded and at hand (assets/music/<id>.m4a or
   * .ogg, `musicFormats`; `assets.music[id]` is the sample, `false` once
   * no format came so it is not asked for again). Nothing without an
   * audio manager.
   * @param {string} id
   * @param {Function} done - `(ok) => void`
   */
  ensureMusic(id, done) {
    if (!id || !this.audioManager) {
      done(false);
      return;
    }
    if (id in this.assets.music) {
      done(!!this.assets.music[id]);
      return;
    }
    var key = 'music/'+id;
    if (this.assets.pending[key]) {
      this.assets.pending[key].push(done);
      return;
    }
    this.assets.pending[key] = [done];
    var formats = GameApp.musicFormats();
    var attempt = (i) => {
      if (i >= formats.length) {
        finish(null);
        return;
      }
      this.audioManager.loadSample('assets/'+key+'.'+formats[i]+'?ver='+window.srcVersion, (sample) => sample ? finish(sample) : attempt(i+1));
    };
    var finish = (sample) => {
      var waiting = this.assets.pending[key] || [];
      delete this.assets.pending[key];
      this.assets.music[id] = sample || false;
      waiting.forEach((cb) => cb(!!sample));
    };
    attempt(0);
  } // ensureMusic

  /**
   * A sound file in the first format the browser plays (`musicFormats`),
   * decoded through the audio manager.
   * @param {string} base - The path without the extension (`assets/sfx/explosion`).
   * @param {Function} done - `(sample|null) => void`
   */
  loadSound(base, done) {
    var formats = GameApp.musicFormats();
    var attempt = (i) => {
      if (i >= formats.length) {
        done(null);
        return;
      }
      this.audioManager.loadSample(base+'.'+formats[i]+'?ver='+window.srcVersion, (sample) => sample ? done(sample) : attempt(i+1));
    };
    attempt(0);
  } // loadSound

  /**
   * The original's effects decoded and on the audio manager
   * (`audioManager.samples`, assets/sfx/<name>.m4a|ogg for every name of
   * `AudioManager.samples`) — once; `assets.sfx` is true when all came,
   * false when any did not (the synthesized effects play then).
   * @param {Function} done - `(ok) => void`
   */
  ensureSfx(done) {
    if (!this.audioManager) {
      done(false);
      return;
    }
    if (this.assets.sfx !== null) {
      done(this.assets.sfx);
      return;
    }
    var key = 'sfx';
    if (this.assets.pending[key]) {
      this.assets.pending[key].push(done);
      return;
    }
    this.assets.pending[key] = [done];
    var names = Object.keys(this.audioManager.constructor.samples);
    var left = names.length;
    names.forEach((name) => {
      this.loadSound('assets/sfx/'+name, (sample) => {
        if (sample) {
          this.audioManager.samples[name] = sample;
        }
        if (--left === 0) {
          var waiting = this.assets.pending[key] || [];
          delete this.assets.pending[key];
          this.assets.sfx = this.audioManager.hasSamples();
          waiting.forEach((cb) => cb(this.assets.sfx));
        }
      });
    });
  } // ensureSfx

  setGlobalData(data) {
    this.applyGlobalData(data.data.global);

    var files = {};
    Object.keys(data.data).forEach((key) => {
      if (key == 'hiScore') {
        this.hiScore = data.data[key];
      } else if (key == 'hallOfFame') {
        this.hallOfFame = Array.isArray(data.data[key]) ? data.data[key] : [];
      } else if (key != 'global') {
        files[key] = data.data[key];
      }
    });
    // global goes last; a full localStorage is cleared and tried once more
    // (R-062)
    this.saveAppDataToStorage(files, data.data.global);
  } // setGlobalData

  // Load the application data: from the server when online (which also refreshes
  // localStorage), or rehydrate the global data from localStorage when offline.
  loadAppData() {
    if (navigator.onLine) {
      this.fetchDataId = this.fetchData('appData.db', false, {}, this, 2000);
    } else {
      this.loadGlobalDataFromStorage();
    }
  } // loadAppData

  loadGlobalDataFromStorage() {
    var stored = localStorage.getItem(window.appPrefix+'.global');
    if (stored !== null) {
      try {
        this.applyGlobalData(JSON.parse(stored));
        return true;
      } catch (error) {
        console.error(error.message);
      }
    }
    return false;
  } // loadGlobalDataFromStorage

  setData(data) {
    this.setGlobalData(data);
  } // setData

  errorData(error) {
    if (!this.loadGlobalDataFromStorage()) {
      console.error(error.message ? error.message : error);
      return;
    }
    // resume a boot that already gave up waiting for this response
    if (this.model && this.model.id == 'BootModel'
        && !this.model.events.some((queued) => queued.id == 'setMenuModel')
        && !this.model.desktopEntity.modalEntity) {
      this.setModel('MenuModel');
    }
  } // errorData

  /**
   * A notice with the error over the current screen. `retry` asks the boot
   * to load the data again when the notice closes; `restart` reloads the page.
   * @param {string} message
   * @param {string} action - 'retry' | 'restart' | 'ignore'
   */
  showErrorMessage(message, action) {
    var topModalEntity = this.model.desktopEntity.topModalEntity();
    var continueEvent = false;
    if (action == 'retry') {
      continueEvent = {id: 'retryLoadAppData'};
    } else if (action == 'restart') {
      continueEvent = {id: 'reloadApp'};
    }
    var w = this.model.desktopWidth, h = this.model.desktopHeight;
    topModalEntity.addModalEntity(new NoticeEntity(topModalEntity,
      -topModalEntity.absoluteX()+((w-NoticeEntity.WIDTH) >> 1), -topModalEntity.absoluteY()+((h-NoticeEntity.HEIGHT) >> 1),
      'ERROR', [String(message).toUpperCase()], continueEvent));
  } // showErrorMessage

} // GameApp
