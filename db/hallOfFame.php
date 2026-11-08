<?php

/**
 * hallOfFame.db — the ten best entries, one per name, from best down:
 * `[{name, score}, ...]`. Without a reachable database an empty list (the
 * dialog then says so), not an error.
 */
class DataCommand {

  public function execute($postData) {
    $result = [];
    if (!class_exists('mysqli')) {
      return $result;
    }
    mysqli_report(MYSQLI_REPORT_OFF);
    $mysqli = @new mysqli($GLOBALS['dbHostname'], $GLOBALS['dbUser'], $GLOBALS['dbPassword'], $GLOBALS['dbName']);
    if ($mysqli->connect_errno) {
      return $result;
    }
    $data = $mysqli->query('SELECT `name`, MAX(`score`) as score FROM `rg_gr_hallOfFame` GROUP BY `name` ORDER BY score DESC LIMIT 10');
    if ($data) {
      while ($row = $data->fetch_object()) {
        $result[] = ['name' => $row->name, 'score' => (int) $row->score];
      }
    }
    $mysqli->close();
    return $result;
  } // execute

} // class DataCommand

