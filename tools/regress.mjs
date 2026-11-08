#!/usr/bin/env node
/**
 * regress — the fingerprints of the screens (METHODOLOGY: regress, not
 * match — there is no original to sit on, only yesterday's build).
 *
 * Each screen is built under Node on the stand-in application of the 3D
 * platform (svision/tools/headlessApp.mjs `headlessSceneApp`), drawn once
 * through the headless layout, and its markup — the records the browser
 * layout would draw on the 2D overlay (backgrounds, texts) and, for the
 * SceneEntity, the scene's own markup (camera, lights, background, one
 * line per item: mesh id, transform, colours) — is compared with the
 * reference in tools/regress/<screen>.txt. Never a pixel from a GPU
 * (R-032). The report is the number of lines and the number of lines that
 * differ; the exit code is the total of the differences.
 *
 * Screens: `menu` (MenuModel over the playfield at rest); `scene` runs the
 * game headless (GameWorker, seed $C0DE) for one tick and draws the frame
 * through MainModel — the first frame of a run: the ship 6 u on, the entry
 * row of blocks with the first obstacles switched on, the HUD; `fly` runs
 * it for 200 ticks with a scripted input — 50 ticks straight, 60 steering
 * left, 40 right, 50 straight — the ship past the run-up, easing back
 * level, the camera trailing (notes 6, 6a), the second row generated, the
 * tumbling boxes of the own dynamic block on their way; `over` runs 2050
 * ticks without steering and **without a track** — the energy drains from
 * 6 s on (notes 10), the ship sinks under a quarter, the run ends a second
 * after the energy is gone: the game-over notice over the frozen scene;
 * `crash` runs straight into the own track until the ship hits a box (a
 * few hundred ticks in) and a second more: the notice over the frozen
 * scene with the ship gone (notes 2, 11); `collect` (GR-M7) flies a
 * pickup-seeking driver at the coins of the own track with the obstacle
 * collisions switched off (`setup`: the fingerprint is the pickups, the
 * coins and the message on the HUD, not a crash) until the second coin and
 * 10 ticks more — the "COINS +1" message still up; `powerup` the same at
 * the multipliers until the first one and 60 ticks more — the X2 with its
 * timer bar part run down. GR-M8, on a lived-in progress (app/progress.js:
 * 700 coins, a record of 3200 m in the first world — the second open by
 * it, the third closed — the second ship bought with its battery at level
 * 2 and active): `shop` is the menu with the SHIPS dialog open on the
 * store's list (the highlighted second ship in the scene behind);
 * `upgrades` the same dialog on the page of that ship (USE THIS SHIP, the
 * battery's level and next price, BACK); `worlds` the WORLDS dialog with
 * the second world highlighted and selected (its colours behind); `hall`
 * the HALL OF FAME dialog with the ten rows the application holds;
 * `gameover` the `crash` run ended on the progress with a record of 200 m
 * in the first world: the notice with the name, NEW RECORD! and the coins,
 * the RECORD line on the HUD (`menu` itself shows the coins and the
 * active ship and world of a fresh progress).
 *
 * usage: node tools/regress.mjs [screen ...]        compare with the references
 *        node tools/regress.mjs --update [screen]   rewrite the reference(s)
 *        node tools/regress.mjs --print screen      print the markup
 *        node tools/regress.mjs --svg screen        print a stand-alone SVG document (rsvg-convert makes a PNG; the scene through Scene3D.project())
 *        node tools/regress.mjs --state screen      print the frame state of a game screen (JSON)
 */
import '../app/svision/tools/nodeEnv.mjs';   // must come first: the import headers read window.srcVersion
import fs from 'node:fs';
import path from 'node:path';

const { headlessSceneApp } = await import('../app/svision/tools/headlessApp.mjs');
const { ZXFonts8x8 } = await import('../app/svision/js/platform/canvas2D/zx/zxFonts8x8.js');
const { Fonts5x5 } = await import('../app/svision/js/platform/canvas2D/fonts5x5.js');
const { Fonts3x3 } = await import('../app/svision/js/platform/canvas2D/fonts3x3.js');
const { appPlatform } = await import('../app/appPlatform.js');
const { MenuModel } = await import('../app/menuModel.js');
const { MainModel } = await import('../app/mainModel.js');
const { GameWorker } = await import('../app/gameWorker.js');
const { Progress } = await import('../app/progress.js');

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
let screens = args.filter((a) => !a.startsWith('--') && a != '-v');
if (screens.length == 0) {
  screens = ['menu', 'scene', 'fly', 'over', 'crash', 'explosion', 'collect', 'powerup', 'countdown', 'shop', 'upgrades', 'worlds', 'hall', 'gameover'];
}
const MENU_SCREENS = ['menu', 'shop', 'upgrades', 'worlds', 'hall'];

const { loadData } = await import('./tracelib.mjs');
const data = loadData();               // data/*.json with the meshes and the tracks of assets/ attached, as the application composes them

/**
 * The input scripts of the game screens: `[ticks, {left, right}]` steps,
 * the actions held for that many ticks; `setup(game)` puts the game into a
 * state before the first tick; `track: false` runs without a track;
 * `untilOver` stops at the end of the run (the frame with `gameOver`).
 */
const SCRIPTS = {
  scene: {ticks: 1, steps: []},
  fly: {ticks: 200, steps: [[50, {}], [25, {left: true}], [25, {right: true}], [100, {}]]},   // shorter swerves since the original's entry block (2026-09-16): 60 ticks left ran into its wall of cubes
  over: {ticks: 2050, steps: [], gameOver: true, track: false},
  crash: {ticks: 3000, steps: [], gameOver: true, untilOver: true},
  // the explosion a third of a second in: the shards of the ship in its particle colours (notes 11)
  explosion: {ticks: 3000, steps: [], until: (game) => game.phase == 'crash', after: 17},
  collect: {ticks: 4000, steps: [], seek: 'coin', until: (game) => game.collected.coin >= 2, after: 10, setup: noCrash},
  powerup: {ticks: 4000, steps: [], seek: 'multiplier', until: (game) => game.collected.multiplier >= 1, after: 60, setup: noCrash},
  gameover: {ticks: 3000, steps: [], gameOver: true, untilOver: true, progress: 'record'},
  // GR-M9: the countdown out of a pause (UnpauseCounting) — the flight, paused, continued,
  // and drawn 825 ms in: the second digit, half shrunk
  countdown: {ticks: 200, steps: [[50, {}], [25, {left: true}], [25, {right: true}], [100, {}]], countdown: 825}
};

/**
 * The progress of a screen (GR-M8): fresh, or lived in (`shop`, `upgrades`,
 * `worlds`, `hall`), or with a record of 200 m to beat (`gameover`).
 * @param {string} kind - 'fresh' | 'lived' | 'record'
 * @returns {Progress}
 */
function makeProgress(kind) {
  const p = new Progress(data);
  const ships = p.shipDefs, worlds = p.worldDefs;
  if (kind == 'lived') {
    p.coins = 700+ships[1].price+p.levelPrice(ships[1].upgrades[0], ships[1].upgrades[0].min+1)+p.levelPrice(ships[1].upgrades[0], ships[1].upgrades[0].min+2);
    p.buyShip(ships[1].id);
    p.buyUpgrade(ships[1].id, ships[1].upgrades[0].type);
    p.buyUpgrade(ships[1].id, ships[1].upgrades[0].type);
    p.selectShip(ships[1].id);
    p.worlds[worlds[0].id].record = 3200;
  } else if (kind == 'record') {
    p.worlds[worlds[0].id].record = 200;
    p.coins = 40;
  }
  return p;
} // makeProgress

/** the obstacle collisions off: the track's hit() finds nothing (the pickup screens) */
function noCrash(game) {
  game.track.hit = () => null;
} // noCrash

/**
 * The pickup-seeking driver: the steer (−1..1) towards the nearest pickup
 * of a kind ahead of the ship, proportional to the offset.
 * @param {Game} game
 * @param {string} kind
 * @returns {number}
 */
function seek(game, kind) {
  const ship = game.ship;
  // only the middle block of every row (the median x of the three at one
  // z): a pickup on a side block moves three widths across when the ship
  // leaves the middle one (the recycling), and the driver would chase it
  const byZ = {};
  game.track.active.forEach((b) => { (byZ[b.z] = byZ[b.z] || []).push(b); });
  const middle = new Set();
  Object.values(byZ).forEach((row) => {
    row.sort((a, b) => a.x-b.x);
    middle.add(row[row.length >> 1]);
  });
  const cands = game.track.active.filter((b) => middle.has(b)).flatMap((b) => b.pickups).filter((p) => p.kind == kind && p.c[2] > ship.z+60 && p.c[2] < ship.z+900);
  cands.sort((a, b) => a.c[2]-b.c[2]);
  return cands[0] ? Math.max(-1, Math.min(1, (cands[0].c[0]-ship.x)/10)) : 0;
} // seek

/**
 * The application as GameApp sets it up, minus the browser: a 1280x720
 * window (ratio 2, the desktop stays 640x360 under `fit: 'cover'`).
 */
function makeApp(progress) {
  const app = headlessSceneApp(appPlatform(), 1280, 720, {
    progress: progress || makeProgress('fresh'),
    saveProgress: () => {},
    finishGame: function(distance, coins) {
      const r = this.progress.finishRun(distance, coins);
      return {record: r.record, newRecord: r.newRecord, total: this.progress.coins};
    },
    hallOfFame: [['ACE', 4321], ['BRUNO', 3980], ['CLARA', 3512], ['DEE', 2999], ['ELI', 2500], ['FAY', 1750], ['GUS', 1200], ['HAL', 640], ['IVY', 300], ['JO', 12]].map(([name, score]) => ({name: name, score: score})),
    version: '0000.00.00',            // fixed: the fingerprint must not move with the version
    title: 'GEOMETRY RACE',
    copyright: '© 2026 L. MITRENGA, CC BY-NC-SA 4.0',
    playerName: 'PLAYER',
    hiScore: 1234,
    devModeName: false,
    globalData: data.global,
    controls: {keyboard: {left: 'ArrowLeft', right: 'ArrowRight', pause: ' ', sounds: 'N'}, mouse: {enable: false}, gamepads: {supported: false, devices: {}}, touchscreen: {supported: false, type: 'halves'}},
    gameData: () => ({ships: data.ships, worlds: data.worlds, sections: data.sections, pickups: data.pickups}),
    ensureShip: (id, done) => done(true),       // the assets are all attached under Node
    ensureWorld: (id, done) => done(true),
    gameSeed: () => 0xC0DE
  });
  app.fonts = {
    zxFonts8x8Mono: new ZXFonts8x8(app, false),
    zxFonts8x8: new ZXFonts8x8(app, true),
    zxFonts8x8Keys: new ZXFonts8x8(app, false),
    fonts5x5: new Fonts5x5(app),
    fonts3x3: new Fonts3x3(app)
  };
  return app;
} // makeApp

/**
 * Runs the game headless through a script and returns the last frame message.
 * @param {Object} script
 * @returns {Object}
 */
function runGame(script) {
  let last = null;
  const worker = new GameWorker((msg) => {
    if (msg.id == 'frame') {
      last = msg;
    }
  });
  worker.handleMessage({id: 'init', seed: 0xC0DE, data: {global: data.global, ships: data.ships, worlds: data.worlds, sections: data.sections, pickups: data.pickups}, headless: true,
    playerName: script.playerName || '', setup: script.setup, track: script.track});
  const actions = ['left', 'right'];
  let tick = 0, after = -1;
  const steps = script.steps.slice();
  let remaining = steps.length ? steps[0][0] : 0;
  while (tick < script.ticks && !(script.untilOver && last && last.gameOver) && after !== 0) {
    if (steps.length && remaining == 0) {
      steps.shift();
      remaining = steps.length ? steps[0][0] : 0;
    }
    const held = steps.length ? steps[0][1] : {};
    actions.forEach((a) => worker.handleMessage({id: 'controls', action: a, value: !!held[a]}));
    if (steps.length) {
      remaining--;
    }
    if (script.seek) {
      worker.handleMessage({id: 'tick', input: {steer: seek(worker.game, script.seek)}});
    } else {
      worker.handleMessage({id: 'tick'});
    }
    tick++;
    if (after < 0 && script.until && script.until(worker.game)) {
      after = script.after || 0;      // so many ticks more after the condition
    } else if (after > 0) {
      after--;
    }
  }
  return last;
} // runGame

/**
 * One frame of a screen as markup lines.
 */
function render(screen) {
  const script = SCRIPTS[screen];
  const app = makeApp(makeProgress(script ? (script.progress || 'fresh') : (screen == 'menu' ? 'fresh' : 'lived')));
  let model, frame = null;
  if (MENU_SCREENS.includes(screen)) {
    model = new MenuModel(app, 0);
    app.model = model;
    model.init();
    // the dialogs of GR-M8 opened as the menu opens them; the store's page
    // and the worlds' highlight through the contents' own calls (an Enter
    // on a row would go through the model's event queue)
    const open = {shop: 'showShips', upgrades: 'showShips', worlds: 'showWorlds', hall: 'showHallOfFame'}[screen];
    if (open) {
      model.handleEvent({id: open});
      const content = model.desktopEntity.modalEntity.contentEntity;
      if (screen == 'shop' || screen == 'upgrades') {
        content.menuEntity.changeMenuItem(1);
        if (screen == 'upgrades') {
          content.handleEvent({id: 'storeShip', index: 1});
        }
      } else if (screen == 'worlds') {
        content.menuEntity.changeMenuItem(1);
        content.handleEvent({id: 'worldsRow', index: 1});
      }
    }
  } else {
    frame = runGame(SCRIPTS[screen]);
    model = new MainModel(app);
    app.model = model;
    model.startWorker = () => {};       // no worker under Node: the frame is handed over below
    model.app.saveScore = () => {};     // no server either
    model.init();
    model.frame = frame;
    if (SCRIPTS[screen].gameOver) {
      model.handleWorkerMessage({data: frame});    // the worker's last frame ends the game: the notice
    }
  }
  model.resizeModel();                // fits the desktop into the pretended element and draws
  model.loopModel(16);                // one frame, as the browser would draw it
  if (script && script.countdown !== undefined) {
    // the pause and Enter: the notice goes, the countdown starts — then the frame it asks for
    model.ready = true;
    model.pauseGame();
    model.desktopEntity.modalEntity.destroy();
    model.handleEvent({id: 'continueGame'});
    model.loopModel(16+script.countdown);
  }
  return {app: app, markup: app.layout.markup(), frame: frame};
} // render

let total = 0;
for (const screen of screens) {
  if (!MENU_SCREENS.includes(screen) && !SCRIPTS[screen]) {
    console.log(`unknown screen: ${screen}`);
    process.exit(2);
  }
  const referenceFile = path.join(root, 'tools/regress', screen+'.txt');
  const r = render(screen);
  const lines = r.markup.split('\n');

  if (flags.includes('--svg')) {
    process.stdout.write(r.app.layout.toSVG());
    continue;
  }
  if (flags.includes('--print')) {
    process.stdout.write(r.markup+'\n');
    continue;
  }
  if (flags.includes('--state')) {
    process.stdout.write(JSON.stringify(r.frame ? r.frame.state : null, null, 1)+'\n');
    continue;
  }
  if (flags.includes('--update')) {
    fs.mkdirSync(path.dirname(referenceFile), {recursive: true});
    fs.writeFileSync(referenceFile, r.markup+'\n');
    console.log(`${screen}: ${lines.length} lines, reference written to ${path.relative(root, referenceFile)}`);
    continue;
  }
  if (!fs.existsSync(referenceFile)) {
    console.log(`${screen}: ${lines.length} lines, no reference (${path.relative(root, referenceFile)}) — run with --update`);
    total++;
    continue;
  }
  const reference = fs.readFileSync(referenceFile, 'utf8').replace(/\n$/, '').split('\n');
  let differences = Math.abs(lines.length-reference.length);
  const n = Math.min(lines.length, reference.length);
  for (let i = 0; i < n; i++) {
    if (lines[i] !== reference[i]) {
      differences++;
      if (args.includes('-v')) {
        console.log(`  DIFF line ${i+1}:\n    expected ${reference[i]}\n    got      ${lines[i]}`);
      }
    }
  }
  console.log(`${screen}: ${lines.length} lines, ${differences} differences`);
  total += differences;
}
process.exit(total);
