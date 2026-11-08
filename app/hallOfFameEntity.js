const { AbstractEntity } = await import('./svision/js/abstractEntity.js?ver='+window.srcVersion);
const { TextEntity } = await import('./svision/js/platform/canvas2D/textEntity.js?ver='+window.srcVersion);
const { ButtonEntity } = await import('./svision/js/platform/canvas2D/buttonEntity.js?ver='+window.srcVersion);
// begin code

/**
 * The hall of fame on the 2D overlay (GR-M8): the canvas2D counterpart of
 * the vector platform's VectorHallOfFameEntity and of Manic Miner's
 * hallOfFameEntity, as the contents of a ZXDialogEntity coloured by the
 * dialog's theme. The rows — the place, the name, the score in metres —
 * come from the server (`hallOfFame.db`: `[{name, score}]` from best
 * down, the ten best, one per name — the contract of appData.db and
 * saveGame.db); the list the application already holds (`app.hallOfFame`,
 * delivered with appData.db and refreshed after every saved game) is shown
 * at once and the server's answer replaces it. LOADING until it comes, NO
 * SCORES YET for an empty one, SYSTEM OFFLINE when there is none. The best score goes to `app.hiScore`. Enter, Escape, a
 * click or a tap close it; closing sends `contentClosed` to the window.
 */
export class HallOfFameEntity extends AbstractEntity {

  /** the rows: where they start, their pitch, how many */
  static get ROWS() { return {y: 20, pitch: 12, count: 10, place: 30, score: 90}; }

  /**
   * @param {AbstractEntity} parentEntity - The window.
   * @param {number} x
   * @param {number} y
   * @param {number} width
   * @param {number} height
   * @param {Object} properties - The dialog properties (`theme` colours the contents).
   * @param {Object} [options] - `url` (hallOfFame.db), `title` (the heading line), `hint`.
   */
  constructor(parentEntity, x, y, width, height, properties, options) {
    var theme = (properties && properties.theme) || {};
    super(parentEntity, x, y, width, height, false, theme.bkColor || false);
    this.id = 'HallOfFameEntity';
    this.theme = theme;
    this.options = Object.assign({url: 'hallOfFame.db', title: 'THE TEN LONGEST RUNS', hint: 'ENTER OR ESC CLOSES'}, options || {});
    this.rowEntities = [];
    this.statusEntity = null;
  } // constructor

  init() {
    super.init();
    var t = this.theme, w = this.width, h = this.height, fonts = this.app.fonts;
    this.addEntity(new TextEntity(this, fonts.zxFonts8x8, 6, 5, w-12, 8, this.options.title, t.valueColor, false, {}));
    this.statusEntity = new TextEntity(this, fonts.zxFonts8x8, 6, (h >> 1)-8, w-12, 16, '', t.iconColor, false, {align: 'center', textWrap: true});
    this.addEntity(this.statusEntity);
    this.addEntity(new TextEntity(this, fonts.fonts5x5, 6, h-9, w-12-50, 8, this.options.hint, t.iconColor, false, {}));
    this.addEntity(new ButtonEntity(this, fonts.fonts5x5, w-6-46, h-15, 46, 13, 'CLOSE', {id: 'closeHallOfFame'}, ['Enter', 'Escape', ' ', 'GamepadOK', 'GamepadExit'], t.buttonPenColor, t.closeButtonColor, {align: 'center', margin: 4}));

    var known = Array.isArray(this.app.hallOfFame) ? this.app.hallOfFame : [];
    if (known.length) {
      this.showRows(known);
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      if (!known.length) {
        this.showOfflineNotice();
      }
    } else {
      if (!known.length) {
        this.statusEntity.setText('LOADING');
      }
      this.fetchData(this.options.url, false, {});
    }
  } // init

  /**
   * The rows: the place, the name, the score — the old ones taken out.
   * @param {Object[]} rows - `[{name, score}]` from best down.
   */
  showRows(rows) {
    var R = HallOfFameEntity.ROWS, t = this.theme, w = this.width, fonts = this.app.fonts;
    this.rowEntities.forEach((e) => {
      var i = this.entities.indexOf(e);
      if (i >= 0) {
        this.entities[i].shutdown();
        this.entities.splice(i, 1);
      }
    });
    this.rowEntities = [];
    this.statusEntity.setText(rows.length ? '' : 'NO SCORES YET');
    rows.slice(0, R.count).forEach((row, i) => {
      var y = R.y+i*R.pitch;
      var place = new TextEntity(this, fonts.zxFonts8x8, 6, y, R.place, 8, (i+1)+'.', t.iconColor, false, {align: 'right'});
      var name = new TextEntity(this, fonts.zxFonts8x8, 6+R.place+8, y, w-12-R.place-8-R.score-8, 8, String(row.name || ''), t.penColor, false, {});
      var score = new TextEntity(this, fonts.zxFonts8x8Mono, w-6-R.score, y, R.score, 8, row.score+' M', t.valueColor, false, {align: 'right'});
      this.rowEntities.push(place, name, score);
      this.addEntity(place);
      this.addEntity(name);
      this.addEntity(score);
    });
    if (rows.length && this.app) {
      this.app.hiScore = rows[0].score;
    }
  } // showRows

  /**
   * The rows from the server.
   * @param {Object} data - `{data: [{name, score}, ...]}`.
   */
  setData(data) {
    var rows = Array.isArray(data.data) ? data.data : Object.keys(data.data || {}).map((k) => data.data[k]);
    this.showRows(rows);
    if (this.app) {
      this.app.hallOfFame = rows;
    }
  } // setData

  errorData(error) {
    if (!this.rowEntities.length) {
      this.showOfflineNotice();
    }
  } // errorData

  showOfflineNotice() {
    this.statusEntity.setPenColor(this.theme.warningColor);
    this.statusEntity.setText('SYSTEM OFFLINE');
  } // showOfflineNotice

  close() {
    this.destroy();
    this.sendEvent(-1, 0, {id: 'contentClosed', entity: this});
  } // close

  handleEvent(event) {
    if (super.handleEvent(event)) {
      return true;
    }
    switch (event.id) {
      case 'closeHallOfFame':
        this.close();
        return true;
      case 'keyPress':
        switch (event.key) {
          case 'Mouse1':
          case 'Touch':
            // a click or a tap anywhere else closes too
            this.close();
            return true;
        }
        // any other key is swallowed: the dialog is modal
        return true;
      case 'keyRelease':
      case 'mouseHover':
        return true;
    }
    return false;
  } // handleEvent

} // HallOfFameEntity
