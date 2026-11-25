# PHP and CodeIgniter 3

Copy [AccountGraph.php](../examples/php/AccountGraph.php) into your application. The client targets PHP 7.2 and later. It was syntax-checked and exercised on PHP 8.5.6, including its stream transport and SQLite outbox. PHP 7.2 compatibility was checked by source review. It uses JSON and cURL, with PHP streams when cURL is absent. HTTPS needs the host's trusted CA certificates and, for streams, OpenSSL. Only loopback may use plain HTTP. The optional outbox uses PDO and the driver for the host database.

```php
require_once __DIR__ . '/AccountGraph.php';
$graph = new AccountGraph(getenv('GRAPH_URL'), getenv('GRAPH_TOKEN'), 1000, 5000, 3);
```

Give the server's base URL, such as `https://graph.example.org`. The last three arguments are the connect timeout in milliseconds, the timeout for the entire request in milliseconds per attempt, and the maximum number of attempts. On a retryable fault the client resends the request with its original keys. In a completed batch it retries only entries marked `NOT_ATTEMPTED`. The wait starts at 50 ms and doubles on each retry. Keep the bearer token in the server environment. Keep request bodies, contact details, SQL parameters and exception traces out of application logs.

## Where the calls belong

| Call | Where to use it |
| --- | --- |
| `record` | Queue one entry alongside each saved change. The worker posts it after commit. A direct batch returns `results` in entry order. Check each item's `ok`, even after a 200. |
| `decide` | Record the operator's merge or unmerge in the host and queue the decision in the same transaction. Save the reviewer ID and the decision number they saw. |
| `forget` | Queue a confirmed erasure with the host's deletion. Keep its answer for the operator who reconciles any conversions already delivered. |
| `lookup` | Request suggestions separately from creating a contact. A staff detail panel can also load a person's members, a call's party, or a journey on demand. |
| `report` | A background job builds a reporting view. Show its `asOf` time on the cached report. |
| `events` | A consumer follows events after its last saved cursor and updates the host's views. |

No graph write belongs in a page's critical path. A phone screen opens from local data and can request graph details after it opens. Keep the host's duplicate checks and save button available while a separate staff-only request asks for suggestions.

## What to queue

Use an opaque subject such as `contact:42`. On every write, save the original occurrence time as integer epoch milliseconds. For host changes, derive the key once from the source system, operation, host row ID and revision. For example, `AccountGraph::key('desk.profile', 42, 7)` identifies revision 7 of contact 42 in this host. For a call or text, `AccountGraph::providerKey($id)` checks the provider's original ID and returns it unchanged. It accepts 1–128 letters, digits, dots, dashes or underscores. A retry uses the saved request, including the same `key` and `at`. A later host edit has its own revision. On 32-bit PHP, use a whole-valued number such as `round(microtime(true) * 1000)` when capturing the time. Casting it to a PHP integer would overflow.

| Host change | Graph request |
| --- | --- |
| Contact saved | Record a `profile` with `subject` and permitted `facts`, such as an email or phone. Include `createdAt` when the host knows the original creation time. Put a representative's own details in `speaker`. |
| Contacts merged | Decide with `action: "merge"`, `pairs: [{"a":"contact:42","b":"contact:57"}]`, `by`, `key`, `at` and the `seen` from a person lookup. Keep both stable host IDs. |
| Merge undone | Decide with `action: "unmerge"`, the original pair, a new decision key, operator and time. On `STALE` or `NOT_JOINED`, show staff the current records. On success inspect `stands` and `notAsAsked`. Sharing other evidence can still join the pair. |
| Call reported | Record a `call` keyed by the provider's call ID. Supply `direction`, `to`, `from` when known (required outbound), start time and known duration in seconds. Include `result.answered` only when known. Send later results as `call_update` referencing that call key. |
| Text reported | Record a `text` keyed by the provider's message ID with `direction`, `from`, `to` and message time. When relevant, extract and send the attribution `code`. Omit ordinary message content. |
| Step reached | Record a `conversion` with a stable transaction key, subject and configured `stage`. Include value and currency if known. Queue its profile first. |
| Payment received or refunded | Record a `payment` for that ledger row, with `conversion` set to the original conversion key, `direction` of `received` or `refunded`, positive `amount` and currency. Send the amount of this payment. |
| Opt-out | Enforce the host's own suppression immediately. For an inbound SMS opt-out, queue the original text ID and time with the recognized opt-out word as its entire `text`. For withdrawn advertising permissions, record a `consent` entry on the subject with the actual booleans for `adUserData` and `adPersonalization`. |
| Erasure approved | Read and confirm the IDs in scope. Send `forget` with `key`, `at`, `by`, `subjects` (1–50) and `platforms: "report"`, or `"retract"` if supported and requested. Keep the returned `sent` list for follow-up. Clean up local copies and outbox payloads under the host's erasure policy. |

Never send case notes, medical or other health information, income, government identification numbers, transcripts or free-text descriptions. Choose allowed fields explicitly. Keep keys, tags, reviewer IDs and reasons free of those details too. PHP encodes an empty array as a JSON list. Where an empty object is allowed, such as `facts` with a speaker, use `(object) array()`. Exact fields, refusal reasons and token permissions are in the [HTTP contract](http.md).

## Install the CodeIgniter example

Copy the four directories in [codeigniter/](../examples/php/codeigniter/) into the matching directories under `application/`. Place the client in `application/third_party/AccountGraph.php`. Set `GRAPH_URL` and `GRAPH_TOKEN` for the server process and cron. The library loads its timeouts from `application/config/graph_client.php`. Use the CI3 PDO database driver for the host's connection, configure `PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION` in its `options`, and disable database debugging, query logging and the profiler in production.

```php
$this->load->library('graph_client');
$this->load->model('graph_outbox');
```

The library exposes the six methods of the standalone client. For a suggestion at contact creation, have the form make a separate authenticated request to a host endpoint. This call allows 80 ms to connect and 200 ms overall, with one attempt.

```php
try {
    $answer = $this->graph_client->suggest(array('phone' => '+12025550142'), $at);
    $candidates = $answer['candidates'];
} catch (AccountGraphFault $fault) {
    $candidates = array();
}
```

Show only candidate records the operator can already open. Label each suggestion with its host record, `level` and evidence `kinds`, such as “shared phone”. Surface any `unconfirmed` or `conflict` flag and let the operator inspect the pair. A suggestion never merges records automatically. Before confirming, use `lookup(array('kind' => 'person', 'subjects' => $pairIds, 'at' => $at))` and keep the returned `decisions` as `seen`.

## Host outbox

Create the table once in the host database. On MySQL use a transactional engine for both the contact table and the outbox.

**MySQL**

```sql
CREATE TABLE account_graph_outbox (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  record_id VARCHAR(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  call_name VARCHAR(10) NOT NULL,
  request MEDIUMTEXT NOT NULL,
  state VARCHAR(10) NOT NULL DEFAULT 'pending',
  answer MEDIUMTEXT,
  INDEX ag_outbox_record (record_id, id),
  INDEX ag_outbox_pending (state, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

**PostgreSQL**

```sql
CREATE TABLE account_graph_outbox (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  record_id VARCHAR(200) NOT NULL,
  call_name VARCHAR(10) NOT NULL,
  request TEXT NOT NULL,
  state VARCHAR(10) NOT NULL DEFAULT 'pending',
  answer TEXT
);
CREATE INDEX ag_outbox_record ON account_graph_outbox (record_id, id);
CREATE INDEX ag_outbox_pending ON account_graph_outbox (state, id);
```

Update the contact and insert the outbox row on the **same connection, in the same transaction**. The conditional update below locks the contact and checks the revision the operator edited. If two people edit it, the second save must resolve the stale revision before queuing anything. The host supplies the contact ID, email, prior revision and time of this change.

```php
$this->load->model('graph_outbox');
$this->load->database();
$db = $this->db->conn_id;
$db->beginTransaction();
try {
    $change = $db->prepare('UPDATE contacts SET email = ?, revision = revision + 1 WHERE id = ? AND revision = ?');
    $change->execute(array($email, $id, $revision));
    if ($change->rowCount() !== 1) {
        throw new RuntimeException('Contact changed before the save.');
    }
    $subject = 'contact:' . $id;
    $entry = array(
        'type' => 'profile', 'key' => AccountGraph::key('desk.profile', $id, $revision + 1),
        'at' => $at, 'subject' => $subject, 'facts' => array('email' => $email)
    );
    $this->graph_outbox->enqueue($subject, 'record', array('entries' => array($entry)));
    $db->commit();
} catch (Throwable $error) {
    $db->rollBack();
    throw $error;
}
```

Use the same `record_id` for every change that must stay in order. For a workflow that merges or erases several records, use a shared ordering group for **all** writes that may involve those records, including profiles. In that workflow lock one stable host row for the group before making the change and enqueuing it. A transaction that reserves an outbox ID and commits late can otherwise appear after its successor. The shared group can cover the whole integration on a small host. Queue each request once, with one entry per queued `record`.

Schedule the CLI worker once a minute, with the same application environment as the web process.

```cron
* * * * * cd /path/to/application-root && /usr/bin/php index.php graph_worker run
```

The worker stores the graph answer on a sent row. A lost acknowledgment leaves the request safe to repeat with its saved key. A retryable fault or an exhausted `NOT_ATTEMPTED` stays pending. An item refusal stays `refused` with its reason, and a permanent fault stays `failed`. An earlier unresolved row holds back later rows in its ordering group. Cron prints counts for that pass. Staff can find older unresolved rows with `SELECT id, state FROM account_graph_outbox WHERE state <> 'sent' ORDER BY id`. Inspect the private answer, correct a refusal or fix the configuration, then return the row to `pending`. Reconcile a `KEY_REUSED` against the host's original transaction before doing so. Restrict access to this table and expire the saved payloads when they are no longer needed.

## Read to the end

Each of the six methods returns the call's answer as PHP data. For an absent party or record, a lookup can return `null`. A fault throws `AccountGraphFault` with `faultCode`, `retryable` and `detail`. A refusal arrives as data with `ok` false, including when a different entry in the batch was accepted.

```php
foreach ($graph->reportPages(array('kind' => 'callbacks', 'window' => $window, 'at' => $at)) as $page) {
    foreach ($page['value']['rows'] as $row) {
        saveCallbackForStaff($row);
    }
}
foreach ($graph->eventPages(array('after' => $savedCursor, 'limit' => 100)) as $page) {
    if (!$page['ok']) {
        // CURSOR_LOST means the next pass must start at the oldest retained event.
        scheduleReplayFromTheBeginning();
        break;
    }
    applyEventsAndSaveCursor($page['value']['events'], $page['value']['cursor']);
}
```

The host supplies the functions that save rows and cursors. Apply event effects and save the cursor together, with effects safe to repeat on restart. On `CURSOR_LOST`, clear the checkpoint, reconcile the host view and replay from `null`. The report helper follows `value.next` for `callbacks` and `texts`. Use `journeyPages` for the `next` cursor of a journey lookup.
