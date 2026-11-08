const { MenuDialogEntity } = await import('./menuDialogEntity.js?ver='+window.srcVersion);
// begin code

/**
 * The worlds (GR-M8, the `WorldMenu` of the original — notes 15): the
 * contents of the WORLDS dialog. One row per world of data/worlds.json in
 * order — the value column says SELECTED, OPEN, or the price of a closed
 * one — and under it the record of the highlighted world and how it
 * opens: the record of the world before it strictly over the distance to
 * win, or the coins. Enter selects an open world for the next runs, buys
 * a closed one when the coins reach the price (NOT ENOUGH COINS
 * otherwise) and selects it. The choice goes to the application's
 * progress (app/progress.js) and is saved at once. The highlighted world
 * colours the sky and the ground behind the menu (`model.showWorld`).
 */
export class WorldsEntity extends MenuDialogEntity {

  /**
   * @param {AbstractEntity} parentEntity
   * @param {number} x
   * @param {number} y
   * @param {number} width
   * @param {number} height
   * @param {Object} properties - The dialog properties.
   */
  constructor(parentEntity, x, y, width, height, properties) {
    super(parentEntity, x, y, width, height, properties, {hint: 'ENTER CHOOSES OR BUYS - ESC CLOSES'});
    this.id = 'WorldsEntity';
    this.progress = this.app.progress;
  } // constructor

  init() {
    super.init();
    if (this.progress) {
      this.selection = this.progress.world;
      this.menuEntity.changeMenuItem(this.progress.world);
    }
    this.select(this.menuEntity.selection);
  } // init

  worlds() {
    return this.progress ? this.progress.worldDefs : [];
  } // worlds

  heading() {
    return this.progress ? 'YOUR COINS: '+this.progress.coins : 'NO PROGRESS - THE DATA IS MISSING';
  } // heading

  rows() {
    var p = this.progress, t = this.theme;
    if (!p) {
      return [{t1: 'NO WORLDS', t2: '', event: {id: 'menuDialogClose'}}];
    }
    return this.worlds().map((w, i) => {
      var open = p.worldUnlocked(i);
      return {
        t1: w.name,
        t2: p.world === i ? 'SELECTED' : open ? 'OPEN' : w.price+' COINS',
        penColor: open ? t.penColor : t.iconColor,
        event: {id: 'worldsRow', index: i}
      };
    });
  } // rows

  describe(index) {
    var p = this.progress, w = this.worlds()[index];
    if (!p || !w) {
      return [];
    }
    var record = p.record(index);
    var line1 = 'YOUR RECORD HERE: '+(record > 0 ? record+' M' : 'NONE YET');
    if (p.worldUnlocked(index)) {
      return [line1, p.world === index ? 'THE WORLD OF YOUR NEXT RUN' : 'ENTER: FLY HERE NEXT'];
    }
    var before = this.worlds()[index-1];
    var need = before ? 'OVER '+w.distanceToWin+' M IN '+before.name+' (YOURS '+p.record(index-1)+' M)' : '';
    var buy = p.coins >= w.price ? 'ENTER: BUY FOR '+w.price+' COINS' : 'OR '+w.price+' COINS - YOU NEED '+(w.price-p.coins)+' MORE';
    return [line1, 'OPENS '+need+', '+buy];
  } // describe

  select(index) {
    if (this.model && this.model.showWorld && this.worlds()[index]) {
      this.model.showWorld(index);
    }
  } // select

  onClose() {
    if (this.model && this.model.showWorld && this.progress) {
      this.model.showWorld(this.progress.world);
    }
    this.closeDialog();
  } // onClose

  handleEvent(event) {
    if (super.handleEvent(event)) {
      return true;
    }
    var p = this.progress;
    switch (event.id) {
      case 'worldsRow':
        if (!p || !this.worlds()[event.index]) {
          return true;
        }
        if (p.worldUnlocked(event.index) || p.buyWorld(event.index)) {
          p.selectWorld(event.index);
          if (this.app.saveProgress) {
            this.app.saveProgress();
          }
          this.rebuild();
        } else {
          this.message('NOT ENOUGH COINS');
        }
        return true;
    }
    return false;
  } // handleEvent

} // WorldsEntity
