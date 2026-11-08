const { WebGL2Platform } = await import('./svision/js/platform/webGL2/webGL2Platform.js?ver='+window.srcVersion);
// begin code

/**
 * The 3D platform of the game (R-032, ZADANI chap. 4): a desktop of 640x360
 * model units in landscape — the pixel grid of the HUD, the menu and the
 * dialogs on the 2D overlay (the original is `sensorLandscape`, its UI
 * 1095x616 ≈ 16:9; decided in GR-M1) — fitted at a whole ratio from 2x up,
 * and with `fit: 'cover'` grown over the whole window whatever its aspect:
 * no border bands, the models lay the HUD out by the desktop size they get.
 * The 3D picture is rendered at the device's pixel ratio; the GL clear
 * colour outside every scene is the night blue of the menu.
 */
export function appPlatform() {
  return new WebGL2Platform({
    width: 640,
    height: 360,
    defaultColor: false,
    border: {minimal: 0, defaultColor: '#0b1020'},
    background: '#0b1020',
    fit: 'cover',
    antialias: true,
    pixelRatio: false
  });
} // appPlatform
