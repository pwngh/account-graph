<?php
/**
 * Queue graph writes alongside host changes and deliver them in dependency order.
 * Requires PHP 7.2 or later.
 *
 * @filename account_graph_outbox_lib.php
 */

require_once __DIR__ . '/account_graph_lib.php';
require_once __DIR__ . '/account_graph_outbox_pdo.php';

class account_graph_outbox_lib
{
    /**
     * Create the shared outbox library. Pass the host connection to enqueue or run.
     *
     * @param array $config Library settings. This stateless library has no configuration keys.
     *        (e.g. [])
     * @return void
     */
    public function __construct(array $config = [])
    {
        // CI3 supplies a config array. The write itself supplies the host transaction connection.
    }

    /**
     * Build one pending row on the host connection and screen profile fields before storage.
     *
     * @param string $record_id Ordering group in the host.
     *        (e.g. 'contact:42')
     * @param string $call Graph write method.
     *        (e.g. 'record')
     * @param array $request Original write, including its time and stable key.
     *        (e.g. ['entries' => [['type' => 'arrival', 'key' => 'visit-42', 'subject' => 'contact:42', 'at' => 1000]]])
     * @param int|string|null $depends_on Earlier outbox ID that must succeed first.
     *        (e.g. '17')
     * @param array|null $dropped Receives omitted field paths and reasons, without their values.
     *        (e.g. ['facts.email' => 'Expected an email address.'])
     * @return array|null Database columns or null for an unusable profile.
     */
    public static function row(string $record_id, string $call, array $request, $depends_on = null, ?array &$dropped = null): ?array
    {
        $dropped = [];
        if ($record_id === '' || strlen($record_id) > 200 || !in_array($call, ['record', 'decide', 'forget'], true)) {
            throw new InvalidArgumentException('A record ID and a write call are required');
        }
        if ($depends_on !== null && ((!is_int($depends_on) && !is_string($depends_on)) || !preg_match('/^[1-9][0-9]*$/D', (string) $depends_on))) {
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
            if (!in_array($kind, ['profile', 'arrival', 'cost', 'conversion', 'restatement', 'payment', 'call', 'call_update', 'text', 'consent', 'link', 'transfer'], true)) {
                throw new InvalidArgumentException('Unknown record entry type');
            }
        }
        if (!isset($write['key'], $write['at']) || !self::text($write['key'], 200)) {
            throw new InvalidArgumentException('Store the original key and at with each write');
        }
        if ($kind === 'profile') {
            $write = self::profile_entry($write, $dropped);
            if ($write === null) {
                return null;
            }
            $request['entries'] = [$write];
        }
        return ['record_id' => $record_id, 'call_name' => $call, 'item_kind' => $kind, 'item_key' => $write['key'],
            'request' => account_graph_lib::json((object) $request), 'state' => 'pending', 'depends_on' => $depends_on];
    }

    /**
     * Keep useful profile or speaker facts and report dropped fields to the caller.
     *
     * @param array $write Profile entry to prepare.
     *        (e.g. ['type' => 'profile', 'facts' => ['device' => 'desk-42']])
     * @param array $dropped Receives omitted field paths and reasons, without their values.
     *        (e.g. ['facts.email' => 'Expected an email address.'])
     * @return array|null Screened entry or null when nothing remains.
     */
    private static function profile_entry(array $write, array &$dropped): ?array
    {
        $facts = self::facts(array_key_exists('facts', $write) ? $write['facts'] : [], false, $dropped);
        $speaker = array_key_exists('speaker', $write) ? self::facts($write['speaker'], true, $dropped) : [];
        if (!$speaker && (!$facts || array_keys($facts) === ['name'])) {
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
        return $write;
    }

    /**
     * Check the wire length before storing a string.
     *
     * @param mixed $value Value received from host data.
     *        (e.g. 'contact:42')
     * @param int $limit Maximum length in UTF-16 units.
     *        (e.g. 100)
     * @return bool
     */
    private static function text($value, int $limit): bool
    {
        if (!is_string($value) || $value === '' || strlen($value) > $limit * 4 || strpos($value, "\0") !== false) {
            return false;
        }
        // The wire limit counts UTF-16 units. Each character outside the BMP takes two.
        $chars = preg_match_all('/./us', $value);
        return $chars !== false && $chars + preg_match_all('/[\x{10000}-\x{10ffff}]/u', $value) <= $limit;
    }

    /**
     * Record field paths that the host can show to staff.
     *
     * @param array $input Fields the host supplied.
     *        (e.g. ['device' => 'desk-42'])
     * @param array $kept Fields that passed screening.
     *        (e.g. ['device' => 'desk-42'])
     * @param array $reasons Safe descriptions for known fields.
     *        (e.g. ['device' => 'Expected a device identifier.'])
     * @param string $path Field path in diagnostics.
     *        (e.g. 'facts')
     * @param array $dropped Receives omitted field paths and reasons, without their values.
     *        (e.g. ['facts.email' => 'Expected an email address.'])
     * @return void
     */
    private static function dropped_fields(array $input, array $kept, array $reasons, string $path, array &$dropped): void
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

    /**
     * Screen the fields accepted on a profile or its speaker.
     *
     * @param mixed $given Submitted facts or speaker.
     *        (e.g. ['phone' => '+12025550100'])
     * @param bool $speaker Whether these fields describe a speaker.
     *        (e.g. false)
     * @param array $dropped Receives omitted field paths and reasons, without their values.
     *        (e.g. ['facts.email' => 'Expected an email address.'])
     * @return array Accepted facts.
     */
    private static function facts($given, bool $speaker, array &$dropped): array
    {
        $path = $speaker ? 'speaker' : 'facts';
        if (!is_array($given) && !is_object($given)) {
            $dropped[$path] = 'Expected an object.';
            return [];
        }
        $fields = (array) $given;
        $facts = self::contact_facts($fields);
        $reasons = [
            'email' => 'Expected an email address of at most 512 characters with a local part and domain.',
            'phone' => 'Expected a usable phone number of at most 64 characters.',
            'device' => 'Expected 1 to 128 letters, digits, dots, dashes or underscores.'
        ];
        if ($speaker) {
            self::dropped_fields($fields, $facts, $reasons, $path, $dropped);
            if (!$fields) {
                $dropped['speaker'] = 'A speaker needs a device, phone or email.';
            }
            return $facts;
        }
        $reasons += [
            'ip' => 'Expected an IPv4 or IPv6 address of at most 64 characters.',
            'name' => 'A name needs both a usable first and last name.',
            'dob' => 'Expected a valid calendar date in YYYY-MM-DD format.',
            'address' => 'An address needs a nonblank street of at most 2048 characters.',
            'identifiers' => 'Expected a list containing at least one usable identifier.'
        ];
        if (self::text($fields['ip'] ?? null, 64) && @inet_pton(trim($fields['ip'])) !== false) {
            $facts['ip'] = $fields['ip'];
        }
        self::name_fields($fields, $facts, $dropped);
        $dob = $fields['dob'] ?? null;
        if (is_string($dob) && preg_match('/^([0-9]{4})-([0-9]{2})-([0-9]{2})$/D', $dob, $parts)
            && checkdate((int) $parts[2], (int) $parts[3], (int) $parts[1])) {
            $facts['dob'] = $dob;
        }
        self::address_fields($fields, $facts, $dropped);
        self::identifier_fields($fields, $facts, $dropped);
        self::dropped_fields($fields, $facts, $reasons, $path, $dropped);
        return $facts;
    }

    /**
     * Keep usable email, phone and device identifiers with their original spelling.
     *
     * @param array $fields Host-supplied fields.
     *        (e.g. ['device' => 'desk-42'])
     * @return array Accepted contact facts.
     */
    private static function contact_facts(array $fields): array
    {
        $facts = [];
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
        return $facts;
    }

    /**
     * Keep complete names and record problems with their parts.
     *
     * @param array $fields Host-supplied fields.
     *        (e.g. ['device' => 'desk-42'])
     * @param array $facts Accepted facts collected so far.
     *        (e.g. ['device' => 'desk-42'])
     * @param array $dropped Receives omitted field paths and reasons, without their values.
     *        (e.g. ['facts.email' => 'Expected an email address.'])
     * @return void
     */
    private static function name_fields(array $fields, array &$facts, array &$dropped): void
    {
        $name = (array) ($fields['name'] ?? []);
        $parts = [];
        $name_fields = ['first' => 'Expected text of 1 to 200 characters.', 'last' => 'Expected text of 1 to 200 characters.'];
        foreach ($name_fields as $field => $reason) {
            if (self::text($name[$field] ?? null, 200)) {
                $parts[$field] = $name[$field];
            }
        }
        if (count($parts) === 2) {
            $facts['name'] = $parts;
        }
        if (is_array($fields['name'] ?? null) || is_object($fields['name'] ?? null)) {
            self::dropped_fields($name, $parts, $name_fields, 'facts.name', $dropped);
        }
    }

    /**
     * Keep addresses with a usable street and record problems in nested fields.
     *
     * @param array $fields Host-supplied fields.
     *        (e.g. ['device' => 'desk-42'])
     * @param array $facts Accepted facts collected so far.
     *        (e.g. ['device' => 'desk-42'])
     * @param array $dropped Receives omitted field paths and reasons, without their values.
     *        (e.g. ['facts.email' => 'Expected an email address.'])
     * @return void
     */
    private static function address_fields(array $fields, array &$facts, array &$dropped): void
    {
        $address = (array) ($fields['address'] ?? []);
        $parts = [];
        $address_fields = [];
        foreach (['street' => 2048, 'street2' => 2048, 'secondary' => 200, 'city' => 200, 'state' => 200, 'zipcode' => 200] as $field => $limit) {
            $address_fields[$field] = $field === 'street' ? 'An address needs a nonblank street of at most 2048 characters.' : 'Expected text of 1 to ' . $limit . ' characters.';
            if (self::text($address[$field] ?? null, $limit) && ($field !== 'street' || trim($address[$field]) !== '')) {
                $parts[$field] = $address[$field];
            }
        }
        if (isset($parts['street'])) {
            $facts['address'] = $parts;
        }
        if (is_array($fields['address'] ?? null) || is_object($fields['address'] ?? null)) {
            self::dropped_fields($address, $parts, $address_fields, 'facts.address', $dropped);
        }
    }

    /**
     * Keep the first 100 usable custom identifiers.
     *
     * @param array $fields Host-supplied fields.
     *        (e.g. ['device' => 'desk-42'])
     * @param array $facts Accepted facts collected so far.
     *        (e.g. ['device' => 'desk-42'])
     * @param array $dropped Receives omitted field paths and reasons, without their values.
     *        (e.g. ['facts.email' => 'Expected an email address.'])
     * @return void
     */
    private static function identifier_fields(array $fields, array &$facts, array &$dropped): void
    {
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
    }

    /**
     * Check the length of a phone line without counting an extension.
     *
     * @param string $phone Phone exactly as the host received it.
     *        (e.g. '+1 (202) 555-0100 ext 12')
     * @return bool
     */
    private static function phone(string $phone): bool
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

    /**
     * Insert one write in the same PDO transaction as the host change.
     *
     * @param PDO $db The host database connection.
     *        (e.g. new PDO('sqlite::memory:'))
     * @param string $record_id Ordering group in the host.
     *        (e.g. 'contact:42')
     * @param string $call Graph write method.
     *        (e.g. 'record')
     * @param array $request Original write, including its time and stable key.
     *        (e.g. ['entries' => [['type' => 'arrival', 'key' => 'visit-42', 'subject' => 'contact:42', 'at' => 1000]]])
     * @param int|string|null $depends_on Earlier outbox ID that must succeed first.
     *        (e.g. '17')
     * @param array|null $dropped Receives omitted field paths and reasons, without their values.
     *        (e.g. ['facts.email' => 'Expected an email address.'])
     * @return string|false Saved row ID or false for a screened-out profile.
     */
    public static function enqueue(PDO $db, string $record_id, string $call, array $request, $depends_on = null, ?array &$dropped = null)
    {
        $dropped = [];
        if (!$db->inTransaction()) {
            throw new LogicException('Enqueue on the host transaction connection');
        }
        $row = self::row($record_id, $call, $request, $depends_on, $dropped);
        if (!$row) {
            return false;
        }
        $store = new account_graph_outbox_pdo(['Db' => $db]);
        if ($depends_on !== null && !$store->one('SELECT id FROM account_graph_outbox WHERE id = ?', [$depends_on])) {
            throw new InvalidArgumentException('The prerequisite outbox row does not exist');
        }
        $sql = 'INSERT INTO account_graph_outbox (' . implode(', ', array_keys($row)) . ') VALUES (?, ?, ?, ?, ?, ?, ?)';
        if ($db->getAttribute(PDO::ATTR_DRIVER_NAME) === 'pgsql') {
            return (string) $store->one($sql . ' RETURNING id', array_values($row))['id'];
        }
        $store->execute($sql, array_values($row));
        return (string) $db->lastInsertId();
    }

    /**
     * Send a bounded pass on an idle PDO connection.
     *
     * @param PDO $db The host database connection.
     *        (e.g. new PDO('sqlite::memory:'))
     * @param account_graph_lib $graph Client configured for this graph.
     *        (e.g. new account_graph_lib(['Base_Url' => 'https://graph.example.org', 'Token' => $token]))
     * @param int $limit Maximum rows to process during this pass.
     *        (e.g. 100)
     * @return array Counts by resulting state.
     */
    public static function run(PDO $db, account_graph_lib $graph, int $limit = 100): array
    {
        if ($db->inTransaction()) {
            throw new LogicException('Run the worker on an idle connection');
        }
        return self::work(new account_graph_outbox_pdo(['Db' => $db]), $graph, $limit);
    }

    /**
     * Claim rows in order on the host adapter and save each answer before releasing its claim.
     *
     * @param object $store Adapter providing one, execute, begin, commit and rollback.
     *        (e.g. new account_graph_outbox_pdo(['Db' => $db]))
     * @param account_graph_lib $graph Client configured for this graph.
     *        (e.g. new account_graph_lib(['Base_Url' => 'https://graph.example.org', 'Token' => $token]))
     * @param int $limit Maximum rows to process during this pass.
     *        (e.g. 100)
     * @return array Counts by resulting state.
     */
    public static function work(object $store, account_graph_lib $graph, int $limit = 100): array
    {
        if ($limit < 1) {
            throw new InvalidArgumentException('The worker limit must be a positive integer');
        }
        $counts = ['sent' => 0, 'refused' => 0, 'failed' => 0, 'blocked' => 0, 'pending' => 0];
        $table = 'account_graph_outbox';
        list($next, $claimed) = self::selection_queries($table);
        $id = 0;
        $processed = 0;
        while ($processed < $limit) {
            $row = $store->one($next, [$id]);
            if (!$row) {
                break;
            }
            $id = $row['id'];
            $store->begin();
            try {
                // A crash rolls back the claim, so the next worker retries the original key.
                if (!$store->execute("UPDATE $table SET state = 'sending' WHERE id = ? AND state = ?", [$id, $row['state']])) {
                    $store->rollback();
                    continue;
                }
                $job = $store->one($claimed, [$id]);
                if ($job['restart_after'] !== null) {
                    // A concurrent repair can make an older row ready between selection and claim.
                    $id = $job['restart_after'];
                    $store->rollback();
                    continue;
                }
                list($state, $answer, $stop, $counted) = self::dispatch($graph, $job);
                $processed += $counted;
                $finish = "UPDATE $table SET state = ?, answer = ?" . ($state === 'sent' ? ', request = NULL' : '') . ' WHERE id = ?';
                $store->execute($finish, [$state, account_graph_lib::json($answer), $id]);
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

    /**
     * Select eligible rows and recheck order after claiming one.
     *
     * @param string $table Fixed host outbox table name.
     *        (e.g. 'account_graph_outbox')
     * @return array Selection and claim queries.
     */
    private static function selection_queries(string $table): array
    {
        // A parked dependency blocks its descendants. A repaired prerequisite makes its children eligible again.
        $earlier = "FROM $table older LEFT JOIN $table parent ON parent.id = older.depends_on
            WHERE older.record_id = j.record_id AND older.id < j.id AND (older.state IN ('pending','sending')
                OR (older.state = 'blocked' AND (parent.id IS NULL OR parent.state = 'sent')))";
        $next = "SELECT j.id, j.state FROM $table j LEFT JOIN $table p ON p.id = j.depends_on
            WHERE j.id > ? AND (j.state = 'pending' OR (j.state = 'blocked' AND (p.id IS NULL OR p.state = 'sent')))
            AND NOT EXISTS (SELECT 1 $earlier) ORDER BY j.id LIMIT 1";
        $claimed = "SELECT j.call_name, j.request, j.answer, j.depends_on, p.state AS parent_state,
            (SELECT MIN(older.id) - 1 $earlier) AS restart_after FROM $table j LEFT JOIN $table p ON p.id = j.depends_on WHERE j.id = ?";
        return [$next, $claimed];
    }

    /**
     * Keep blocked or deferred writes in order and spend the pass budget on eligible work.
     *
     * @param account_graph_lib $graph Client configured for this graph.
     *        (e.g. new account_graph_lib(['Base_Url' => 'https://graph.example.org', 'Token' => $token]))
     * @param array $job Row claimed in this worker transaction.
     *        (e.g. ['call_name' => 'decide', 'request' => $json, 'parent_state' => null, 'answer' => null])
     * @return array State, answer, whether to stop and whether this used a slot.
     */
    private static function dispatch(account_graph_lib $graph, array $job): array
    {
        $parent = $job['parent_state'];
        // Enqueue checked the prerequisite. Retention only deletes sent rows.
        if ($parent !== null && $parent !== 'sent') {
            $park = in_array($parent, ['failed', 'refused', 'blocked'], true);
            return [$park ? 'blocked' : 'pending', ['depends_on' => $job['depends_on']], false, (int) $park];
        }
        $last = json_decode($job['answer'] ?? '', true);
        $now = microtime(true);
        if (is_numeric($last['retry_at'] ?? null) && $last['retry_at'] > $now) {
            // Bound a legacy deadline once. A deferred row leaves the send budget for ready groups.
            $last['retry_at'] = min((float) $last['retry_at'], $now + account_graph_lib::MAX_RETRY_AFTER_SECONDS);
            return ['pending', $last, false, 0];
        }
        list($state, $answer, $stop) = self::send($graph, $job);
        return [$state, $answer, $stop, 1];
    }

    /**
     * Post the stored request and classify its answer for the next worker or staff.
     *
     * @param account_graph_lib $graph Client configured for this graph.
     *        (e.g. new account_graph_lib(['Base_Url' => 'https://graph.example.org', 'Token' => $token]))
     * @param array $job Row claimed in this worker transaction.
     *        (e.g. ['call_name' => 'decide', 'request' => $json, 'parent_state' => null, 'answer' => null])
     * @return array State, answer and whether to end the pass.
     */
    private static function send(account_graph_lib $graph, array $job): array
    {
        try {
            $request = json_decode($job['request'] ?? '');
            $call = $job['call_name'];
            if (!is_object($request) || !in_array($call, ['record', 'decide', 'forget'], true)) {
                throw new account_graph_fault(['Code' => 'INPUT.MALFORMED']);
            }
            $answer = $graph->$call((array) $request);
            $decision = $call === 'record' ? $answer['results'][0] : $answer;
            $state = $decision['ok'] ? 'sent' : ($decision['reason'] === 'NOT_ATTEMPTED' ? 'pending' : 'refused');
            return [$state, $answer, false];
        } catch (account_graph_fault $fault) {
            $answer = ['fault' => ['code' => $fault->fault_code, 'retryable' => $fault->retryable, 'detail' => $fault->detail]];
            if (in_array($fault->fault_code, ['INPUT.MALFORMED', 'INPUT.TOO_LARGE'], true)) {
                return ['failed', $answer, false];
            }
            if (is_string($fault->detail['retryAfter'] ?? null)) {
                $retry_at = account_graph_lib::retry_at($fault->detail['retryAfter']);
                if ($retry_at !== null) {
                    $answer['retry_at'] = $retry_at;
                }
            }
            return ['pending', $answer, true];
        }
    }
}
