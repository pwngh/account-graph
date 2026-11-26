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

Add constants to `wp-config.php` before WordPress loads. Give each site that writes to the same graph a different stable source name. Use up to 40 letters, digits, dashes and underscores. The mapping keys under each provider are the form IDs. Map only fields dedicated to the listed identifiers. Gravity Forms input IDs can include a decimal point, so quote them as strings.

```php
define('ACCOUNT_GRAPH_URL', 'https://graph.example.org');
define('ACCOUNT_GRAPH_TOKEN', getenv('GRAPH_TOKEN'));
define('ACCOUNT_GRAPH_SOURCE', 'example-site');
define('ACCOUNT_GRAPH_FORMS', [
    'gravity' => [
        17 => ['email' => '1', 'phone' => '2'],
    ],
    'cf7' => [
        23 => ['email' => 'your-email', 'phone' => 'your-tel'],
    ],
]);

// Optional WordPress page IDs or slugs. An exclusion takes precedence.
define('ACCOUNT_GRAPH_INCLUDE_PAGES', ['contact', 'request-information']);
define('ACCOUNT_GRAPH_EXCLUDE_PAGES', ['private-contact']);
```

On `wp_enqueue_scripts`, the loader enqueues the graph’s public `/collect.js`. Its `script_loader_tag` filter sets `type="module"` for that handle. An empty or absent inclusion list allows all public pages. Configure the site’s origin in the graph’s `ORIGINS` and permit the graph under the site’s `script-src` and `connect-src` policies. Supply the visitor’s consent before the tag runs where required. The URL must use HTTPS except on loopback, and the browser never receives the token. [Browser tag and consent](operations.md#script-tag)

## Submission hooks

| Compatibility target | Hook and arguments | Entry identity and timing |
| --- | --- | --- |
| Gravity Forms 2.8 | `gform_after_submission($entry, $form)` receives two associative arrays. The example reads `$form['id']`, `$entry['id']`, the UTC `date_created`, the status and mapped entry fields. | The saved numeric entry ID identifies the submission. The hook runs after persistence. Spam and inactive entries are skipped. [Gravity Forms hook](https://docs.gravityforms.com/gform_after_submission/) · [Entry object](https://docs.gravityforms.com/entry-object/) |
| Contact Form 7 5.9 | `wpcf7_mail_sent($contact_form)` supplies a `WPCF7_ContactForm`. Its `id()` identifies the form. `WPCF7_Submission::get_instance()` supplies `get_posted_data($field)` for one mapped input and `get_meta('timestamp')` for the Unix submission time. | Queue after successful mail processing, so validation failures, spam and mail failures do not count as inquiries. The hook confirms that CF7 reports sending the mail, without guaranteeing delivery to a mailbox. [CF7 5.9 submission source](https://plugins.trac.wordpress.org/browser/contact-form-7/tags/5.9/includes/submission.php) · [CF7 5.9 form source](https://plugins.trac.wordpress.org/browser/contact-form-7/tags/5.9/includes/contact-form.php) |

Core CF7 provides a form ID and a submission object but no persistent entry ID. The example assigns a UUID once to each accepted submission object and persists it with the job. Repeated callbacks on that object and later cron retries use the original keys. A second independent HTTP submission receives a new UUID, even when the submitted fields match. A site that already saves CF7 entries can define `ACCOUNT_GRAPH_CF7_ENTRY_ID` as the name of a trusted callback accepting the form and submission objects and returning the saved positive decimal ID or UUID. That ID also makes later replays from a different process idempotent. Never use a posted field, form ID alone, email, or hash of the message as the entry ID.

Each configured submission yields a subject scoped by site, form provider, form ID and entry ID. The job holds a profile followed by a conversion at the `inquiry` step. Keys for the two writes are derived separately from that subject. The stored time and payload stay fixed on retry. A duplicate hook preserves the first job. Unmapped forms are ignored. The permitted mapping targets are `email`, `phone`, and an optional `device` from a dedicated device-ID field. Ordinary message bodies, uploaded files, case notes and unmapped fields are never copied into the job. When no mapped identifier survives screening, the worker sends only the inquiry because the graph requires a usable fact for a profile.

## Delivery and retention

The form callback makes one local queue insert. It never calls the graph. WordPress options provide durable storage without a table-install hook, which must-use files cannot rely on. Each submission gets one private, non-autoloaded option with an atomic insert. The original profile and inquiry live together, so a dependency cannot be lost between inserts. Graph settings and credentials live exclusively in `wp-config.php`.

WordPress schedules `account_graph_deliver` hourly. A site-specific MySQL or MariaDB advisory lock admits one worker. A database-routing drop-in must keep queue reads, writes and lock operations on the same primary connection. Each acknowledged write advances the saved phase only while the worker still owns the lock and the previous option value matches. A crash after a graph commit leaves the original key available for replay. An accepted profile clears the saved facts before the inquiry is sent. A sent inquiry leaves only `{"state":"sent"}` under the submission’s option name. This receipt prevents duplicate callbacks from creating new work.

A worker handles up to 20 ready submissions per pass and scans past jobs deferred by `Retry-After`. Authentication, configuration and service faults returned during delivery leave the current job pending with `last_fault` set to the graph fault code. If the worker cannot construct a client, it logs the configuration fault code and retains the queue. An item refusal or invalid input parks that submission, clears its payload, and keeps the phase, key and reason or fault code for review. Its dependent inquiry stays unsent. Other submissions can proceed. For a quiet site, run WP-Cron from the host scheduler so due events run without page visits. Removing the integration stops its worker. Drain pending jobs first, then clear the scheduled hook during removal. [WordPress scheduled events](https://developer.wordpress.org/reference/functions/wp_schedule_event/)

Restrict access to the options table and its backups. Disable `SAVEQUERIES`, SQL logging that records values, and public debug output in production. A local persistence failure emits a fixed server-log message and lets the form finish. In that case there is no durable event to retry. Reconcile with the original saved entry when available. The form plugin’s own persistence and this post-submission hook are separate operations. Retain the short sent receipts while source hooks can replay. Apply the site’s erasure and retention rules to pending jobs, receipts and backups.

The compatibility targets are WordPress 6.5, Gravity Forms 2.8 and Contact Form 7 5.9. Use a PHP version supported by the installed WordPress and form-plugin releases. The example uses PHP 7.2-compatible syntax and was linted on PHP 8.5.6. The repository tests use small WordPress and form-hook stubs with the real graph HTTP server. A full installation of these releases was unavailable in this checkout. [WordPress script enqueue hook](https://developer.wordpress.org/reference/hooks/wp_enqueue_scripts/) · [WordPress script tag filter](https://developer.wordpress.org/reference/hooks/script_loader_tag/)
