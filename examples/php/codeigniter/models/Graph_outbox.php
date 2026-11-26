<?php
defined('BASEPATH') OR exit('No direct script access allowed');
require_once APPPATH . 'third_party/AccountGraph.php';

class Graph_outbox extends CI_Model
{
    public function enqueue($recordId, $call, array $request, $dependsOn = null, &$dropped = null)
    {
        $dropped = array();
        $this->load->database();
        if ($this->transactionActive() === false) {
            throw new LogicException('Queue the graph write in the host transaction.');
        }
        $fields = AccountGraphOutbox::row($recordId, $call, $request, $dependsOn, $dropped);
        if ($fields === null) {
            return false;
        }
        // A nonlocking read avoids making a web save wait on the worker's network call.
        if ($dependsOn !== null && !$this->one('SELECT id FROM account_graph_outbox WHERE id = ?', array($dependsOn))) {
            throw new InvalidArgumentException('The outbox prerequisite does not exist.');
        }
        $sql = $this->db->set($fields)->get_compiled_insert('account_graph_outbox');
        $postgres = $this->db->dbdriver === 'postgre' || ($this->db->dbdriver === 'pdo' && $this->db->subdriver === 'pgsql');
        $result = $this->write($postgres ? $sql . ' RETURNING id' : $sql);
        if ($postgres) {
            $id = $result instanceof PDOStatement ? $result->fetchColumn() : pg_fetch_result($result, 0, 'id');
        } else {
            $id = $this->db->insert_id();
        }
        if (!preg_match('/^[1-9][0-9]*$/D', (string) $id)) {
            throw new RuntimeException('The outbox insert did not return a row ID.');
        }
        return (string) $id;
    }

    public function run(AccountGraph $client, $limit = 100)
    {
        $this->load->database();
        if ($this->transactionActive()) {
            throw new LogicException('Run the graph worker outside the host transaction.');
        }
        return AccountGraphOutbox::work($this, $client, $limit);
    }

    private function transactionActive()
    {
        if (method_exists($this->db, 'trans_active')) {
            return $this->db->trans_active();
        }
        if ($this->db->conn_id instanceof PDO) {
            return $this->db->conn_id->inTransaction();
        }
        // Older drivers expose no transaction state. The producer opens it before enqueueing.
        return null;
    }

    private function tableSql($sql)
    {
        $table = $this->db->protect_identifiers('account_graph_outbox', true, null, false);
        return str_replace('account_graph_outbox', $table, $sql);
    }

    private function write($sql)
    {
        // CI3 query() can log the entire SQL on error. The builder has already escaped the values.
        try {
            $result = @$this->db->simple_query($sql);
        } catch (Throwable $error) {
            $result = false;
        }
        unset($sql);
        if ($result === false) {
            throw new RuntimeException('Graph outbox write failed.');
        }
        return $result;
    }

    public function one($sql, array $args = array())
    {
        $result = $this->db->query($this->tableSql($sql), $args);
        if ($result === false) {
            throw new RuntimeException('Graph outbox read failed.');
        }
        return $result->row_array();
    }

    public function execute($sql, array $args = array())
    {
        $result = $this->write($this->db->compile_binds($this->tableSql($sql), $args));
        if ($result instanceof PDOStatement) {
            return $result->rowCount();
        }
        return $this->db->dbdriver === 'postgre' ? pg_affected_rows($result) : $this->db->affected_rows();
    }

    public function begin()
    {
        if (!$this->db->trans_begin()) {
            throw new RuntimeException('Could not begin the outbox transaction.');
        }
    }

    public function commit()
    {
        if (!$this->db->trans_commit()) {
            throw new RuntimeException('Could not commit the outbox transaction.');
        }
    }

    public function rollback()
    {
        if (!$this->db->trans_rollback()) {
            throw new RuntimeException('Could not roll back the outbox transaction.');
        }
    }
}
