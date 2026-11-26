<?php

require __DIR__ . '/../../../examples/php/AccountGraph.php';

$task = json_decode($argv[1], true);

function exercise($task)
{
    $client = new AccountGraph($task['url'], $task['token'], 500, $task['timeout'] ?? 30000, $task['attempts'] ?? 3);
    $method = $task['method'];
    $request = $task['request'];
    if ($method === 'configure') {
        return true;
    }
    if ($method === 'key') {
        return AccountGraph::key($request[0], $request[1], $request[2]);
    }
    if ($method === 'screen') {
        return AccountGraphOutbox::row($request['subject'], 'record', array('entries' => array($request)));
    }
    if (in_array($method, array('seed', 'work', 'repair', 'overlap', 'purge', 'missingDependency', 'savedAnswer'), true)) {
        $db = new PDO('sqlite:' . $task['database'], null, null, array(PDO::ATTR_ERRMODE => PDO::ERRMODE_SILENT));
        if ($method === 'seed') {
            $db->exec("CREATE TABLE account_graph_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, record_id TEXT NOT NULL, call_name TEXT NOT NULL, item_key TEXT NOT NULL, item_kind TEXT NOT NULL, request TEXT, state TEXT NOT NULL DEFAULT 'pending', answer TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, depends_on INTEGER)");
            $db->beginTransaction();
            AccountGraphOutbox::enqueue($db, 'rollback', 'record', array('entries' => array(array('type' => 'arrival', 'subject' => 'rollback', 'at' => 1, 'key' => 'rollback'))));
            $db->rollBack();
            $db->beginTransaction();
            $ids = array();
            foreach ($request as $entry) {
                $group = $entry['_group'] ?? $entry['subject'];
                $parent = isset($entry['_depends']) ? $ids[$entry['_depends']] : null;
                unset($entry['_group'], $entry['_depends']);
                $ids[] = AccountGraphOutbox::enqueue($db, $group, 'record', array('entries' => array($entry)), $parent);
            }
            $db->commit();
        } elseif ($method === 'savedAnswer') {
            $update = $db->prepare("UPDATE account_graph_outbox SET answer = ? WHERE id = ? AND state = 'pending'");
            if (!$update->execute(array(json_encode($request['answer']), $request['id'])) || $update->rowCount() !== 1) {
                throw new RuntimeException('The test expected a pending outbox row');
            }
        } elseif ($method === 'purge') {
            $delete = $db->prepare("DELETE FROM account_graph_outbox WHERE item_key = ? AND state = 'sent'");
            $delete->execute(array($request['key']));
        } elseif ($method === 'missingDependency') {
            $db->beginTransaction();
            try {
                AccountGraphOutbox::enqueue($db, 'contact:probe', 'record', array('entries' => array($request['entry'])), $request['id']);
                return false;
            } catch (InvalidArgumentException $error) {
                return true;
            } finally {
                $db->rollBack();
            }
        } elseif ($method === 'repair') {
            $update = $db->prepare("UPDATE account_graph_outbox SET request = ?, state = 'pending' WHERE item_key = ? AND state = 'failed'");
            $update->execute(array(json_encode(array('entries' => array($request))), $request['key']));
        } elseif ($method === 'overlap') {
            $other = new PDO('sqlite:' . $task['database'], null, null, array(PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION));
            $repair = function () use ($other, $client, $request) {
                $update = $other->prepare("UPDATE account_graph_outbox SET state = 'pending', request = ? WHERE item_key = ? AND state = 'failed'");
                $update->execute(array(json_encode(array('entries' => array($request))), $request['key']));
                AccountGraphOutbox::run($other, $client, 1);
            };
            $store = new class($db, $repair) extends AccountGraphOutboxPDO {
                private $repair;
                public function __construct($db, $repair)
                {
                    parent::__construct($db);
                    $this->repair = $repair;
                }
                public function begin()
                {
                    // The other worker commits the prerequisite after selection, before this worker claims its row.
                    if ($this->repair) {
                        $repair = $this->repair;
                        $this->repair = null;
                        $repair();
                    }
                    parent::begin();
                }
            };
            AccountGraphOutbox::work($store, $client, 1);
        } else {
            AccountGraphOutbox::run($db, $client, $request['limit'] ?? 100);
        }
        $rows = $db->query('SELECT id, state, answer, request, item_key, item_kind, created_at, depends_on FROM account_graph_outbox ORDER BY id')->fetchAll(PDO::FETCH_ASSOC);
        foreach ($rows as &$row) {
            if ($row['answer'] !== null) {
                $row['answer'] = json_decode($row['answer'], true);
            }
        }
        return $rows;
    }
    $answer = $client->$method($request);
    return $answer instanceof Traversable ? iterator_to_array($answer, false) : $answer;
}

try {
    echo json_encode(exercise($task));
} catch (AccountGraphFault $fault) {
    echo json_encode(array('fault' => $fault->faultCode, 'retryable' => $fault->retryable, 'detail' => $fault->detail));
}
