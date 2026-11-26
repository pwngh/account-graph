<?php
/**
 * Run one CI3 outbox pass from the command line.
 * Requires PHP 7.2 or later and CodeIgniter 3.
 *
 * @filename Graph_worker.php
 */

defined('BASEPATH') OR exit('No direct script access allowed');

class Graph_worker extends CI_Controller
{
    /**
     * Drain the host outbox from cron and report counts without row contents.
     *
     * @return void
     */
    public function run(): void
    {
        if (!is_cli()) {
            show_404();
            return;
        }
        try {
            $this->load->library('account_graph_lib');
            $this->load->model('graph_outbox');
            $counts = $this->graph_outbox->run($this->account_graph_lib);
            fwrite(STDOUT, json_encode($counts) . PHP_EOL);
            exit(($counts['failed'] || $counts['refused'] || $counts['blocked'] || $counts['pending']) ? 1 : 0);
        } catch (Throwable $error) {
            // A database exception can contain the statement or its parameters.
            fwrite(STDERR, "Graph worker stopped before finishing its pass.\n");
            exit(1);
        }
    }
}
