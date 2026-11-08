<?php
  require_once 'config/config.php';
  $appName = $appPublicName ?? 'GEOMETRY RACE';
  $appDescription = 'Play '.$appName.' online for free in your browser: an endless 3D runner — steer a ship through geometric obstacles and keep its energy up.';
  $appPrefix = 'gr';
  $appNoscript =
    '<h1>'.$appName.'</h1>'.
    '<p>'.$appName.' is an endless runner in 3D: a ship flies towards the horizon at a constant speed, '.
    'you steer it left and right through fields of cubes, pillars and walls, and its energy runs out '.
    'unless you collect more on the way.</p>'.
    '<p>It runs directly in your web browser. '.
    'There is nothing to install and nothing to download — just open the page and play. '.
    'Please enable JavaScript to start the game.</p>'.
    '<p><a href="about">More about the game and this remake</a></p>';
  $appOpenGraph = [
    'image' => 'images/app-icon-512x512.png',
  ];
  $appJsonLd = [
    'genre' => 'Endless runner',
    'gamePlatform' => 'Web browser',
  ];
  require_once 'app/svision/php/main.php';
