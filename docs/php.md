# PHP and CodeIgniter 3

Copy the lowercase PHP files at the top of [examples/php](../examples/php/) into one directory. Require `account_graph_lib.php` for the six calls or `account_graph_outbox_lib.php` for the outbox and client together. WordPress sites can use the [must-use integration](wordpress.md). The client targets PHP 7.2 and later. It was syntax-checked and exercised on PHP 8.5.6, including its stream transport and SQLite outbox. PHP 7.2 compatibility was checked by source review. It uses JSON and cURL, with PHP streams when cURL is absent. HTTPS needs the host's trusted CA certificates and, for streams, OpenSSL. Only loopback may use plain HTTP. The standalone outbox uses PDO. The CodeIgniter model uses the host’s existing query builder and connection.

```php
require_once __DIR__ . '/account_graph_lib.php';
$config = array(
    'Base_Url' => getenv('GRAPH_URL'),
    'Token' => getenv('GRAPH_TOKEN'),
    'Connect_Timeout_Ms' => 1000,
    'Timeout_Ms' => 35000,
    'Attempts' => 3
);
$graph = new account_graph_lib($config);
```

Supply `Base_Url` (such as `https://graph.example.org`) and a service or reviewer `Token`. The other settings are optional. The example shows their defaults. `Connect_Timeout_Ms` limits connection setup, `Timeout_Ms` covers the whole attempt, and `Attempts` includes the first send. On a retryable fault the client resends the request with its original keys. In a completed batch it retries only entries marked `NOT_ATTEMPTED`. The default attempt allows 35 seconds because the graph has a 30-second record budget and the reply must travel back.

The wait starts at 50 ms and doubles on each retry. `Retry-After` can extend it by up to 15 minutes. A zero, negative or past value leaves the normal backoff in effect. For a wait over five seconds the client returns the fault so a worker can schedule the retry. A standalone caller can pass `$fault->detail['retryAfter'] ?? null` to `account_graph_lib::retry_at()` for the capped Unix timestamp in seconds. A TLS verification or handshake failure reports `CONFIG.INVALID` with a TLS detail. A timeout reports `TRANSPORT.INDETERMINATE` because a write may already have committed. Keep the bearer token in the server environment. Keep request bodies, contact details, SQL parameters and exception traces out of application logs.

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

Use an opaque subject such as `contact:42`. On every write, save the original occurrence time as integer epoch milliseconds. For host changes, derive the key once from the source system, operation, host row ID and revision. For example, `account_graph_lib::key('desk.profile', 42, 7)` identifies revision 7 of contact 42 in this host. For a call or text, `account_graph_lib::provider_key($id)` checks the provider's original ID and returns it unchanged. It accepts 1–128 letters, digits, dots, dashes or underscores. A retry uses the saved request, including the same `key` and `at`. A later host edit has its own revision. On 32-bit PHP, use a whole-valued number such as `round(microtime(true) * 1000)` when capturing the time. Casting it to a PHP integer would overflow.

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

Copy the lowercase library files to `application/third_party/`. Copy the directories in [codeigniter/](../examples/php/codeigniter/) into the matching directories under `application/`. CI3 looks for an initial capital in a library filename. The files under `application/libraries/` let its loader find the shared classes on a case-sensitive host. Set `GRAPH_URL` and `GRAPH_TOKEN` in the server and cron environments. The supplied `application/config/account_graph_lib.php` reads them when CI3 constructs the client. Keep exception traces, the profiler and saved SQL queries out of logs containing contact data or credentials.

```php
$this->load->library('account_graph_lib');
$this->load->model('graph_outbox');
```

When the host already has the settings array, it can call `$this->load->library('account_graph_lib', $config)` directly. The model queues changes on the host's existing mysqli or PDO transaction and uses its configured error mode. It submits builder-escaped writes through the driver so CI3's query history and SQL error log omit the payload.

For a suggestion at contact creation, have the form make a separate authenticated request to a host endpoint. Load a client for that endpoint with an 80 ms connect timeout, a 200 ms overall deadline and one attempt. A synchronous DNS resolver on an older host can exceed the socket deadline, so keep the form independent of the suggestion request.

```php
try {
    $config = array('Base_Url' => getenv('GRAPH_URL'), 'Token' => getenv('GRAPH_TOKEN'),
        'Connect_Timeout_Ms' => 80, 'Timeout_Ms' => 200, 'Attempts' => 1);
    $this->load->library('account_graph_lib', $config, 'suggestions');
    $answer = $this->suggestions->lookup(array('kind' => 'match', 'facts' => array('phone' => '+12025550142'), 'at' => $at));
    $candidates = $answer['candidates'];
} catch (account_graph_fault $fault) {
    $candidates = array();
}
```

Show only candidate records the operator can already open. Label each suggestion with its host record, `level` and evidence `kinds`, such as “shared phone”. Surface any `unconfirmed` or `conflict` flag and let the operator inspect the pair. A suggestion never merges records automatically. Before confirming, use `lookup(array('kind' => 'person', 'subjects' => $pairIds, 'at' => $at))` and keep the returned `decisions` as `seen`.

## Host outbox

Create the table once in the host database. If the CI3 connection has a table prefix, apply it to the table name in the SQL below. On MySQL use a transactional engine for both the contact table and the outbox.

**MySQL**

```sql
CREATE TABLE account_graph_outbox (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  record_id VARCHAR(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  call_name VARCHAR(10) NOT NULL,
  item_kind TEXT NOT NULL,
  item_key MEDIUMTEXT NOT NULL,
  request MEDIUMTEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  depends_on BIGINT UNSIGNED,
  INDEX ag_outbox_dependency (depends_on),
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
  item_kind TEXT NOT NULL,
  item_key TEXT NOT NULL,
  request TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  depends_on BIGINT,
  state VARCHAR(10) NOT NULL DEFAULT 'pending',
  answer TEXT
);
CREATE INDEX ag_outbox_dependency ON account_graph_outbox (depends_on);
CREATE INDEX ag_outbox_record ON account_graph_outbox (record_id, id);
CREATE INDEX ag_outbox_pending ON account_graph_outbox (state, id);
```

Update the contact and insert the outbox row on the **same connection, in the same transaction**. The conditional update below locks the contact and checks the revision the operator edited. If two people edit it, the second save must resolve the stale revision before queuing anything. The host supplies the contact ID, email, prior revision and time of this change. On older mysqli drivers that expose no transaction state, the producer owns this boundary. Run the worker on its own idle connection.

```php
$this->load->model('graph_outbox');
$this->load->database();
$db = $this->db;
if (!$db->trans_begin()) {
    throw new RuntimeException('Could not start the contact save.');
}
try {
    $changed = $db->where('id', $id)->where('revision', $revision)
        ->update('contacts', array('email' => $email, 'revision' => $revision + 1));
    if (!$changed || $db->affected_rows() !== 1) {
        throw new RuntimeException('Contact could not be saved at this revision.');
    }
    $subject = 'contact:' . $id;
    $entry = array(
        'type' => 'profile', 'key' => account_graph_lib::key('desk.profile', $id, $revision + 1),
        'at' => $at, 'subject' => $subject, 'facts' => array('email' => $email)
    );
    $outboxId = $this->graph_outbox->enqueue($subject, 'record', array('entries' => array($entry)), null, $dropped);
    if (!$db->trans_status() || !$db->trans_commit()) {
        throw new RuntimeException('Contact save did not commit.');
    }
} catch (Throwable $error) {
    $db->trans_rollback();
    throw $error;
}
```

The producer screens profile facts before storing the JSON. It drops unknown fields, malformed email addresses, unusable phone formats, invalid devices and IP addresses, incomplete names and addresses, invalid calendar dates or dates outside the required format, and malformed identifier strings. It keeps usable fields from the same profile. With only a name or no facts and no usable speaker, `enqueue` returns `false` and the host can still commit its contact. A valid speaker permits empty subject facts. The graph applies its policy, country rules and provider checks to what remains.

In the example, `$dropped` receives a fresh map of field paths to reasons. When `$outboxId === false`, use those reasons to tell staff why the profile was skipped. A partially accepted profile can also have entries in `$dropped`. Known fields have paths such as `facts.email`. Unknown names are grouped under a path such as `facts.*`, since a form can put contact details in a field name. Reasons omit the submitted values. With standalone PDO, pass the same final argument to `account_graph_outbox_lib::enqueue($db, $subject, 'record', $request, null, $dropped)`.

Use one `record_id` per record to preserve send order. A shared group also works for edits spanning multiple records, provided producers lock a common host row before allocating outbox IDs. A commit that arrives late can otherwise become visible after its successor. Each queued `record` carries one entry.

On insert, `enqueue` returns the outbox ID as a decimal string. Pass that ID as the optional fourth argument to the CI model (fifth to standalone `enqueue`) when a later write requires that **specific earlier write** to succeed. For example, a restatement that corrects a conversion can depend on the conversion row. The writer declares this dependency when it knows the business relationship. Sharing a contact or ordering group alone does not declare a dependency. If a proposed prerequisite was screened out, handle that case at the host before enqueueing a dependent write.

**Link successive `decide` entries for the same pair with `depends_on`.** A merge followed by an unmerge, or a split followed by an unsplit, must reach the graph in that order. After a repair, the worker can send an older row after a newer one. A late profile is safe in this respect because its sightings carry the original event time (`at`), and its standing `createdAt` is ordered by `at`, then `key`. Replaying paired decisions out of order can change which decision stands.

Under the host lock for the pair, read its previous outstanding decision's outbox ID, or use `null` if there is none. Use the same group and predecessor whether staff select A then B or B then A. Store the returned ID with the host decision in the same transaction so the next edit can depend on it.

```php
$decisionRowId = $this->graph_outbox->enqueue($pairGroup, 'decide', $decision, $previousDecisionRowId);
```

Schedule the CLI worker once a minute, with the same application environment as the web process.

```cron
* * * * * cd /path/to/application-root && /usr/bin/php index.php graph_worker run
```

On success the worker saves the answer, item kind and key and clears the request body in the same transaction. A lost acknowledgment leaves the original key safe to repeat. A fresh authentication, configuration, graph or transport fault ends the current pass. The row stays pending with the fault in `answer`. If the answer has a `retry_at` deadline, subsequent passes hold later writes in that row's group and continue sending independent groups. The worker persists the deadline across restarts and shortens any previously saved deadline beyond 15 minutes to 15 minutes from the time it first reads it. Cron counts a waiting row under `pending`. Its saved answer gives staff the fault code and the retry time in Unix seconds. An exhausted `NOT_ATTEMPTED` also stays pending.

An item refusal stays `refused` with the full answer. A malformed or oversized write stays `failed` with the input fault and its detail. The worker continues with independent changes, including later changes to the same record. A write whose explicit prerequisite was set aside becomes `blocked`. Once the prerequisite succeeds, a later pass picks up its children. Staff can inspect unresolved rows with `SELECT id, item_kind, state, depends_on FROM account_graph_outbox WHERE state <> 'sent' ORDER BY id`. Resolve the cause before returning a refused or malformed row to `pending`. Verify a `KEY_REUSED` against the original host transaction.

Choose a retention period for the remaining answers and identifiers. For example, a daily cleanup can run `DELETE FROM account_graph_outbox WHERE state = 'sent' AND created_at < ?` with a bound UTC cutoff 30 days ago. The producer checks the prerequisite exists with an ordinary read. A foreign key on MySQL would make that insert wait while a worker sends the parent. Once a dependency has been admitted, the worker treats a missing parent as a successful row removed by this cleanup. Delete only successful rows automatically. Restrict access to unsent requests and review them on a schedule. For erasure, reconcile or cancel outstanding dependent writes before deleting their prerequisite.

## Upgrading an existing outbox

Pause producers and cron while upgrading. Existing rows acquire the migration time as their creation time. Copy the original key and kind before clearing sent bodies. Both migrations return previously failed service requests to the queue, preserving their original keys. Existing rows have no declared dependency.

**MySQL upgrade (5.7.8 or later)**

```sql
ALTER TABLE account_graph_outbox
  MODIFY request MEDIUMTEXT NULL,
  ADD COLUMN item_kind TEXT, ADD COLUMN item_key MEDIUMTEXT,
  ADD COLUMN created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN depends_on BIGINT UNSIGNED,
  ADD INDEX ag_outbox_dependency (depends_on);
UPDATE account_graph_outbox SET
  item_kind = COALESCE(CASE WHEN call_name = 'record' THEN JSON_UNQUOTE(JSON_EXTRACT(request, '$.entries[0].type')) ELSE call_name END, call_name),
  item_key = CASE WHEN call_name = 'record' THEN JSON_UNQUOTE(JSON_EXTRACT(request, '$.entries[0].key')) ELSE JSON_UNQUOTE(JSON_EXTRACT(request, '$.key')) END;
ALTER TABLE account_graph_outbox MODIFY item_kind TEXT NOT NULL, MODIFY item_key MEDIUMTEXT NOT NULL;
UPDATE account_graph_outbox SET request = NULL WHERE state = 'sent';
UPDATE account_graph_outbox SET state = 'pending' WHERE state = 'failed'
  AND JSON_UNQUOTE(JSON_EXTRACT(answer, '$.fault.code')) NOT IN ('INPUT.MALFORMED', 'INPUT.TOO_LARGE');
```

**PostgreSQL upgrade**

```sql
BEGIN;
ALTER TABLE account_graph_outbox ALTER COLUMN request DROP NOT NULL,
  ADD COLUMN item_kind TEXT, ADD COLUMN item_key TEXT,
  ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN depends_on BIGINT;
UPDATE account_graph_outbox SET
  item_kind = COALESCE(CASE WHEN call_name = 'record' THEN request::json #>> '{entries,0,type}' ELSE call_name END, call_name),
  item_key = CASE WHEN call_name = 'record' THEN request::json #>> '{entries,0,key}' ELSE request::json ->> 'key' END;
ALTER TABLE account_graph_outbox ALTER COLUMN item_kind SET NOT NULL, ALTER COLUMN item_key SET NOT NULL;
CREATE INDEX ag_outbox_dependency ON account_graph_outbox (depends_on);
UPDATE account_graph_outbox SET request = NULL WHERE state = 'sent';
UPDATE account_graph_outbox SET state = 'pending' WHERE state = 'failed'
  AND answer::jsonb #>> '{fault,code}' NOT IN ('INPUT.MALFORMED', 'INPUT.TOO_LARGE');
COMMIT;
```

## Read to the end

Each of the six methods returns the call's answer as PHP data. For an absent party or record, a lookup can return `null`. A fault throws `account_graph_fault` with `fault_code`, `retryable` and `detail`. A refusal arrives as data with `ok` false, including when a different entry in the batch was accepted.

```php
foreach ($graph->report_pages(array('kind' => 'callbacks', 'window' => $window, 'at' => $at)) as $page) {
    foreach ($page['value']['rows'] as $row) {
        saveCallbackForStaff($row);
    }
}
foreach ($graph->event_pages(array('after' => $savedCursor, 'limit' => 100)) as $page) {
    if (!$page['ok']) {
        // CURSOR_LOST means the next pass must start at the oldest retained event.
        scheduleReplayFromTheBeginning();
        break;
    }
    applyEventsAndSaveCursor($page['value']['events'], $page['value']['cursor']);
}
```

The host supplies the functions that save rows and cursors. Apply event effects and save the cursor together, with effects safe to repeat on restart. On `CURSOR_LOST`, clear the checkpoint, reconcile the host view and replay from `null`. The report helper follows `value.next` for `callbacks` and `texts`. Use `journey_pages` for the `next` cursor of a journey lookup.
