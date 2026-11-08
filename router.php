<?php
// dev router for php -S: an existing file is served as is, anything else goes to index.php?<path>
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$file = __DIR__ . $path;
if ($path !== '/' && is_file($file)) {
  return false;
}
$_SERVER['QUERY_STRING'] = ltrim($path, '/');
$_GET = [];
parse_str($_SERVER['QUERY_STRING'], $_GET);
require __DIR__ . '/index.php';
