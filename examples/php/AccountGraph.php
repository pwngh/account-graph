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
    const MAX_RETRY_AFTER_SECONDS = 900;

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

    public function __construct(
        $baseUrl,
        #[\SensitiveParameter]
        $token,
        $connectMs = 1000,
        $timeoutMs = 35000,
        $attempts = 3
    ) {
        // PHP 7 treats the attribute as a comment. Clear the argument before validation can throw.
        $this->token = $token;
        unset($token);
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
        if (!is_string($this->token) || !preg_match('/^[\x21-\x7e]+$/D', $this->token) || !is_int($connectMs) || $connectMs < 1 || !is_int($timeoutMs) || $timeoutMs < 1 || !is_int($attempts) || $attempts < 1 || $attempts > 5) {
            throw new AccountGraphFault('CONFIG.INVALID');
        }
        $this->host = !$this->https && $host === 'localhost' ? '127.0.0.1' : $host;
        $this->port = isset($url['port']) ? $url['port'] : ($this->https ? 443 : 80);
        $this->origin = $scheme . '://' . $this->host . ':' . $this->port;
        $this->path = rtrim(isset($url['path']) ? $url['path'] : '', '/') . '/v1/';
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
            $delayMs = 50 * (1 << ($attempt - 1));
            $response = null;
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
                if (isset($response[2]) && $response[2] !== '') {
                    $fault->detail['retryAfter'] = $response[2];
                }
                if (!$fault->retryable || $attempt === $this->attempts) {
                    throw $fault;
                }
                $until = self::retryAt($fault->detail['retryAfter'] ?? null);
                if ($until !== null) {
                    $requestedMs = ceil(($until - microtime(true)) * 1000);
                    // A later worker pass can honor a long wait without tying up a PHP process.
                    if ($requestedMs > 5000) {
                        throw $fault;
                    }
                    $delayMs = max($delayMs, (int) max(0, $requestedMs));
                }
            }
            // Some older platforms accept only sub-second arguments to usleep.
            $wake = microtime(true) + $delayMs / 1000;
            while (($remaining = $wake - microtime(true)) > 0) {
                usleep((int) min(999999, ceil($remaining * 1000000)));
            }
        }
    }

    public static function retryAt($hint)
    {
        if (!is_string($hint) || $hint === '') {
            return null;
        }
        $now = microtime(true);
        if (preg_match('/^[0-9]+$/D', $hint)) {
            return $now + min(self::MAX_RETRY_AFTER_SECONDS, (float) $hint);
        }
        if (strlen($hint) > 40 || preg_match('/[^\x20-\x7e]/', $hint)) {
            return null;
        }
        $utc = new DateTimeZone('UTC');
        foreach (array('D, d M Y H:i:s \G\M\T', 'l, d-M-y H:i:s \G\M\T', 'D M j H:i:s Y') as $format) {
            $date = DateTimeImmutable::createFromFormat('!' . $format, $hint, $utc);
            $errors = DateTimeImmutable::getLastErrors();
            if ($date && (!$errors || (!$errors['warning_count'] && !$errors['error_count']))) {
                // format('U') works beyond the signed integer range on 32-bit PHP.
                return min($now + self::MAX_RETRY_AFTER_SECONDS, (float) $date->format('U'));
            }
        }
        return null;
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
                CURLOPT_NOSIGNAL => true,
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
                $error = curl_errno($curl);
                if (in_array($error, array(CURLE_SSL_CONNECT_ERROR, CURLE_SSL_PEER_CERTIFICATE, CURLE_SSL_CACERT, CURLE_SSL_CERTPROBLEM, CURLE_SSL_CIPHER), true)
                    || (defined('CURLE_SSL_CACERT_BADFILE') && $error === CURLE_SSL_CACERT_BADFILE)) {
                    throw new AccountGraphFault('CONFIG.INVALID', false, array('stage' => 'tls'));
                }
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
        $tlsFailure = false;
        if ($this->https) {
            // PHP streams expose certificate and protocol failures as warnings, with the same errno as a handshake timeout.
            set_error_handler(function ($severity, $warning) use (&$tlsFailure) {
                if (preg_match('/^stream_socket_client\(\): (?:SSL operation failed|Peer certificate|Could not verify peer|failed loading cafile|Unable to set verify locations)/i', $warning)) {
                    $tlsFailure = true;
                }
                return true;
            }, E_WARNING);
        }
        try {
            $stream = @stream_socket_client($address, $errno, $error, $this->connectMs / 1000, STREAM_CLIENT_CONNECT, $context);
        } finally {
            if ($this->https) {
                restore_error_handler();
            }
        }
        if (!$stream) {
            if ($tlsFailure || ($this->https && !in_array('tls', stream_get_transports(), true))) {
                throw new AccountGraphFault('CONFIG.INVALID', false, array('stage' => 'tls'));
            }
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
    // The host's query builder can insert this same row on the connection that changed the contact.
    public static function row($recordId, $call, array $request, $dependsOn = null, &$dropped = null)
    {
        $dropped = array();
        if (!is_string($recordId) || $recordId === '' || strlen($recordId) > 200 || !in_array($call, array('record', 'decide', 'forget'), true)) {
            throw new InvalidArgumentException('A record ID and a write call are required');
        }
        if ($dependsOn !== null && ((!is_string($dependsOn) && !is_int($dependsOn)) || !preg_match('/^[1-9][0-9]*$/D', (string) $dependsOn))) {
            throw new InvalidArgumentException('A prerequisite must be an existing outbox row ID');
        }
        $write = $request;
        $kind = $call;
        if ($call === 'record') {
            if (!isset($request['entries'][0]) || !is_array($request['entries']) || count($request['entries']) !== 1) {
                throw new InvalidArgumentException('Enqueue one record entry per row');
            }
            $write = (array) $request['entries'][0];
            $kind = $write['type'] ?? '';
            if (!in_array($kind, array('profile', 'arrival', 'cost', 'conversion', 'restatement', 'payment', 'call', 'call_update', 'text', 'consent', 'link', 'transfer'), true)) {
                throw new InvalidArgumentException('Unknown record entry type');
            }
        }
        if (!isset($write['key'], $write['at']) || !self::text($write['key'], 200)) {
            throw new InvalidArgumentException('Store the original key and at with each write');
        }
        if ($kind === 'profile') {
            $facts = self::facts(array_key_exists('facts', $write) ? $write['facts'] : array(), false, $dropped);
            $speaker = array_key_exists('speaker', $write) ? self::facts($write['speaker'], true, $dropped) : array();
            if (!$speaker && (!$facts || array_keys($facts) === array('name'))) {
                if (isset($facts['name'])) {
                    $dropped['facts.name'] = 'A name needs another usable fact or a speaker.';
                }
                $dropped['profile'] = 'No usable subject identifier or speaker.';
                return null;
            }
            $write['facts'] = (object) $facts;
            unset($write['speaker']);
            if ($speaker) {
                $write['speaker'] = (object) $speaker;
            }
            $request['entries'] = array($write);
        }
        return array('record_id' => $recordId, 'call_name' => $call, 'item_kind' => $kind, 'item_key' => $write['key'],
            'request' => AccountGraph::json((object) $request), 'state' => 'pending', 'depends_on' => $dependsOn);
    }

    private static function text($value, $limit)
    {
        if (!is_string($value) || $value === '' || strlen($value) > $limit * 4 || strpos($value, "\0") !== false) {
            return false;
        }
        // The wire limit counts UTF-16 units. Each character outside the BMP takes two.
        $chars = preg_match_all('/./us', $value);
        return $chars !== false && $chars + preg_match_all('/[\x{10000}-\x{10ffff}]/u', $value) <= $limit;
    }

    private static function droppedFields(array $input, array $kept, array $reasons, $path, array &$dropped)
    {
        foreach (array_keys($input) as $key) {
            if (!isset($reasons[$key])) {
                // Unknown keys can themselves be email addresses or other contact data.
                $dropped[$path . '.*'] = 'Unknown field.';
            } elseif (!array_key_exists($key, $kept)) {
                $dropped[$path . '.' . $key] = $reasons[$key];
            }
        }
    }

    private static function facts($given, $speaker, array &$dropped)
    {
        $path = $speaker ? 'speaker' : 'facts';
        if (!is_array($given) && !is_object($given)) {
            $dropped[$path] = 'Expected an object.';
            return array();
        }
        $fields = (array) $given;
        $facts = array();
        $reasons = array(
            'email' => 'Expected an email address of at most 512 characters with a local part and domain.',
            'phone' => 'Expected a usable phone number of at most 64 characters.',
            'device' => 'Expected 1 to 128 letters, digits, dots, dashes or underscores.'
        );
        $email = $fields['email'] ?? null;
        if (self::text($email, 512)) {
            $trimmed = preg_replace('/^[\s\x{feff}]+|[\s\x{feff}]+$/u', '', $email);
            $at = strrpos($trimmed, '@');
            if ($at !== false && $at > 0 && $at < strlen($trimmed) - 1) {
                $facts['email'] = $email;
            }
        }
        $phone = $fields['phone'] ?? null;
        if (self::text($phone, 64) && self::phone($phone)) {
            $facts['phone'] = $phone;
        }
        if (isset($fields['device']) && is_string($fields['device']) && preg_match('/^[a-zA-Z0-9_.-]{1,128}$/D', $fields['device'])) {
            $facts['device'] = $fields['device'];
        }
        if ($speaker) {
            self::droppedFields($fields, $facts, $reasons, $path, $dropped);
            if (!$fields) {
                $dropped['speaker'] = 'A speaker needs a device, phone or email.';
            }
            return $facts;
        }
        $reasons += array(
            'ip' => 'Expected an IPv4 or IPv6 address of at most 64 characters.',
            'name' => 'A name needs both a usable first and last name.',
            'dob' => 'Expected a valid calendar date in YYYY-MM-DD format.',
            'address' => 'An address needs a nonblank street of at most 2048 characters.',
            'identifiers' => 'Expected a list containing at least one usable identifier.'
        );
        if (self::text($fields['ip'] ?? null, 64) && @inet_pton(trim($fields['ip'])) !== false) {
            $facts['ip'] = $fields['ip'];
        }
        $name = (array) ($fields['name'] ?? array());
        $parts = array();
        $nameFields = array('first' => 'Expected text of 1 to 200 characters.', 'last' => 'Expected text of 1 to 200 characters.');
        foreach ($nameFields as $field => $reason) {
            if (self::text($name[$field] ?? null, 200)) {
                $parts[$field] = $name[$field];
            }
        }
        if (count($parts) === 2) {
            $facts['name'] = $parts;
        }
        if (is_array($fields['name'] ?? null) || is_object($fields['name'] ?? null)) {
            self::droppedFields($name, $parts, $nameFields, 'facts.name', $dropped);
        }
        $dob = $fields['dob'] ?? null;
        if (is_string($dob) && preg_match('/^([0-9]{4})-([0-9]{2})-([0-9]{2})$/D', $dob, $parts)
            && checkdate((int) $parts[2], (int) $parts[3], (int) $parts[1])) {
            $facts['dob'] = $dob;
        }
        $address = (array) ($fields['address'] ?? array());
        $parts = array();
        $addressFields = array();
        foreach (array('street' => 2048, 'street2' => 2048, 'secondary' => 200, 'city' => 200, 'state' => 200, 'zipcode' => 200) as $field => $limit) {
            $addressFields[$field] = $field === 'street' ? $reasons['address'] : 'Expected text of 1 to ' . $limit . ' characters.';
            if (self::text($address[$field] ?? null, $limit) && ($field !== 'street' || trim($address[$field]) !== '')) {
                $parts[$field] = $address[$field];
            }
        }
        if (isset($parts['street'])) {
            $facts['address'] = $parts;
        }
        if (is_array($fields['address'] ?? null) || is_object($fields['address'] ?? null)) {
            self::droppedFields($address, $parts, $addressFields, 'facts.address', $dropped);
        }
        if (isset($fields['identifiers']) && is_array($fields['identifiers'])) {
            foreach ($fields['identifiers'] as $id) {
                if (isset($facts['identifiers']) && count($facts['identifiers']) === 100) {
                    $dropped['facts.identifiers'] = 'Only the first 100 usable identifiers can be queued.';
                    break;
                }
                if (is_string($id) && strlen($id) <= 1024 && strpos($id, "\0") === false && preg_match('/^[^:]+:\s*\S/us', $id)) {
                    $facts['identifiers'][] = $id;
                } else {
                    $dropped['facts.identifiers[]'] = 'Expected a kind:value identifier of at most 1024 bytes.';
                }
            }
        }
        self::droppedFields($fields, $facts, $reasons, $path, $dropped);
        return $facts;
    }

    private static function phone($phone)
    {
        // Keep the provider's spelling. An extension is never part of the line's digit count.
        $parts = preg_split('/(?<=[0-9)])[\s.,\/;(-]*(?:extensi(?:[oó]|o\x{0301})n|extn?|anexo|interno|int|postd)(?!\p{L})[\s.:(=#-]*[0-9]+(?![\p{L}0-9])/iu', $phone, 2);
        $line = $parts ? $parts[0] : $phone;
        $international = preg_match('/^[\s\x{feff}]*\+/u', $line);
        preg_match_all('/(?<=[0-9)])[\s.\/(-]*(?:x|#|[,;]+|[pw](?=[0-9]))[\s.:(=#-]*(?=[0-9]{1,7}(?![\p{L}0-9]|[\s.()-]*[0-9]{3}))/iu', $line, $marks, PREG_OFFSET_CAPTURE);
        foreach ($marks[0] as $mark) {
            $prefix = substr($line, 0, $mark[1]);
            $digits = strlen(preg_replace('/[^0-9]/', '', $prefix));
            if ($digits >= 10 && $digits <= ($international ? 15 : 11)) {
                $line = $prefix;
                break;
            }
        }
        $digits = strlen(preg_replace('/[^0-9]/', '', $line));
        return $international ? $digits >= 8 && $digits <= 15 : $digits === 10 || $digits === 11;
    }

    public static function enqueue(PDO $db, $recordId, $call, array $request, $dependsOn = null, &$dropped = null)
    {
        $dropped = array();
        if (!$db->inTransaction()) {
            throw new LogicException('Enqueue on the host transaction connection');
        }
        $row = self::row($recordId, $call, $request, $dependsOn, $dropped);
        if (!$row) {
            return false;
        }
        $store = new AccountGraphOutboxPDO($db);
        if ($dependsOn !== null && !$store->one('SELECT id FROM account_graph_outbox WHERE id = ?', array($dependsOn))) {
            throw new InvalidArgumentException('The prerequisite outbox row does not exist');
        }
        $sql = 'INSERT INTO account_graph_outbox (' . implode(', ', array_keys($row)) . ') VALUES (?, ?, ?, ?, ?, ?, ?)';
        if ($db->getAttribute(PDO::ATTR_DRIVER_NAME) === 'pgsql') {
            return (string) $store->one($sql . ' RETURNING id', array_values($row))['id'];
        }
        $store->execute($sql, array_values($row));
        return (string) $db->lastInsertId();
    }

    public static function run(PDO $db, AccountGraph $graph, $limit = 100)
    {
        if ($db->inTransaction()) {
            throw new LogicException('Run the worker on an idle connection');
        }
        return self::work(new AccountGraphOutboxPDO($db), $graph, $limit);
    }

    public static function work($store, AccountGraph $graph, $limit = 100)
    {
        if (!is_int($limit) || $limit < 1) {
            throw new InvalidArgumentException('The worker limit must be a positive integer');
        }
        $counts = array('sent' => 0, 'refused' => 0, 'failed' => 0, 'blocked' => 0, 'pending' => 0);
        $table = 'account_graph_outbox';
        // A parked dependency blocks its descendants. A repaired prerequisite makes its children eligible again.
        $earlier = "FROM $table older LEFT JOIN $table parent ON parent.id = older.depends_on
            WHERE older.record_id = j.record_id AND older.id < j.id AND (older.state IN ('pending','sending')
                OR (older.state = 'blocked' AND (parent.id IS NULL OR parent.state = 'sent')))";
        $next = "SELECT j.id, j.state FROM $table j LEFT JOIN $table p ON p.id = j.depends_on
            WHERE j.id > ? AND (j.state = 'pending' OR (j.state = 'blocked' AND (p.id IS NULL OR p.state = 'sent')))
            AND NOT EXISTS (SELECT 1 $earlier) ORDER BY j.id LIMIT 1";
        $claimed = "SELECT j.call_name, j.request, j.answer, j.depends_on, p.state AS parent_state,
            (SELECT MIN(older.id) - 1 $earlier) AS restart_after FROM $table j LEFT JOIN $table p ON p.id = j.depends_on WHERE j.id = ?";
        $id = 0;
        $processed = 0;
        while ($processed < $limit) {
            $row = $store->one($next, array($id));
            if (!$row) {
                break;
            }
            $id = $row['id'];
            $store->begin();
            try {
                // A crash rolls back the claim, so the next worker retries the original key.
                if (!$store->execute("UPDATE $table SET state = 'sending' WHERE id = ? AND state = ?", array($id, $row['state']))) {
                    $store->rollback();
                    continue;
                }
                $job = $store->one($claimed, array($id));
                if ($job['restart_after'] !== null) {
                    // A concurrent repair can make an older row ready between selection and claim.
                    $id = $job['restart_after'];
                    $store->rollback();
                    continue;
                }
                $stop = false;
                $last = json_decode($job['answer'] ?? '', true);
                $now = microtime(true);
                // Enqueue checked the prerequisite. Retention only deletes sent rows.
                if ($job['parent_state'] !== null && $job['parent_state'] !== 'sent') {
                    // An in-flight prerequisite still protects its group's order until it has an answer.
                    $park = in_array($job['parent_state'], array('failed', 'refused', 'blocked'), true);
                    $state = $park ? 'blocked' : 'pending';
                    $answer = array('depends_on' => $job['depends_on']);
                    if ($park) {
                        $processed++;
                    }
                } elseif (is_numeric($last['retry_at'] ?? null) && $last['retry_at'] > $now) {
                    // Persist the absolute cap once for rows written by older workers. Leave the send budget for ready groups.
                    $state = 'pending';
                    $answer = $last;
                    $answer['retry_at'] = min((float) $last['retry_at'], $now + AccountGraph::MAX_RETRY_AFTER_SECONDS);
                } else {
                    list($state, $answer, $stop) = self::send($graph, $job);
                    $processed++;
                }
                $finish = "UPDATE $table SET state = ?, answer = ?" . ($state === 'sent' ? ', request = NULL' : '') . ' WHERE id = ?';
                $store->execute($finish, array($state, AccountGraph::json($answer), $id));
                $store->commit();
            } catch (Throwable $error) {
                $store->rollback();
                throw $error;
            }
            $counts[$state]++;
            if ($stop) {
                break;
            }
        }
        return $counts;
    }

    private static function send(AccountGraph $graph, array $job)
    {
        try {
            $request = json_decode($job['request'] ?? '');
            $call = $job['call_name'];
            if (!is_object($request) || !in_array($call, array('record', 'decide', 'forget'), true)) {
                throw new AccountGraphFault('INPUT.MALFORMED');
            }
            $answer = $graph->$call((array) $request);
            $decision = $call === 'record' ? $answer['results'][0] : $answer;
            $state = $decision['ok'] ? 'sent' : ($decision['reason'] === 'NOT_ATTEMPTED' ? 'pending' : 'refused');
            return array($state, $answer, false);
        } catch (AccountGraphFault $fault) {
            $answer = array('fault' => array('code' => $fault->faultCode, 'retryable' => $fault->retryable, 'detail' => $fault->detail));
            if (in_array($fault->faultCode, array('INPUT.MALFORMED', 'INPUT.TOO_LARGE'), true)) {
                return array('failed', $answer, false);
            }
            if (isset($fault->detail['retryAfter'])) {
                $retryAt = AccountGraph::retryAt($fault->detail['retryAfter']);
                if ($retryAt !== null) {
                    $answer['retry_at'] = $retryAt;
                }
            }
            return array('pending', $answer, true);
        }
    }
}

class AccountGraphOutboxPDO
{
    private $db;

    public function __construct(PDO $db)
    {
        $this->db = $db;
    }

    private function query($sql, array $args)
    {
        $query = @$this->db->prepare($sql);
        if (!$query || !@$query->execute($args)) {
            throw new RuntimeException('Outbox query failed');
        }
        return $query;
    }

    public function one($sql, array $args)
    {
        $query = $this->query($sql, $args);
        $row = $query->fetch(PDO::FETCH_ASSOC);
        $query->closeCursor();
        return $row ?: null;
    }

    public function execute($sql, array $args)
    {
        return $this->query($sql, $args)->rowCount();
    }

    public function begin()
    {
        if (!@$this->db->beginTransaction()) {
            throw new RuntimeException('Could not start the outbox transaction');
        }
    }

    public function commit()
    {
        if (!@$this->db->commit()) {
            throw new RuntimeException('Could not commit the outbox transaction');
        }
    }

    public function rollback()
    {
        if ($this->db->inTransaction() && !@$this->db->rollBack()) {
            throw new RuntimeException('Could not roll back the outbox transaction');
        }
    }
}
