#!/usr/bin/env node
/**
 * checksave — the player's progress (app/progress.js, GR-M8) checked
 * under Node against the mechanics of the notes: the store (notes 14 —
 * the prices of the upgrade levels with the growth and the flooring, the
 * levels turned into multipliers, buying a ship, an upgrade, selecting),
 * the worlds' unlocking (notes 15 — strictly over the distance to win,
 * or bought), a run over (notes 13 — the coins to the total, the record of
 * the world) and the saving (notes 16 — the JSON round trip through a
 * string, the way localStorage keeps it, a fresh progress for another
 * version or garbage, every value clamped on the way in). No DOM, no
 * server: the same class the application saves.
 *
 * The report is the number of checks and the number of differences; the
 * exit code is the number of differences.
 *
 * usage: node tools/checksave.mjs [-v]
 */
import '../app/svision/tools/nodeEnv.mjs';   // must come first: the import headers read window.srcVersion
import fs from 'node:fs';
import path from 'node:path';

const { Progress } = await import('../app/progress.js');

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const verbose = process.argv.includes('-v');
let checks = 0, differences = 0;

function check(name, ok, detail) {
  checks++;
  if (!ok) {
    differences++;
    console.log(`  DIFF ${name}${detail !== undefined ? ': '+JSON.stringify(detail) : ''}`);
  } else if (verbose) {
    console.log(`  ok   ${name}`);
  }
} // check

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const near = (a, b) => Math.abs(a-b) < 1e-9;

const json = (file) => JSON.parse(fs.readFileSync(path.join(root, 'data', file+'.json'), 'utf8'));
const data = {global: json('global'), ships: json('ships'), worlds: json('worlds')};
const R = data.global.rules.upgrades;
const ships = data.ships.ships, worlds = data.worlds.worlds;
const defaultShip = ships.find((s) => s.default);
const bySlot = (type, min) => ships.find((s) => (s.upgrades || []).some((u) => u.type === type && (min === undefined || u.min === min)));

// ------------------------------------------------------------------ fresh

console.log('fresh progress');
{
  const p = new Progress(data);
  check('coins 0', p.coins === 0);
  check('default ship bought and active', p.shipBought(defaultShip.id) && p.activeShip === defaultShip.id);
  check('the other ships not bought', ships.filter((s) => !s.default).every((s) => !p.shipBought(s.id)));
  check('every slot at its min', ships.every((s) => (s.upgrades || []).every((u) => p.upgradeLevel(s.id, u.type) === u.min)));
  check('world 0 selected and open', p.world === 0 && p.worldUnlocked(0));
  check('the priced worlds closed', worlds.every((w, i) => (w.price > 0) === !p.worldUnlocked(i)));
  check('records 0', worlds.every((w, i) => p.record(i) === 0));
}

// ----------------------------------------------------------------- prices

console.log('prices (notes 14)');
{
  // the flooring: one significant digit under 100, two from 100 on
  const floors = [[20, 20], [24, 20], [28.8, 20], [34.56, 30], [41.472, 40], [49.766, 40], [99, 90], [100, 100], [105, 100], [119.9, 110], [192, 190], [230.4, 230], [276.48, 270], [331.776, 330], [398.13, 390], [999, 990], [1000, 1000], [1234, 1200]];
  floors.forEach(([v, want]) => check(`floorPrice(${v}) = ${want}`, Progress.floorPrice(v) === want, Progress.floorPrice(v)));
  check('priceGrowth is the notes\' 1.2', near(R.priceGrowth, 1.2));
  check('levelsToMax is the notes\' 20', R.levelsToMax === 20);

  // a slot from 0 with base 20 (the second ship of the notes): 20, 20, 20, 30, 40, 40
  const p = new Progress(data);
  const s20 = bySlot('battery', 0);
  check('a ship with a battery slot from 0 exists', !!s20);
  if (s20) {
    const slot = s20.upgrades.find((u) => u.type === 'battery');
    const want = [20, 20, 20, 30, 40, 40].map((x) => x*slot.price/20);
    const got = [];
    for (let level = slot.min+1; level <= slot.max; level++) {
      got.push(p.levelPrice(slot, level));
    }
    check(`levels ${slot.min+1}..${slot.max} of base ${slot.price}`, same(got, want), got);
  }
  // a slot from 4 with base 160 (the eighth ship): 160, 190, 230, 270, 330, 390
  const s160 = bySlot('battery', 4);
  check('a ship with a battery slot from 4 exists', !!s160);
  if (s160) {
    const slot = s160.upgrades.find((u) => u.type === 'battery');
    const got = [];
    for (let level = slot.min+1; level <= slot.max; level++) {
      got.push(p.levelPrice(slot, level));
    }
    check(`levels ${slot.min+1}..${slot.max} of base ${slot.price} from ${slot.min}`, same(got, [160, 190, 230, 270, 330, 390].map((x) => x*slot.price/160)), got);
  }
  // upgradePrice: the next level's, null at the top and for a missing slot
  check('upgradePrice of a missing slot is null', p.upgradePrice(defaultShip.id, 'battery') === null);
  if (s20) {
    p.ships[s20.id].upgrades.battery = s20.upgrades[0].max;
    check('upgradePrice at the top is null', p.upgradePrice(s20.id, 'battery') === null);
  }
}

// ------------------------------------------------------------ multipliers

console.log('multipliers (notes 14)');
{
  const p = new Progress(data);
  const m = p.multipliers(defaultShip.id);
  check('the default ship: every multiplier at the minimum', near(m.battery, R.ranges.battery[0]) && near(m.coins, R.ranges.coins[0]) && near(m.multiplier, R.ranges.multiplier[0]), m);
  check('the default ship: no magnet', m.magnet === 0, m);
  const magnetShip = bySlot('magnet');
  if (magnetShip) {
    const slot = magnetShip.upgrades.find((u) => u.type === 'magnet');
    const want = R.ranges.magnet[0]+Math.min(1, slot.min/R.levelsToMax)*(R.ranges.magnet[1]-R.ranges.magnet[0]);
    check('a ship with a magnet slot has the magnet at its min level', near(p.multipliers(magnetShip.id).magnet, want), p.multipliers(magnetShip.id));
    p.ships[magnetShip.id].upgrades.magnet = slot.max;
    check('magnet at the top level = min + max/20 of the range', near(p.multipliers(magnetShip.id).magnet, R.ranges.magnet[0]+(slot.max/R.levelsToMax)*(R.ranges.magnet[1]-R.ranges.magnet[0])));
  }
  const s160 = bySlot('battery', 4);
  if (s160) {
    check('battery level 4 = 1.2 (f = 4/20)', near(p.multipliers(s160.id).battery, 1.2), p.multipliers(s160.id));
    p.ships[s160.id].upgrades.battery = 10;
    check('battery level 10 = 1.5 (the example of the notes)', near(p.multipliers(s160.id).battery, 1.5), p.multipliers(s160.id));
    p.ships[s160.id].upgrades.battery = 40;
    check('a level over levelsToMax is clamped to the maximum', near(p.multipliers(s160.id).battery, R.ranges.battery[1]));
  }
  check('the active ship by default', same(p.multipliers(), p.multipliers(p.activeShip)));
}

// ------------------------------------------------------------------ store

console.log('the store (notes 14)');
{
  const p = new Progress(data);
  const ship = ships.find((s) => s.price > 0 && (s.upgrades || []).length > 0);
  const slot = ship.upgrades[0];
  check('cannot buy without coins', !p.buyShip(ship.id) && !p.shipBought(ship.id));
  check('cannot select an unbought ship', !p.selectShip(ship.id) && p.activeShip === defaultShip.id);
  check('cannot upgrade an unbought ship', !p.buyUpgrade(ship.id, slot.type));
  p.coins = ship.price-1;
  check('one coin short: no sale', !p.buyShip(ship.id) && p.coins === ship.price-1);
  p.coins = ship.price;
  check('the exact price buys', p.buyShip(ship.id) && p.shipBought(ship.id) && p.coins === 0);
  check('not sold twice', !p.buyShip(ship.id));
  check('a bought ship can be selected', p.selectShip(ship.id) && p.activeShip === ship.id);
  check('buying the default ship again fails', !p.buyShip(defaultShip.id));
  const first = p.upgradePrice(ship.id, slot.type);
  check('the first level costs the base', first === Progress.floorPrice(slot.price), first);
  check('no upgrade without coins', !p.buyUpgrade(ship.id, slot.type) && p.upgradeLevel(ship.id, slot.type) === slot.min);
  p.coins = first;
  check('the upgrade sells for its price', p.buyUpgrade(ship.id, slot.type) && p.upgradeLevel(ship.id, slot.type) === slot.min+1 && p.coins === 0);
  check('an unknown type is not sold', !p.buyUpgrade(ship.id, 'nonsense'));
  p.coins = 1e9;
  let bought = 0;
  while (p.buyUpgrade(ship.id, slot.type)) {
    bought++;
  }
  check('the upgrade stops at max', bought === slot.max-slot.min-1 && p.upgradeLevel(ship.id, slot.type) === slot.max && p.upgradePrice(ship.id, slot.type) === null, {bought: bought, level: p.upgradeLevel(ship.id, slot.type)});
  const spent = 1e9-p.coins;
  let want = 0;
  for (let level = slot.min+2; level <= slot.max; level++) {
    want += p.levelPrice(slot, level);
  }
  check('the coins spent are the sum of the level prices', spent === want, {spent: spent, want: want});
  const listed = p.upgrades(ship.id);
  check('upgrades() lists every slot with its level and next price', listed.length === ship.upgrades.length && listed[0].level === slot.max && listed[0].price === null, listed);
}

// ----------------------------------------------------------------- worlds

console.log('the worlds (notes 15)');
{
  const p = new Progress(data);
  const w1 = worlds[1], w2 = worlds[2];
  check('world 1 closed at a record of 0', !p.worldUnlocked(1));
  check('cannot select a closed world', !p.selectWorld(1) && p.world === 0);
  p.worlds[worlds[0].id].record = w1.distanceToWin;
  check(`a record of exactly ${w1.distanceToWin} m does not open world 1 (strictly over)`, !p.worldUnlocked(1));
  p.worlds[worlds[0].id].record = w1.distanceToWin+1;
  check(`a record of ${w1.distanceToWin+1} m opens world 1`, p.worldUnlocked(1));
  check('world 2 is still closed (its own previous world counts)', !p.worldUnlocked(2));
  check('an open world can be selected', p.selectWorld(1) && p.world === 1);
  check('buying an open world fails', !p.buyWorld(1));
  p.coins = w2.price-1;
  check('one coin short of world 2: no sale', !p.buyWorld(2) && !p.worldUnlocked(2));
  p.coins = w2.price;
  check('world 2 bought for its price', p.buyWorld(2) && p.worldUnlocked(2) && p.coins === 0);
  check('a bought world stays open with the record gone', (p.worlds[worlds[1].id].record = 0, p.worldUnlocked(2)));
  check('an unknown world is closed', !p.worldUnlocked(7) && !p.selectWorld(7) && !p.buyWorld(7));
}

// ------------------------------------------------------------------- runs

console.log('a run over (notes 13)');
{
  const p = new Progress(data);
  let r = p.finishRun(1234.9, 17);
  check('the coins go to the total', p.coins === 17);
  check('the distance becomes the record (whole metres)', p.record(0) === 1234 && r.newRecord && r.record === 0, r);
  r = p.finishRun(1000, 3);
  check('a shorter run keeps the record', p.record(0) === 1234 && !r.newRecord && r.record === 1234, r);
  check('its coins still count', p.coins === 20);
  r = p.finishRun(1234, 0);
  check('the same distance is not a new record', !r.newRecord);
  p.selectWorld(0);
  p.worlds[worlds[0].id].record = worlds[1].distanceToWin+1;
  p.selectWorld(1);
  p.finishRun(500, 0);
  check('the record goes to the selected world', p.record(1) === 500 && p.record(0) === worlds[1].distanceToWin+1);
  check('negative or NaN input counts as nothing', (p.finishRun(-5, NaN), p.coins === 20 && p.record(1) === 500));
}

// ------------------------------------------------------------------- JSON

console.log('saving (notes 16)');
{
  const fresh = new Progress(data);
  const j = fresh.toJSON();
  check('the JSON is versioned', j.version === Progress.VERSION);
  check('a fresh round trip is identical', same(Progress.fromJSON(JSON.parse(JSON.stringify(j)), data).toJSON(), j));

  // a lived-in progress
  const p = new Progress(data);
  p.coins = 5000;
  const ship = ships.find((s) => s.price > 0 && (s.upgrades || []).length > 0);
  p.buyShip(ship.id);
  p.buyUpgrade(ship.id, ship.upgrades[0].type);
  p.selectShip(ship.id);
  p.worlds[worlds[0].id].record = worlds[1].distanceToWin+1;
  p.selectWorld(1);
  p.buyWorld(2);
  p.finishRun(777, 12);
  const s = JSON.stringify(p.toJSON());
  const back = Progress.fromJSON(JSON.parse(s), data);
  check('a lived-in round trip is identical', same(back.toJSON(), p.toJSON()), {saved: p.toJSON(), loaded: back.toJSON()});
  check('the round trip keeps the coins, the ship, the level, the world, the records', back.coins === p.coins && back.activeShip === ship.id && back.upgradeLevel(ship.id, ship.upgrades[0].type) === ship.upgrades[0].min+1 && back.world === 1 && back.record(1) === 777 && back.worldUnlocked(2));
  check('the multipliers survive the round trip', same(back.multipliers(), p.multipliers()));

  // what does not load
  check('null is a fresh progress', same(Progress.fromJSON(null, data).toJSON(), fresh.toJSON()));
  check('a string is a fresh progress', same(Progress.fromJSON('nonsense', data).toJSON(), fresh.toJSON()));
  check('another version is a fresh progress', same(Progress.fromJSON(Object.assign(JSON.parse(s), {version: Progress.VERSION+1}), data).toJSON(), fresh.toJSON()));
  check('no version is a fresh progress', (() => { const g = JSON.parse(s); delete g.version; return same(Progress.fromJSON(g, data).toJSON(), fresh.toJSON()); })());

  // garbage clamped
  const g = JSON.parse(s);
  g.coins = -40;
  g.ships[ship.id].upgrades[ship.upgrades[0].type] = 99;
  g.ships[defaultShip.id].bought = false;
  g.ships['nonsense'] = {bought: true, upgrades: {}};
  g.activeShip = 'nonsense';
  g.world = 7;
  g.worlds[worlds[2].id].record = -3;
  g.worlds['nonsense'] = {bought: true, record: 1};
  const c = Progress.fromJSON(g, data);
  check('negative coins load as 0', c.coins === 0);
  check('a level over max is clamped to max', c.upgradeLevel(ship.id, ship.upgrades[0].type) === ship.upgrades[0].max);
  check('the default ship cannot be un-bought', c.shipBought(defaultShip.id));
  check('an unknown ship is dropped', !('nonsense' in c.ships) && !('nonsense' in c.toJSON().ships));
  check('an unknown active ship falls back to the default', c.activeShip === defaultShip.id);
  check('an unknown world index falls back to 0', c.world === 0);
  check('a negative record loads as 0', c.record(2) === 0);
  check('an unknown world is dropped', !('nonsense' in c.worlds));
  const g2 = JSON.parse(s);
  g2.ships[ship.id].upgrades[ship.upgrades[0].type] = -5;
  g2.activeShip = ships.find((x) => x.price > 0 && x.id !== ship.id).id;   // not bought
  g2.worlds[worlds[0].id].record = 0;
  g2.worlds[worlds[2].id].bought = false;
  g2.world = 2;
  const c2 = Progress.fromJSON(g2, data);
  check('a level under min is clamped to min', c2.upgradeLevel(ship.id, ship.upgrades[0].type) === ship.upgrades[0].min);
  check('an unbought active ship falls back to the default', c2.activeShip === defaultShip.id);
  check('a closed selected world falls back to 0', c2.world === 0);
  check('the JSON of the store has no reference to the data (plain values only)', !/"mesh"|"positions"/.test(s));
}

console.log(`checksave: ${checks} checks, ${differences} differences`);
process.exit(differences);
