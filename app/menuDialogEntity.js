const { AbstractEntity } = await import('./svision/js/abstractEntity.js?ver='+window.srcVersion);
const { TextEntity } = await import('./svision/js/platform/canvas2D/textEntity.js?ver='+window.srcVersion);
const { ButtonEntity } = await import('./svision/js/platform/canvas2D/buttonEntity.js?ver='+window.srcVersion);
const { MenuEntity } = await import('./svision/js/platform/canvas2D/menuEntity.js?ver='+window.srcVersion);
// begin code

/**
 * The contents of a dialog made of a list (GR-M8: the store, the worlds):
 * a heading line, a MenuEntity of rows — a label and a value each, Enter
 * or a click on a row sends the row's event — two lines of information
 * about the highlighted row under it, a message line in the warning
 * colour (NOT ENOUGH COINS), a hint and a CLOSE button. Contents only, no
 * frame and no title: MenuModel puts it into a ZXDialogEntity and colours
 * it through the `theme` of the dialog properties (ZXDialogProperties,
 * R-028), the way the library's dialogs work. Closing sends
 * `contentClosed` up, so the window closes with it.
 *
 * A subclass gives `rows()` — `[{t1, t2, event, penColor}]` — and
 * `describe(index)` — the two lines for a row — and handles the rows'
 * events; `rebuild()` builds the list again after a change (a purchase
 * recolours the rows, which `refreshMenu` alone would not) keeping the
 * selection, `select(index)` is called whenever the highlighted row
 * changes (the base polls the menu in `loopEntity`, the model ticks the
 * modal), `closeDialog()` closes. Candidate for svision once a second
 * game wants it (ROADMAP fáze 4).
 */
export class MenuDialogEntity extends AbstractEntity {

  /** the size of the window MenuModel opens these contents in (desktop units), and the layout inside */
  static get WINDOW() { return {width: 400, height: 210}; }
  static get LAYOUT() { return {headingY: 5, menuY: 18, itemPitch: 14, itemHeight: 12, infoGap: 6, infoPitch: 10, margin: 6, buttonWidth: 46, buttonHeight: 13}; }

  /**
   * The options of the MenuEntity from the theme of the dialog: the
   * game's dialog colours (MenuModel.dialogProperties) on the list.
   * @param {Object} fonts - The app's fonts.
   * @param {Object} theme - The `theme` of the dialog properties.
   * @param {number} width - The width of the list.
   * @returns {Object}
   */
  static menuOptions(fonts, theme, width) {
    var L = MenuDialogEntity.LAYOUT;
    return {
      fonts: fonts.zxFonts8x8,
      leftMargin: 0, rightMargin: 0, topMargin: 0,
      itemWidth: width, itemHeight: L.itemHeight, itemPitch: L.itemPitch,
      t1LeftMargin: 4, t1TopMargin: 2, t2Width: 150, t2RightMargin: 4, t2TopMargin: 2,
      textColor: theme.penColor,
      selectionTextColor: theme.selectionPenColor,
      selectionBarColor: theme.selectionColor,
      hoverColor: theme.hoverColor,
      selectionHoverColor: theme.selectionHoverColor,
      clickColor: theme.clickColor,
      selectionClickColor: theme.selectionClickColor
    };
  } // menuOptions

  /**
   * @param {AbstractEntity} parentEntity - The window (ZXDialogEntity).
   * @param {number} x
   * @param {number} y
   * @param {number} width
   * @param {number} height
   * @param {Object} properties - The dialog properties (their `theme` colours the contents).
   * @param {Object} [options] - `hint` (the bottom line), `closeLabel` (CLOSE).
   */
  constructor(parentEntity, x, y, width, height, properties, options) {
    var theme = (properties && properties.theme) || {};
    super(parentEntity, x, y, width, height, false, theme.bkColor || false);
    this.id = 'MenuDialogEntity';
    this.theme = theme;
    this.options = Object.assign({hint: 'ENTER SELECTS - ESC CLOSES', closeLabel: 'CLOSE'}, options || {});
    this.menuEntity = null;
    this.headingEntity = null;
    this.infoEntities = [];
    this.messageEntity = null;
    this.hintEntity = null;
    this.closeButton = null;
    this.selection = 0;           // the highlighted row
    this.lastSelection = -1;
    this.rowsList = [];
  } // constructor

  init() {
    super.init();
    var L = MenuDialogEntity.LAYOUT, t = this.theme, w = this.width, h = this.height, m = L.margin;
    var fonts = this.app.fonts;
    this.headingEntity = new TextEntity(this, fonts.zxFonts8x8, m, L.headingY, w-2*m, 8, '', t.valueColor, false, {});
    this.addEntity(this.headingEntity);
    this.buildMenu();
    for (var i = 0; i < 2; i++) {
      var e = new TextEntity(this, fonts.zxFonts8x8, m, 0, w-2*m, 8, '', t.penColor, false, {});
      this.infoEntities.push(e);
      this.addEntity(e);
    }
    this.messageEntity = new TextEntity(this, fonts.zxFonts8x8, m, 0, w-2*m, 8, '', t.warningColor, false, {});
    this.addEntity(this.messageEntity);
    this.hintEntity = new TextEntity(this, fonts.fonts5x5, m, h-L.buttonHeight+4, w-2*m-L.buttonWidth-4, 8, this.options.hint, t.iconColor, false, {});
    this.addEntity(this.hintEntity);
    this.closeButton = new ButtonEntity(this, fonts.fonts5x5, w-m-L.buttonWidth, h-L.buttonHeight-2, L.buttonWidth, L.buttonHeight, this.options.closeLabel, {id: 'menuDialogClose'}, ['Escape', 'GamepadExit'], t.buttonPenColor, t.closeButtonColor, {align: 'center', margin: 4});
    this.addEntity(this.closeButton);
    this.placeLines();
    this.refresh();
  } // init

  /**
   * Builds the list of rows (again): the rows from `rows()`, the
   * selection kept — or the one given.
   * @param {number} [selection] - The row to highlight; the current one by default.
   */
  buildMenu(selection) {
    var L = MenuDialogEntity.LAYOUT, m = L.margin;
    if (this.menuEntity) {
      // taken out at once (destroy() would queue it for the next frame)
      this.selection = typeof selection == 'number' ? selection : this.menuEntity.selection;
      var i = this.entities.indexOf(this.menuEntity);
      if (i >= 0) {
        this.entities[i].shutdown();
        this.entities.splice(i, 1);
      }
      this.menuEntity = null;
    }
    this.rowsList = this.rows();
    var n = this.rowsList.length;
    this.selection = Math.max(0, Math.min(n-1, this.selection));
    var options = MenuDialogEntity.menuOptions(this.app.fonts, this.theme, this.width-2*m);
    options.selection = this.selection;
    this.menuEntity = new MenuEntity(this, m, L.menuY, this.width-2*m, n*L.itemPitch, false, options, this, MenuDialogEntity.getMenuData);
    this.addEntity(this.menuEntity);
    this.lastSelection = -1;
  } // buildMenu

  /**
   * The data source of the MenuEntity: the rows list.
   */
  static getMenuData(self, key, row) {
    switch (key) {
      case 'numberOfItems':
        return self.rowsList.length;
      default:
        var r = self.rowsList[row];
        return r && (key in r) ? r[key] : '';
    }
  } // getMenuData

  /**
   * Places the information lines and the message under the list.
   */
  placeLines() {
    var L = MenuDialogEntity.LAYOUT;
    var y = L.menuY+this.rowsList.length*L.itemPitch+L.infoGap;
    this.infoEntities.forEach((e) => {
      e.y = y;
      e.invalidate();
      y += L.infoPitch;
    });
    this.messageEntity.y = y+2;
    this.messageEntity.invalidate();
  } // placeLines

  /**
   * Builds the list again after a change of state and refreshes the texts.
   * @param {number} [selection] - The row to highlight; the current one by default.
   */
  rebuild(selection) {
    this.buildMenu(selection);
    this.placeLines();
    this.refresh();
  } // rebuild

  /**
   * The heading, the information about the highlighted row.
   */
  refresh() {
    this.headingEntity.setText(this.heading());
    var lines = this.describe(this.menuEntity ? this.menuEntity.selection : 0) || [];
    this.infoEntities.forEach((e, i) => e.setText(lines[i] || ''));
  } // refresh

  /**
   * A message in the warning colour under the information (empty to clear).
   * @param {string} text
   */
  message(text) {
    this.messageEntity.setText(text || '');
  } // message

  /**
   * Closes the contents (and the window with them).
   */
  closeDialog() {
    this.destroy();
    this.sendEvent(-1, 0, {id: 'contentClosed', entity: this});
  } // closeDialog

  // ------------------------------------------------- what a subclass gives

  /** @returns {string} The heading line. */
  heading() { return ''; }

  /** @returns {Object[]} `[{t1, t2, event, penColor}]` */
  rows() { return []; }

  /**
   * @param {number} index - The highlighted row.
   * @returns {string[]} Up to two lines about it.
   */
  describe(index) { return []; }

  /**
   * The highlighted row changed.
   * @param {number} index
   */
  select(index) {}

  /**
   * The CLOSE button, Escape: close by default.
   */
  onClose() {
    this.closeDialog();
  } // onClose

  // ------------------------------------------------------------- events

  loopEntity(timestamp) {
    if (this.menuEntity) {
      this.menuEntity.loopEntity(timestamp);
      if (this.menuEntity.selection !== this.lastSelection) {
        this.lastSelection = this.menuEntity.selection;
        this.selection = this.lastSelection;
        this.message('');
        this.refresh();
        this.select(this.lastSelection);
      }
    }
  } // loopEntity

  handleEvent(event) {
    if (super.handleEvent(event)) {
      return true;
    }
    switch (event.id) {
      case 'menuDialogClose':
        this.onClose();
        return true;
      case 'keyPress':
        // any other key is swallowed: the dialog is modal
        return true;
      case 'keyRelease':
      case 'mouseHover':
        return true;
    }
    return false;
  } // handleEvent

} // MenuDialogEntity
