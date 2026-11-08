// begin code

/**
 * The player's progress (GR-M8): what the original keeps in PlayerPrefs
 * as `WorldsInfo`, `ShipsInfo` and `TotalCredits` (notes 16), with the
 * mechanics of the store (notes 14) and of the worlds' unlocking (notes
 * 15) — no real money anywhere, the coins of the runs are the only
 * currency. No DOM: the application keeps one in localStorage as the JSON
 * of `toJSON()` (`GameApp.saveProgress`), the tools check the round trip
 * (`tools/checksave.mjs`).
 *
 * The rules, with the chapter of the notes each comes from:
 * - a ship is bought for its price when the coins reach it; the ship of
 *   data/ships.json marked `default` is bought from the start and is the
 *   active ship until another is chosen (14);
 * - every upgrade slot of a ship (`{type, min, max, price}`) starts at its
 *   `min` level; the next level costs the slot's base price times
 *   `priceGrowth` (1.2) to the power of (level − min − 1), floored to one
 *   significant digit under 100 and two from 100 on; only the next level
 *   of a bought ship can be bought (14);
 * - a level turns into the game's multiplier of the type through
 *   f = clamp01(level / `levelsToMax`) and the range of the type
 *   (data/global.json `rules.upgrades.ranges`: battery 1–2, magnet 1–2,
 *   coins 1–3, multiplier 1–3); a ship without a slot of the type is at
 *   the minimum — and has no magnet at all (14);
 * - a world is open when its price is 0, when it was bought, or when the
 *   record of the world before it is strictly over the world's
 *   `distanceToWin`; a closed one can be bought for its price (15);
 * - a run over adds its coins to the total and its distance becomes the
 *   record of its world when it is longer (13);
 * - the JSON is versioned (`version`); an unknown version, or none, means
 *   a fresh progress (16).
 *
 * Nothing in here is drawn: the store and the worlds dialogs (storeEntity,
 * worldsEntity) read and call it and the application saves it.
 */
export class Progress {

  /** the version of the saved JSON: bump it when the shape changes and `fromJSON` cannot read the old one */
  static get VERSION() { return 1; }

  /**
   * @param {Object} data - The game's data `{global, ships, worlds}` (data/*.json); `global.rules.upgrades`, `ships.ships` and `worlds.worlds` are required.
   */
  constructor(data) {
    if (!data || !data.global || !data.global.rules || !data.global.rules.upgrades || !data.ships || !data.worlds) {
      throw new Error('Progress: the data (global.rules.upgrades, ships, worlds) is missing');
    }
    this.rules = data.global.rules.upgrades;
    this.shipDefs = data.ships.ships || [];
    this.worldDefs = data.worlds.worlds || [];
    this.coins = 0;
    this.ships = {};              // id -> {bought, upgrades: {type: level}}
    this.worlds = {};             // id -> {bought, record}
    this.shipDefs.forEach((s) => {
      var upgrades = {};
      (s.upgrades || []).forEach((u) => { upgrades[u.type] = u.min; });
      this.ships[s.id] = {bought: !!s.default || s.price === 0, upgrades: upgrades};
    });
    this.worldDefs.forEach((w) => {
      this.worlds[w.id] = {bought: !(w.price > 0), record: 0};
    });
    var first = this.shipDefs.find((s) => s.default) || this.shipDefs[0] || null;
    this.activeShip = first ? first.id : null;
    this.world = 0;               // the index of the selected world in data/worlds.json
  } // constructor

  // ------------------------------------------------------------- helpers

  /**
   * The definition of a ship.
   * @param {string} id
   * @returns {Object|null}
   */
  shipDef(id) {
    return this.shipDefs.find((s) => s.id === id) || null;
  } // shipDef

  /**
   * The definition of a world by its index.
   * @param {number} index
   * @returns {Object|null}
   */
  worldDef(index) {
    return this.worldDefs[index] || null;
  } // worldDef

  /**
   * A price floored to its significant digits the way the store does it
   * (notes 14): one digit under 100, two from 100 on.
   * @param {number} price
   * @returns {number}
   */
  static floorPrice(price) {
    if (price < 10) {
      return Math.floor(price);
    }
    var digits = price < 100 ? 1 : 2;
    var scale = Math.pow(10, Math.floor(Math.log10(price))-digits+1);
    return Math.floor(price/scale+1e-9)*scale;
  } // floorPrice

  /**
   * The price of a level of an upgrade slot: the base times the growth to
   * the power of (level − min − 1), floored (notes 14).
   * @param {Object} slot - `{min, max, price}`
   * @param {number} level - The level bought (min+1..max).
   * @returns {number}
   */
  levelPrice(slot, level) {
    return Progress.floorPrice(slot.price*Math.pow(this.rules.priceGrowth, level-slot.min-1));
  } // levelPrice

  // --------------------------------------------------------------- ships

  /**
   * @param {string} id
   * @returns {boolean}
   */
  shipBought(id) {
    return !!(this.ships[id] && this.ships[id].bought);
  } // shipBought

  /**
   * Buys a ship when the coins reach its price (`TryBuyShip`).
   * @param {string} id
   * @returns {boolean} Bought now.
   */
  buyShip(id) {
    var def = this.shipDef(id);
    if (!def || this.shipBought(id) || this.coins < def.price) {
      return false;
    }
    this.coins -= def.price;
    this.ships[id].bought = true;
    return true;
  } // buyShip

  /**
   * Makes a bought ship the active one (`OnShopExitConfirmed`).
   * @param {string} id
   * @returns {boolean}
   */
  selectShip(id) {
    if (!this.shipBought(id)) {
      return false;
    }
    this.activeShip = id;
    return true;
  } // selectShip

  /**
   * The level of an upgrade of a ship: the slot's level, or 0 for a ship
   * without the slot.
   * @param {string} id
   * @param {string} type - battery | magnet | coins | multiplier
   * @returns {number}
   */
  upgradeLevel(id, type) {
    var s = this.ships[id];
    return s && (type in s.upgrades) ? s.upgrades[type] : 0;
  } // upgradeLevel

  /**
   * The slots of a ship with their state: `{type, min, max, level, price}`
   * — `price` of the next level, or null at the top.
   * @param {string} id
   * @returns {Object[]}
   */
  upgrades(id) {
    var def = this.shipDef(id);
    if (!def) {
      return [];
    }
    return (def.upgrades || []).map((u) => {
      var level = this.upgradeLevel(id, u.type);
      return {type: u.type, min: u.min, max: u.max, level: level, price: level < u.max ? this.levelPrice(u, level+1) : null};
    });
  } // upgrades

  /**
   * The price of the next level of an upgrade, or null when there is none
   * (no such slot, or the top level).
   * @param {string} id
   * @param {string} type
   * @returns {number|null}
   */
  upgradePrice(id, type) {
    var u = this.upgrades(id).find((x) => x.type === type);
    return u ? u.price : null;
  } // upgradePrice

  /**
   * Buys the next level of an upgrade of a bought ship when the coins
   * reach its price (`TryBuyUpgrade`).
   * @param {string} id
   * @param {string} type
   * @returns {boolean}
   */
  buyUpgrade(id, type) {
    if (!this.shipBought(id)) {
      return false;
    }
    var price = this.upgradePrice(id, type);
    if (price === null || this.coins < price) {
      return false;
    }
    this.coins -= price;
    this.ships[id].upgrades[type]++;
    return true;
  } // buyUpgrade

  /**
   * The multipliers a ship brings into a run (`UpgradeToMultiplierAdapter`,
   * notes 14): `{battery, coins, multiplier, magnet}` — `magnet` 0 for a
   * ship without the slot (no magnet, `Game` options).
   * @param {string} [id] - The active ship by default.
   * @returns {Object}
   */
  multipliers(id) {
    id = id || this.activeShip;
    var def = this.shipDef(id);
    var result = {};
    Object.keys(this.rules.ranges).forEach((type) => {
      var range = this.rules.ranges[type];
      var f = Math.max(0, Math.min(1, this.upgradeLevel(id, type)/this.rules.levelsToMax));
      result[type] = range[0]+f*(range[1]-range[0]);
    });
    if (!def || !(def.upgrades || []).some((u) => u.type === 'magnet')) {
      result.magnet = 0;
    }
    return result;
  } // multipliers

  // -------------------------------------------------------------- worlds

  /**
   * The record of a world in metres.
   * @param {number} index
   * @returns {number}
   */
  record(index) {
    var def = this.worldDef(index);
    return def && this.worlds[def.id] ? this.worlds[def.id].record : 0;
  } // record

  /**
   * Is a world open (`WorldSelectManager.Refresh`, notes 15): free, bought,
   * or the record of the world before it strictly over its distance to win.
   * @param {number} index
   * @returns {boolean}
   */
  worldUnlocked(index) {
    var def = this.worldDef(index);
    if (!def) {
      return false;
    }
    if (!(def.price > 0) || this.worlds[def.id].bought) {
      return true;
    }
    return index > 0 && this.record(index-1) > def.distanceToWin;
  } // worldUnlocked

  /**
   * Buys a closed world for its coins (`BuyWithCoins`).
   * @param {number} index
   * @returns {boolean}
   */
  buyWorld(index) {
    var def = this.worldDef(index);
    if (!def || this.worldUnlocked(index) || this.coins < def.price) {
      return false;
    }
    this.coins -= def.price;
    this.worlds[def.id].bought = true;
    return true;
  } // buyWorld

  /**
   * Selects an open world for the next runs (`SelectedWorld`).
   * @param {number} index
   * @returns {boolean}
   */
  selectWorld(index) {
    if (!this.worldUnlocked(index)) {
      return false;
    }
    this.world = index;
    return true;
  } // selectWorld

  // ---------------------------------------------------------------- runs

  /**
   * A run over (`GameManager.GameOver`, notes 13): the coins go to the
   * total, the distance becomes the record of the selected world when it is
   * longer.
   * @param {number} distance - Metres (whole).
   * @param {number} coins - The coins of the run.
   * @returns {Object} `{record: the record before, newRecord: true when beaten}`
   */
  finishRun(distance, coins) {
    distance = Math.max(0, Math.trunc(distance || 0));
    this.coins += Math.max(0, Math.trunc(coins || 0));
    var before = this.record(this.world), def = this.worldDef(this.world);
    var newRecord = def && distance > before;
    if (newRecord) {
      this.worlds[def.id].record = distance;
    }
    return {record: before, newRecord: !!newRecord};
  } // finishRun

  // ---------------------------------------------------------------- JSON

  /**
   * The progress as plain data for localStorage: versioned, keyed by the
   * ids of data/*.json (a ship or a world added later comes in fresh).
   * @returns {Object}
   */
  toJSON() {
    var ships = {}, worlds = {};
    Object.keys(this.ships).forEach((id) => {
      ships[id] = {bought: this.ships[id].bought, upgrades: Object.assign({}, this.ships[id].upgrades)};
    });
    Object.keys(this.worlds).forEach((id) => {
      worlds[id] = {bought: this.worlds[id].bought, record: this.worlds[id].record};
    });
    return {version: Progress.VERSION, coins: this.coins, activeShip: this.activeShip, world: this.world, ships: ships, worlds: worlds};
  } // toJSON

  /**
   * A progress from the data `toJSON()` gave — or a fresh one for another
   * version, a broken shape, or nothing. Every value is clamped to what the
   * data allows: an unknown ship or world is dropped, a level is kept
   * between the slot's min and max, a bought default is not un-bought, the
   * active ship must be bought, the selected world open.
   * @param {Object|null} json
   * @param {Object} data - The game's data (see the constructor).
   * @returns {Progress}
   */
  static fromJSON(json, data) {
    var p = new Progress(data);
    if (!json || typeof json != 'object' || json.version !== Progress.VERSION) {
      return p;
    }
    var int = (v) => (typeof v == 'number' && isFinite(v) ? Math.max(0, Math.trunc(v)) : 0);
    p.coins = int(json.coins);
    var ships = json.ships || {};
    p.shipDefs.forEach((def) => {
      var saved = ships[def.id];
      if (!saved || typeof saved != 'object') {
        return;
      }
      var s = p.ships[def.id];
      s.bought = s.bought || !!saved.bought;
      (def.upgrades || []).forEach((u) => {
        var level = saved.upgrades && typeof saved.upgrades[u.type] == 'number' ? int(saved.upgrades[u.type]) : u.min;
        s.upgrades[u.type] = Math.max(u.min, Math.min(u.max, level));
      });
    });
    var worlds = json.worlds || {};
    p.worldDefs.forEach((def) => {
      var saved = worlds[def.id];
      if (!saved || typeof saved != 'object') {
        return;
      }
      var w = p.worlds[def.id];
      w.bought = w.bought || !!saved.bought;
      w.record = int(saved.record);
    });
    if (typeof json.activeShip == 'string' && p.shipBought(json.activeShip)) {
      p.activeShip = json.activeShip;
    }
    var world = int(json.world);
    if (p.worldUnlocked(world)) {
      p.world = world;
    }
    return p;
  } // fromJSON

} // Progress
