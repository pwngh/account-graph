<?php
defined('BASEPATH') OR exit('No direct script access allowed');

$config['url'] = getenv('GRAPH_URL');
$config['token'] = getenv('GRAPH_TOKEN');
$config['connect_ms'] = 1000;
$config['timeout_ms'] = 5000;
$config['attempts'] = 3;
