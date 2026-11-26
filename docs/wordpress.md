# WordPress forms

Use a must-use file for this integration. WordPress loads top-level PHP files in `wp-content/mu-plugins/` automatically, and an administrator cannot deactivate them on the Plugins screen. The submission hooks and scheduled worker keep running when the site changes themes. A regular plugin adds installation and activation steps, and a theme’s `functions.php` ties delivery to that theme. [WordPress must-use plugins](https://developer.wordpress.org/advanced-administration/plugins/mu-plugins/)

## Install and configure

Copy the files from the checkout into this layout. The loader includes its companion from the subdirectory. Keep the service token on the server.

```text
wp-content/mu-plugins/
  account-graph.php                     from examples/php/wordpress/
  account-graph/
    account_graph_wordpress.php         from examples/php/wordpress/
    account_graph_lib.php               from examples/php/
    account_graph_fault.php             from examples/php/
    account_graph_outbox_lib.php        from examples/php/
    account_graph_outbox_pdo.php        from examples/php/
```

Add constants to `wp-config.php` before WordPress loads. Give each independent WordPress installation a stable source name. All blogs in one multisite network can share it. The numeric blog ID distinguishes them even if their domains change. Use up to 40 letters, digits, dashes and underscores. The mapping keys under each provider are the form IDs. Map only fields dedicated to the listed identifiers. Gravity Forms input IDs can include a decimal point, so quote them as strings.

```php
define('ACCOUNT_GRAPH_URL', 'https://graph.example.org');
define('ACCOUNT_GRAPH_TOKEN', getenv('GRAPH_TOKEN'));
define('ACCOUNT_GRAPH_SOURCE', 'example-site');
define('ACCOUNT_GRAPH_FORMS', [
    'gravity' => [
        17 => ['email' => '1', 'phone' => '2', 'device' => 'ag_device'],
    ],
    'cf7' => [
        23 => ['email' => 'your-email', 'phone' => 'your-tel', 'device' => 'ag_device'],
    ],
]);

// Optional WordPress page IDs or slugs. An exclusion takes precedence.
define('ACCOUNT_GRAPH_INCLUDE_PAGES', ['contact', 'request-information']);
define('ACCOUNT_GRAPH_EXCLUDE_PAGES', ['private-contact']);
```

On `wp_enqueue_scripts`, WordPress 6.5 loads the public module `/collect.js?forms=all` through `wp_enqueue_script_module`. An empty or absent inclusion list allows all public pages. Configure the site’s origin in the graph’s `ORIGINS` and permit the graph under the site’s `script-src` and `connect-src` policies. Supply the visitor’s consent before the tag runs where required. The URL must use HTTPS except on loopback, and the browser never receives the token. [Browser tag and consent](operations.md#script-tag)

## Submission hooks

| Compatibility target | Hook and arguments | Entry identity and timing |
| --- | --- | --- |
| Gravity Forms 2.8 | `gform_after_submission($entry, $form)` receives two associative arrays. The example reads `$form['id']`, `$entry['id']`, the UTC `date_created`, the status and mapped entry fields. | The saved numeric entry ID identifies the submission. The hook runs after persistence. Spam and inactive entries are skipped. [Gravity Forms hook](https://docs.gravityforms.com/gform_after_submission/) · [Entry object](https://docs.gravityforms.com/entry-object/) |
| Contact Form 7 5.9 | `wpcf7_submit($contact_form, $result)` supplies a `WPCF7_ContactForm` and a result array. The form’s `id()` identifies it. `WPCF7_Submission::get_instance()` supplies `get_posted_data($field)` for one mapped input and `get_meta('timestamp')` for the Unix submission time. | Queue when `$result['status']` is `mail_sent` or `mail_failed`. Both represent a valid inquiry, even when the mail server fails. Validation failures, spam and aborted submissions are skipped. [CF7 5.9 submission source](https://plugins.trac.wordpress.org/browser/contact-form-7/tags/5.9/includes/submission.php) · [CF7 5.9 form source](https://plugins.trac.wordpress.org/browser/contact-form-7/tags/5.9/includes/contact-form.php) |

The collector’s submit listener adds `ag_device` and, when permitted, `ag_landing` to every POST form on an included page. Third-party POST forms on those pages also receive the hidden fields. Limit the tag to pages whose form destinations should receive them. Add `'device' => 'ag_device'` to each form map that should connect an inquiry to a visit. The integration reads the device during the live submission and saves it in the queued profile. An ordinary Gravity Forms entry retains only its numbered fields, so the hook reads `$_POST['ag_device']` while `gform_submit` still identifies that form. A later replay of the saved entry cannot reconstruct that field. For CF7, the hook reads the named posted field and uses `$_POST` for a dynamically added input missing from the form definition, after confirming `_wpcf7` matches the form.

The collector supplies `ag_speaker_device` when a control marked `data-ag-for-other` says the form is about someone else. With the collector device mapping, that ID goes into `speaker.device`. An unmapped device stays out of the profile. Existing custom device field mappings still work for first-party submissions. The integration ignores `ag_landing`, message bodies, file uploads, and unmapped inputs. When all subject identifiers are missing, a valid speaker still permits a profile. Otherwise only the inquiry can be sent. [How the collector fills forms](identify.md#hosted-forms)

### Which submissions count once

The graph subject contains `ACCOUNT_GRAPH_SOURCE`, the current blog ID, the form provider, the form ID, and the first entry ID. Profile and inquiry keys derive separately from it. Use distinct source names for independent WordPress installations that share a graph. Blog IDs are stable across a site domain change.

For each site, provider and form, submissions with the same screened identifiers share the first inquiry for ten minutes from receipt. Email case and phone punctuation are normalized. The comparison includes a mapped device and distinguishes the speaker when present. WordPress stores a salted HMAC of those fields with an expiry. The first submission fixes the original time and graph keys. Repeating a successful request after a double click or retrying mail delivery therefore counts once. A genuinely new submission with identical details during those ten minutes also counts once. Changed identifiers or the end of the window allow a new inquiry. Without any usable subject identifier, separate submissions need a shared saved entry ID to be recognized as a replay.

Gravity Forms provides a saved entry ID. CF7 core provides no durable entry ID, so the example allocates a UUID and coalesces matching submissions across requests. For a site that saves entries with Flamingo or another integration, the example runs on `wpcf7_submit` at priority 100, after normal-priority submission listeners. The site may set `ACCOUNT_GRAPH_CF7_ENTRY_ID` to a trusted callback taking the form and submission objects. It must return an existing positive decimal ID or UUID already saved when this callback runs, or `null` when the entry has yet to be saved. A known saved ID remains a replay for the lifetime of its queue row or receipt, even after the fingerprint expires. Never use a visitor-supplied field as that ID.

On upgrade, pending jobs keep their recorded keys. Existing per-blog receipts still guard their original entry IDs. A historical `KEY_REUSED` caused by two blogs sharing the old namespace needs reconciliation against the original form entry because the parked job has already cleared its profile. Verify which original entry the graph accepted. On the affected blog, remove only the confirmed refused receipt for the other entry, then replay that saved entry to use its new blog-scoped keys. Recover identifying fields from a trusted source record when available.

## Delivery and retention

The form callback records the job locally and schedules delivery. All graph calls run in the worker. WordPress options provide durable storage without a table-install hook, which must-use files cannot rely on. Each submission gets one private, non-autoloaded option with an atomic insert. The original profile and inquiry live together, so a dependency cannot be lost between inserts. Graph settings and credentials live exclusively in `wp-config.php`.

Each enqueue schedules a single `account_graph_deliver` event due immediately. Multiple enqueues can share a wake-up. A separate hourly event provides recovery if cron misses it. WordPress runs due events when WP-Cron gets execution time. A site-specific MySQL or MariaDB advisory lock admits one worker. A database-routing drop-in must keep queue reads, writes and lock operations on the same primary connection. Each acknowledged write advances the saved phase only while the worker still owns the lock and the previous option value matches. A crash after a graph commit leaves the original key available for replay. An accepted profile clears the saved facts before the inquiry is sent. A sent inquiry leaves only `{"state":"sent"}` under the submission’s option name. This receipt prevents duplicate callbacks from creating new work.

A worker handles up to 20 ready submissions per pass, schedules a continuation when it reaches that limit, and scans past jobs deferred by `Retry-After`. Cron removes expired fingerprint records in batches. Authentication, configuration and service faults returned during delivery leave the current job pending with `last_fault` set to the graph fault code. If the worker cannot construct a client, it logs the configuration fault code and retains the queue. An item refusal or invalid input parks that submission, clears its payload, and keeps the phase, key and reason or fault code for review. Its dependent inquiry stays unsent. Other submissions can proceed. Cron and WordPress requests check the oldest pending job. A queue that has waited over an hour produces one value-free warning until the backlog clears. Older jobs from before the upgrade start this clock on first observation. On quiet or fully cached sites, run due WP-Cron events from the host scheduler every minute for each blog. Without PHP execution, neither delivery nor the warning can run. Removing the integration stops its worker. Drain pending jobs first, then clear the scheduled hook during removal. [WordPress scheduled events](https://developer.wordpress.org/reference/functions/wp_schedule_event/)

Restrict access to the options table and its backups. Disable `SAVEQUERIES`, SQL logging that records values, and public debug output in production. A local persistence failure emits a fixed server-log message and lets the form finish. In that case there is no durable event to retry. Reconcile with the original saved entry when available. The form plugin’s own persistence and this post-submission hook are separate operations. Retain the short sent receipts while source hooks can replay. Apply the site’s erasure and retention rules to pending jobs, receipts and backups.

The compatibility targets are WordPress 6.5, Gravity Forms 2.8 and Contact Form 7 5.9. Use a PHP version supported by the installed WordPress and form-plugin releases. The example uses PHP 7.2-compatible syntax and was linted on PHP 8.5.6. The repository tests use small WordPress and form-hook stubs with the real graph HTTP server. A full installation of these releases was unavailable in this checkout. [WordPress script enqueue hook](https://developer.wordpress.org/reference/hooks/wp_enqueue_scripts/) · [WordPress module enqueue](https://developer.wordpress.org/reference/functions/wp_enqueue_script_module/)
