<?php
defined('BASEPATH') OR exit('No direct script access allowed');
require_once APPPATH . 'third_party/AccountGraph.php';

class Graph_client extends AccountGraph
{
    private $suggestions;

    public function __construct(array $config)
    {
        parent::__construct($config['url'], $config['token'], $config['connect_ms'], $config['timeout_ms'], $config['attempts']);
        $this->suggestions = new AccountGraph($config['url'], $config['token'], 80, 200, 1);
    }

    // The contact form asks separately so a busy graph cannot hold up the save.
    public function suggest(array $facts, $at)
    {
        return $this->suggestions->lookup(array('kind' => 'match', 'facts' => $facts, 'at' => $at));
    }
}
