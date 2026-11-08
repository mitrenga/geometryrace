const { AbstractAudioManager } = await import('./svision/js/audio/abstractAudioManager.js?ver='+window.srcVersion);
const { AudioSampleHandler } = await import('./svision/js/audio/audioSampleHandler.js?ver='+window.srcVersion);
const { Tool } = await import('./svision/js/tool.js?ver='+window.srcVersion);
// begin code

/**
 * The sound of the game (GR-M9, ZADANI chap. 7): the original's own
 * recordings, nothing synthesized (the operator, 2026-09-16: "drop the
 * sounds where there is no m4a or ogg sample" — the study preview is to
 * sound like the original, or not at all). Every bus therefore plays
 * samples the browser decoded (`AbstractAudioManager.loadSample` through
 * `GameApp.ensureSfx` / `ensureMusic`), and a bus whose samples are
 * missing is never opened: the game is simply silent there.
 *
 *   sfx     the one `pickupAudio` source of the original's SoundManager
 *           (notes 17): the pickup, the explosion (a crash and the energy
 *           out alike), the boosters and the countdown's ping all play on
 *           it, each cutting the one before, all at the pitch of the
 *           pickup ladder (`PITCH`, the `rate` of the handler)
 *   music   the track of the world, looping (`track`)
 *   sounds  what the volume dialog opens to try the SOUNDS level (the
 *           pickup's clip); the game never opens it
 *
 * The effects follow the one user level SOUNDS (`audioBusSoundsLevel`),
 * the music its own, MUSIC (`audioBusMusicLevel`). The menu never opens a
 * bus of its own accord (R-024) — only its volume dialogs do, to try the
 * level. The tools' stand-in application has no manager at all: the
 * models ask `hasAudio()`.
 */
var EFFECT_BUSES = ['sfx'];
var MUSIC_BUS = 'music';
var SFX_BUS = 'sfx';
/** the original's effects by name (assets/sfx/<name>): the clip of notes 17 each comes from */
var SAMPLES = {
  explosion: 'Explosion',              // EXPLOSION: a crash, and the energy out
  pickup: 'pickupSoundFinal',          // pickupSounds[0]
  ping: 'CountPing3Final',             // COUNT_PING: the countdown out of a pause
  pingLast: 'CountPing3LastFinal'      // COUNT_PING_LAST, and BOOSTERS_ON
};

export class AudioManager extends AbstractAudioManager {

  /**
   * @param {GameApp} app
   */
  constructor(app) {
    super(app);
    this.id = 'AudioManager';
    this.volume = {};
    this.volume.sounds = Math.min(10, Math.max(0, Math.round(Number(Tool.readCookie('audioBusSoundsLevel', 7)))));
    this.volume.music = Math.min(10, Math.max(0, Math.round(Number(Tool.readCookie('audioBusMusicLevel', 5)))));
    this.latencyHint = 'interactive';
    /** the decoded track of the world to play on `music` (PCMSample.fromAudioBuffer), or null */
    this.track = null;
    /** the original's effects by name (PCMSample.fromAudioBuffer), once loaded (GameApp.ensureSfx) */
    this.samples = {};
  } // constructor

  static get effectBuses() {
    return EFFECT_BUSES;
  } // effectBuses

  static get musicBus() {
    return MUSIC_BUS;
  } // musicBus

  static get sfxBus() {
    return SFX_BUS;
  } // sfxBus

  /** the names of the original's effects and the clips they come from */
  static get samples() {
    return SAMPLES;
  } // samples

  /**
   * The ladder the pitch of the effects' source climbs (notes 17,
   * `SoundManager.PlayPickupSfx`): a pickup plays at the pitch the source
   * has, then the pitch steps up by `step` while it is at most `max` (so
   * it ends at 1.85); `PowerupManager.changePitch` puts it back to 1
   * after `resetTicks` ticks (2 s at 50 Hz) without a pickup, and so does
   * every ping of the countdown (`ResetPickupAudioPitch`).
   */
  static get PITCH() {
    return {step: 0.05, max: 1.8, resetTicks: 100};
  } // PITCH

  /**
   * The pitch of the source after a pickup played at `factor`.
   * @param {number} factor - The pitch it played at (1 at rest).
   * @returns {number}
   */
  static nextPitch(factor) {
    var P = AudioManager.PITCH;
    return factor <= P.max+1e-9 ? Math.round((factor+P.step)*1000)/1000 : factor;
  } // nextPitch

  /**
   * Whether the original's effects are at hand: every one of them decoded.
   * @returns {boolean}
   */
  hasSamples() {
    return Object.keys(SAMPLES).every((name) => !!this.samples[name]);
  } // hasSamples

  /**
   * Whether the effects bus plays — it is open, which it only is with the
   * samples.
   * @returns {boolean}
   */
  sfxPlays() {
    return SFX_BUS in this.buses;
  } // sfxPlays

  /**
   * Whether the music bus plays — it is open, which it only is with a
   * track.
   * @returns {boolean}
   */
  trackPlays() {
    return MUSIC_BUS in this.buses;
  } // trackPlays

  createAudioHandler(bus, options) {
    return new AudioSampleHandler(this.app);
  } // createAudioHandler

  /**
   * The level's factor: the same curve as the other games.
   * @param {number} volume - 0..10
   * @returns {number}
   */
  volumeFactor(volume) {
    var levels = [0, 0.005, 0.01, 0.02, 0.04, 0.07, 0.1, 0.14, 0.18, 0.23, 0.29];
    return levels[volume]/levels[10];
  } // volumeFactor

  openBus(bus, options) {
    super.openBus(bus, options);
    this.refreshVolume(bus);
    this.muteBus(bus, ('muted' in options) ? options.muted : false);
  } // openBus

  refreshVolume(bus) {
    var handler = this.buses[bus];
    if (handler === undefined) {
      return;
    }
    handler.setBusVolume(this.volumeFactor(bus === MUSIC_BUS ? this.volume.music : this.volume.sounds));
  } // refreshVolume

  /**
   * Muting `sounds` mutes every effect bus; `music` is its own.
   */
  muteBus(bus, muted) {
    if (bus === 'sounds') {
      EFFECT_BUSES.forEach((b) => super.muteBus(b, muted));
      return;
    }
    super.muteBus(bus, muted);
  } // muteBus

  /**
   * The sample of a sound: the world's track for `music`, one of the
   * original's effects by name otherwise — false when it is not there,
   * which leaves the bus silent.
   */
  audioData(bus, sound, options) {
    if (sound === 'music') {
      return this.track || false;
    }
    return this.samples[sound] || false;
  } // audioData

} // AudioManager
