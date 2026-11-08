const { AbstractModel } = await import('./svision/js/abstractModel.js?ver='+window.srcVersion);
const { AbstractEntity } = await import('./svision/js/abstractEntity.js?ver='+window.srcVersion);
const { TextEntity } = await import('./svision/js/platform/canvas2D/textEntity.js?ver='+window.srcVersion);
const { ButtonEntity } = await import('./svision/js/platform/canvas2D/buttonEntity.js?ver='+window.srcVersion);
const { MenuEntity } = await import('./svision/js/platform/canvas2D/menuEntity.js?ver='+window.srcVersion);
const { SceneEntity } = await import('./svision/js/platform/scene3D/sceneEntity.js?ver='+window.srcVersion);
const { ZXDialogEntity } = await import('./svision/js/platform/canvas2D/zx/zxDialogEntity.js?ver='+window.srcVersion);
const { ZXDialogProperties } = await import('./svision/js/platform/canvas2D/zx/zxDialogProperties.js?ver='+window.srcVersion);
const { ZXPlayerNameEntity } = await import('./svision/js/platform/canvas2D/zx/zxPlayerNameEntity.js?ver='+window.srcVersion);
const { ZXVolumeEntity } = await import('./svision/js/platform/canvas2D/zx/zxVolumeEntity.js?ver='+window.srcVersion);
const { ZXSettingsEntity } = await import('./svision/js/platform/canvas2D/zx/zxSettingsEntity.js?ver='+window.srcVersion);
const { NoticeEntity } = await import('./noticeEntity.js?ver='+window.srcVersion);
const { StoreEntity } = await import('./storeEntity.js?ver='+window.srcVersion);
const { WorldsEntity } = await import('./worldsEntity.js?ver='+window.srcVersion);
const { HallOfFameEntity } = await import('./hallOfFameEntity.js?ver='+window.srcVersion);
const { MenuDialogEntity } = await import('./menuDialogEntity.js?ver='+window.srcVersion);
const { Playfield } = await import('./playfield.js?ver='+window.srcVersion);
// begin code

/**
 * Main menu (ZADANI chap. 3, the structure of Manic Miner and asteroids):
 * START GAME, PLAYER NAME, HALL OF FAME, SHIPS, WORLDS, SOUNDS, MUSIC, SETTINGS,
 * ABOUT GAME — canvas2D entities on the 2D overlay, over a SceneEntity
 * across the whole desktop that shows the playfield at rest (the ship on
 * the plane among a few blocks, the same scene the game starts with), so
 * the menu itself proves that the overlay works over the 3D picture.
 * The dialogs are the ZX ones of the library in the game's colours
 * (ZXDialogProperties, R-028): the player's name, the volume, the
 * settings — and the game's own in the same windows (GR-M8): the ship
 * store (StoreEntity), the worlds (WorldsEntity), the hall of fame
 * (HallOfFameEntity). The scene behind the menu shows the active ship in
 * the selected world of the player's progress (app/progress.js) — and,
 * while the store or the worlds are open, the highlighted ship or world
 * (`showShip`, `showWorld`); the coins stand under the menu.
 *
 * The menu never opens the audio buses (R-024) — it closes whatever the
 * game left open — and START GAME first asks for the browser's gesture
 * for audio when one is still needed (`waitForAudioGesture`, the shape of
 * Battlezone), then opens the game (MainModel). The SOUNDS and MUSIC
 * dialogs are the library's volume slider over the original's clips —
 * the pickup and the track of the selected world, fetched for the dialog
 * (`ensureSfx`, `ensureMusic`); without them the game has no sound at
 * all (GR-M9) and the row says so.
 * The whole screen has a fingerprint under Node (tools/regress.mjs).
 */
export class MenuModel extends AbstractModel {

  /** the title: its top and height (5x5 font at scale 4), shared with BootModel */
  static get TITLE_Y() { return 28; }
  static get TITLE_HEIGHT() { return 24; }
  static get TITLE_COLOR() { return '#ffffff'; }

  /** the look of the overlay: the colours of the menu and the dialogs */
  static get COLORS() {
    return {
      text: '#c9d3e0',
      selectionText: '#ffffff',
      selectionBar: '#2c5aa0',
      hover: '#233a5e',
      selectionHover: '#3a6fc0',
      click: '#16243d',
      selectionClick: '#1f4f96',
      version: '#8fb3e6',
      upgrade: '#ffd166'
    };
  } // COLORS

  /**
   * The title as it stands over the menu (the 5x5 font of the library,
   * scaled ×4 — an own title font is an open point of ZADANI chap. 4) —
   * BootModel makes the same one in the middle of the screen and glides
   * it into this place, so the two screens meet without a jump.
   * @param {AbstractEntity} parentEntity - The desktop.
   * @param {number} y - The top of the title.
   * @param {string} title
   * @returns {TextEntity}
   */
  static newTitleEntity(parentEntity, y, title) {
    var model = parentEntity.model;
    return new TextEntity(parentEntity, model.app.fonts.fonts5x5, 0, y, model.desktopWidth, MenuModel.TITLE_HEIGHT, title, MenuModel.TITLE_COLOR, false, {align: 'center', scale: 4});
  } // newTitleEntity

  /**
   * The dialog properties of the game: the ZX dialogs of the library in the
   * night blue of the overlay (R-028). Hex colours only — the headless
   * drawing cache of the tools takes no other.
   * @returns {Object}
   */
  static dialogProperties() {
    return ZXDialogProperties.merge({
      frameColor: '#8fb3e6',
      frameWidth: 1,
      titleColor: '#ffffff',
      bkColor: '#16243d',
      theme: {
        penColor: '#ffffff',
        valueColor: '#ffd166',
        buttonPenColor: '#ffffff',
        buttonColor: '#2c5aa0',
        buttonHoverColor: '#3a6fc0',
        buttonClickColor: '#1f4f96',
        closeButtonColor: '#3d5482',
        okButtonColor: '#2e8b57',
        dangerButtonColor: '#b03a3a',
        selectionColor: '#2c5aa0',
        selectionPenColor: '#ffffff',
        selectionHoverColor: '#3a6fc0',
        selectionClickColor: '#1f4f96',
        hoverColor: '#233a5e',
        clickColor: '#1b2a44',
        separatorColor: '#8fb3e6',
        iconColor: '#8fb3e6',
        sliderColor: '#ffffff',
        cursorColor: '#ffd166',
        warningColor: '#ff8f66',
        inputPenColor: '#ffffff',
        inputBkColor: '#2c3f63',
        keyboardButtonsPenColor: '#16243d',
        keyboardButtonsBkColor: '#c9d3e0',
        keyboardButtonsShiftColor: '#8fb3e6'
      },
      remapKeys: {frameColor: '#8fb3e6', titleColor: '#ffffff', bkColor: '#1b2a44', theme: {penColor: '#ffffff', valueColor: '#ffd166', buttonPenColor: '#ffffff', buttonColor: '#2c5aa0', closeButtonColor: '#3d5482', dangerButtonColor: '#b03a3a'}},
      selectingGamepad: {frameColor: '#8fb3e6', bkColor: '#2c3f63', theme: {penColor: '#ffffff', selectionColor: '#ffffff', selectionPenColor: '#16243d', hoverColor: '#3a6fc0', selectionHoverColor: '#c9d3e0'}},
      waitForAudioEvent: {frameColor: '#8fb3e6', bkColor: '#2c3f63', theme: {penColor: '#ffffff'}}
    });
  } // dialogProperties

  /**
   * @param {GameApp} app
   * @param {number} selectionItem - The row selected at start.
   */
  constructor(app, selectionItem) {
    super(app);
    this.id = 'MenuModel';

    this.menuItems = [
      {t1: 'START GAME', event: {id: 'startGame'}},
      {t1: 'PLAYER NAME', event: {id: 'setPlayerName'}},
      {t1: 'HALL OF FAME', event: {id: 'showHallOfFame'}},
      {t1: 'SHIPS', event: {id: 'showShips'}},
      {t1: 'WORLDS', event: {id: 'showWorlds'}},
      {t1: 'SOUNDS', event: {id: 'setSounds'}},
      {t1: 'MUSIC', event: {id: 'setMusic'}},
      {t1: 'SETTINGS', event: {id: 'setSettings'}},
      {t1: 'ABOUT GAME', event: {id: 'showAbout'}}
    ];
    var c = MenuModel.COLORS;
    this.menuOptions = {
      fonts: this.app.fonts.zxFonts8x8,
      leftMargin: 0,
      rightMargin: 0,
      topMargin: 0,
      itemHeight: 12,
      itemPitch: 14,
      t1LeftMargin: 4,
      t1TopMargin: 2,
      t2Width: 100,
      t2RightMargin: 4,
      t2TopMargin: 2,
      textColor: c.text,
      selectionTextColor: c.selectionText,
      selectionBarColor: c.selectionBar,
      hoverColor: c.hover,
      selectionHoverColor: c.selectionHover,
      clickColor: c.click,
      selectionClickColor: c.selectionClick,
      selection: selectionItem || 0
    };
    this.menuWidth = 240;
    this.dialogProperties = MenuModel.dialogProperties();
    this.playfield = new Playfield(app.gameData());

    this.view = null;
    this.titleEntity = null;
    this.menuEntity = null;
    this.versionEntity = null;
    this.copyrightEntity = null;
    this.coinsEntity = null;
    this.newVersionAvailable = false;
    this.preview = {shipId: null, world: null};   // what the scene behind the menu shows instead of the progress's choice
  } // constructor

  init() {
    super.init();

    // the menu is silent (R-024); the stand-in application of the tools has no manager
    if (this.app.audioManager) {
      this.sendEvent(0, {id: 'closeAllAudioBuses'});
    }

    this.desktopEntity.bkColor = false;   // the 3D picture shows through the overlay
    var w = this.desktopWidth, h = this.desktopHeight;

    // the world at rest behind the menu
    this.view = new SceneEntity(this.desktopEntity, 0, 0, w, h, '#ffffff', false);
    this.desktopEntity.addEntity(this.view);
    this.refreshScene();

    this.titleEntity = MenuModel.newTitleEntity(this.desktopEntity, MenuModel.TITLE_Y, this.app.title);
    this.desktopEntity.addEntity(this.titleEntity);

    this.menuEntity = new MenuEntity(this.desktopEntity, 0, 0, this.menuWidth, this.menuItems.length*this.menuOptions.itemPitch, false, this.menuOptions, this, this.getMenuData);
    this.desktopEntity.addEntity(this.menuEntity);

    var c = MenuModel.COLORS;
    this.versionEntity = new ButtonEntity(this.desktopEntity, this.app.fonts.fonts5x5, 0, 0, 120, 8, 'V'+this.app.version, {id: 'upgradeApp'}, [], c.version, false, {align: 'right'});
    this.versionEntity.hoverColor = false;
    this.versionEntity.clickColor = false;
    this.desktopEntity.addEntity(this.versionEntity);
    this.copyrightEntity = new TextEntity(this.desktopEntity, this.app.fonts.fonts5x5, 0, 0, 300, 8, this.app.copyright, c.version, false, {});
    this.desktopEntity.addEntity(this.copyrightEntity);
    // the coins of the progress under the menu (GR-M8)
    this.coinsEntity = new TextEntity(this.desktopEntity, this.app.fonts.fonts5x5, 0, 0, this.menuWidth, 8, '', c.upgrade, false, {align: 'center'});
    this.desktopEntity.addEntity(this.coinsEntity);
    this.refreshCoins();

    this.layoutEntities();
    this.checkServerVersion();
  } // init

  /**
   * Places the entities by the desktop size — on init and on every resize
   * (`fit: 'cover'`: the desktop grows to the window).
   */
  layoutEntities() {
    var w = this.desktopWidth, h = this.desktopHeight;
    var inset = 8;

    this.view.width = w;
    this.view.height = h;

    this.titleEntity.width = w;
    this.titleEntity.invalidate();

    this.menuEntity.x = (w-this.menuWidth) >> 1;
    this.menuEntity.y = MenuModel.TITLE_Y+MenuModel.TITLE_HEIGHT+28;
    this.coinsEntity.x = this.menuEntity.x;
    this.coinsEntity.y = this.menuEntity.y+this.menuItems.length*this.menuOptions.itemPitch+6;
    this.coinsEntity.invalidate();

    this.versionEntity.x = w-inset-120;
    this.versionEntity.y = h-inset-8;
    this.versionEntity.invalidate();
    this.copyrightEntity.x = inset;
    this.copyrightEntity.y = h-inset-8;
    this.copyrightEntity.invalidate();
  } // layoutEntities

  /**
   * The state the scene behind the menu rests in: the ship and the world
   * of the progress (or the preview the store and the worlds dialog ask
   * for), nothing moving.
   * @returns {Object}
   */
  restState() {
    var state = Playfield.emptyState(), p = this.app.progress;
    state.shipId = this.preview.shipId !== null ? this.preview.shipId : p ? p.activeShip : null;
    state.world = this.preview.world !== null ? this.preview.world : p ? p.world : 0;
    return state;
  } // restState

  /**
   * Builds the scene behind the menu again from the rest state.
   */
  refreshScene() {
    if (!this.view) {
      return;
    }
    var state = this.restState();
    Playfield.build(this.view.scene, this.playfield.frame(state), this.playfield);
    // the ship's mesh may still be on its way (assets/ships): the scene again when it lands
    if (state.shipId && !this.playfield.meshes['ship:'+state.shipId] && this.app.ensureShip) {
      this.app.ensureShip(state.shipId, (ok) => {
        if (ok && this.view && this.restState().shipId === state.shipId) {
          this.playfield = new Playfield(this.app.gameData());
          Playfield.build(this.view.scene, this.playfield.frame(this.restState()), this.playfield);
        }
      });
    }
  } // refreshScene

  /**
   * Shows a ship in the scene behind the menu (the store's highlighted row).
   * @param {string|null} shipId - null: the progress's active ship.
   */
  showShip(shipId) {
    this.preview.shipId = shipId;
    this.refreshScene();
    this.refreshCoins();
  } // showShip

  /**
   * Shows a world in the scene behind the menu (the worlds' highlighted row).
   * @param {number|null} world - null: the progress's selected world.
   */
  showWorld(world) {
    this.preview.world = world;
    this.refreshScene();
    this.refreshCoins();
  } // showWorld

  /**
   * The coins line under the menu and the values of the SHIPS and WORLDS
   * rows from the progress.
   */
  refreshCoins() {
    var p = this.app.progress;
    if (this.coinsEntity) {
      this.coinsEntity.setText(p ? p.coins+' COINS' : '');
    }
    if (this.menuEntity) {
      this.menuEntity.refreshMenu();
    }
  } // refreshCoins

  /**
   * Asks the server for its version; a newer one turns the version line
   * into UPGRADE !, which reloads the application when chosen.
   */
  checkServerVersion() {
    // a dedicated receiver, so the request does not clash with the model's own fetch
    var receiver = {
      id: this.id+'Version',
      fetchDataId: '',
      setData: (data) => {
        if (data.data.version && data.data.version !== 'unknown' && data.data.version !== this.app.version) {
          this.newVersionAvailable = true;
          this.versionEntity.setText('UPGRADE !');
          this.versionEntity.setPenColor(MenuModel.COLORS.upgrade);
        }
      },
      errorData: () => {}
    };
    receiver.fetchDataId = this.app.fetchData('version.db', false, {}, receiver);
  } // checkServerVersion

  getMenuData(self, key, row) {
    switch (key) {

      case 'numberOfItems':
        return self.menuItems.length;

      case 't2':
        var p = self.app.progress;
        switch (row) {
          case 1:
            return self.app.playerName;
          case 3:
            var ship = p ? p.shipDef(p.activeShip) : null;
            return ship ? ship.name : '';
          case 4:
            var world = p ? p.worldDef(p.world) : null;
            return world ? world.name : '';
          case 5:
            return self.app.audioManager ? ZXVolumeEntity.levelText(self.app.audioManager.volume.sounds) : 'NONE';
          case 6:
            return self.app.audioManager ? ZXVolumeEntity.levelText(self.app.audioManager.volume.music) : 'NONE';
        }
        break;

      default:
        if (key in self.menuItems[row]) {
          return self.menuItems[row][key];
        }
        break;

    }
    return '';
  } // getMenuData

  /**
   * Opens a dialog from the menu: the window with the title (ZXDialogEntity)
   * in the middle of the desktop, coloured by the dialog properties, and
   * the contents the factory makes for it, as the modal of the desktop.
   * The contents of the library are laid out for 200 x 124 units.
   * @param {string} title - The text of the title bar.
   * @param {Function} contentFactory - Called with the window, returns the contents entity.
   * @param {Object} [size] - `{width, height}` of the window; the dialog properties' by default (the game's own contents are laid out for MenuDialogEntity.WINDOW).
   */
  openDialog(title, contentFactory, size) {
    var p = this.dialogProperties;
    var width = size ? size.width : p.width, height = size ? size.height : p.height;
    var x = (this.desktopWidth-width) >> 1, y = (this.desktopHeight-height) >> 1;
    this.desktopEntity.addModalEntity(new ZXDialogEntity(this.desktopEntity, x, y, width, height, title, p, contentFactory));
  } // openDialog

  /**
   * Opens a notice in the middle of the desktop.
   * @param {string} title
   * @param {string[]} lines
   * @param {Object|false} [continueEvent] - Sent to the model when the notice closes.
   * @param {Object} [options] - The notice's (`escapeEvent`, `hint`).
   */
  openNotice(title, lines, continueEvent, options) {
    var x = (this.desktopWidth-NoticeEntity.WIDTH) >> 1, y = (this.desktopHeight-NoticeEntity.HEIGHT) >> 1;
    this.desktopEntity.addModalEntity(new NoticeEntity(this.desktopEntity, x, y, title, lines, continueEvent || false, options));
  } // openNotice

  /**
   * The browser's gesture for audio before the game: the notice asks for
   * Enter, a click or a tap (which the input manager records as the
   * gesture) and then sends `continueEvent`; Escape closes it without.
   * @param {string} continueEvent - The event's id.
   * @returns {boolean} True when the notice was opened, false when no gesture is needed.
   */
  waitForAudioGesture(continueEvent) {
    if (!this.app.audioManager || !this.app.inputEventsManager.needEventForAudio()) {
      return false;
    }
    this.openNotice('SOUND', ['THE BROWSER STARTS THE AUDIO', 'ONLY AFTER A KEY OR A TAP'], {id: continueEvent}, {hint: 'PRESS ENTER - ESC FOR SILENCE'});
    return true;
  } // waitForAudioGesture

  handleEvent(event) {
    if (super.handleEvent(event)) {
      return true;
    }

    switch (event.id) {
      case 'resizeModel':
        this.layoutEntities();
        return true;

      case 'startGame':
        if (this.waitForAudioGesture('startGame2')) {
          return true;
        }
      case 'startGame2':
        this.app.startGame();
        return true;

      case 'setPlayerName':
        this.openDialog('PLAYER NAME', (dialog) => new ZXPlayerNameEntity(dialog, dialog.innerX, dialog.innerY, dialog.innerWidth, dialog.innerHeight, false, this.dialogProperties));
        return true;

      case 'showHallOfFame':
        this.openDialog('HALL OF FAME', (dialog) => new HallOfFameEntity(dialog, dialog.innerX, dialog.innerY, dialog.innerWidth, dialog.innerHeight, this.dialogProperties), MenuDialogEntity.WINDOW);
        return true;

      case 'showShips':
        if (!this.app.progress) {
          this.openNotice('SHIPS', ['THE GAME DATA IS MISSING', 'NO STORE WITHOUT IT']);
          return true;
        }
        this.openDialog('SHIPS', (dialog) => new StoreEntity(dialog, dialog.innerX, dialog.innerY, dialog.innerWidth, dialog.innerHeight, this.dialogProperties), MenuDialogEntity.WINDOW);
        return true;

      case 'showWorlds':
        if (!this.app.progress) {
          this.openNotice('WORLDS', ['THE GAME DATA IS MISSING', 'NO WORLDS WITHOUT IT']);
          return true;
        }
        this.openDialog('WORLDS', (dialog) => new WorldsEntity(dialog, dialog.innerX, dialog.innerY, dialog.innerWidth, dialog.innerHeight, this.dialogProperties), MenuDialogEntity.WINDOW);
        return true;


      case 'setSounds':
        // the level is tried on the pickup's clip; without the clips there is no sound at all (GR-M9)
        if (!this.app.audioManager) {
          this.openNotice('SOUNDS', ['NO AUDIO IN THIS BUILD']);
          return true;
        }
        this.app.ensureSfx((ok) => {
          if (!ok) {
            this.openNotice('SOUNDS', ['THE SOUNDS OF THE GAME', 'ARE NOT IN THIS BUILD']);
            return;
          }
          this.openDialog('SOUNDS', (dialog) => new ZXVolumeEntity(dialog, dialog.innerX, dialog.innerY, dialog.innerWidth, dialog.innerHeight, 'sounds', 'audioBusSoundsLevel', 'pickup', this.dialogProperties));
        });
        return true;

      case 'setMusic':
        // the track of the selected world, fetched for the dialog as the run would (the service worker has it)
        if (!this.app.audioManager) {
          this.openNotice('MUSIC', ['NO AUDIO IN THIS BUILD']);
          return true;
        }
        var world = this.app.progress ? this.app.progress.worldDef(this.app.progress.world) : null;
        this.app.ensureMusic(world ? world.id : null, (ok) => {
          if (!ok) {
            this.openNotice('MUSIC', ['THE MUSIC OF THE GAME', 'IS NOT IN THIS BUILD']);
            return;
          }
          this.app.audioManager.track = this.app.assets.music[world.id];
          this.openDialog('MUSIC', (dialog) => new ZXVolumeEntity(dialog, dialog.innerX, dialog.innerY, dialog.innerWidth, dialog.innerHeight, 'music', 'audioBusMusicLevel', 'music', this.dialogProperties));
        });
        return true;

      case 'setSettings':
        this.openDialog('SETTINGS', (dialog) => new ZXSettingsEntity(dialog, dialog.innerX, dialog.innerY, dialog.innerWidth, dialog.innerHeight, this.app.controlsOptions, this.dialogProperties));
        return true;

      case 'showAbout':
        this.openNotice('ABOUT GAME', [this.app.title, 'REMAKE ON SVISION, 3D PLATFORM'].concat(this.app.copyright.split(', ')));
        return true;

      case 'upgradeApp':
        if (this.newVersionAvailable) {
          this.app.upgradeApp();
        }
        return true;
    }

    return false;
  } // handleEvent

  loopModel(timestamp) {
    super.loopModel(timestamp);

    if (this.desktopEntity.modalEntity) {
      this.desktopEntity.modalEntity.loopEntity(timestamp);
    } else if (this.menuEntity) {
      this.menuEntity.loopEntity(timestamp);
    }

    this.drawModel();
  } // loopModel

} // MenuModel
