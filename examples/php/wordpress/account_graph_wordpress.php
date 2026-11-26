<?php
/**
 * WordPress, Gravity Forms and Contact Form 7 callbacks for the account graph.
 * Requires PHP 7.2 or later and the WordPress functions loaded by the must-use file.
 *
 * @filename account_graph_wordpress.php
 */
defined('ABSPATH') || exit;
require_once __DIR__ . '/account_graph_outbox_lib.php';

final class account_graph_wordpress
{
    const PREFIX = 'account_graph_job_';
    const RECENT = 'account_graph_recent_';
    const HOOK = 'account_graph_deliver';
    private const BACKLOG = 'account_graph_backlog_notice';

    /** @var object WordPress database connection for this site. */
    private $db;
    /** @var SplObjectStorage IDs assigned to CF7 submissions in this request. */
    private $submissions;

    /**
     * Use the site's options table for a durable per-submission queue.
     *
     * 'Database' => null, // required, object, the site's wpdb connection.
     *
     * @param array $config WordPress dependencies.
     *        (e.g. ['Database' => $GLOBALS['wpdb']])
     * @return void
     */
    public function __construct(array $config)
    {
        if (!is_object($config['Database'] ?? null)) {
            throw new InvalidArgumentException('A WordPress database connection is required.');
        }
        $this->db = $config['Database'];
        $this->submissions = new SplObjectStorage();
    }

    /**
     * Enqueue the public browser module on pages allowed in wp-config.php.
     *
     * @return void
     */
    public function browser(): void
    {
        $include = defined('ACCOUNT_GRAPH_INCLUDE_PAGES') ? ACCOUNT_GRAPH_INCLUDE_PAGES : [];
        $exclude = defined('ACCOUNT_GRAPH_EXCLUDE_PAGES') ? ACCOUNT_GRAPH_EXCLUDE_PAGES : [];
        if (!is_array($include) || !is_array($exclude) || ($exclude && is_page($exclude)) || ($include && !is_page($include))) {
            return;
        }
        $base = defined('ACCOUNT_GRAPH_URL') ? ACCOUNT_GRAPH_URL : '';
        try {
            // Reuse the client's scheme, loopback and credential checks. Construction does no I/O.
            new account_graph_lib(['Base_Url' => $base, 'Token' => 'public-browser-tag']);
            wp_enqueue_script_module('account-graph', rtrim($base, '/') . '/collect.js?forms=all', [], null);
        } catch (Throwable $error) {
            // Invalid graph settings must leave the host's page available.
        }
    }

    /**
     * Read the collector's hidden input while the form submission is still available.
     *
     * @param string $provider Form provider.
     *        (e.g. 'gravity')
     * @param string $form_id Form whose entry is being accepted.
     *        (e.g. '17')
     * @param object|null $submission Current CF7 submission, when available.
     *        (e.g. WPCF7_Submission::get_instance())
     * @return array Subject or speaker device, with null for an unusable submitted ID.
     */
    private function browser_device(string $provider, string $form_id, ?object $submission = null): array
    {
        $mapped = $this->forms()[$provider][$form_id]['device'] ?? null;
        if ((!is_string($mapped) && !is_int($mapped)) || (string) $mapped === '') {
            return [];
        }
        $posted_form = $_POST[$provider === 'gravity' ? 'gform_submit' : '_wpcf7'] ?? null;
        $same_form = is_scalar($posted_form) && (string) $posted_form === $form_id;
        // The collector disables the subject input when somebody else fills in the form.
        $fields = ['ag_speaker_device' => 'speaker'];
        if ($mapped === 'ag_device') {
            $fields['ag_device'] = 'subject';
        }
        foreach ($fields as $name => $owner) {
            $value = $submission ? $submission->get_posted_data($name) : null;
            if ($value === null || $value === '' || $value === []) {
                // GF saves only numbered fields. CF7 can omit inputs absent from its form definition.
                $value = $same_form ? ($_POST[$name] ?? null) : null;
            }
            if ($value !== null && $value !== '') {
                // An invalid speaker ID still prevents attaching this browser to the subject.
                $valid = $mapped === 'ag_device' && is_string($value) && preg_match('/^[a-zA-Z0-9._-]{1,128}$/D', $value);
                return [$owner => $valid ? $value : null];
            }
        }
        return [];
    }

    /**
     * Save the submitted Gravity Forms entry locally, after validation and persistence.
     *
     * @param array $entry Entry fields.
     *        (e.g. ['id' => '82', '1' => 'row@example.org'])
     * @param array $form Form definition.
     *        (e.g. ['id' => 17])
     * @return void
     */
    public function gravity(array $entry, array $form): void
    {
        try {
            if (($entry['status'] ?? 'active') !== 'active') {
                return;
            }
            $at = isset($entry['date_created']) ? strtotime($entry['date_created'] . ' UTC') : false;
            $this->enqueue('gravity', (string) ($form['id'] ?? ''), (string) ($entry['id'] ?? ''), $at ?: time(),
                function (string $field) use ($entry) { return $entry[$field] ?? null; },
                $this->browser_device('gravity', (string) ($form['id'] ?? '')), true);
        } catch (Throwable $error) {
            $this->queue_error();
        }
    }

    /**
     * Queue one accepted CF7 submission after mail succeeds.
     *
     * @param object $form The WPCF7_ContactForm passed by wpcf7_mail_sent.
     *        (e.g. form 23)
     * @return void
     */
    public function cf7(object $form): void
    {
        try {
            $form_id = (string) $form->id();
            if (!isset($this->forms()['cf7'][$form_id])) {
                return;
            }
            $submission = WPCF7_Submission::get_instance();
            if (!$submission) {
                return;
            }
            if (!isset($this->submissions[$submission])) {
                // Use a site's saved ID only when its own persistence hook has already run.
                $id = defined('ACCOUNT_GRAPH_CF7_ENTRY_ID') ? call_user_func(ACCOUNT_GRAPH_CF7_ENTRY_ID, $form, $submission) : null;
                $saved = $id !== null && $id !== false && $id !== '';
                $this->submissions[$submission] = [$saved ? (string) $id : wp_generate_uuid4(), $saved];
            }
            list($id, $saved) = $this->submissions[$submission];
            $at = $submission->get_meta('timestamp');
            $this->enqueue('cf7', $form_id, $id, is_numeric($at) ? (int) $at : time(),
                function (string $field) use ($submission) { return $submission->get_posted_data($field); },
                $this->browser_device('cf7', $form_id, $submission), $saved);
        } catch (Throwable $error) {
            $this->queue_error();
        }
    }

    /**
     * Read the per-plugin and per-form mappings from wp-config.php.
     *
     * @return array Configured fields.
     *        (e.g. ['gravity' => [17 => ['email' => '1']]])
     */
    private function forms(): array
    {
        return defined('ACCOUNT_GRAPH_FORMS') && is_array(ACCOUNT_GRAPH_FORMS) ? ACCOUNT_GRAPH_FORMS : [];
    }

    /**
     * Report local persistence trouble without writing the request or exception trace.
     *
     * @return void
     */
    private function queue_error(): void
    {
        error_log('Account graph could not persist or update a form job.');
    }

    /**
     * Keep only supported, explicitly mapped identifiers. Unmapped forms produce no job.
     *
     * @param string $provider Form provider.
     *        (e.g. 'gravity')
     * @param string $form Form ID.
     *        (e.g. '17')
     * @param string $id Source entry ID.
     *        (e.g. '82')
     * @param int $seconds Submission time in Unix seconds.
     *        (e.g. 1700000000)
     * @param callable $get Read one configured field.
     *        (e.g. a callback reading entry field '1')
     * @param array $browser_device Device supplied by the collector for the subject or speaker.
     *        (e.g. ['subject' => 'desk-42'])
     * @param bool $saved Whether the form plugin can replay this entry ID in a later request.
     *        (e.g. true for Gravity Forms)
     * @return void
     */
    private function enqueue(string $provider, string $form, string $id, int $seconds, callable $get, array $browser_device, bool $saved): void
    {
        $map = $this->forms()[$provider][$form] ?? null;
        if (!is_array($map)) {
            return;
        }
        $source = defined('ACCOUNT_GRAPH_SOURCE') ? ACCOUNT_GRAPH_SOURCE : '';
        if (!is_string($source) || !preg_match('/^[a-zA-Z0-9_-]{1,40}$/D', $source) || !preg_match('/^[1-9][0-9]*$/D', $form)
            || !preg_match('/^(?:[1-9][0-9]{0,29}|[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12})$/D', $id)) {
            throw new RuntimeException('Invalid form source or durable entry ID.');
        }
        $blog = (string) get_current_blog_id();
        if (!preg_match('/^[1-9][0-9]*$/D', $blog)) {
            throw new RuntimeException('Invalid WordPress site ID.');
        }
        $scope = 'wp:' . $source . ':' . $blog . ':' . $provider . ':' . $form . ':';
        $subject = $scope . $id;
        $entry_hash = sha1($subject);
        $legacy = 'wp:' . $source . ':' . $provider . ':' . $form . ':' . $id;
        if ($this->known_entry($subject, $legacy)) {
            return;
        }
        $facts = $this->mapped_facts($map, $provider, $get, $browser_device);
        $at = $seconds * 1000;
        $profile = ['type' => 'profile', 'key' => account_graph_lib::key('wordpress.profile', $subject, 1), 'at' => $at, 'subject' => $subject, 'facts' => $facts];
        if (isset($browser_device['speaker'])) {
            $profile['speaker'] = ['device' => $browser_device['speaker']];
        }
        $row = account_graph_outbox_lib::row($subject, 'record', ['entries' => [$profile]]);
        if ($row) {
            $profile = json_decode($row['request'], true)['entries'][0];
            // A representative may submit for different people from the same browser.
            if (!empty($profile['facts'])) {
                list($id, $seconds) = $this->claim_fingerprint($scope, $profile, $id, $seconds);
            }
            $subject = $scope . $id;
            $at = $seconds * 1000;
            $profile['subject'] = $subject;
            $profile['at'] = $at;
            $profile['key'] = account_graph_lib::key('wordpress.profile', $subject, 1);
        }
        $inquiry = ['type' => 'conversion', 'key' => account_graph_lib::key('wordpress.inquiry', $subject, 1), 'at' => $at, 'subject' => $subject, 'stage' => 'inquiry'];
        $job = ['state' => 'pending', 'phase' => $row ? 'profile' : 'inquiry', 'retry_at' => 0, 'queued_at' => time(), 'inquiry' => $inquiry];
        if ($row) {
            $job['profile'] = $profile;
        }

        $this->save_job($subject, $entry_hash, $saved, $job);
    }

    /**
     * Recognize a saved entry across retries and the move to site-scoped subjects.
     *
     * @param string $subject Site-scoped submission identity.
     *        (e.g. 'wp:example-site:2:gravity:17:82')
     * @param string $legacy Identity used by the original integration.
     *        (e.g. 'wp:example-site:gravity:17:82')
     * @return bool Whether this blog already has a job or receipt for this entry.
     */
    private function known_entry(string $subject, string $legacy): bool
    {
        $wpdb = $this->db;
        // Old jobs and sent receipts still identify their entry in this blog's own options table.
        $known = $wpdb->prepare("SELECT 1 FROM {$wpdb->options} WHERE option_name IN (%s, %s) LIMIT 1", self::PREFIX . sha1($legacy), self::PREFIX . sha1($subject));
        if ($wpdb->get_var($known)) {
            return true;
        }
        if (!empty($wpdb->last_error)) {
            throw new RuntimeException('Form receipt read failed.');
        }
        return false;
    }

    /**
     * Read only configured identifying fields, including any explicitly mapped browser device.
     *
     * @param array $map Configured graph fields and their form inputs.
     *        (e.g. ['email' => '1'])
     * @param string $provider Form provider.
     *        (e.g. 'gravity')
     * @param callable $get Read one configured field.
     *        (e.g. a callback reading entry field '1')
     * @param array $browser_device Device submitted by the collector for the subject or speaker.
     *        (e.g. ['subject' => 'desk-42'])
     * @return array Identifying fields to screen with the outbox.
     */
    private function mapped_facts(array $map, string $provider, callable $get, array $browser_device): array
    {
        $facts = [];
        foreach (['email', 'phone', 'device'] as $fact) {
            $field = $map[$fact] ?? null;
            if ((!is_string($field) && !is_int($field)) || (string) $field === '') {
                continue;
            }
            $field = (string) $field;
            if (($fact === 'device' && $browser_device) || in_array($field, ['ag_device', 'ag_speaker_device', 'ag_landing'], true)) {
                continue;
            }
            $pattern = $provider === 'gravity' ? '/^[1-9][0-9]*(?:\.[0-9]+)?$/D' : '/^[a-zA-Z][-a-zA-Z0-9_.:]*$/D';
            if (!preg_match($pattern, $field)) {
                continue;
            }
            $raw = $get($field);
            if (!is_string($raw)) {
                continue;
            }
            $value = trim($raw);
            if ($fact === 'email' && !filter_var($value, FILTER_VALIDATE_EMAIL)) {
                continue;
            }
            if ($fact === 'phone' && !preg_match('/^[+0-9(). -]+(?:\s*(?:ext\.?|x)\s*[0-9]{1,7})?$/iD', $value)) {
                continue;
            }
            $facts[$fact] = $value;
        }
        if (isset($browser_device['subject'])) {
            $facts['device'] = $browser_device['subject'];
        }
        return $facts;
    }

    /**
     * Store the job and its trusted source entry alias together, including on a concurrent replay.
     *
     * @param string $subject Canonical site-scoped submission identity.
     *        (e.g. 'wp:example-site:2:gravity:17:82')
     * @param string $entry_hash Hash of this callback's original source identity.
     *        (e.g. sha1('wp:example-site:2:gravity:17:83'))
     * @param bool $saved Whether the form plugin can replay this entry ID in a later request.
     *        (e.g. true for Gravity Forms)
     * @param array $job Pending job to insert if its receipt is absent.
     *        (e.g. a queued profile and inquiry)
     * @return void
     */
    private function save_job(string $subject, string $entry_hash, bool $saved, array $job): void
    {
        $wpdb = $this->db;
        $name = self::PREFIX . sha1($subject);
        $values = "(%s, %s, 'no')";
        $args = [$name, account_graph_lib::json($job)];
        if ($saved && $name !== self::PREFIX . $entry_hash) {
            // A source ID has one unique option name whether it wins the window or becomes an alias.
            $values .= ", (%s, %s, 'no')";
            $args[] = self::PREFIX . $entry_hash;
            $args[] = account_graph_lib::json(['state' => 'alias', 'job' => $name]);
        }
        $sql = $wpdb->prepare("INSERT INTO {$wpdb->options} (option_name, option_value, autoload) VALUES $values ON DUPLICATE KEY UPDATE option_name = option_name", $args);
        $this->write($sql);
        $this->wake();
    }

    /**
     * Keep the first entry ID and graph timestamp for ten minutes across independent submissions.
     *
     * @param string $scope Site, provider and form namespace.
     *        (e.g. 'wp:example-site:1:gravity:17:')
     * @param array $profile Screened identifying fields for this submission.
     *        (e.g. ['facts' => ['email' => 'row@example.org']])
     * @param string $id Source entry ID.
     *        (e.g. '82')
     * @param int $seconds Original submission time in Unix seconds.
     *        (e.g. 1700000000)
     * @return array Canonical entry ID and submission time.
     */
    private function claim_fingerprint(string $scope, array $profile, string $id, int $seconds): array
    {
        $wpdb = $this->db;
        $facts = $profile['facts'];
        if (isset($facts['email'])) {
            $facts['email'] = strtolower($facts['email']);
        }
        if (isset($facts['phone'])) {
            $facts['phone'] = preg_replace('/[(). -]/', '', strtolower($facts['phone']));
        }
        $name = self::RECENT . hash_hmac('sha256', account_graph_lib::json([$scope, $facts, $profile['speaker'] ?? null]), wp_salt('auth'));
        $now = time();
        $cutoff = sprintf('%012d', $now);
        $claim = sprintf('%012d:%s:%d', $now + 600, $id, $seconds);
        // A conditional upsert picks one winner across PHP workers, even across a clock bucket boundary.
        $sql = $wpdb->prepare("INSERT INTO {$wpdb->options} (option_name, option_value, autoload) VALUES (%s, %s, 'no') ON DUPLICATE KEY UPDATE option_value = CASE WHEN SUBSTR(option_value, 1, 12) <= %s THEN %s ELSE option_value END", $name, $claim, $cutoff, $claim);
        $this->write($sql);
        $winner = $wpdb->get_var($wpdb->prepare("SELECT option_value FROM {$wpdb->options} WHERE option_name = %s", $name));
        $parts = is_string($winner) ? explode(':', $winner) : [];
        if (count($parts) !== 3 || !preg_match('/^[0-9]+$/D', $parts[2])) {
            throw new RuntimeException('Form fingerprint read failed.');
        }
        return [$parts[1], (int) $parts[2]];
    }

    /**
     * Remove expired fingerprint claims in bounded batches during the site's cron pass.
     *
     * @return void
     */
    private function expire_fingerprints(): void
    {
        $wpdb = $this->db;
        $sql = $wpdb->prepare("DELETE FROM {$wpdb->options} WHERE option_name LIKE %s AND SUBSTR(option_value, 1, 12) <= %s LIMIT 250", $wpdb->esc_like(self::RECENT) . '%', sprintf('%012d', time()));
        if ($this->write($sql) === 250) {
            $this->wake();
        }
    }

    /**
     * Schedule a regular pass even if the previous PHP worker died during a send.
     *
     * @return void
     */
    public function schedule(): void
    {
        try {
            if (!wp_next_scheduled(self::HOOK) && !wp_schedule_event(time(), 'hourly', self::HOOK)) {
                error_log('Account graph could not schedule its form worker.');
            }
        } catch (Throwable $error) {
            error_log('Account graph could not schedule its form worker.');
        }
        // A site with delayed or disabled WP-Cron can still report trouble on its next visitor.
        $this->observe_backlog(true);
    }

    /**
     * Request delivery on the next cron pass without delaying the form response.
     *
     * @return void
     */
    private function wake(): void
    {
        // WordPress coalesces identical events. Distinct arguments keep the hourly event independent.
        $args = ['wake'];
        try {
            if (!wp_schedule_single_event(time(), self::HOOK, $args) && !wp_next_scheduled(self::HOOK, $args)) {
                error_log('Account graph could not schedule its form worker.');
            }
        } catch (Throwable $error) {
            error_log('Account graph could not schedule its form worker.');
        }
    }

    /**
     * Run the paired writes under a site-specific, connection-owned cron lock.
     *
     * @return void
     */
    public function deliver(): void
    {
        try {
            $this->observe_backlog();
            $this->with_lock('ag_wp_', function (string $lock): void {
                $this->expire_fingerprints();
                $graph = new account_graph_lib(['Base_Url' => defined('ACCOUNT_GRAPH_URL') ? ACCOUNT_GRAPH_URL : '', 'Token' => defined('ACCOUNT_GRAPH_TOKEN') ? ACCOUNT_GRAPH_TOKEN : '', 'Attempts' => 1]);
                $this->drain($graph, $lock);
            });
            $this->observe_backlog();
        } catch (account_graph_fault $fault) {
            error_log('Account graph form worker could not start (' . $fault->fault_code . ').');
        } catch (Throwable $error) {
            $this->queue_error();
        }
    }

    /**
     * Serialize one site's workers or observers without waiting on a busy connection.
     *
     * @param string $prefix Lock purpose.
     *        (e.g. 'ag_wp_')
     * @param callable $run Work to perform under the site's lock.
     *        (e.g. a worker pass)
     * @return void
     */
    private function with_lock(string $prefix, callable $run): void
    {
        $wpdb = $this->db;
        $lock = $prefix . sha1((defined('DB_NAME') ? DB_NAME : '') . '/' . $wpdb->options);
        if ((string) $wpdb->get_var($wpdb->prepare('SELECT GET_LOCK(%s, 0)', $lock)) !== '1') {
            return;
        }
        try {
            $run($lock);
        } finally {
            $wpdb->get_var($wpdb->prepare('SELECT RELEASE_LOCK(%s)', $lock));
        }
    }

    /**
     * Log one value-free warning for a continuous backlog older than an hour.
     *
     * @param bool $visitor Limit option-table scans from ordinary page visits to once per minute.
     *        (e.g. true on init)
     * @return void
     */
    private function observe_backlog(bool $visitor = false): void
    {
        try {
            if ($visitor && get_transient('account_graph_queue_checked') !== false) {
                return;
            }
            // A visitor checking the warning must never take the worker's delivery slot.
            $this->with_lock('ag_wp_notice_', function () use ($visitor): void {
                $this->update_notice();
                if ($visitor) {
                    set_transient('account_graph_queue_checked', 1, 60);
                }
            });
        } catch (Throwable $error) {
            $this->queue_error();
        }
    }

    /**
     * Keep the warning marker until the oldest pending job is young again or the queue drains.
     *
     * @return void
     */
    private function update_notice(): void
    {
        $wpdb = $this->db;
        $prefix = $wpdb->esc_like(self::PREFIX) . '%';
        $sql = $wpdb->prepare("SELECT option_value FROM {$wpdb->options} WHERE option_name LIKE %s AND option_value LIKE %s ORDER BY option_id LIMIT 1", $prefix, '{"state":"pending",%');
        $rows = $wpdb->get_results($sql, ARRAY_A);
        if (!is_array($rows) || !empty($wpdb->last_error)) {
            throw new RuntimeException('Form queue read failed.');
        }
        $job = $rows ? json_decode($rows[0]['option_value'], true) : null;
        $marker = $wpdb->get_var($wpdb->prepare("SELECT option_value FROM {$wpdb->options} WHERE option_name = %s", self::BACKLOG));
        if (!empty($wpdb->last_error)) {
            throw new RuntimeException('Form queue notice read failed.');
        }
        $marker = is_string($marker) ? $marker : null;
        $next = null;
        if ($job !== null) {
            $queued = $job['queued_at'] ?? null;
            if (!is_int($queued)) {
                // Earlier jobs have the form's timestamp only. Start their clock on first observation.
                $next = $marker ?? (string) time();
                $queued = (int) $next;
            }
            if ($queued < time() - 3600) {
                $next = 'warned';
            }
        }
        if ($marker === $next) {
            return;
        }
        if ($next === null) {
            $sql = $wpdb->prepare("DELETE FROM {$wpdb->options} WHERE option_name = %s", self::BACKLOG);
        } elseif ($marker === null) {
            $sql = $wpdb->prepare("INSERT INTO {$wpdb->options} (option_name, option_value, autoload) VALUES (%s, %s, 'no')", self::BACKLOG, $next);
        } else {
            $sql = $wpdb->prepare("UPDATE {$wpdb->options} SET option_value = %s WHERE option_name = %s", $next, self::BACKLOG);
        }
        if ($this->write($sql) && $next === 'warned') {
            error_log('Account graph form worker has a pending job over one hour old.');
        }
    }

    /**
     * Scan past deferred jobs to find ready submissions. Release the database between sends.
     *
     * @param account_graph_lib $graph Client configured from wp-config.php.
     *        (e.g. the cron client)
     * @param string $lock Site-specific MySQL advisory lock name.
     *        (e.g. 'ag_wp_abc')
     * @return void
     */
    private function drain(account_graph_lib $graph, string $lock): void
    {
        $wpdb = $this->db;
        $after = '0';
        $processed = 0;
        $prefix = $wpdb->esc_like(self::PREFIX) . '%';
        do {
            $sql = $wpdb->prepare("SELECT option_id, option_name, option_value FROM {$wpdb->options} WHERE option_name LIKE %s AND option_value LIKE %s AND option_id > %s ORDER BY option_id LIMIT 25", $prefix, '{"state":"pending",%', $after);
            $rows = $wpdb->get_results($sql, ARRAY_A);
            foreach ($rows as $row) {
                $after = (string) $row['option_id'];
                $job = json_decode($row['option_value'], true);
                if ($job['retry_at'] > microtime(true)) {
                    continue;
                }
                if (!$this->send($graph, $lock, $row['option_name'], $row['option_value'], $job)) {
                    return;
                }
                if (++$processed === 20) {
                    $this->wake();
                    return;
                }
            }
        } while (count($rows) === 25);
    }

    /**
     * Finish a profile before its dependent inquiry. Each acknowledgment advances only the saved phase.
     *
     * @param account_graph_lib $graph Cron's authenticated graph client.
     *        (e.g. one client per delivery pass)
     * @param string $lock Site lock name.
     *        (e.g. 'ag_wp_abc')
     * @param string $name Queue option name.
     *        (e.g. 'account_graph_job_abc')
     * @param string $old Exact saved JSON used to detect a competing update.
     *        (e.g. the originally loaded job)
     * @param array $job Saved entries and phase.
     *        (e.g. ['phase' => 'inquiry', 'inquiry' => $entry])
     * @return bool Whether this worker may continue with other submissions.
     */
    private function send(account_graph_lib $graph, string $lock, string $name, string $old, array $job): bool
    {
        do {
            $phase = $job['phase'];
            $stop = false;
            try {
                $entry = $job[$phase];
                if ($phase === 'profile') {
                    // A speaker-only profile still needs a JSON object for its empty facts.
                    $entry['facts'] = (object) $entry['facts'];
                }
                $item = $graph->record(['entries' => [$entry]])['results'][0];
                if ($item['ok'] && $phase === 'profile') {
                    unset($job['profile'], $job['last_fault']);
                    $job['phase'] = 'inquiry';
                    $job['retry_at'] = 0;
                } elseif ($item['ok']) {
                    $job = ['state' => 'sent'];
                } elseif ($item['reason'] === 'NOT_ATTEMPTED') {
                    return true;
                } else {
                    $job = ['state' => 'refused', 'phase' => $phase, 'key' => $job[$phase]['key'], 'reason' => $item['reason']];
                }
            } catch (account_graph_fault $fault) {
                if (in_array($fault->fault_code, ['INPUT.MALFORMED', 'INPUT.TOO_LARGE'], true)) {
                    $job = ['state' => 'failed', 'phase' => $phase, 'key' => $job[$phase]['key'], 'code' => $fault->fault_code];
                } else {
                    $job['last_fault'] = $fault->fault_code;
                    $hint = $fault->detail['retryAfter'] ?? null;
                    $job['retry_at'] = is_string($hint) ? (account_graph_lib::retry_at($hint) ?? 0) : 0;
                    $stop = true;
                }
            }
            $json = account_graph_lib::json($job);
            if ($json !== $old && !$this->replace($lock, $name, $old, $json)) {
                return false;
            }
            $old = $json;
            if ($stop) {
                return false;
            }
        } while ($job['state'] === 'pending');
        return true;
    }

    /**
     * Check the prior option bytes and lock ownership before advancing the phase.
     *
     * @param string $lock Site lock name.
     *        (e.g. 'ag_wp_abc')
     * @param string $name Queue option name.
     *        (e.g. 'account_graph_job_abc')
     * @param string $old Previously read JSON.
     *        (e.g. the pending job)
     * @param string $json Replacement JSON.
     *        (e.g. '{"state":"sent"}')
     * @return bool Whether this worker successfully updated the option.
     */
    private function replace(string $lock, string $name, string $old, string $json): bool
    {
        $wpdb = $this->db;
        $sql = $wpdb->prepare("UPDATE {$wpdb->options} SET option_value = %s WHERE option_name = %s AND BINARY option_value = BINARY %s AND IS_USED_LOCK(%s) = CONNECTION_ID()", $json, $name, $old, $lock);
        return $this->write($sql) === 1;
    }

    /**
     * Suppress database error output because WordPress's expanded write SQL contains mapped fields.
     *
     * @param string $sql Prepared job insert or update.
     *        (e.g. an UPDATE of one private option)
     * @return int Number of affected rows, zero on a replay or a lost worker lock.
     */
    private function write(string $sql): int
    {
        $wpdb = $this->db;
        $previous = $wpdb->suppress_errors(true);
        try {
            $result = $wpdb->query($sql);
        } finally {
            $wpdb->suppress_errors($previous);
        }
        if ($result === false) {
            throw new RuntimeException('Form queue write failed.');
        }
        return (int) $result;
    }
}
