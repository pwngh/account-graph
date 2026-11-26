<?php
defined('BASEPATH') OR exit('No direct script access allowed');

$config['url'] = getenv('GRAPH_URL');
$config['connect_ms'] = 1000;
$config['timeout_ms'] = 35000;
$config['attempts'] = 3;
