<?php
/**
 * Calls the account graph over HTTPS from a PHP host, including CodeIgniter 3.
 *
 * Requires PHP 7.2 or later.
 *
 * @filename account_graph_lib.php
 */
require_once __DIR__ . '/account_graph_fault.php';

class account_graph_lib
{
    const MAX_RETRY_AFTER_SECONDS = 900;

    private $origin;
    private $host;
    private $port;
    private $path;
    private $https;
    private $loopback;
    private $token;
    private $connect_ms;
    private $timeout_ms;
    private $attempts;

    /**
     * Configure the authenticated graph endpoint and its request deadlines.
     *
     * 'Base_Url' => '', // required, string, the graph server base URL.
     * --
     * 'Token' => '', // required, string, the service or reviewer token sent as a bearer token.
     * --
     * 'Connect_Timeout_Ms' => 1000, // optional, int, milliseconds allowed to connect per attempt.
     * --
     * 'Timeout_Ms' => 35000, // optional, int, milliseconds allowed for the entire request per attempt.
     * --
     * 'Attempts' => 3, // optional, int, total attempts from one to five, including the first.
     *
     * @param array $config Connection settings.
     *        (e.g. ['Base_Url' => 'https://graph.example.org', 'Token' => getenv('GRAPH_TOKEN')])
     * @return void
     */
    public function __construct(
        #[\SensitiveParameter]
        array $config = []
    ) {
        // PHP 7 treats the attribute as a comment. Remove the config argument before any exception records its trace.
        $base_url = $config['Base_Url'] ?? null;
        $this->token = $config['Token'] ?? null;
        $connect_ms = ( !empty($config['Connect_Timeout_Ms']) ) ? $config['Connect_Timeout_Ms'] : 1000;
        $timeout_ms = ( !empty($config['Timeout_Ms']) ) ? $config['Timeout_Ms'] : 35000;
        $attempts = ( !empty($config['Attempts']) ) ? $config['Attempts'] : 3;
        unset($config);
        if (!is_string($base_url) || $base_url === '') {
            throw new account_graph_fault(['Code' => 'CONFIG.INVALID', 'Message' => 'Base_Url is required.']);
        }
        if (!is_string($this->token) || $this->token === '') {
            throw new account_graph_fault(['Code' => 'CONFIG.INVALID', 'Message' => 'Token is required.']);
        }
        if (!preg_match('/^[\x21-\x7e]+$/D', $this->token) || !is_int($connect_ms) || $connect_ms < 1 || !is_int($timeout_ms) || $timeout_ms < 1 || !is_int($attempts) || $attempts < 1 || $attempts > 5) {
            throw new account_graph_fault(['Code' => 'CONFIG.INVALID']);
        }
        $this->configure_url($base_url);
        $this->connect_ms = min($connect_ms, $timeout_ms);
        $this->timeout_ms = $timeout_ms;
        $this->attempts = $attempts;
    }

    /**
     * Validate the endpoint and select its protocol, host, port and path.
     *
     * @param string $base_url Graph server base URL.
     *        (e.g. 'https://graph.example.org')
     * @return void
     */
    private function configure_url(string $base_url): void
    {
        $url = !preg_match('/[\x00-\x20\x7f\\\\]/', $base_url) ? parse_url($base_url) : false;
        if (!isset($url['scheme'], $url['host']) || isset($url['user']) || isset($url['pass']) || isset($url['query']) || isset($url['fragment'])) {
            throw new account_graph_fault(['Code' => 'CONFIG.INVALID']);
        }
        $scheme = strtolower($url['scheme']);
        $host = strtolower($url['host']);
        $this->https = $scheme === 'https';
        // Use only canonical numeric IPv4, IPv6 loopback or the exact localhost name for plaintext.
        $ipv4 = preg_match('/^127(?:\.(?:0|[1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-5])){3}$/D', $host);
        $ipv6 = substr($host, 0, 1) === '[' && substr($host, -1) === ']' && bin2hex((string) @inet_pton(substr($host, 1, -1))) === '00000000000000000000000000000001';
        $this->loopback = $host === 'localhost' || $ipv4 || $ipv6;
        if (!$this->https && ($scheme !== 'http' || !$this->loopback)) {
            throw new account_graph_fault(['Code' => 'CONFIG.INVALID']);
        }
        $this->host = !$this->https && $host === 'localhost' ? '127.0.0.1' : $host;
        $this->port = isset($url['port']) ? $url['port'] : ($this->https ? 443 : 80);
        $this->origin = $scheme . '://' . $this->host . ':' . $this->port;
        $this->path = rtrim(isset($url['path']) ? $url['path'] : '', '/') . '/v1/';
    }

    /**
     * Derive a stable write key from a host operation, row ID and revision.
     *
     * @param string $source Host and operation prefix.
     *        (e.g. 'contacts.profile')
     * @param int|string $row_id Original host row ID.
     *        (e.g. 42)
     * @param int|string $revision Revision of the host change.
     *        (e.g. 7)
     * @return string The graph key to save with this revision.
     */
    public static function key(string $source, $row_id, $revision): string
    {
        if (!preg_match('/^[a-zA-Z0-9._:-]{1,100}$/D', $source)) {
            throw new InvalidArgumentException('Use a short host and operation name for the key prefix');
        }
        foreach ([$row_id, $revision] as $part) {
            if ((!is_string($part) && !is_int($part)) || (string) $part === '') {
                throw new InvalidArgumentException('A row ID and revision are required');
            }
        }
        // Keep long row IDs and revisions within the graph's key length.
        return 'host:' . $source . ':' . sha1(self::json([(string) $row_id, (string) $revision]));
    }

    /**
     * Validate and return a provider's original call or text ID.
     *
     * @param string $id Provider ID.
     *        (e.g. 'text-21')
     * @return string The unchanged provider ID.
     */
    public static function provider_key(string $id): string
    {
        if (!preg_match('/^[a-zA-Z0-9._-]{1,128}$/D', $id)) {
            throw new InvalidArgumentException('Use the original call or text provider ID');
        }
        return $id;
    }

    /**
     * Encode a request or answer, preserving numeric and JSON object types.
     *
     * @param mixed $value JSON-encodable value.
     *        (e.g. ['subjects' => ['contact:42']])
     * @return string JSON representation.
     */
    public static function json($value): string
    {
        $json = json_encode($value, JSON_PRESERVE_ZERO_FRACTION);
        if ($json === false) {
            throw new account_graph_fault(['Code' => 'INPUT.MALFORMED']);
        }
        return $json;
    }

    /**
     * Record a batch of entries in order.
     *
     * @param array $request Call argument.
     *        (e.g. ['entries' => [['type' => 'arrival', 'key' => 'visit-42', 'at' => 1790000000000, 'subject' => 'contact:42']]])
     * @return array The accepted or refused result for each entry.
     */
    public function record(array $request): array
    {
        return $this->call('record', $request);
    }

    /**
     * Submit a reviewed decision about records or a fact.
     *
     * @param array $request Call argument.
     *        (e.g. ['key' => 'merge-42', 'at' => 1790000000000, 'by' => 'staff', 'action' => 'merge', 'pairs' => [['a' => 'contact:42', 'b' => 'contact:43']]])
     * @return array The accepted decision or its refusal.
     */
    public function decide(array $request): array
    {
        return $this->call('decide', $request);
    }

    /**
     * Submit an approved erasure for the selected subjects.
     *
     * @param array $request Call argument.
     *        (e.g. ['key' => 'erase-42', 'at' => 1790000000000, 'by' => 'staff', 'subjects' => ['contact:42'], 'platforms' => 'report'])
     * @return array The erasure result or its refusal.
     */
    public function forget(array $request): array
    {
        return $this->call('forget', $request);
    }

    /**
     * Read the information requested for a lookup kind.
     *
     * @param array $request Call argument.
     *        (e.g. ['kind' => 'party', 'call' => 'call-42'])
     * @return array|null The lookup value, or null for an absent party or record.
     */
    public function lookup(array $request): ?array
    {
        return $this->call('lookup', $request);
    }

    /**
     * Read one page of a reporting view.
     *
     * @param array $request Call argument.
     *        (e.g. ['kind' => 'deliveries', 'state' => 'pending'])
     * @return array The report value and its asOf time.
     */
    public function report(array $request): array
    {
        return $this->call('report', $request);
    }

    /**
     * Read one event page while retaining future event types for the caller.
     *
     * @param array $request Call argument.
     *        (e.g. ['after' => null, 'limit' => 50])
     * @return array The page of events or a cursor refusal.
     */
    public function events(array $request): array
    {
        $answer = $this->call('events', $request);
        if (isset($answer['value']['events']) && is_array($answer['value']['events'])) {
            $types = ['cluster.changed', 'conversion.failed', 'delivery.paused', 'delivery.late', 'costs.failed', 'feed.quiet', 'callback.overdue', 'audit.head'];
            foreach ($answer['value']['events'] as $i => $event) {
                $type = $event['type'] ?? null;
                if ($type === 'Unrecognized' && array_key_exists('raw', $event)) {
                    continue;
                }
                $seq = $event['seq'] ?? null;
                if (($event['schemaVersion'] ?? null) === 1 && in_array($type, $types, true) && $this->safe_integer($seq) && $this->safe_integer($event['at'] ?? null) && is_array($event['data'] ?? null)) {
                    continue;
                }
                $answer['value']['events'][$i] = ['schemaVersion' => 1, 'seq' => $this->safe_integer($seq) ? $seq : 0, 'type' => 'Unrecognized', 'raw' => $event];
            }
        }
        return $answer;
    }

    /**
     * Check whether a decoded JSON number is an exact graph integer.
     *
     * @param mixed $number Decoded JSON value.
     *        (e.g. 1790000000000)
     * @return bool Whether the value is a safe integer.
     */
    private function safe_integer($number): bool
    {
        // On a 32-bit PHP host even an ordinary epoch millisecond date decodes as a float.
        return (is_int($number) || (is_float($number) && floor($number) === $number)) && abs($number) <= 9007199254740991;
    }

    /**
     * Follow the event cursor until caught up or the server refuses the cursor.
     *
     * @param array $request Call argument.
     *        (e.g. ['after' => null, 'limit' => 50])
     * @return Generator The full answer for each page.
     */
    public function event_pages(array $request): Generator
    {
        do {
            $page = $this->events($request);
            yield $page;
            if (!$page['ok'] || !$page['value']['more']) {
                return;
            }
            $this->check_cursor($page['value']['cursor'], $request['after']);
            $request['after'] = $page['value']['cursor'];
        } while (true);
    }

    /**
     * Follow report cursors while retaining the original report filters.
     *
     * @param array $request Call argument.
     *        (e.g. ['kind' => 'callbacks', 'at' => 1790000000000, 'window' => ['from' => '2026-09-01', 'to' => '2026-09-30', 'timeZone' => 'UTC']])
     * @return Generator Each report page including its asOf time.
     */
    public function report_pages(array $request): Generator
    {
        do {
            $page = $this->report($request);
            yield $page;
            if (!isset($page['value']['next'])) {
                return;
            }
            $this->check_cursor($page['value']['next'], $request['after'] ?? null);
            $request['after'] = $page['value']['next'];
        } while (true);
    }

    /**
     * Follow a journey backwards from the most recent page.
     *
     * @param array $request Call argument.
     *        (e.g. ['kind' => 'journey', 'subject' => 'contact:42'])
     * @return Generator Each journey page including its entries.
     */
    public function journey_pages(array $request): Generator
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
            $this->check_cursor($page['next'], $request['before'] ?? null);
            $request['before'] = $page['next'];
        } while (true);
    }

    /**
     * Fail when the server promises another page without advancing its cursor.
     *
     * @param int|float|string|null $next Cursor returned by the graph.
     *        (e.g. 'epoch.100')
     * @param int|float|string|null $previous Cursor used for the current page.
     *        (e.g. null)
     * @return void
     */
    private function check_cursor($next, $previous): void
    {
        if ($next === null || $next === $previous) {
            throw new account_graph_fault(['Code' => 'GRAPH.INTERNAL']);
        }
    }

    /**
     * Send a call with bounded retries and preserve the order of partially completed batches.
     *
     * @param string $name Graph call name.
     *        (e.g. 'lookup')
     * @param array $request Call argument.
     *        (e.g. ['kind' => 'party', 'call' => 'call-42'])
     * @return array|null The decoded graph answer.
     */
    private function call(string $name, array $request): ?array
    {
        $body = self::json((object) $request);
        // Keep the original JSON types and positions even when only part of a batch needs another turn.
        $entries = $name === 'record' ? (json_decode($body)->entries ?? null) : null;
        $entries = is_array($entries) ? $entries : null;
        $positions = $entries !== null ? array_keys($entries) : [];
        $results = [];
        for ($attempt = 1; ; $attempt++) {
            $delay_ms = 50 * (1 << ($attempt - 1));
            $response = null;
            try {
                $response = function_exists('curl_init') ? $this->curl_post($name, $body) : $this->stream_post($name, $body);
                $answer = $this->answer($name, $response);
                if ($name !== 'record') {
                    return $answer;
                }
                $pending = $this->record_results($answer, $entries, $positions, $results);
                if (!$pending || $attempt === $this->attempts) {
                    ksort($results);
                    return ['results' => $results];
                }
                $positions = $pending;
                $remaining = [];
                foreach ($positions as $position) {
                    $remaining[] = $entries[$position];
                }
                $body = self::json(['entries' => $remaining]);
            } catch (account_graph_fault $fault) {
                $delay_ms = $this->retry_delay($fault, $attempt, $delay_ms, $response);
            }
            $this->sleep_ms($delay_ms);
        }
    }

    /**
     * Collect the results in their original positions and find entries awaiting another attempt.
     *
     * @param array|null $answer Decoded record response.
     *        (e.g. ['results' => [['type' => 'arrival', 'key' => 'visit-42', 'ok' => false, 'reason' => 'NOT_ATTEMPTED']]])
     * @param array|null $entries Original record entries.
     *        (e.g. [(object) ['type' => 'arrival', 'key' => 'visit-42']])
     * @param array $positions Original indices sent in this attempt.
     *        (e.g. [0])
     * @param array $results Results accumulated across attempts.
     *        (e.g. [])
     * @return array Original indices of unattempted entries.
     */
    private function record_results(?array $answer, ?array $entries, array $positions, array &$results): array
    {
        if (!isset($answer['results']) || !is_array($answer['results']) || $entries === null || count($answer['results']) !== count($positions)) {
            throw new account_graph_fault(['Code' => 'TRANSPORT.INDETERMINATE', 'Retryable' => true]);
        }
        $pending = [];
        foreach ($positions as $i => $position) {
            $item = $answer['results'][$i] ?? null;
            $entry = $entries[$position];
            if (!is_array($item) || !$this->is_decision($item) || ($item['key'] ?? null) !== $entry->key || ($item['type'] ?? null) !== $entry->type) {
                throw new account_graph_fault(['Code' => 'TRANSPORT.INDETERMINATE', 'Retryable' => true]);
            }
            $results[$position] = $item;
            if (!$item['ok'] && $item['reason'] === 'NOT_ATTEMPTED') {
                $pending[] = $position;
            }
        }
        return $pending;
    }

    /**
     * Decide whether to retry in this process and how long to wait.
     *
     * @param account_graph_fault $fault Fault from the last attempt.
     *        (e.g. new account_graph_fault(['Code' => 'GRAPH.UNAVAILABLE', 'Retryable' => true]))
     * @param int $attempt Attempt number starting at one.
     *        (e.g. 1)
     * @param int $delay_ms Backoff for this attempt in milliseconds.
     *        (e.g. 50)
     * @param array|null $response Transport status, body and Retry-After header, if received.
     *        (e.g. [503, '', '1'])
     * @return int Milliseconds until the next attempt.
     */
    private function retry_delay(account_graph_fault $fault, int $attempt, int $delay_ms, ?array $response): int
    {
        if (isset($response[2]) && $response[2] !== '') {
            $fault->detail['retryAfter'] = $response[2];
        }
        if (!$fault->retryable || $attempt === $this->attempts) {
            throw $fault;
        }
        $hint = $fault->detail['retryAfter'] ?? null;
        $until = is_string($hint) ? self::retry_at($hint) : null;
        if ($until !== null) {
            $requested_ms = ceil(($until - microtime(true)) * 1000);
            // A later worker pass can honor a long wait without tying up a PHP process.
            if ($requested_ms > 5000) {
                throw $fault;
            }
            $delay_ms = max($delay_ms, (int) max(0, $requested_ms));
        }
        return $delay_ms;
    }

    /**
     * Wait until the backoff period has elapsed.
     *
     * @param int $delay_ms Delay in milliseconds.
     *        (e.g. 50)
     * @return void
     */
    private function sleep_ms(int $delay_ms): void
    {
        // Some older platforms accept only sub-second arguments to usleep.
        $wake = microtime(true) + $delay_ms / 1000;
        while (($remaining = $wake - microtime(true)) > 0) {
            usleep((int) min(999999, ceil($remaining * 1000000)));
        }
    }

    /**
     * Convert a Retry-After header into an absolute Unix time capped at fifteen minutes.
     *
     * @param string|null $hint Header value or null when absent.
     *        (e.g. '120')
     * @return float|null Unix timestamp in seconds, or null for an invalid header.
     */
    public static function retry_at(?string $hint): ?float
    {
        if ($hint === null || $hint === '') {
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
        foreach (['D, d M Y H:i:s \G\M\T', 'l, d-M-y H:i:s \G\M\T', 'D M j H:i:s Y'] as $format) {
            $date = DateTimeImmutable::createFromFormat('!' . $format, $hint, $utc);
            $errors = DateTimeImmutable::getLastErrors();
            if ($date && (!$errors || (!$errors['warning_count'] && !$errors['error_count']))) {
                // format('U') works beyond the signed integer range on 32-bit PHP.
                return min($now + self::MAX_RETRY_AFTER_SECONDS, (float) $date->format('U'));
            }
        }
        return null;
    }

    /**
     * Recognize an accepted item or a refusal with a reason.
     *
     * @param array $item Decoded JSON result.
     *        (e.g. ['ok' => false, 'reason' => 'STALE'])
     * @return bool Whether the item has the decision shape.
     */
    private function is_decision(array $item): bool
    {
        return isset($item['ok']) && ($item['ok'] === true ? isset($item['value']) : ($item['ok'] === false && isset($item['reason']) && is_string($item['reason'])));
    }

    /**
     * Decode a graph response or report its fault.
     *
     * @param string $name Graph call that received the response.
     *        (e.g. 'lookup')
     * @param array $response Transport status, body and Retry-After header.
     *        (e.g. [200, 'null', ''])
     * @return array|null The graph value or refusal.
     */
    private function answer(string $name, array $response): ?array
    {
        [$status, $body, $retry_after] = $response;
        $answer = json_decode($body, true);
        if ($status === 200 && json_last_error() === JSON_ERROR_NONE && (is_array($answer) || ($name === 'lookup' && $answer === null))) {
            if ($name === 'decide' || $name === 'forget') {
                if (!is_array($answer) || !$this->is_decision($answer)) {
                    throw new account_graph_fault(['Code' => 'TRANSPORT.INDETERMINATE', 'Retryable' => true]);
                }
            }
            return $answer;
        }
        $fault = $answer['fault'] ?? null;
        $codes = ['INPUT.MALFORMED', 'INPUT.TOO_LARGE', 'AUTH.REJECTED', 'AUTH.FORBIDDEN', 'CONFIG.UNSUPPORTED', 'CONFIG.MISMATCH', 'CONFIG.INVALID', 'GRAPH.UNAVAILABLE', 'GRAPH.CLOSED', 'GRAPH.INTERNAL', 'TRANSPORT.INDETERMINATE', 'TRANSPORT.ABORTED'];
        if (isset($fault['code']) && in_array($fault['code'], $codes, true)) {
            $retryable = in_array($fault['code'], ['GRAPH.UNAVAILABLE', 'TRANSPORT.INDETERMINATE'], true) && ($fault['retryable'] ?? false) === true;
            throw new account_graph_fault(['Code' => $fault['code'], 'Retryable' => $retryable, 'Detail' => isset($fault['detail']) && is_array($fault['detail']) ? $fault['detail'] : []]);
        }
        $mapped = [401 => 'AUTH.REJECTED', 403 => 'AUTH.FORBIDDEN', 413 => 'INPUT.TOO_LARGE'];
        if (isset($mapped[$status])) {
            throw new account_graph_fault(['Code' => $mapped[$status]]);
        }
        $detail = ['status' => $status];
        if ($status === 429 || $status === 503) {
            if ($retry_after !== '') {
                $detail['retryAfter'] = $retry_after;
            }
            throw new account_graph_fault(['Code' => 'GRAPH.UNAVAILABLE', 'Retryable' => true, 'Detail' => $detail]);
        }
        if ($status === 404 || $status === 405 || ($status >= 300 && $status < 400)) {
            throw new account_graph_fault(['Code' => 'CONFIG.INVALID', 'Detail' => $detail]);
        }
        if ($status === 502 || $status === 504 || ($status >= 200 && $status < 300 && in_array($name, ['record', 'decide', 'forget'], true))) {
            throw new account_graph_fault(['Code' => 'TRANSPORT.INDETERMINATE', 'Retryable' => true]);
        }
        throw new account_graph_fault(['Code' => 'GRAPH.INTERNAL', 'Detail' => $detail]);
    }

    /**
     * Send a JSON request using cURL with connect and total deadlines.
     *
     * @param string $name Graph call name.
     *        (e.g. 'events')
     * @param string $body Encoded request.
     *        (e.g. '{"after":null,"limit":50}')
     * @return array Status, response body and Retry-After header.
     */
    private function curl_post(string $name, string $body): array
    {
        $curl = curl_init($this->origin . $this->path . $name);
        $retry_after = '';
        try {
            $options = [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => $body,
                CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Authorization: Bearer ' . $this->token, 'Expect:'],
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_FOLLOWLOCATION => false,
                CURLOPT_NOSIGNAL => true,
                CURLOPT_CONNECTTIMEOUT_MS => $this->connect_ms,
                CURLOPT_TIMEOUT_MS => $this->timeout_ms,
                CURLOPT_HEADERFUNCTION => function ($handle, string $line) use (&$retry_after): int {
                    if (stripos($line, 'Retry-After:') === 0) {
                        $retry_after = trim(substr($line, 12));
                    }
                    return strlen($line);
                }
            ];
            if ($this->loopback) {
                $options[CURLOPT_NOPROXY] = '*';
            }
            curl_setopt_array($curl, $options);
            $text = curl_exec($curl);
            if ($text === false) {
                $error = curl_errno($curl);
                if (in_array($error, [CURLE_SSL_CONNECT_ERROR, CURLE_SSL_PEER_CERTIFICATE, CURLE_SSL_CACERT, CURLE_SSL_CERTPROBLEM, CURLE_SSL_CIPHER], true)
                    || (defined('CURLE_SSL_CACERT_BADFILE') && $error === CURLE_SSL_CACERT_BADFILE)) {
                    throw new account_graph_fault(['Code' => 'CONFIG.INVALID', 'Detail' => ['stage' => 'tls']]);
                }
                throw new account_graph_fault(['Code' => 'TRANSPORT.INDETERMINATE', 'Retryable' => true]);
            }
            return [curl_getinfo($curl, CURLINFO_HTTP_CODE), $text, $retry_after];
        } finally {
            // PHP 7 uses a resource. PHP 8 releases the handle when it leaves scope.
            if (is_resource($curl)) {
                curl_close($curl);
            }
        }
    }

    /**
     * Send a JSON request using a socket stream with the same deadlines.
     *
     * @param string $name Graph call name.
     *        (e.g. 'events')
     * @param string $body Encoded request.
     *        (e.g. '{"after":null,"limit":50}')
     * @return array Status, response body and Retry-After header.
     */
    private function stream_post(string $name, string $body): array
    {
        $deadline = microtime(true) + $this->timeout_ms / 1000;
        $stream = $this->connect_stream();
        try {
            $this->write_request($stream, $deadline, $name, $body);
            return $this->read_reply($stream, $deadline);
        } finally {
            fclose($stream);
        }
    }

    /**
     * Connect to the configured endpoint and verify the peer for HTTPS.
     *
     * @return resource Connected socket stream.
     */
    private function connect_stream()
    {
        $context = stream_context_create(['ssl' => ['verify_peer' => true, 'verify_peer_name' => true, 'peer_name' => trim($this->host, '[]')]]);
        $address = ($this->https ? 'tls://' : 'tcp://') . $this->host . ':' . $this->port;
        $tls_failure = false;
        if ($this->https) {
            // PHP streams expose certificate and protocol failures as warnings, with the same errno as a handshake timeout.
            set_error_handler(function (int $severity, string $warning) use (&$tls_failure): bool {
                if (preg_match('/^stream_socket_client\(\): (?:SSL operation failed|Peer certificate|Could not verify peer|failed loading cafile|Unable to set verify locations)/i', $warning)) {
                    $tls_failure = true;
                }
                return true;
            }, E_WARNING);
        }
        try {
            $stream = @stream_socket_client($address, $errno, $error, $this->connect_ms / 1000, STREAM_CLIENT_CONNECT, $context);
        } finally {
            if ($this->https) {
                restore_error_handler();
            }
        }
        if (!$stream) {
            if ($tls_failure || ($this->https && !in_array('tls', stream_get_transports(), true))) {
                throw new account_graph_fault(['Code' => 'CONFIG.INVALID', 'Detail' => ['stage' => 'tls']]);
            }
            throw new account_graph_fault(['Code' => 'TRANSPORT.INDETERMINATE', 'Retryable' => true]);
        }
        return $stream;
    }

    /**
     * Write the entire HTTP request before its deadline.
     *
     * @param resource $stream Connected socket.
     *        (e.g. $this->connect_stream())
     * @param float $deadline Absolute Unix time in seconds.
     *        (e.g. microtime(true) + 1)
     * @param string $name Graph call name.
     *        (e.g. 'events')
     * @param string $body Encoded request.
     *        (e.g. '{"after":null,"limit":50}')
     * @return void
     */
    private function write_request($stream, float $deadline, string $name, string $body): void
    {
        // HTTP/1.0 lets the peer frame the reply with Content-Length or close the connection.
        $request = 'POST ' . $this->path . $name . " HTTP/1.0\r\nHost: " . $this->host . ':' . $this->port
            . "\r\nConnection: close\r\nContent-Type: application/json\r\nAuthorization: Bearer " . $this->token
            . "\r\nContent-Length: " . strlen($body) . "\r\n\r\n" . $body;
        stream_set_blocking($stream, false);
        $offset = 0;
        while ($offset < strlen($request)) {
            $this->wait($stream, $deadline, true);
            $count = @fwrite($stream, substr($request, $offset, 16384));
            if ($count === false || feof($stream)) {
                throw new account_graph_fault(['Code' => 'TRANSPORT.INDETERMINATE', 'Retryable' => true]);
            }
            $offset += $count;
        }
    }

    /**
     * Read the HTTP status, headers and framed or close-delimited body.
     *
     * @param resource $stream Connected socket.
     *        (e.g. $this->connect_stream())
     * @param float $deadline Absolute Unix time in seconds.
     *        (e.g. microtime(true) + 1)
     * @return array Status, response body and Retry-After header.
     */
    private function read_reply($stream, float $deadline): array
    {
        $body = '';
        do {
            while (($end = strpos($body, "\r\n\r\n")) === false) {
                if (feof($stream)) {
                    throw new account_graph_fault(['Code' => 'TRANSPORT.INDETERMINATE', 'Retryable' => true]);
                }
                $body .= $this->read_chunk($stream, $deadline);
            }
            $headers = substr($body, 0, $end);
            $body = substr($body, $end + 4);
            if (!preg_match('~^HTTP/1\.[01] ([0-9]{3})\b~', $headers, $status_line)) {
                throw new account_graph_fault(['Code' => 'TRANSPORT.INDETERMINATE', 'Retryable' => true]);
            }
            $status = (int) $status_line[1];
        } while ($status >= 100 && $status < 200 && $status !== 101);

        $length = preg_match('/^Content-Length:[ \t]*([0-9]+)[ \t]*\r?$/im', $headers, $match) ? (int) $match[1] : null;
        // A framed reply is complete even if a peer leaves its connection open.
        while (($length === null || strlen($body) < $length) && !feof($stream)) {
            $body .= $this->read_chunk($stream, $deadline);
        }
        if ($length !== null && strlen($body) !== $length) {
            throw new account_graph_fault(['Code' => 'TRANSPORT.INDETERMINATE', 'Retryable' => true]);
        }
        $retry_after = preg_match('/^Retry-After:[ \t]*([^\r\n]+)/im', $headers, $retry) ? trim($retry[1]) : '';
        return [$status, $body, $retry_after];
    }

    /**
     * Read the next available bytes before the request deadline.
     *
     * @param resource $stream Connected socket.
     *        (e.g. $this->connect_stream())
     * @param float $deadline Absolute Unix time in seconds.
     *        (e.g. microtime(true) + 1)
     * @return string Bytes read from the socket.
     */
    private function read_chunk($stream, float $deadline): string
    {
        $this->wait($stream, $deadline, false);
        $chunk = @fread($stream, 65536);
        if ($chunk === false) {
            throw new account_graph_fault(['Code' => 'TRANSPORT.INDETERMINATE', 'Retryable' => true]);
        }
        return $chunk;
    }

    /**
     * Wait for the socket to become readable or writable within the request deadline.
     *
     * @param resource $stream Connected socket.
     *        (e.g. $this->connect_stream())
     * @param float $deadline Absolute Unix time in seconds.
     *        (e.g. microtime(true) + 1)
     * @param bool $writing Whether to wait for a writable socket.
     *        (e.g. true)
     * @return void
     */
    private function wait($stream, float $deadline, bool $writing): void
    {
        // A slow trickle of bytes must not restart the request timeout.
        $remaining = $deadline - microtime(true);
        $seconds = (int) $remaining;
        $read = $writing ? [] : [$stream];
        $write = $writing ? [$stream] : [];
        $except = null;
        if ($remaining <= 0 || !@stream_select($read, $write, $except, $seconds, (int) (($remaining - $seconds) * 1000000))) {
            throw new account_graph_fault(['Code' => 'TRANSPORT.INDETERMINATE', 'Retryable' => true]);
        }
    }
}
