<?php
/**
 * Run host outbox queries and transactions with PDO.
 * Requires PHP 7.2 or later.
 *
 * @filename account_graph_outbox_pdo.php
 */

class account_graph_outbox_pdo
{
    private $db;

    /**
     * Use the existing host connection for all statements and transaction boundaries.
     *
     * 'Db' => null, // required, PDO, the same connection used for the host change.
     *
     * @param array $config Host connection settings.
     *        (for example ['Db' => $db])
     * @return void
     */
    public function __construct(array $config)
    {
        if (!(($config['Db'] ?? null) instanceof PDO)) {
            throw new InvalidArgumentException('Db must be the host PDO connection');
        }
        $this->db = $config['Db'];
    }

    /**
     * Prepare the statement and surface a database failure without including SQL values.
     *
     * @param string $sql Parameterized outbox statement.
     *        (for example 'SELECT state FROM account_graph_outbox WHERE id = ?')
     * @param array $args Bound statement values.
     *        (for example ['17'])
     * @return PDOStatement
     */
    private function query(string $sql, array $args): PDOStatement
    {
        // Some drivers include the failing row in exception messages, even for bound parameters.
        try {
            $query = @$this->db->prepare($sql);
            $ok = $query && @$query->execute($args);
        } catch (PDOException $error) {
            $ok = false;
        }
        if (!$ok) {
            throw new RuntimeException('Outbox query failed');
        }
        return $query;
    }

    /**
     * Read the first matching row and release the statement cursor.
     *
     * @param string $sql Parameterized outbox statement.
     *        (for example 'SELECT state FROM account_graph_outbox WHERE id = ?')
     * @param array $args Bound statement values.
     *        (for example ['17'])
     * @return array|null
     */
    public function one(string $sql, array $args = []): ?array
    {
        $query = $this->query($sql, $args);
        $row = $query->fetch(PDO::FETCH_ASSOC);
        $query->closeCursor();
        return $row ?: null;
    }

    /**
     * Execute a statement and return its affected row count.
     *
     * @param string $sql Parameterized outbox statement.
     *        (for example "UPDATE account_graph_outbox SET state = 'sent' WHERE id = ?")
     * @param array $args Bound statement values.
     *        (for example ['17'])
     * @return int
     */
    public function execute(string $sql, array $args = []): int
    {
        return $this->query($sql, $args)->rowCount();
    }

    /**
     * Begin a transaction for a single delivery attempt.
     *
     * @return void
     */
    public function begin(): void
    {
        if (!@$this->db->beginTransaction()) {
            throw new RuntimeException('Could not start the outbox transaction');
        }
    }

    /**
     * Commit the answer and release the claim.
     *
     * @return void
     */
    public function commit(): void
    {
        if (!@$this->db->commit()) {
            throw new RuntimeException('Could not commit the outbox transaction');
        }
    }

    /**
     * Roll back any open delivery transaction after an error or a lost claim.
     *
     * @return void
     */
    public function rollback(): void
    {
        if ($this->db->inTransaction() && !@$this->db->rollBack()) {
            throw new RuntimeException('Could not roll back the outbox transaction');
        }
    }
}
