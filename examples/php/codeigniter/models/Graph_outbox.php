<?php
/**
 * Queue writes on the host transaction and adapt the CI3 database driver for the shared worker.
 * Requires PHP 7.2 or later and CodeIgniter 3.
 *
 * @filename Graph_outbox.php
 */

defined('BASEPATH') OR exit('No direct script access allowed');
require_once APPPATH . 'third_party/account_graph_outbox_lib.php';

class Graph_outbox extends CI_Model
{
    /**
     * Queue a single write on the CI3 connection that is saving the host change.
     *
     * @param string $record_id Ordering group in the host.
     *        (for example 'contact:42')
     * @param string $call Graph write method.
     *        (for example 'record')
     * @param array $request Original write, including its time and stable key.
     *        (for example ['entries' => [['type' => 'arrival', 'key' => 'visit-42', 'at' => 1000, 'subject' => 'contact:42']]])
     * @param int|string|null $depends_on Earlier outbox ID that must succeed first.
     *        (for example '17')
     * @param array|null $dropped Receives the paths and reasons for fields the model omits.
     *        (for example ['facts.email' => 'Expected an email address.'])
     * @return string|false Outbox ID or false for a screened-out profile.
     */
    public function enqueue(string $record_id, string $call, array $request, $depends_on = null, ?array &$dropped = null)
    {
        $dropped = [];
        $this->load->database();
        if ($this->transaction_active() === false) {
            throw new LogicException('Queue the graph write in the host transaction.');
        }
        $fields = account_graph_outbox_lib::row($record_id, $call, $request, $depends_on, $dropped);
        if ($fields === null) {
            return false;
        }
        // A nonlocking read avoids making a web save wait on the worker's network call.
        if ($depends_on !== null && !$this->one('SELECT id FROM account_graph_outbox WHERE id = ?', [$depends_on])) {
            throw new InvalidArgumentException('The outbox prerequisite does not exist.');
        }
        $sql = $this->db->set($fields)->get_compiled_insert('account_graph_outbox');
        return $this->insert_id($sql);
    }

    /**
     * Insert the builder-escaped row and read its generated ID on the same connection.
     *
     * @param string $sql Outbox SQL.
     *        (for example $this->db->get_compiled_insert('account_graph_outbox'))
     * @return string Outbox ID.
     */
    private function insert_id(string $sql): string
    {
        $postgres = $this->db->dbdriver === 'postgre' || ($this->db->dbdriver === 'pdo' && $this->db->subdriver === 'pgsql');
        $result = $this->driver_query($postgres ? $sql . ' RETURNING id' : $sql, 'Graph outbox write failed.');
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

    /**
     * Send a bounded worker pass from its own idle CI3 connection.
     *
     * @param account_graph_lib $client The client loaded by CI3.
     *        (for example $this->account_graph_lib)
     * @param int $limit Maximum rows to process in this pass.
     *        (for example 100)
     * @return array Counts by resulting state.
     */
    public function run(account_graph_lib $client, int $limit = 100): array
    {
        $this->load->database();
        if ($this->transaction_active()) {
            throw new LogicException('Run the graph worker outside the host transaction.');
        }
        return account_graph_outbox_lib::work($this, $client, $limit);
    }

    /**
     * Read the host transaction state when the driver exposes it.
     *
     * @return bool|null
     */
    private function transaction_active(): ?bool
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

    /**
     * Apply the host table prefix to worker statements.
     *
     * @param string $sql Outbox SQL.
     *        (for example 'SELECT state FROM account_graph_outbox WHERE id = ?')
     * @return string
     */
    private function table_sql(string $sql): string
    {
        $table = $this->db->protect_identifiers('account_graph_outbox', true, null, false);
        return str_replace('account_graph_outbox', $table, $sql);
    }

    /**
     * Execute escaped SQL on the host connection without caching rows or logging values in CI3.
     *
     * @param string $sql Outbox SQL.
     *        (for example $this->db->get_compiled_insert('account_graph_outbox'))
     * @param string $message Message to return on failure.
     *        (for example 'Graph outbox read failed.')
     * @return PDOStatement|resource|object|bool Driver result.
     */
    private function driver_query(string $sql, string $message)
    {
        // CI3 query() can log the entire SQL on error. The builder has already escaped the values.
        try {
            $result = @$this->db->simple_query($sql);
        } catch (Throwable $error) {
            $result = false;
        }
        unset($sql);
        if ($result === false) {
            throw new RuntimeException($message);
        }
        return $result;
    }

    /**
     * Read the first matching outbox row.
     *
     * @param string $sql Outbox SQL.
     *        (for example 'SELECT state FROM account_graph_outbox WHERE id = ?')
     * @param array $args Bound statement values.
     *        (for example ['17'])
     * @return array|null
     */
    public function one(string $sql, array $args = []): ?array
    {
        // A cached claim can outlive its transaction, and a cached request can outlive its erasure.
        $result = $this->driver_query($this->db->compile_binds($this->table_sql($sql), $args), 'Graph outbox read failed.');
        if ($result instanceof PDOStatement) {
            try {
                return $result->fetch(PDO::FETCH_ASSOC) ?: null;
            } finally {
                $result->closeCursor();
            }
        }
        if ($this->db->dbdriver === 'postgre') {
            try {
                return pg_fetch_assoc($result) ?: null;
            } finally {
                pg_free_result($result);
            }
        }
        try {
            return $result->fetch_assoc() ?: null;
        } finally {
            $result->free();
        }
    }

    /**
     * Run a worker update and return the number of claimed or changed rows.
     *
     * @param string $sql Outbox SQL.
     *        (for example "UPDATE account_graph_outbox SET state = 'sending' WHERE id = ?")
     * @param array $args Bound statement values.
     *        (for example ['17'])
     * @return int
     */
    public function execute(string $sql, array $args = []): int
    {
        $result = $this->driver_query($this->db->compile_binds($this->table_sql($sql), $args), 'Graph outbox write failed.');
        if ($result instanceof PDOStatement) {
            return $result->rowCount();
        }
        return $this->db->dbdriver === 'postgre' ? pg_affected_rows($result) : $this->db->affected_rows();
    }

    /**
     * Open the delivery transaction before claiming a row.
     *
     * @return void
     */
    public function begin(): void
    {
        if (!$this->db->trans_begin()) {
            throw new RuntimeException('Could not begin the outbox transaction.');
        }
    }

    /**
     * Save the answer and release the row claim.
     *
     * @return void
     */
    public function commit(): void
    {
        if (!$this->db->trans_commit()) {
            throw new RuntimeException('Could not commit the outbox transaction.');
        }
    }

    /**
     * Undo an interrupted or stale row claim.
     *
     * @return void
     */
    public function rollback(): void
    {
        if (!$this->db->trans_rollback()) {
            throw new RuntimeException('Could not roll back the outbox transaction.');
        }
    }
}
