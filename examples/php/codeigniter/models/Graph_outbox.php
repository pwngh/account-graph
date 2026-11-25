<?php
defined('BASEPATH') OR exit('No direct script access allowed');
require_once APPPATH . 'third_party/AccountGraph.php';

class Graph_outbox extends CI_Model
{
    private function connection()
    {
        $this->load->database();
        $db = $this->db->conn_id;
        if (!($db instanceof PDO)) {
            throw new RuntimeException('Configure the application database with the CI3 PDO driver.');
        }
        return $db;
    }

    public function enqueue($recordId, $call, array $request)
    {
        return AccountGraphOutbox::enqueue($this->connection(), $recordId, $call, $request);
    }

    public function run(AccountGraph $client, $limit = 100)
    {
        return AccountGraphOutbox::run($this->connection(), $client, $limit);
    }
}
