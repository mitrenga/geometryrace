<?php

/**
 * saveGame.db — a finished game: the player's name (or the initials the
 * machine asked for) and the score go into the hall of fame; the answer is
 * the best score and the ten best entries (one per name), the same shape
 * appData.db and hallOfFame.db give, so the application keeps them for the
 * next game's high score table.
 */
class DataCommand {

  public function execute($postData) {
    $data = json_decode($postData);
    $result = ['hiScore' => 0, 'hallOfFame' => []];
    if (!class_exists('mysqli') || !$data || !isset($data->name) || !isset($data->score)) {
      return $result;
    }
    $name = mb_substr(trim((string) $data->name), 0, 64);
    $score = (int) $data->score;
    if ($name === '' || $score <= 0) {
      return $result;
    }
    mysqli_report(MYSQLI_REPORT_OFF);
    $mysqli = @new mysqli($GLOBALS['dbHostname'], $GLOBALS['dbUser'], $GLOBALS['dbPassword'], $GLOBALS['dbName']);
    if ($mysqli->connect_errno) {
      return $result;
    }
    $statement = $mysqli->prepare('INSERT INTO `rg_gr_hallOfFame` (`name`, `score`, `created`) VALUES (?, ?, NOW())');
    if ($statement) {
      $statement->bind_param('si', $name, $score);
      $statement->execute();
      $statement->close();
    }
    $rows = $mysqli->query('SELECT `name`, MAX(`score`) as score FROM `rg_gr_hallOfFame` GROUP BY `name` ORDER BY score DESC LIMIT 10');
    if ($rows) {
      while ($row = $rows->fetch_object()) {
        $result['hallOfFame'][] = ['name' => $row->name, 'score' => (int) $row->score];
      }
    }
    if (count($result['hallOfFame'])) {
      $result['hiScore'] = $result['hallOfFame'][0]['score'];
    }
    $mysqli->close();
    return $result;
  } // execute

} // class DataCommand
