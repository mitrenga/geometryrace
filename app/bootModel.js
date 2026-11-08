const { AbstractModel } = await import('./svision/js/abstractModel.js?ver='+window.srcVersion);
const { MenuModel } = await import('./menuModel.js?ver='+window.srcVersion);
// begin code

/**
 * Boot model — the counterpart of svision's ZXResetModel (GR-M3 skeleton,
 * the shape of asteroids): the title in the middle of the screen over the
 * empty night blue, then it glides up to where the menu has it (the same
 * entity as in MenuModel, so the menu appears under it without a jump) and
 * the menu takes over. Enter, space, a click or a tap skip to the menu.
 *
 * The handover to the menu is the event `setMenuModel`, queued with a delay;
 * GameApp.errorData looks for it in the queue to know that the boot is still
 * on its way to the menu (the same contract as ZXResetModel).
 */
export class BootModel extends AbstractModel {

  /**
   * @param {GameApp} app
   */
  constructor(app) {
    super(app);
    this.id = 'BootModel';
    this.titleEntity = null;
    this.titleFrom = 0;             // y of the title in the middle of the screen
    this.titleTo = MenuModel.TITLE_Y;
    this.moveStart = false;         // timestamp the glide began, or false
    this.moveDuration = 700;
  } // constructor

  init() {
    super.init();

    this.desktopEntity.bkColor = false;
    this.layoutEntities();
    this.sendEvent(1200, {id: 'moveTitle'});
  } // init

  /**
   * Places the title by the desktop size — on init and on every resize
   * (`fit: 'cover'`: the desktop grows to the window).
   */
  layoutEntities() {
    var h = this.desktopHeight;
    this.titleFrom = Math.round((h-MenuModel.TITLE_HEIGHT)/2);
    if (this.titleEntity === null) {
      this.titleEntity = MenuModel.newTitleEntity(this.desktopEntity, this.titleFrom, this.app.title);
      this.desktopEntity.addEntity(this.titleEntity);
    } else {
      this.titleEntity.width = this.desktopWidth;
      if (this.moveStart === false) {
        this.titleEntity.y = this.titleFrom;
      }
      this.titleEntity.invalidate();
    }
  } // layoutEntities

  handleEvent(event) {
    if (super.handleEvent(event)) {
      return true;
    }
    switch (event.id) {
      case 'resizeModel':
        this.layoutEntities();
        return true;
      case 'moveTitle':
        // the glide and the handover run on the same clock: the menu comes
        // the moment the title arrives
        this.moveStart = this.app.now;
        this.sendEvent(this.moveDuration, {id: 'setMenuModel'});
        return true;
      case 'setMenuModel':
        // not before the application data has come or failed
        // (AbstractApp.appDataPending): on a slow line the boot stays
        if (this.app.appDataPending()) {
          this.sendEvent(100, {id: 'setMenuModel'});
          return true;
        }
        this.app.setModel('MenuModel');
        return true;
      case 'retryLoadAppData':
        // sent by the error notice's ENTER: reload the application data and
        // retry the menu handover once the request is over (setMenuModel
        // waits for it; offline there is none and the app falls back to
        // storage at once)
        this.app.loadAppData();
        this.sendEvent(0, {id: 'setMenuModel'});
        return true;
      case 'keyPress':
        switch (event.key) {
          case 'Enter':
          case ' ':
          case 'GamepadOK':
          case 'Mouse1':
          case 'Touch':
            // skips the glide
            if (this.app.globalData !== false) {
              this.app.setModel('MenuModel');
              return true;
            }
        }
        break;
    }
    return false;
  } // handleEvent

  loopModel(timestamp) {
    super.loopModel(timestamp);
    if (this.moveStart !== false) {
      var t = Math.min(1, (timestamp-this.moveStart)/this.moveDuration);
      var ease = 1-Math.pow(1-t, 3);                    // fast out, settles softly
      this.titleEntity.y = Math.round(this.titleFrom+(this.titleTo-this.titleFrom)*ease);
      if (t >= 1) {
        this.moveStart = false;
      }
    }
    this.drawModel();
  } // loopModel

} // BootModel
