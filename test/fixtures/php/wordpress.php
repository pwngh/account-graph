<?php

// The hook callbacks run in separate PHP processes to exercise delivery from saved options.
define('ABSPATH', $argv[1] . '/');
define('ARRAY_A', 'ARRAY_A');
define('ACCOUNT_GRAPH_URL', $argv[3]);
define('ACCOUNT_GRAPH_TOKEN', 'synthetic-wordpress');
define('ACCOUNT_GRAPH_SOURCE', 'example-site');
$input = json_decode($argv[5] ?? '{}', true);
$configured_device = empty($input['no_device']) ? array('device' => 'ag_device') : array();
$gravity_form = array('email' => '1', 'phone' => '2') + $configured_device;
$cf7_form = array('email' => 'your-email', 'phone' => 'your-phone') + $configured_device;
// Plain form IDs belong to blog 1. Blog 4 reuses both form numbers for unrelated forms.
define('ACCOUNT_GRAPH_FORMS', array(
    'gravity' => array(17 => $gravity_form, '2:17' => $gravity_form, '3:17' => $gravity_form),
    'cf7' => array(23 => $cf7_form, '2:23' => $cf7_form, '3:23' => $cf7_form)
));
if ($argv[4] !== 'all-pages') {
    define('ACCOUNT_GRAPH_INCLUDE_PAGES', array('contact', 'private'));
    define('ACCOUNT_GRAPH_EXCLUDE_PAGES', array('private'));
}
if ($argv[4] === 'saved-cf7' || isset($input['saved_id'])) {
    define('ACCOUNT_GRAPH_CF7_ENTRY_ID', 'fixture_cf7_id');
}
function fixture_cf7_id($form, $submission) { return $GLOBALS['published_cf7_id'] ?? null; }
function get_current_blog_id() { return $GLOBALS['input']['blog'] ?? 1; }
function wp_salt($scheme) { return 'synthetic-wordpress-site-secret'; }
function wp_unslash($value) { return stripslashes($value); }

class FixtureWpdb
{
    public $options = 'wp_options';
    public $sqlite;
    public $fail_write = false;
    private $silent = false;
    public function __construct($file)
    {
        $class = class_exists('Pdo\Sqlite') ? 'Pdo\Sqlite' : 'PDO';
        $this->sqlite = new $class('sqlite:' . $file, null, null, array(PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION));
        $register = method_exists($this->sqlite, 'createFunction') ? 'createFunction' : 'sqliteCreateFunction';
        $this->sqlite->exec('CREATE TABLE IF NOT EXISTS wp_options (option_id INTEGER PRIMARY KEY, option_name TEXT UNIQUE, option_value TEXT NOT NULL, autoload TEXT NOT NULL)');
        // Another worker holds every lock while the input says so.
        $this->sqlite->$register('GET_LOCK', function () { return empty($GLOBALS['input']['lock_busy']) ? 1 : 0; }, 2);
        $this->sqlite->$register('RELEASE_LOCK', function () { return 1; }, 1);
        $this->sqlite->$register('IS_USED_LOCK', function () { return 17; }, 1);
        $this->sqlite->$register('CONNECTION_ID', function () { return 17; }, 0);
    }
    public function suppress_errors($flag = true)
    {
        $old = $this->silent;
        $this->silent = $flag;
        return $old;
    }
    public function esc_like($s) { return addcslashes($s, '_%\\'); }
    public function prepare($sql, ...$args)
    {
        if (isset($args[0]) && is_array($args[0])) $args = $args[0];
        return preg_replace_callback('/%[ds]/', function ($match) use (&$args) {
            $arg = array_shift($args);
            return $match[0] === '%d' ? (string) (int) $arg : $this->sqlite->quote($arg);
        }, $sql);
    }
    public function query($sql)
    {
        if ($this->fail_write) throw new RuntimeException('Local storage unavailable');
        $sql = preg_replace('/ON DUPLICATE KEY UPDATE option_value\s*=/i', 'ON CONFLICT(option_name) DO UPDATE SET option_value =', $sql);
        $sql = preg_replace('/ON DUPLICATE KEY UPDATE option_name\s*=\s*option_name/i', 'ON CONFLICT(option_name) DO NOTHING', $sql);
        $sql = preg_replace('/^DELETE FROM wp_options WHERE (.*) LIMIT (\d+)$/is', 'DELETE FROM wp_options WHERE option_id IN (SELECT option_id FROM wp_options WHERE $1 LIMIT $2)', $sql);
        $sql = $this->like($sql);
        if (preg_match('/(?<!AS )\bBINARY\b(?!\))/', $sql)) {
            // MySQL 8.0.27 and later warn about the BINARY operator.
            fwrite(STDERR, "'BINARY expr' is deprecated and will be removed in a future release. Please use CAST instead\n");
        }
        $sql = str_replace('AS BINARY)', 'AS BLOB)', $sql);
        return $this->sqlite->exec($sql);
    }
    public function get_var($sql)
    {
        $value = $this->sqlite->query($this->like($sql))->fetchColumn();
        return $value === false ? null : $value;
    }
    public function get_results($sql, $format)
    {
        return $this->sqlite->query($this->like($sql))->fetchAll(PDO::FETCH_ASSOC);
    }
    private function like($sql)
    {
        // MySQL uses a backslash LIKE escape by default. SQLite requires ESCAPE.
        $sql = preg_replace("/(LIKE '[^']*')/i", "$1 ESCAPE '\\\\'", $sql);
        return $sql;
    }
}
$GLOBALS['wpdb'] = new FixtureWpdb($argv[2]);
$GLOBALS['hooks'] = array();
$GLOBALS['scripts'] = array();
$GLOBALS['schedule'] = array();
$GLOBALS['singles'] = array();
$GLOBALS['page'] = 'contact';
function add_action($name, $callback, $priority = 10, $argc = 1) { $GLOBALS['hooks'][$name][$priority][] = array($callback, $argc); }
function add_filter($name, $callback, $priority = 10, $argc = 1) { add_action($name, $callback, $priority, $argc); }
function invoke_hook($name, ...$args)
{
    if (!isset($GLOBALS['hooks'][$name])) return null;
    ksort($GLOBALS['hooks'][$name]);
    $result = null;
    foreach ($GLOBALS['hooks'][$name] as $listeners) {
        foreach ($listeners as list($callback, $count)) {
            $result = $callback(...array_slice($args, 0, $count));
        }
    }
    return $result;
}
function wp_enqueue_script($handle, $src, $deps = array(), $version = false, $footer = false) { $GLOBALS['scripts'][] = array('classic', $src); }
function wp_enqueue_script_module($id, $src, $deps = array(), $version = false) { $GLOBALS['scripts'][] = array('module', $src); }
function is_page($list = '') { return $list === '' || in_array($GLOBALS['page'], (array) $list, true); }
function wp_next_scheduled($hook, $args = array())
{
    foreach ($GLOBALS['singles'] as $event) {
        if ($event['hook'] === $hook && $event['args'] === $args) return $event['due'];
    }
    return !$args && isset($GLOBALS['schedule'][$hook]) ? time() + 60 : false;
}
function wp_schedule_single_event($due, $hook, $args = array())
{
    $scheduled = wp_next_scheduled($hook, $args);
    if ($scheduled && abs($scheduled - $due) < 600) return false;
    $GLOBALS['singles'][] = array('due' => $due, 'hook' => $hook, 'args' => $args);
    return true;
}
function wp_schedule_event($time, $interval, $hook) { $GLOBALS['schedule'][$hook] = $interval; return true; }
function wp_generate_uuid4() { return '00000000-0000-4000-8000-' . bin2hex(random_bytes(6)); }
function get_transient($key) { return $GLOBALS['transients'][$key] ?? false; }
function set_transient($key, $value, $ttl) { $GLOBALS['transients'][$key] = $value; return true; }
class WPCF7_ContactForm { public function id() { return 23; } }
class WPCF7_Submission
{
    public static $active;
    public static $reads = array();
    public static function get_instance() { return self::$active; }
    public function get_meta($key) { return $key === 'timestamp' ? ($GLOBALS['input']['at'] ?? 1793534400) : null; }
    public function get_posted_data($key = '')
    {
        if (!in_array($key, array('your-email', 'your-phone', 'ag_device', 'ag_speaker_device'), true)) throw new LogicException('Only read mapped fields');
        self::$reads[] = $key;
        if ($key === 'your-email') return $GLOBALS['input']['email'] ?? 'visitor@example.org';
        if ($key === 'your-phone') return $GLOBALS['input']['phone'] ?? '+12025550143';
        return $GLOBALS['input']['registered'][$key] ?? null;
    }
}

require ABSPATH . 'account-graph.php';
// A normal-priority entry store publishes its ID after CF7 finishes processing the submission.
add_action('wpcf7_submit', function () { $GLOBALS['published_cf7_id'] = $GLOBALS['input']['saved_id'] ?? 123; }, 10, 2);
$command = $argv[4];
if ($command === 'pages' || $command === 'all-pages') {
    $shown = array();
    foreach (array('contact', 'private', 'news') as $page) {
        $GLOBALS['page'] = $page;
        $GLOBALS['scripts'] = array();
        invoke_hook('wp_enqueue_scripts');
        if ($GLOBALS['scripts']) $shown[$page] = $GLOBALS['scripts'][0];
    }
    invoke_hook('init');
    echo json_encode(array('shown' => $shown, 'schedule' => $GLOBALS['schedule']));
    exit;
}
if ($command === 'expire-window') {
    $GLOBALS['wpdb']->sqlite->exec("UPDATE wp_options SET option_value = '000000000001' || SUBSTR(option_value, 13) WHERE option_name GLOB 'account_graph_recent_*'");
} elseif ($command === 'age-receipts') {
    $db = $GLOBALS['wpdb']->sqlite;
    $change = $db->prepare('UPDATE wp_options SET option_value = ? WHERE option_name = ?');
    foreach ($input['ages'] as $id => $days) {
        $receipt = array('state' => 'sent');
        if ($days !== null) $receipt['sent_at'] = time() - $days * 86400;
        $name = 'account_graph_job_' . sha1('wp:example-site:1:gravity:17:' . $id);
        $change->execute(array(json_encode($receipt), $name));
    }
} elseif ($command === 'age') {
    $stmt = $GLOBALS['wpdb']->sqlite->query("SELECT option_id, option_value FROM wp_options WHERE option_name GLOB 'account_graph_job_*' AND option_value LIKE '%\"state\":\"pending\"%' ORDER BY option_id LIMIT 1");
    $first = $stmt->fetch(PDO::FETCH_ASSOC);
    $job = json_decode($first['option_value'], true);
    $job['queued_at'] = time() - ($input['age'] ?? 3601);
    $GLOBALS['wpdb']->sqlite->prepare('UPDATE wp_options SET option_value = ? WHERE option_id = ?')->execute(array(json_encode($job), $first['option_id']));
} elseif ($command === 'inspect') {
    invoke_hook('init');
} elseif ($command === 'cron') {
    invoke_hook('account_graph_deliver');
} else {
    // Model the existing recurring event due shortly after the form POST.
    $GLOBALS['schedule']['account_graph_deliver'] = 'hourly';
    $GLOBALS['wpdb']->fail_write = $command === 'storage-fault';
    if (in_array($command, array('gravity', 'submit', 'storage-fault'), true)) {
        $_POST = ($input['post'] ?? array()) + array('gform_submit' => '17');
        $entry = array('id' => (string) ($input['id'] ?? '123'), 'form_id' => 17, 'date_created' => gmdate('Y-m-d H:i:s', $input['at'] ?? 1793534400),
            '1' => $input['email'] ?? 'row17@example.org', '2' => $input['phone'] ?? '+12025550142', '3' => 'private message');
        invoke_hook('gform_after_submission', $entry, array('id' => 17));
        invoke_hook('gform_after_submission', $entry, array('id' => 17));
        $entry['id'] = '124';
        $entry['form_id'] = 99;
        invoke_hook('gform_after_submission', $entry, array('id' => 99));
    }
    if (in_array($command, array('cf7', 'saved-cf7', 'submit', 'storage-fault'), true)) {
        $_POST = ($input['post'] ?? array()) + array('_wpcf7' => '23');
        WPCF7_Submission::$active = new WPCF7_Submission();
        $form = new WPCF7_ContactForm();
        $result = array('contact_form_id' => 23, 'status' => $input['status'] ?? 'mail_sent', 'message' => 'private message');
        invoke_hook('wpcf7_submit', $form, $result);
        invoke_hook('wpcf7_submit', $form, $result);
    }
}
$db = $GLOBALS['wpdb']->sqlite;
$rows = $db->query("SELECT option_value,autoload FROM wp_options WHERE option_name GLOB 'account_graph_job_*' AND option_value NOT LIKE '{\"state\":\"alias\",%' ORDER BY option_id")->fetchAll(PDO::FETCH_ASSOC);
$deadlines = $db->query("SELECT CAST(SUBSTR(option_value, 1, 12) AS INTEGER) FROM wp_options WHERE option_name GLOB 'account_graph_recent_*'")->fetchAll(PDO::FETCH_COLUMN);
$aliases = $db->query("SELECT option_name FROM wp_options WHERE option_name GLOB 'account_graph_job_*' AND option_value LIKE '{\"state\":\"alias\",%' ORDER BY option_id")->fetchAll(PDO::FETCH_COLUMN);
echo json_encode(array('rows' => $rows, 'deadlines' => $deadlines, 'aliases' => $aliases, 'reads' => WPCF7_Submission::$reads, 'singles' => $GLOBALS['singles']));
