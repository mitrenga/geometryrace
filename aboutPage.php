<?php

require_once 'app/svision/php/abstractAboutPage.php';

/**
 * The /about page: what the game is and what this remake is. Skeleton text
 * (GR-M3); the credits and the links are GR-M9. The original is a
 * proprietary work of an existing studio: its name, logo and assets are not
 * used (ZADANI.md chap. 8), the mechanics are rebuilt from its behaviour.
 */
class AboutPage extends AbstractAboutPage {

  protected function aboutData() {
    return [
      'image' => 'images/app-icon-512x512.png',
      'sections' => [
        [
          'heading' => 'The game',
          'html' =>
            '<p>An endless runner in three dimensions, in the style of the mobile racers of the '.
            'mid 2010s: a ship flies towards the horizon at a constant speed and the player only steers '.
            'it left and right — through fields of cubes, pillars, walls and moving blocks, over a plane '.
            'that never ends. The ship\'s energy drains as it flies and is refilled by the energy it '.
            'collects on the way; coins buy new ships and open new worlds. A crash, or an empty battery, '.
            'ends the run; the distance flown is the score.</p>',
        ],
        [
          'heading' => 'This remake',
          'html' =>
            '<p>This remake rebuilds the mechanics of the game — the movement, the speed, the energy, '.
            'the track and its obstacles — in your web browser, on the 3D platform of the svision '.
            'library (WebGL2 with a 2D overlay for the HUD). The look, the sounds and the name are its '.
            'own. There is nothing to install and nothing to download — just open the page and play, '.
            'free of charge. The game supports keyboard, touch controls and gamepads.</p>'.$this->installNote(),
        ],
        [
          'heading' => 'Other games',
          'html' =>
            '<p>This remake is one of a growing collection of classic games from the 8-bit and 16-bit era '.
            '— ZX Spectrum, Commodore 64, arcade and more — rebuilt faithfully on the same library and '.
            'playable in your browser, free of charge. Browse the whole collection at '.
            '<a href="https://retrogames.free/" target="_blank" rel="noopener">retrogames.free</a>.</p>',
        ],
      ],
      'footer' =>
        '<p>An unofficial fan remake. The original game belongs to its authors. '.
        'The remake\'s source code is licensed under <a href="https://creativecommons.org/licenses/by-nc-sa/4.0/" target="_blank" rel="noopener">CC BY-NC-SA 4.0</a>.</p>',
    ];
  } // aboutData

} // AboutPage
