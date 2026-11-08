SELECT `ndx`, `name`, `score`, `created`
FROM `rg_gr_hallOfFame`
ORDER BY `ndx` DESC
LIMIT :limit
