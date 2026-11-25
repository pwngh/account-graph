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
    if ($method === 'seed' || $method === 'work') {
        $db = new PDO('sqlite:' . $task['database'], null, null, array(PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION));
        if ($method === 'seed') {
            $db->exec("CREATE TABLE account_graph_outbox (id INTEGER PRIMARY KEY, record_id TEXT NOT NULL, call_name TEXT NOT NULL, request TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', answer TEXT)");
            $db->beginTransaction();
            AccountGraphOutbox::enqueue($db, 'rollback', 'record', array('entries' => array($request[0])));
            $db->rollBack();
            $db->beginTransaction();
            foreach ($request as $entry) {
                AccountGraphOutbox::enqueue($db, $entry['subject'], 'record', array('entries' => array($entry)));
            }
            $db->commit();
        } else {
            AccountGraphOutbox::run($db, $client);
        }
        $rows = $db->query('SELECT state, answer FROM account_graph_outbox ORDER BY id')->fetchAll(PDO::FETCH_ASSOC);
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
