const { AbstractEntity } = await import('./svision/js/abstractEntity.js?ver='+window.srcVersion);
const { TextEntity } = await import('./svision/js/platform/canvas2D/textEntity.js?ver='+window.srcVersion);
// begin code

/**
 * A modal notice on the 2D overlay (the canvas2D counterpart of the vector
 * platform's VectorNoticeEntity): a framed box with a title, a few lines of
 * text and a hint, closed by Enter, space, a click or a tap — which sends
 * `continueEvent` to the model when there is one — or by Escape (Exit),
 * which sends `escapeEvent` instead when one is given, or just closes.
 * Used for errors (GameApp.showErrorMessage), the pause of the game and
 * the milestones that are not here yet. Candidate for svision once a
 * second canvas2D game wants it (ROADMAP).
 */
export class NoticeEntity extends AbstractEntity {

  /** the box: its size in desktop units, the frame, the colours of the skeleton's look */
  static get WIDTH() { return 320; }
  static get HEIGHT() { return 120; }
  static get COLORS() {
    return {frame: '#8fb3e6', panel: '#16243d', title: '#ffffff', text: '#ffffff', hint: '#ffd166'};
  } // COLORS

  /**
   * @param {AbstractEntity} parentEntity
   * @param {number} x
   * @param {number} y
   * @param {string} title
   * @param {string[]} lines
   * @param {Object|false} continueEvent - Sent to the model when the notice closes with Enter (or a click), or false.
   * @param {Object} [options] - `escapeEvent`: sent instead when Escape closes it; `hint`: the bottom line (default PRESS ENTER); `width`, `height`.
   */
  constructor(parentEntity, x, y, title, lines, continueEvent, options) {
    options = Object.assign({escapeEvent: false, hint: 'PRESS ENTER', width: NoticeEntity.WIDTH, height: NoticeEntity.HEIGHT}, options || {});
    super(parentEntity, x, y, options.width, options.height, NoticeEntity.COLORS.text, NoticeEntity.COLORS.frame);
    this.id = 'NoticeEntity';
    this.title = title;
    this.lines = lines;
    this.continueEvent = continueEvent;
    this.options = options;
  } // constructor

  init() {
    super.init();
    var c = NoticeEntity.COLORS;
    var w = this.width, h = this.height;
    var fonts = this.app.fonts.fonts5x5;
    this.addEntity(new AbstractEntity(this, 2, 2, w-4, h-4, false, c.panel));
    this.addEntity(new TextEntity(this, fonts, 2, 8, w-4, 12, this.title, c.title, false, {align: 'center', scale: 2}));
    this.addEntity(new TextEntity(this, this.app.fonts.zxFonts8x8, 8, 30, w-16, h-64, this.lines.join('\n'), c.text, false, {align: 'center'}));
    this.addEntity(new TextEntity(this, fonts, 2, h-16, w-4, 8, this.options.hint, c.hint, false, {align: 'center'}));
  } // init

  /**
   * Closes the notice and sends the event of the way it was closed.
   * @param {boolean} escaped - Closed by Escape.
   */
  close(escaped) {
    var event = escaped ? this.options.escapeEvent : this.continueEvent;
    this.destroy();
    if (event) {
      if (event.id == 'reloadApp') {
        // an error the application cannot recover from: start over
        window.location.reload();
        return;
      }
      this.sendEvent(0, 0, event);
    }
  } // close

  handleEvent(event) {
    if (super.handleEvent(event)) {
      return true;
    }
    switch (event.id) {
      case 'keyPress':
        switch (event.key) {
          case 'Escape':
          case 'GamepadExit':
            this.close(true);
            return true;
          case 'Enter':
          case ' ':
          case 'GamepadOK':
          case 'Mouse1':
          case 'Touch':
            this.close(false);
            return true;
        }
        // any other key is swallowed: the notice is modal
        return true;
      case 'keyRelease':
      case 'mouseHover':
        return true;
    }
    return false;
  } // handleEvent

} // NoticeEntity
