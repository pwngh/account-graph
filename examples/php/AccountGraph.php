<?php

class AccountGraphFault extends RuntimeException
{
    public $faultCode;
    public $retryable;
    public $detail;

    public function __construct($code, $retryable = false, array $detail = array())
    {
        // A proxy's error page or the server's message can contain input.
        parent::__construct($code);
        $this->faultCode = $code;
        $this->retryable = $retryable;
        $this->detail = $detail;
    }

    public function __toString()
    {
        // Older PHP versions include method arguments in an uncaught exception's trace.
        return 'AccountGraphFault: ' . $this->faultCode;
    }
}

class AccountGraph
{
    private $origin;
    private $host;
    private $port;
    private $path;
    private $https;
    private $loopback;
    private $token;
    private $connectMs;
    private $timeoutMs;
    private $attempts;

    public function __construct($baseUrl, $token, $connectMs = 1000, $timeoutMs = 5000, $attempts = 3)
    {
        $url = is_string($baseUrl) && !preg_match('/[\x00-\x20\x7f\\\\]/', $baseUrl) ? parse_url($baseUrl) : false;
        if (!isset($url['scheme'], $url['host']) || isset($url['user']) || isset($url['pass']) || isset($url['query']) || isset($url['fragment'])) {
            throw new AccountGraphFault('CONFIG.INVALID');
        }
        $scheme = strtolower($url['scheme']);
        $host = strtolower($url['host']);
        $this->https = $scheme === 'https';
        // Use only canonical numeric IPv4, IPv6 loopback or the exact localhost name for plaintext.
        $ipv4 = preg_match('/^127(?:\.(?:0|[1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-5])){3}$/D', $host);
        $ipv6 = substr($host, 0, 1) === '[' && substr($host, -1) === ']' && bin2hex((string) @inet_pton(substr($host, 1, -1))) === '00000000000000000000000000000001';
        $this->loopback = $host === 'localhost' || $ipv4 || $ipv6;
        if (!$this->https && ($scheme !== 'http' || !$this->loopback)) {
            throw new AccountGraphFault('CONFIG.INVALID');
        }
        if (!is_string($token) || !preg_match('/^[\x21-\x7e]+$/D', $token) || !is_int($connectMs) || $connectMs < 1 || !is_int($timeoutMs) || $timeoutMs < 1 || !is_int($attempts) || $attempts < 1 || $attempts > 5) {
            throw new AccountGraphFault('CONFIG.INVALID');
        }
        $this->host = !$this->https && $host === 'localhost' ? '127.0.0.1' : $host;
        $this->port = isset($url['port']) ? $url['port'] : ($this->https ? 443 : 80);
        $this->origin = $scheme . '://' . $this->host . ':' . $this->port;
        $this->path = rtrim(isset($url['path']) ? $url['path'] : '', '/') . '/v1/';
        $this->token = $token;
        $this->connectMs = min($connectMs, $timeoutMs);
        $this->timeoutMs = $timeoutMs;
        $this->attempts = $attempts;
    }

    public static function key($source, $rowId, $revision)
    {
        if (!is_string($source) || !preg_match('/^[a-zA-Z0-9._:-]{1,100}$/D', $source)) {
            throw new InvalidArgumentException('Use a short host and operation name for the key prefix');
        }
        foreach (array($rowId, $revision) as $part) {
            if ((!is_string($part) && !is_int($part)) || (string) $part === '') {
                throw new InvalidArgumentException('A row ID and revision are required');
            }
        }
        // Keep long row IDs and revisions within the graph's key length.
        return 'host:' . $source . ':' . sha1(self::json(array((string) $rowId, (string) $revision)));
    }

    public static function providerKey($id)
    {
        if (!is_string($id) || !preg_match('/^[a-zA-Z0-9._-]{1,128}$/D', $id)) {
            throw new InvalidArgumentException('Use the original call or text provider ID');
        }
        return $id;
    }

    public static function json($value)
    {
        $json = json_encode($value, JSON_PRESERVE_ZERO_FRACTION);
        if ($json === false) {
            throw new AccountGraphFault('INPUT.MALFORMED');
        }
        return $json;
    }

    public function record(array $request) { return $this->call('record', $request); }
    public function decide(array $request) { return $this->call('decide', $request); }
    public function forget(array $request) { return $this->call('forget', $request); }
    public function lookup(array $request) { return $this->call('lookup', $request); }
    public function report(array $request) { return $this->call('report', $request); }
    public function events(array $request)
    {
        $answer = $this->call('events', $request);
        if (isset($answer['value']['events']) && is_array($answer['value']['events'])) {
            $types = array('cluster.changed', 'conversion.failed', 'delivery.paused', 'delivery.late', 'costs.failed', 'feed.quiet', 'callback.overdue', 'audit.head');
            foreach ($answer['value']['events'] as $i => $event) {
                $type = $event['type'] ?? null;
                if ($type === 'Unrecognized' && array_key_exists('raw', $event)) {
                    continue;
                }
                $seq = $event['seq'] ?? null;
                if (($event['schemaVersion'] ?? null) === 1 && in_array($type, $types, true) && $this->safeInteger($seq) && $this->safeInteger($event['at'] ?? null) && is_array($event['data'] ?? null)) {
                    continue;
                }
                $answer['value']['events'][$i] = array('schemaVersion' => 1, 'seq' => $this->safeInteger($seq) ? $seq : 0, 'type' => 'Unrecognized', 'raw' => $event);
            }
        }
        return $answer;
    }

    private function safeInteger($number)
    {
        // On a 32-bit PHP host even an ordinary epoch millisecond date decodes as a float.
        return (is_int($number) || (is_float($number) && floor($number) === $number)) && abs($number) <= 9007199254740991;
    }

    public function eventPages(array $request)
    {
        do {
            $page = $this->events($request);
            yield $page;
            if (!$page['ok'] || !$page['value']['more']) {
                return;
            }
            $request['after'] = $this->nextCursor($page['value']['cursor'], $request['after']);
        } while (true);
    }

    public function reportPages(array $request)
    {
        do {
            $page = $this->report($request);
            yield $page;
            if (!isset($page['value']['next'])) {
                return;
            }
            $request['after'] = $this->nextCursor($page['value']['next'], $request['after'] ?? null);
        } while (true);
    }

    public function journeyPages(array $request)
    {
        if (($request['kind'] ?? null) !== 'journey') {
            throw new InvalidArgumentException('Use a journey lookup');
        }
        do {
            $page = $this->lookup($request);
            yield $page;
            if (!isset($page['next'])) {
                return;
            }
            $request['before'] = $this->nextCursor($page['next'], $request['before'] ?? null);
        } while (true);
    }

    private function nextCursor($next, $previous)
    {
        if ($next === null || $next === $previous) {
            throw new AccountGraphFault('GRAPH.INTERNAL');
        }
        return $next;
    }

    private function call($name, array $request)
    {
        $body = self::json((object) $request);
        // Keep the original JSON types and positions even when only part of a batch needs another turn.
        $entries = $name === 'record' ? (json_decode($body)->entries ?? null) : null;
        $positions = is_array($entries) ? array_keys($entries) : array();
        $results = array();
        for ($attempt = 1; ; $attempt++) {
            try {
                $response = function_exists('curl_init') ? $this->curlPost($name, $body) : $this->streamPost($name, $body);
                $answer = $this->answer($name, $response);
                if ($name !== 'record') {
                    return $answer;
                }
                if (!isset($answer['results']) || !is_array($answer['results']) || !is_array($entries) || count($answer['results']) !== count($positions)) {
                    throw new AccountGraphFault('TRANSPORT.INDETERMINATE', true);
                }
                $pending = array();
                foreach ($positions as $i => $position) {
                    $item = $answer['results'][$i] ?? null;
                    $entry = $entries[$position];
                    if (!$this->isDecision($item) || ($item['key'] ?? null) !== $entry->key || ($item['type'] ?? null) !== $entry->type) {
                        throw new AccountGraphFault('TRANSPORT.INDETERMINATE', true);
                    }
                    $results[$position] = $item;
                    if (!$item['ok'] && $item['reason'] === 'NOT_ATTEMPTED') {
                        $pending[] = $position;
                    }
                }
                if (!$pending || $attempt === $this->attempts) {
                    ksort($results);
                    return array('results' => $results);
                }
                $positions = $pending;
                $remaining = array();
                foreach ($positions as $position) {
                    $remaining[] = $entries[$position];
                }
                $body = self::json(array('entries' => $remaining));
            } catch (AccountGraphFault $fault) {
                if (!$fault->retryable || $attempt === $this->attempts) {
                    throw $fault;
                }
            }
            usleep(50000 * (1 << ($attempt - 1)));
        }
    }

    private function isDecision($item)
    {
        return isset($item['ok']) && ($item['ok'] === true ? isset($item['value']) : ($item['ok'] === false && isset($item['reason']) && is_string($item['reason'])));
    }

    private function answer($name, array $response)
    {
        list($status, $body, $retryAfter) = $response;
        $answer = json_decode($body, true);
        if ($status === 200 && json_last_error() === JSON_ERROR_NONE) {
            if ($name === 'decide' || $name === 'forget') {
                if (!$this->isDecision($answer)) {
                    throw new AccountGraphFault('TRANSPORT.INDETERMINATE', true);
                }
            }
            return $answer;
        }
        $fault = $answer['fault'] ?? null;
        $codes = array('INPUT.MALFORMED', 'INPUT.TOO_LARGE', 'AUTH.REJECTED', 'AUTH.FORBIDDEN', 'CONFIG.UNSUPPORTED', 'CONFIG.MISMATCH', 'CONFIG.INVALID', 'GRAPH.UNAVAILABLE', 'GRAPH.CLOSED', 'GRAPH.INTERNAL', 'TRANSPORT.INDETERMINATE', 'TRANSPORT.ABORTED');
        if (isset($fault['code']) && in_array($fault['code'], $codes, true)) {
            $retryable = in_array($fault['code'], array('GRAPH.UNAVAILABLE', 'TRANSPORT.INDETERMINATE'), true) && ($fault['retryable'] ?? false) === true;
            throw new AccountGraphFault($fault['code'], $retryable, isset($fault['detail']) && is_array($fault['detail']) ? $fault['detail'] : array());
        }
        $mapped = array(401 => 'AUTH.REJECTED', 403 => 'AUTH.FORBIDDEN', 413 => 'INPUT.TOO_LARGE');
        if (isset($mapped[$status])) {
            throw new AccountGraphFault($mapped[$status]);
        }
        $detail = array('status' => $status);
        if ($status === 429 || $status === 503) {
            if ($retryAfter !== '') {
                $detail['retryAfter'] = $retryAfter;
            }
            throw new AccountGraphFault('GRAPH.UNAVAILABLE', true, $detail);
        }
        if ($status === 404 || $status === 405 || ($status >= 300 && $status < 400)) {
            throw new AccountGraphFault('CONFIG.INVALID', false, $detail);
        }
        if ($status === 502 || $status === 504 || ($status >= 200 && $status < 300 && in_array($name, array('record', 'decide', 'forget'), true))) {
            throw new AccountGraphFault('TRANSPORT.INDETERMINATE', true);
        }
        throw new AccountGraphFault('GRAPH.INTERNAL', false, $detail);
    }

    private function curlPost($name, $body)
    {
        $curl = curl_init($this->origin . $this->path . $name);
        $retryAfter = '';
        try {
            $options = array(
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => $body,
                CURLOPT_HTTPHEADER => array('Content-Type: application/json', 'Authorization: Bearer ' . $this->token, 'Expect:'),
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_FOLLOWLOCATION => false,
                CURLOPT_CONNECTTIMEOUT_MS => $this->connectMs,
                CURLOPT_TIMEOUT_MS => $this->timeoutMs,
                CURLOPT_HEADERFUNCTION => function ($handle, $line) use (&$retryAfter) {
                    if (stripos($line, 'Retry-After:') === 0) {
                        $retryAfter = trim(substr($line, 12));
                    }
                    return strlen($line);
                }
            );
            if ($this->loopback) {
                $options[CURLOPT_NOPROXY] = '*';
            }
            curl_setopt_array($curl, $options);
            $text = curl_exec($curl);
            if ($text === false) {
                throw new AccountGraphFault('TRANSPORT.INDETERMINATE', true);
            }
            return array(curl_getinfo($curl, CURLINFO_HTTP_CODE), $text, $retryAfter);
        } finally {
            // PHP 7 uses a resource. PHP 8 releases the handle when it leaves scope.
            if (is_resource($curl)) {
                curl_close($curl);
            }
        }
    }

    private function streamPost($name, $body)
    {
        // HTTP/1.0 lets the peer frame the reply with Content-Length or close the connection.
        $request = 'POST ' . $this->path . $name . " HTTP/1.0\r\nHost: " . $this->host . ':' . $this->port
            . "\r\nConnection: close\r\nContent-Type: application/json\r\nAuthorization: Bearer " . $this->token
            . "\r\nContent-Length: " . strlen($body) . "\r\n\r\n" . $body;
        $context = stream_context_create(array('ssl' => array('verify_peer' => true, 'verify_peer_name' => true, 'peer_name' => trim($this->host, '[]'))));
        $deadline = microtime(true) + $this->timeoutMs / 1000;
        $address = ($this->https ? 'tls://' : 'tcp://') . $this->host . ':' . $this->port;
        $stream = @stream_socket_client($address, $errno, $error, $this->connectMs / 1000, STREAM_CLIENT_CONNECT, $context);
        if (!$stream) {
            throw new AccountGraphFault('TRANSPORT.INDETERMINATE', true);
        }
        try {
            stream_set_blocking($stream, false);
            $offset = 0;
            while ($offset < strlen($request)) {
                $this->wait($stream, $deadline, true);
                $count = @fwrite($stream, substr($request, $offset, 16384));
                if ($count === false || feof($stream)) {
                    throw new AccountGraphFault('TRANSPORT.INDETERMINATE', true);
                }
                $offset += $count;
            }
            $body = '';
            do {
                while (($end = strpos($body, "\r\n\r\n")) === false) {
                    if (feof($stream)) {
                        throw new AccountGraphFault('TRANSPORT.INDETERMINATE', true);
                    }
                    $body .= $this->readChunk($stream, $deadline);
                }
                $headers = substr($body, 0, $end);
                $body = substr($body, $end + 4);
                if (!preg_match('~^HTTP/1\.[01] ([0-9]{3})\b~', $headers, $statusLine)) {
                    throw new AccountGraphFault('TRANSPORT.INDETERMINATE', true);
                }
                $status = (int) $statusLine[1];
            } while ($status >= 100 && $status < 200 && $status !== 101);

            $length = preg_match('/^Content-Length:[ \t]*([0-9]+)[ \t]*\r?$/im', $headers, $match) ? (int) $match[1] : null;
            // A framed reply is complete even if a peer leaves its connection open.
            while (($length === null || strlen($body) < $length) && !feof($stream)) {
                $body .= $this->readChunk($stream, $deadline);
            }
            if ($length !== null && strlen($body) !== $length) {
                throw new AccountGraphFault('TRANSPORT.INDETERMINATE', true);
            }
            $retryAfter = preg_match('/^Retry-After:[ \t]*([^\r\n]+)/im', $headers, $retry) ? trim($retry[1]) : '';
            return array($status, $body, $retryAfter);
        } finally {
            fclose($stream);
        }
    }

    private function readChunk($stream, $deadline)
    {
        $this->wait($stream, $deadline, false);
        $chunk = @fread($stream, 65536);
        if ($chunk === false) {
            throw new AccountGraphFault('TRANSPORT.INDETERMINATE', true);
        }
        return $chunk;
    }

    private function wait($stream, $deadline, $writing)
    {
        // A slow trickle of bytes must not restart the request timeout.
        $remaining = $deadline - microtime(true);
        $seconds = (int) $remaining;
        $read = $writing ? array() : array($stream);
        $write = $writing ? array($stream) : array();
        $except = null;
        if ($remaining <= 0 || !@stream_select($read, $write, $except, $seconds, (int) (($remaining - $seconds) * 1000000))) {
            throw new AccountGraphFault('TRANSPORT.INDETERMINATE', true);
        }
    }
}

class AccountGraphOutbox
{
    public static function enqueue(PDO $db, $recordId, $call, array $request)
    {
        if (!$db->inTransaction() || $db->getAttribute(PDO::ATTR_ERRMODE) !== PDO::ERRMODE_EXCEPTION) {
            throw new LogicException('Enqueue on the host transaction connection in PDO exception mode');
        }
        if (!is_string($recordId) || $recordId === '' || strlen($recordId) > 200 || !in_array($call, array('record', 'decide', 'forget'), true)) {
            throw new InvalidArgumentException('A record ID and a write call are required');
        }
        $body = AccountGraph::json((object) $request);
        $write = json_decode($body);
        if ($call === 'record') {
            if (!isset($write->entries) || !is_array($write->entries) || count($write->entries) !== 1) {
                throw new InvalidArgumentException('Enqueue one record entry per row');
            }
            $write = $write->entries[0];
        }
        if (!isset($write->key, $write->at) || !is_string($write->key) || $write->key === '') {
            throw new InvalidArgumentException('Store the original key and at with each write');
        }
        $insert = $db->prepare('INSERT INTO account_graph_outbox (record_id, call_name, request, state) VALUES (?, ?, ?, ?)');
        $insert->execute(array($recordId, $call, $body, 'pending'));
    }

    public static function run(PDO $db, AccountGraph $graph, $limit = 100)
    {
        if ($db->inTransaction() || $db->getAttribute(PDO::ATTR_ERRMODE) !== PDO::ERRMODE_EXCEPTION) {
            throw new LogicException('Run the worker on an idle connection in PDO exception mode');
        }
        if (!is_int($limit) || $limit < 1) {
            throw new InvalidArgumentException('The worker limit must be a positive integer');
        }
        $counts = array('sent' => 0, 'refused' => 0, 'failed' => 0, 'pending' => 0);
        $next = $db->prepare("SELECT j.id FROM account_graph_outbox j WHERE j.id > ? AND j.state = 'pending'
            AND NOT EXISTS (SELECT 1 FROM account_graph_outbox older WHERE older.record_id = j.record_id AND older.id < j.id AND older.state <> 'sent')
            ORDER BY j.id LIMIT 1");
        $claim = $db->prepare("UPDATE account_graph_outbox SET state = 'sending' WHERE id = ? AND state = 'pending'");
        $read = $db->prepare('SELECT call_name, request FROM account_graph_outbox WHERE id = ?');
        $finish = $db->prepare('UPDATE account_graph_outbox SET state = ?, answer = ? WHERE id = ?');
        $id = 0;
        for ($i = 0; $i < $limit; $i++) {
            $next->execute(array($id));
            $id = $next->fetchColumn();
            $next->closeCursor();
            if ($id === false) {
                break;
            }
            $db->beginTransaction();
            try {
                // Only one worker sends this row. A crash rolls back the claim and leaves the original keys in place.
                $claim->execute(array($id));
                if (!$claim->rowCount()) {
                    $db->rollBack();
                    continue;
                }
                $read->execute(array($id));
                $job = $read->fetch(PDO::FETCH_ASSOC);
                $read->closeCursor();
                $call = $job['call_name'];
                try {
                    $request = json_decode($job['request']);
                    if (!is_object($request) || !in_array($call, array('record', 'decide', 'forget'), true)) {
                        throw new AccountGraphFault('INPUT.MALFORMED');
                    }
                    $answer = $graph->$call((array) $request);
                    $decision = $call === 'record' ? $answer['results'][0] : $answer;
                    $state = $decision['ok'] ? 'sent' : ($decision['reason'] === 'NOT_ATTEMPTED' ? 'pending' : 'refused');
                } catch (AccountGraphFault $fault) {
                    $answer = array('fault' => array('code' => $fault->faultCode, 'retryable' => $fault->retryable, 'detail' => $fault->detail));
                    $state = $fault->retryable ? 'pending' : 'failed';
                }
                $finish->execute(array($state, AccountGraph::json($answer), $id));
                $db->commit();
                $counts[$state]++;
            } catch (Throwable $error) {
                if ($db->inTransaction()) {
                    $db->rollBack();
                }
                throw $error;
            }
        }
        return $counts;
    }
}
