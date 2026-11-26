# Access to account data

Keep the main service token and reviewer credentials out of browsers. The main token opens every service call and the reviewer API. Reviewers can read every report and forget records, including requesting supported ad retractions.

Give each integration a named service token with the calls and kinds it needs. These tokens never open the reviewer API or its operational metrics. A browser still needs an allowed origin to post, and Twilio still needs its signature. The script files, health check and review page shell are public. A service signs as `system:<name>`. Logs identify a request by service name and call. Keep credentials out of names, request bodies and request IDs.

See the [HTTP access table](docs/http.md#tokens) and [token settings](docs/operations.md#named-service-tokens).
