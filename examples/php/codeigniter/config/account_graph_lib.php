<?php
/**
 * Configure the graph client for application and cron processes.
 * Requires PHP 7.2 or later and CodeIgniter 3.
 *
 * @filename account_graph_lib.php
 */

defined('BASEPATH') OR exit('No direct script access allowed');

$config['Base_Url'] = getenv('GRAPH_URL');
$config['Token'] = getenv('GRAPH_TOKEN');
$config['Connect_Timeout_Ms'] = 1000;
$config['Timeout_Ms'] = 35000;
$config['Attempts'] = 3;
