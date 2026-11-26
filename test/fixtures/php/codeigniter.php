<?php

define('BASEPATH', $argv[1] . '/');
define('APPPATH', BASEPATH . 'application/');
class CI_Model
{
    public $load;
    public $db;
}

require __DIR__ . '/../../../examples/php/codeigniter/models/Graph_outbox.php';

function check($condition)
{
    if (!$condition) {
        throw new RuntimeException('Unexpected CI3 outbox result on line ' . debug_backtrace(DEBUG_BACKTRACE_IGNORE_ARGS, 1)[0]['line']);
    }
}

// CI3 owns the transaction and may return false on a database error. SQLite runs the SQL issued through its driver API.
class FixtureDatabase
{
    public $dbdriver;
    public $subdriver;
    public $conn_id;
    public $sqlite;
    public $inserts = 0;
    public $failFinish = false;
    public $queries = array();
    private $affected = 0;
    private $fields;

    public function __construct($driver, $database = ':memory:')
    {
        $this->dbdriver = $driver === 'mysqli' ? 'mysqli' : 'pdo';
        $this->subdriver = $driver === 'pdo_pgsql' ? 'pgsql' : 'mysql';
        $this->sqlite = new PDO('sqlite:' . $database, null, null, array(PDO::ATTR_ERRMODE => PDO::ERRMODE_SILENT));
        $this->conn_id = $driver === 'mysqli' ? new stdClass() : $this->sqlite;
        $this->sqlite->exec("CREATE TABLE IF NOT EXISTS host_account_graph_outbox (id INTEGER PRIMARY KEY, record_id TEXT NOT NULL, call_name TEXT NOT NULL, item_key TEXT NOT NULL, item_kind TEXT NOT NULL, request TEXT, state TEXT DEFAULT 'pending', answer TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, depends_on INTEGER)");
    }

    public function dbprefix($table) { return 'host_' . $table; }
    public function protect_identifiers($name, $prefix, $protect, $field) { return '"' . $this->dbprefix($name) . '"'; }
    public function trans_active() { return $this->sqlite->inTransaction(); }
    public function trans_begin() { return $this->sqlite->beginTransaction(); }
    public function trans_commit() { return $this->sqlite->commit(); }
    public function trans_rollback() { return $this->sqlite->rollBack(); }
    public function affected_rows() { return $this->affected; }
    public function insert_id() { return $this->sqlite->lastInsertId(); }
    public function set($fields) { $this->fields = $fields; return $this; }
    public function get_compiled_insert($table)
    {
        $this->inserts++;
        $values = array_map(function ($v) { return $v === null ? 'NULL' : $this->sqlite->quote((string) $v); }, $this->fields);
        return 'INSERT INTO ' . $this->dbprefix($table) . ' (' . implode(',', array_keys($this->fields)) . ') VALUES (' . implode(',', $values) . ')';
    }
    public function insert($table, $fields)
    {
        return $this->query($this->set($fields)->get_compiled_insert($table));
    }
    public function compile_binds($sql, $args)
    {
        $parts = explode('?', $sql);
        $out = array_shift($parts);
        foreach ($args as $arg) {
            $out .= $this->sqlite->quote((string) $arg) . array_shift($parts);
        }
        return $out;
    }
    public function simple_query($sql)
    {
        if ($this->failFinish && strpos($sql, 'answer') !== false && preg_match('/^UPDATE/i', $sql)) return false;
        $stmt = $this->sqlite->query($sql);
        if (!$stmt) return false;
        $this->affected = $stmt->rowCount();
        return $this->dbdriver === 'mysqli' && !$stmt->columnCount() ? true : $stmt;
    }
    public function query($sql, $args = array(), $returnObject = null)
    {
        $compiled = $this->compile_binds($sql, $args ?: array());
        $this->queries[] = $compiled;
        $stmt = $this->simple_query($compiled);
        if ($stmt === true || $stmt === false) return $stmt;
        if (!$stmt->columnCount() || (stripos($sql, 'INSERT ') === 0 && $returnObject !== true)) return true;
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return new class($row) {
            private $row;
            public function __construct($row) { $this->row = $row; }
            public function row_array() { return $this->row ?: null; }
        };
    }
}

class FixtureGraph extends AccountGraph
{
    public function record(array $request)
    {
        return array('results' => array(array('ok' => true, 'value' => array('duplicate' => false))));
    }
}

putenv('GRAPH_TOKEN=synthetic-trace-secret');
require __DIR__ . '/../../../examples/php/codeigniter/config/graph_client.php';
require __DIR__ . '/../../../examples/php/codeigniter/libraries/Graph_client.php';
check(!in_array(getenv('GRAPH_TOKEN'), $config, true));
check($config['timeout_ms'] > 30000);
try {
    $config['url'] = 'invalid';
    new Graph_client($config);
    throw new LogicException('Expected a configuration fault');
} catch (AccountGraphFault $fault) {
    check(strpos($fault->getTraceAsString(), getenv('GRAPH_TOKEN')) === false);
}

$model = new Graph_outbox();
$model->load = new class { public function database() {} };
$db = $model->db = new FixtureDatabase($argv[2], $argv[4] ?? ':memory:');
if (isset($argv[3])) {
    if ($argv[3] === 'queue') {
        foreach (array(array('merge', 'unmerge'), array('split', 'unsplit')) as $i => $actions) {
            $pair = array('a' => 'contact:' . (2 * $i), 'b' => 'contact:' . (2 * $i + 1));
            $group = $pair['a'] . '/' . $pair['b'];
            $previous = null;
            foreach ($actions as $offset => $action) {
                $decision = array('at' => 1000 + $offset, 'key' => $action, 'action' => $action, 'pairs' => array($pair));
                // The first decision needs repair. Its inverse is valid but depends on that specific decision.
                if ($offset > 0) $decision['by'] = 'staff';
                check($db->trans_begin());
                $previous = $model->enqueue($group, 'decide', $decision, $previous);
                check($db->trans_commit());
            }
        }
    } else {
        check($argv[3] === 'repair');
        check($db->trans_begin());
        $failed = $db->sqlite->query("SELECT id, request FROM host_account_graph_outbox WHERE state = 'failed'")->fetchAll(PDO::FETCH_ASSOC);
        $repair = $db->sqlite->prepare("UPDATE host_account_graph_outbox SET state = 'pending', request = ? WHERE id = ?");
        foreach ($failed as $row) {
            $decision = json_decode($row['request'], true);
            $decision['by'] = 'staff';
            check($repair->execute(array(json_encode($decision), $row['id'])));
        }
        check($db->trans_commit());
    }
    $model->run(new AccountGraph($argv[5], 'synthetic-test'));
    $rows = $db->sqlite->query('SELECT id, item_key, depends_on, state, answer FROM host_account_graph_outbox ORDER BY id')->fetchAll(PDO::FETCH_ASSOC);
    echo json_encode($rows);
    exit(0);
}
$graph = new FixtureGraph('http://127.0.0.1', 'synthetic-test');
$entry = array('type' => 'profile', 'key' => 'key-17', 'subject' => 'contact:17', 'at' => 1700000000000, 'facts' => array('email' => 'row17@example.org'));
$request = array('entries' => array($entry));
$db->trans_begin();
check($model->enqueue('contact:17', 'record', $request) == 1);
$db->trans_rollback();
check($db->sqlite->query('SELECT COUNT(*) FROM host_account_graph_outbox')->fetchColumn() == 0);
$db->trans_begin();
check($model->enqueue('contact:17', 'record', $request) == 1);
$db->trans_commit();
$db->trans_begin();
try {
    $model->enqueue('contact:17', 'record', $request, '9999');
    throw new LogicException('Expected a missing prerequisite to be refused');
} catch (InvalidArgumentException $expected) {}
$db->trans_rollback();
check($db->inserts === 2);
check(strpos(implode(' ', $db->queries), 'row17@example.org') === false);
$db->failFinish = true;
try {
    $model->run($graph);
    throw new LogicException('A failed database update went unnoticed');
} catch (RuntimeException $expected) {}
check(!$db->trans_active());
check($db->sqlite->query('SELECT state FROM host_account_graph_outbox')->fetchColumn() === 'pending');
$db->failFinish = false;
check($model->run($graph)['sent'] === 1);
$row = $db->sqlite->query('SELECT * FROM host_account_graph_outbox')->fetch(PDO::FETCH_ASSOC);
check($row['request'] === null && $row['item_kind'] === 'profile' && $row['item_key'] === 'key-17' && $row['created_at']);
check($db->sqlite->getAttribute(PDO::ATTR_ERRMODE) === PDO::ERRMODE_SILENT);

function checkDroppedFacts($enqueue, $entry)
{
    $dropped = array('previous' => 'old');
    $unusable = $entry;
    $unusable['facts'] = array('phone' => '555-0100', 'private-field@example.org' => 'secret body');
    $unusable['speaker'] = array('email' => 'invalid@', 'private-field@example.org' => 'secret body');
    check($enqueue($unusable, $dropped) === false);
    check($dropped['facts.phone'] === 'Expected a usable phone number of at most 64 characters.');
    check($dropped['facts.*'] === 'Unknown field.' && $dropped['profile'] === 'No usable subject identifier or speaker.');
    check(isset($dropped['speaker.email']) && $dropped['speaker.*'] === 'Unknown field.');
    $report = json_encode($dropped);
    foreach (array('555-0100', 'private-field@example.org', 'secret body', 'invalid@', 'previous') as $secret) {
        check(strpos($report, $secret) === false);
    }
    $empty = $entry;
    $empty['facts'] = array();
    check($enqueue($empty, $dropped) === false && array_keys($dropped) === array('profile'));
    $empty['speaker'] = 'private';
    check($enqueue($empty, $dropped) === false && $dropped['speaker'] === 'Expected an object.');
    unset($empty['speaker']);
    $empty['facts'] = array('name' => array('first' => 'Test', 'last' => 'Record'));
    check($enqueue($empty, $dropped) === false && isset($dropped['facts.name'], $dropped['profile']));

    $mixed = $entry;
    $mixed['facts']['address'] = array('street' => 'Example Street', 'private-field@example.org' => 'private', 'state' => array('private'));
    $mixed['facts']['identifiers'] = array('private-field@example.org' => 'invalid', 'other' => 'hardware:example');
    $mixed['facts']['dob'] = '2001-02-29';
    $mixed['speaker'] = array('phone' => '+12025550142', 'device' => 'invalid device');
    check($enqueue($mixed, $dropped) !== false);
    check(isset($dropped['facts.address.*'], $dropped['facts.address.state'], $dropped['facts.identifiers[]'], $dropped['facts.dob'], $dropped['speaker.device']));
    check(!isset($dropped['profile'], $dropped['facts.email'], $dropped['speaker.phone']));
    $report = json_encode($dropped);
    foreach (array('private', 'row17@example.org', '+12025550142', '2001-02-29', 'invalid device') as $secret) {
        check(strpos($report, $secret) === false);
    }
    check($enqueue($entry, $dropped) !== false && $dropped === array());
}

$db->trans_begin();
checkDroppedFacts(function ($profile, &$dropped) use ($model) {
    return $model->enqueue('contact:17', 'record', array('entries' => array($profile)), null, $dropped);
}, $entry);
$db->trans_rollback();

// The standalone producer uses the same screening and a fresh diagnostics map per enqueue.
$db->sqlite->exec('ALTER TABLE host_account_graph_outbox RENAME TO account_graph_outbox');
$db->trans_begin();
checkDroppedFacts(function ($profile, &$dropped) use ($db) {
    return AccountGraphOutbox::enqueue($db->sqlite, 'contact:17', 'record', array('entries' => array($profile)), null, $dropped);
}, $entry);
$db->trans_rollback();
echo 'ok';
