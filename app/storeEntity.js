const { MenuDialogEntity } = await import('./menuDialogEntity.js?ver='+window.srcVersion);
// begin code

/**
 * The ship store (GR-M8, the `ShipStoreMenu` of the original in the
 * game's own words — notes 14): the contents of the SHIPS dialog. Two
 * pages on one list: the ships of data/ships.json in the store's order —
 * the value column says ACTIVE, OWNED or the price — and, for a bought
 * ship, its page: USE THIS SHIP, one row per upgrade slot with its level
 * and the price of the next, BACK. Enter on an unbought ship buys it when
 * the coins reach the price (NOT ENOUGH COINS otherwise), on a bought one
 * opens its page; on an upgrade buys the next level. Every purchase and
 * choice goes to the application's progress (app/progress.js) and is
 * saved at once (`app.saveProgress`). The highlighted ship is shown in
 * the world behind the menu (`model.showShip`).
 *
 * The mechanics are the progress's; this only lists and asks. The
 * descriptions of the upgrades are the game's own (the original's are
 * localised texts that are not taken over).
 */
export class StoreEntity extends MenuDialogEntity {

  /** what an upgrade does, in the game's words, by type */
  static get UPGRADES() {
    return {
      battery: {name: 'BATTERY', text: 'THE ENERGY DRAINS SLOWER'},
      coins: {name: 'COINS', text: 'MORE COINS ON THE TRACK'},
      multiplier: {name: 'MULTIPLIER', text: 'THE COIN MULTIPLIER LASTS LONGER'},
      magnet: {name: 'MAGNET', text: 'PULLS THE PICKUPS IN FROM FARTHER'}
    };
  } // UPGRADES

  /**
   * @param {AbstractEntity} parentEntity
   * @param {number} x
   * @param {number} y
   * @param {number} width
   * @param {number} height
   * @param {Object} properties - The dialog properties.
   */
  constructor(parentEntity, x, y, width, height, properties) {
    super(parentEntity, x, y, width, height, properties, {hint: 'ENTER BUYS OR OPENS - ESC CLOSES'});
    this.id = 'StoreEntity';
    this.progress = this.app.progress;
    this.page = 'ships';
    this.shipIndex = 0;           // the ship whose page is open
    this.pageSelection = 0;       // the row on the ship's page
  } // constructor

  init() {
    super.init();
    this.select(this.menuEntity.selection);
  } // init

  /**
   * The ships in the store's order.
   * @returns {Object[]}
   */
  ships() {
    return this.progress ? this.progress.shipDefs : [];
  } // ships

  /**
   * The multiplier of a type as a label: "X1.25".
   * @param {number} m
   * @returns {string}
   */
  static times(m) {
    return 'X'+(Math.round(m*100)/100).toFixed(2).replace(/0$/, '');
  } // times

  heading() {
    if (!this.progress) {
      return 'NO PROGRESS - THE DATA IS MISSING';
    }
    if (this.page == 'ships') {
      return 'YOUR COINS: '+this.progress.coins;
    }
    var ship = this.ships()[this.shipIndex];
    return ship.name+(this.progress.activeShip === ship.id ? ' - ACTIVE' : ' - OWNED')+'   COINS: '+this.progress.coins;
  } // heading

  rows() {
    var p = this.progress, t = this.theme;
    if (!p) {
      return [{t1: 'NO SHIPS', t2: '', event: {id: 'menuDialogClose'}}];
    }
    if (this.page == 'ships') {
      return this.ships().map((ship, i) => {
        var bought = p.shipBought(ship.id);
        return {
          t1: ship.name,
          t2: p.activeShip === ship.id ? 'ACTIVE' : bought ? 'OWNED' : ship.price+' COINS',
          penColor: bought ? t.penColor : t.iconColor,
          event: {id: 'storeShip', index: i}
        };
      });
    }
    var ship = this.ships()[this.shipIndex];
    var rows = [{t1: 'USE THIS SHIP', t2: p.activeShip === ship.id ? 'ACTIVE' : '', event: {id: 'storeSelect'}}];
    p.upgrades(ship.id).forEach((u) => {
      var U = StoreEntity.UPGRADES[u.type] || {name: u.type.toUpperCase()};
      rows.push({
        t1: U.name+' '+u.level+'/'+u.max,
        t2: u.price === null ? 'MAX' : u.price+' COINS',
        penColor: u.price === null ? t.iconColor : t.penColor,
        event: {id: 'storeUpgrade', type: u.type}
      });
    });
    rows.push({t1: 'BACK', t2: '', event: {id: 'storeBack'}});
    return rows;
  } // rows

  describe(index) {
    var p = this.progress;
    if (!p) {
      return [];
    }
    if (this.page == 'ships') {
      var ship = this.ships()[index];
      if (!ship) {
        return [];
      }
      var slots = (ship.upgrades || []).map((u) => (StoreEntity.UPGRADES[u.type] || {name: u.type}).name+' '+p.upgradeLevel(ship.id, u.type)+'/'+u.max);
      var line1 = slots.length ? 'UPGRADES: '+slots.join(', ') : 'NO UPGRADES - THE PLAIN SHIP';
      var line2 = p.shipBought(ship.id) ? 'ENTER: UPGRADES AND CHOICE' : p.coins >= ship.price ? 'ENTER: BUY FOR '+ship.price+' COINS' : 'YOU NEED '+(ship.price-p.coins)+' MORE COINS';
      return [line1, line2];
    }
    var rows = this.rowsList, r = rows[index];
    if (!r) {
      return [];
    }
    if (r.event.id == 'storeUpgrade') {
      var shipId = this.ships()[this.shipIndex].id;
      var u = p.upgrades(shipId).find((x) => x.type === r.event.type);
      var U = StoreEntity.UPGRADES[u.type] || {text: ''};
      var now = p.multipliers(shipId)[u.type];
      var line = U.text+' - NOW '+StoreEntity.times(now);
      if (u.price !== null) {
        var range = p.rules.ranges[u.type];
        var after = range[0]+Math.min(1, (u.level+1)/p.rules.levelsToMax)*(range[1]-range[0]);
        line += ', NEXT '+StoreEntity.times(after);
        return [line, p.coins >= u.price ? 'ENTER: BUY LEVEL '+(u.level+1)+' FOR '+u.price+' COINS' : 'YOU NEED '+(u.price-p.coins)+' MORE COINS'];
      }
      return [line, 'THE TOP LEVEL'];
    }
    if (r.event.id == 'storeSelect') {
      return ['THE SHIP YOU FLY IN THE NEXT RUN', ''];
    }
    return ['BACK TO THE LIST OF SHIPS', ''];
  } // describe

  select(index) {
    if (this.page == 'ships' && this.model && this.model.showShip) {
      var ship = this.ships()[index];
      if (ship) {
        this.model.showShip(ship.id);
      }
    }
  } // select

  /**
   * Opens a page: the list of ships, or a bought ship's.
   * @param {string} page
   */
  open(page) {
    var selection;
    if (this.page == 'ships') {
      this.shipIndex = this.menuEntity.selection;
      this.page = page;
      selection = this.pageSelection;
    } else {
      this.pageSelection = this.menuEntity.selection;
      this.page = page;
      selection = this.shipIndex;
    }
    this.options.hint = page == 'ships' ? 'ENTER BUYS OR OPENS - ESC CLOSES' : 'ENTER BUYS OR CHOOSES - ESC BACK';
    this.hintEntity.setText(this.options.hint);
    this.closeButton.setText(page == 'ships' ? 'CLOSE' : 'BACK');
    this.message('');
    this.rebuild(selection);
  } // open

  /**
   * A change of the progress: saved, the list rebuilt.
   */
  changed() {
    if (this.app.saveProgress) {
      this.app.saveProgress();
    }
    this.rebuild();
    if (this.model && this.model.showShip) {
      this.model.showShip(this.progress.activeShip);
    }
  } // changed

  onClose() {
    if (this.page != 'ships') {
      this.open('ships');
      return;
    }
    if (this.model && this.model.showShip && this.progress) {
      this.model.showShip(this.progress.activeShip);
    }
    this.closeDialog();
  } // onClose

  handleEvent(event) {
    if (super.handleEvent(event)) {
      return true;
    }
    var p = this.progress;
    switch (event.id) {
      case 'storeShip':
        var ship = this.ships()[event.index];
        if (!ship || !p) {
          return true;
        }
        if (p.shipBought(ship.id)) {
          this.open('ship');
        } else if (p.buyShip(ship.id)) {
          p.selectShip(ship.id);
          this.changed();
          this.message(ship.name+' IS YOURS');
        } else {
          this.message('NOT ENOUGH COINS');
        }
        return true;

      case 'storeSelect':
        if (p && p.selectShip(this.ships()[this.shipIndex].id)) {
          this.changed();
        }
        return true;

      case 'storeUpgrade':
        if (p && p.buyUpgrade(this.ships()[this.shipIndex].id, event.type)) {
          this.changed();
        } else {
          this.message('NOT ENOUGH COINS');
        }
        return true;

      case 'storeBack':
        this.open('ships');
        return true;
    }
    return false;
  } // handleEvent

} // StoreEntity
