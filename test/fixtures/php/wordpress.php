<?php

// The hook callbacks run in separate PHP processes to exercise delivery from saved options.
define('ABSPATH', $argv[1] . '/');
define('ARRAY_A', 'ARRAY_A');
define('ACCOUNT_GRAPH_URL', $argv[3]);
define('ACCOUNT_GRAPH_TOKEN', 'synthetic-wordpress');
define('ACCOUNT_GRAPH_SOURCE', 'example-site');
define('ACCOUNT_GRAPH_FORMS', array(
    'gravity' => array(17 => array('email' => '1', 'phone' => '2')),
    'cf7' => array(23 => array('email' => 'your-email', 'phone' => 'your-phone'))
));
if ($argv[4] !== 'all-pages') {
    define('ACCOUNT_GRAPH_INCLUDE_PAGES', array('contact', 'private'));
    define('ACCOUNT_GRAPH_EXCLUDE_PAGES', array('private'));
}
if ($argv[4] === 'saved-cf7') {
    define('ACCOUNT_GRAPH_CF7_ENTRY_ID', 'fixture_cf7_id');
}
function fixture_cf7_id($form, $submission) { return 123; }

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
        $this->sqlite->$register('GET_LOCK', function () { return 1; }, 2);
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
        $sql = preg_replace('/ON DUPLICATE KEY UPDATE .+$/is', 'ON CONFLICT(option_name) DO NOTHING', $sql);
        $sql = str_replace('BINARY ', '', $sql);
        return $this->sqlite->exec($sql);
    }
    public function get_var($sql) { return $this->sqlite->query($sql)->fetchColumn(); }
    public function get_results($sql, $format)
    {
        // MySQL uses a backslash LIKE escape by default. SQLite requires ESCAPE.
        $sql = preg_replace("/(LIKE '[^']*')/i", "$1 ESCAPE '\\\\'", $sql);
        return $this->sqlite->query($sql)->fetchAll(PDO::FETCH_ASSOC);
    }
}
$GLOBALS['wpdb'] = new FixtureWpdb($argv[2]);
$GLOBALS['hooks'] = array();
$GLOBALS['scripts'] = array();
$GLOBALS['schedule'] = array();
$GLOBALS['page'] = 'contact';
function add_action($name, $callback, $priority = 10, $argc = 1) { $GLOBALS['hooks'][$name] = array($callback, $argc); }
function add_filter($name, $callback, $priority = 10, $argc = 1) { add_action($name, $callback, $priority, $argc); }
function invoke_hook($name, ...$args)
{
    list($callback, $count) = $GLOBALS['hooks'][$name];
    return $callback(...array_slice($args, 0, $count));
}
function wp_enqueue_script($handle, $src, $deps = array(), $version = false, $footer = false) { $GLOBALS['scripts'][] = array($handle, $src); }
function is_page($list = '') { return $list === '' || in_array($GLOBALS['page'], (array) $list, true); }
function wp_next_scheduled($hook) { return isset($GLOBALS['schedule'][$hook]) ? 1700000000 : false; }
function wp_schedule_event($time, $interval, $hook) { $GLOBALS['schedule'][$hook] = $interval; return true; }
function wp_generate_uuid4() { return '00000000-0000-4000-8000-' . bin2hex(random_bytes(6)); }
function wp_cache_delete($key, $group) {}
class WPCF7_ContactForm { public function id() { return 23; } }
class WPCF7_Submission
{
    public static $active;
    public static $reads = array();
    public static function get_instance() { return self::$active; }
    public function get_meta($key) { return $key === 'timestamp' ? 1793534400 : null; }
    public function get_posted_data($key = '')
    {
        if (!in_array($key, array('your-email', 'your-phone'), true)) throw new LogicException('Only read mapped fields');
        self::$reads[] = $key;
        return $key === 'your-email' ? 'visitor@example.org' : '+12025550143';
    }
}

require ABSPATH . 'account-graph.php';
$command = $argv[4];
if ($command === 'pages' || $command === 'all-pages') {
    $shown = array();
    foreach (array('contact', 'private', 'news') as $page) {
        $GLOBALS['page'] = $page;
        $GLOBALS['scripts'] = array();
        invoke_hook('wp_enqueue_scripts');
        if ($GLOBALS['scripts']) {
            list($id, $src) = $GLOBALS['scripts'][0];
            $shown[$page] = invoke_hook('script_loader_tag', '<script id="fixture" src="' . $src . '"></script>', $id, $src);
        }
    }
    invoke_hook('init');
    echo json_encode(array('shown' => $shown, 'schedule' => $GLOBALS['schedule'], 'other' => invoke_hook('script_loader_tag', '<script></script>', 'other', '')));
    exit;
}
if ($command === 'submit' || $command === 'storage-fault') {
    $GLOBALS['wpdb']->fail_write = $command === 'storage-fault';
    $entry = array('id' => '123', 'form_id' => 17, 'date_created' => '2026-11-01 12:00:00', '1' => 'row17@example.org', '2' => '+12025550142', '3' => 'private message');
    invoke_hook('gform_after_submission', $entry, array('id' => 17));
    invoke_hook('gform_after_submission', $entry, array('id' => 17));
    $entry['id'] = '124';
    $entry['form_id'] = 99;
    invoke_hook('gform_after_submission', $entry, array('id' => 99));
    WPCF7_Submission::$active = new WPCF7_Submission();
    $form = new WPCF7_ContactForm();
    invoke_hook('wpcf7_mail_sent', $form);
    invoke_hook('wpcf7_mail_sent', $form);
} elseif ($command === 'saved-cf7') {
    WPCF7_Submission::$active = new WPCF7_Submission();
    invoke_hook('wpcf7_mail_sent', new WPCF7_ContactForm());
} elseif ($command === 'cron') {
    invoke_hook('account_graph_deliver');
}
echo json_encode(array('rows' => $GLOBALS['wpdb']->sqlite->query('SELECT option_value,autoload FROM wp_options ORDER BY option_id')->fetchAll(PDO::FETCH_ASSOC), 'reads' => WPCF7_Submission::$reads));
