<?php
defined('BASEPATH') OR exit('No direct script access allowed');

class Graph_worker extends CI_Controller
{
    public function run()
    {
        if (!is_cli()) {
            show_404();
            return;
        }
        try {
            $this->load->library('graph_client');
            $this->load->model('graph_outbox');
            $counts = $this->graph_outbox->run($this->graph_client);
            fwrite(STDOUT, json_encode($counts) . PHP_EOL);
            exit(($counts['failed'] || $counts['refused'] || $counts['blocked'] || $counts['pending']) ? 1 : 0);
        } catch (Throwable $error) {
            // A database exception can contain the statement or its parameters.
            fwrite(STDERR, "Graph worker stopped before finishing its pass.\n");
            exit(1);
        }
    }
}
