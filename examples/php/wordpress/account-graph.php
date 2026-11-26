<?php
/**
 * Plugin Name: Account graph form submissions
 * Description: Load the graph collector and deliver mapped form submissions from WP-Cron.
 * Requires at least: 6.5
 * Requires PHP: 7.2
 *
 * @filename account-graph.php
 */
defined('ABSPATH') || exit;
require_once __DIR__ . '/account-graph/account_graph_wordpress.php';

$account_graph_forms = new account_graph_wordpress(['Database' => $GLOBALS['wpdb']]);
add_action('wp_enqueue_scripts', [$account_graph_forms, 'browser']);
add_filter('script_loader_tag', [$account_graph_forms, 'module'], 10, 2);
add_action('gform_after_submission', [$account_graph_forms, 'gravity'], 10, 2);
add_action('wpcf7_mail_sent', [$account_graph_forms, 'cf7'], 10, 1);
add_action('init', [$account_graph_forms, 'schedule']);
add_action(account_graph_wordpress::HOOK, [$account_graph_forms, 'deliver']);
unset($account_graph_forms);
