<?php

/**
 * appData.db — everything the application loads at start: the JSON files of
 * data/ and the current high score. The database is optional while the game
 * is a skeleton (GR-M3): without a reachable one the high score is 0 and the
 * menu still comes up. With one, the high score and the ten best entries
 * (one per name) come along.
 *
 * The four files are the small ones (global with the rules, the ships'
 * store facts, worlds, the pickups' meshes); the ships' meshes and the
 * worlds' tracks are static files in assets/ the application fetches on
 * demand (GameApp.loadAsset), so localStorage stays small. A file that is
 * not there is left out of the answer, not reported as an error. Nothing
 * of sources/ is ever served.
 */
class DataCommand {

  var $files = ['global', 'ships', 'worlds', 'pickups'];

  public function execute($postData) {
    $result = [];
    foreach ($this->files as $file) {
      $path = 'data/'.$file.'.json';
      if (!file_exists($path)) {
        continue;
      }
      $dataJSON = file_get_contents($path);
      try {
        $result[$file] = json_decode($dataJSON);
      }
      catch (\JsonException $exception) {
        $result[$file] = ['error' => ['message' => $exception->getMessage()]];
      }
    }

    $result['hiScore'] = 0;
    $result['hallOfFame'] = [];
    if (!class_exists('mysqli')) {
      return $result;
    }
    mysqli_report(MYSQLI_REPORT_OFF);
    $mysqli = @new mysqli($GLOBALS['dbHostname'], $GLOBALS['dbUser'], $GLOBALS['dbPassword'], $GLOBALS['dbName']);
    if (!$mysqli->connect_errno) {
      $data = $mysqli->query('SELECT `name`, MAX(`score`) as score FROM `rg_gr_hallOfFame` GROUP BY `name` ORDER BY score DESC LIMIT 10');
      if ($data) {
        while ($row = $data->fetch_object()) {
          $result['hallOfFame'][] = ['name' => $row->name, 'score' => (int) $row->score];
        }
      }
      if (count($result['hallOfFame'])) {
        $result['hiScore'] = $result['hallOfFame'][0]['score'];
      }
      $mysqli->close();
    }

    return $result;
  } // execute

} // class DataCommand
