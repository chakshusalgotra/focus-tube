# FocusTube Monitoring

For system boundaries, use [Architecture](architecture.md#deployment-and-operations); for end-to-end administration, use [Website flows](flows.md#administration-and-monitoring). The [deployment diagram](diagrams/deployment.html) describes checked-in automation, not live health. Exact monitoring/presence routes are indexed in [api.md](api.md#activity-and-administration).

## Available Locally

Sign in as an active administrator and select **Monitoring** in the workspace navigation or **Open monitoring** in **Settings > Administration > Site monitoring**. The **Overview**, **Members**, **Events**, and **System** tabs separate usage charts, member records, account events, and process/storage details. Members cannot use the API by bypassing the hidden navigation. Administrator status still does not grant access to another member's courses, notes, exports or downloads.

The built-in view contains approximate active members, daily/weekly activity, minimal usernames/IDs, last recorded login/activity, recent account events, the last hour of origin traffic, process memory/uptime and application-volume space. It refreshes every 30 seconds while open and visible. Failed refreshes retain a visibly stale snapshot. It does not show historical outages, whole-host CPU, individual browsing history, or an unconfigured external dashboard as healthy.

Activity requires a fresh server challenge followed by foreground interaction or foreground playback. Challenge receipts expire after 45 seconds and cannot be replayed. Presence is deduplicated across tabs and sessions, is withdrawn when hidden/idle, and expires after five minutes if a browser disappears. Logout, expiry, disabling an account and session revocation remove its eligibility. Client reports remain approximate and are not proof of human attention. Daily aggregates use server UTC dates; old learning uploads and imports do not inflate current presence.

The member list is paginated in groups of 25 after case-insensitive username/ID search and role/activity filtering. Search is submitted with Enter or the search button; select menus apply immediately. Sort by recent activity, username A-Z, or newest member. The matching-member count is separate from the site-wide overview totals. Events can be filtered by type and the last 24 hours, 7 days, or 30 days, before taking the latest 30 matches. Clear controls reset each list's filters independently. Tab changes and refreshes preserve filters; closing resets them without storing searches. A failed filter request labels the retained snapshot as stale and blocks mismatched pagination until a successful refresh.

`GET /api/admin/monitoring` accepts `page`, `query` (at most 100 characters), `role=all|admin|member`, `activity=all|active|idle|disabled`, `sort=activity|name|newest`, `event=all|login|register|upgrade|email|logout`, and `days=1|7|30`. Defaults retain the unfiltered recent-activity order and 30-day event window. Unknown parameters and invalid choices are rejected. Member filtering excludes deleted accounts and guests; no email addresses, credentials, session tokens, or learning content are added to the response or logs.

Login/registration/logout/email events are recorded from successful database transactions, not reconstructed from old sessions. History starts when this feature is deployed. Audit events retain 30 days, capped at 10,000 records; daily aggregate membership retains 90 days. Last-login/activity timestamps older than 30 days are cleared by periodic cleanup. Account deletion cascades to this metadata.

### Account Settings

**Settings > Account** opens with three collapsed sections: **Account details**, **Change password**, and **Account email**. Expand the relevant row to access its existing form. Collapsing a row or changing Settings tabs preserves unsaved inputs; the normal discard guard still protects profile/password drafts when closing. Reopening Settings collapses the rows and clears password-change fields. Verified email addresses appear as status text without an enrollment form. Email security checks are active only while the email section is expanded, and invalid fields reopen their containing section.

### Invitations

Administration keeps **Site monitoring** separate from **Member invitations**. Expand **New invitation** to create a link; the issued list stays visible below. Filter the full list by All invitations, Active, Expired, Fully used, or Revoked before 50-item cursor pagination. Changing status returns to page one without clearing the creation form. Filters are disabled while reviewing an expiry edit or revocation. Closing Settings clears the one-time link and resets the form and filter. The list API accepts `status=all|active|expired|exhausted|revoked` alongside its existing `before` and `limit` parameters.

## Optional Product Analytics

The first release adds **Administration > Product analytics**, separately from operational monitoring. `PRODUCT_ANALYTICS_ENABLED` defaults to `0` in every Compose environment. Enabling the installation does not opt users in: active non-admin members must explicitly choose **Share optional usage analytics** under **Settings > Data**. Leave the flag off on live instances until the new purpose, retention, consent flow, and applicable privacy requirements have been reviewed. No analytics vendor or external export is used. Each installation has an independent database; do not combine local/dev/test data with production reports.

Overview displays recorded active members over trailing 1/7/30 UTC calendar days, plus members with at least five minutes of sampled watch activity in the trailing seven days. Engagement shows median watch minutes per recorded active member, distinct users with successful feature use, and an opt-in activation funnel. Feature usage is counts, not an adoption rate for accounts eligible for a specific pilot feature. Chat counts require a persisted answer, not a submitted question; note counts require a changed, nonempty successful save; extension counts require a new successful capture. Imported learning data and failed/replayed saves do not create analytics milestones. Administrators, guests, disabled/deleted accounts, and explicitly excluded test accounts are omitted. Test accounts are not inferred from their username.

The cohort clock starts at **analytics opt-in, not signup**. The seven-day activation denominator includes only opt-ins whose entire seven-day window was observed. Steps are a newly saved course, then at least five sampled watch minutes before the window ends. Existing library items do not count. D7/D30 retention means recorded activity on the exact UTC date seven/thirty days after opt-in. The target day must have ended and have coverage before it enters the denominator. Pending and unobserved cohorts are not zero retention. Results describe opted-in members, not the entire user population; counts and coverage are shown alongside rates.

The server records collection availability every 30 seconds, splitting coverage after a gap over 90 seconds or clock reversal. A complete day must fit within one continuous recorded interval. This is an approximate availability indicator, not proof every browser signal arrived. Today's values are partial; missing historical days are displayed as gaps. Foreground presence still requires fresh one-use server challenges. Watch samples use the server clock, require consecutive playing signals, cap each increment at 30 seconds, reject gaps over 45 seconds, and share one sample cursor per account so tabs cannot add simultaneous watch time. This deliberately undercounts some playback; it measures activity, not verified attention or learning. Browser signals are not tamper-proof.

Storage is first-party SQLite with bounded daily rows rather than a generic raw event stream. Daily records and first-course/activation/sample timestamps are eligible for cleanup after 90 days; opt-in date and current preference metadata remain until withdrawal or account removal. Turning analytics off deletes the account's enrollment/daily rows immediately. Collection errors do not fail core learning writes; the report warns when signals were dropped in the current process. Learning backups do not carry or reactivate consent. Database backups can contain analytics; reconcile later withdrawals/deletions before restoring one and establish an operator backup expiry policy.

Account-bound endpoints require `X-Analytics-Account` plus an authenticated active session: `GET/PUT /api/analytics/preferences`, `GET /api/analytics/export`, and administrator-only `GET /api/admin/analytics?days=7|30|90`. Preference writes accept only `{consent:boolean,notice:"2026-09-28"}`. Administrators can mark known test accounts with `PUT /api/admin/analytics/exclusions/:id` and `{excluded:true}`; this deletes their recorded analytics and resets their consent. Removing exclusion also requires the member to opt in afresh. Reports are aggregate-only, private/no-store, rate-limited, and explicitly refreshed rather than added to the monitoring polling loop.

### Optional Audience Survey

Invitation signup and guest conversion include an **About you (optional)** step between account details and email verification, with independently optional role, learning-goal, and discovery-source enums. The step is omitted when product analytics is unavailable. Not answered and Prefer not to say are distinct. Discovery source is what the person reports, not something extracted from social accounts, an invitation link, IP address, or browser history. Choices include friends/invitations, LinkedIn, X/Twitter, Reddit, Instagram, YouTube, search engines, Other, and Prefer not to say. The explicit sharing checkbox is unchecked by default; without it the frontend omits the answers. **Skip optional questions** clears the answers and consent and advances to verification. Back navigation retains drafts without sending them or granting consent. Core signup and learning remain available without optional sharing.

`GET /api/auth/status` exposes `onboarding:{available,notice,audienceNotice}`. When available, `POST /api/auth/register` and `POST /api/auth/upgrade` accept optional `onboarding:{consent:true,notice,audienceNotice,answers:{role?,goal?,source?}}`. Validation occurs before expensive signup work and again in the redemption transaction. Consent, answers, account creation/conversion, invitation consumption, and session creation commit together or roll back together. Email-verification requests never carry the optional answers. False consent cannot accompany answers; omitted onboarding leaves analytics off. Administrator bootstrap accounts stay excluded. No delayed Library prompt remains, including for old clients (`canOffer` is false). Members can edit/remove answers later in **Account > Learning profile**. Adding the new platform enums transactionally rebuilds the existing constrained survey table without losing prior rows or revisions.

Survey writes require the current opaque revision and notice `2026-09-28-audience`. The server rejects stale saves, including an old tab attempting to restore answers after withdrawal and re-enrollment. A conflict keeps the local form draft; Refresh loads the current revision without replacing that draft and requires a reviewed retry. All answers are strict enums, with no age, free text, automatic classification, or provider call. Survey answers expire after 90 days from the last save, leaving an empty skipped state. Analytics withdrawal/exclusion deletes the associated survey row through the enrollment relationship; account deletion cascades too. Ordinary learning imports never restore survey answers or consent.

`GET/PUT /api/analytics/audience` uses the existing session plus `X-Analytics-Account`. Account writes accept `{action:"skip"|"save"|"remove",revision,notice,answers?}`; only save accepts `answers:{role?,goal?,source?}`. The former offer action is rejected. Own analytics export includes the current learning profile. `GET /api/admin/analytics/audience` accepts no filters and returns aggregates for opted-in non-admin/non-test members with activity in the previous 30 complete UTC days. The current self-reported group is used, not a historical occupation at signup. The date-range picker is hidden for Audience so it cannot imply a different period. Unknown means no answer for that field, including skipped or expired answers; it is not a guessed user category. New signups are not immediately included in a report based on prior complete days.

Breakdown counts require at least ten members in each nonempty group, including Unknown and Prefer not to say. If any group is smaller, the entire dimension is withheld instead of publishing totals that reveal the missing count by subtraction. Response coverage is withheld if the respondent or nonrespondent count is between one and nine. Role/goal comparisons use eligible opt-in activation and exact D7 return definitions; both success and failure counts must be at least ten. If any nonempty group lacks a safe comparison, that comparison is withheld across the whole dimension. Source comparisons and arbitrary intersections are not offered. This conservative approach reduces small-cell disclosure but is not a guarantee against differencing across repeated reports or outside knowledge. Restrict admin access and review disclosure risk before launch. Percentages explicitly include Unknown in the eligible-member denominator; survey response rates are shown separately.

Age bands, geographic inference, automated campaign attribution, anonymous visitor funnels, arbitrary demographic segmentation, and session replay remain **not implemented**. Age remains blocked on the owner's minors-policy decision. Do not claim historical signup funnels from imported or pre-consent learning history.

## Operational Logs and Metrics

[observability.js](../observability.js) uses Pino and the maintained `@prometheus-io/client` package. `prom-client` was marked deprecated by the registry at implementation time. Logs include UTC time, a server-generated request ID, normalized route template, method, status and duration. They do not serialize request/response bodies, cookies, authorization headers, raw URL queries, invitation/email/session secrets, user IDs, email addresses, course titles or note content. Dependencies report allowlisted outcomes rather than provider error messages. Do not add raw request objects to these logs.

Local Compose writes JSON logs to stdout and a separate `focustube-logs` volume. Docker keeps three 10 MB stdout files. Pino rotates file logs daily or at 10 MB and keeps four rotated files plus the active file. This is a size/file-count bound, not a guarantee of a full number of days under high traffic. Files may briefly exceed the threshold by buffered writes. Collector failures must not cause unbounded retention or expose logs publicly. The collector has no access to the application database, SMTP settings or Docker socket.

Metrics cover HTTP request rate and latency, in-flight requests, Node CPU/heap/RSS/event-loop delay, database/WAL size, application-volume space/readiness, login/registration/rate-limit outcomes, and SMTP/CAPTCHA outcomes. Successful SMTP submission means the provider accepted a message, not that it arrived in an inbox. Metrics use only bounded route/method/status/operation/environment labels; usernames, IDs, IPs and raw paths must never become labels.

Health checks, private scrapes, presence messages and admin polling are excluded from the traffic chart. Other API polling, asset requests and bots still count as requests, not unique visitors. The local one-hour chart is in memory and resets with the process; pre-start intervals are shown as missing. Use Grafana for persistent time series and peak-hour analysis.

## Enable Grafana Cloud

External export is off by default. Creating vendor accounts, selecting a billing/retention plan and activating credentials are operator steps. No account, token or public endpoint was created automatically. Choose an appropriate data region and retention policy before exporting. Keep Grafana private with MFA and limited reader access.

1. In Grafana Cloud, obtain your Prometheus remote-write URL/user ID, Loki push URL/user ID and a scoped access-policy token with only metrics/logs write permissions. Use verified HTTPS URLs; do not disable TLS verification.
2. Add `GRAFANA_METRICS_URL`, `GRAFANA_METRICS_USER`, `GRAFANA_LOGS_URL`, `GRAFANA_LOGS_USER`, and `GRAFANA_API_TOKEN` to the ignored local environment configuration. Never commit them or put them in a public dashboard JSON.
3. Set `METRICS_TOKEN` to an independent random 32-byte base64url value from your password manager. It is not a browser session, SMTP password or Grafana writer token. Optionally set `GRAFANA_DASHBOARD_URL` and `UPTIME_DASHBOARD_URL` to private HTTPS dashboard links. The secret-free field list is in [.env.example](../.env.example).
4. Confirm `172.30.26.0/29` is unused on your Docker host. The provided collector overlay uses fixed private app/collector addresses `.2` and `.3`; change the subnet, both addresses and the app's `METRICS_ALLOWED_ADDRESSES` together if it conflicts.
5. Validate and start only the opt-in monitoring profile:

```bash
docker --context desktop-linux compose -f compose.yaml -f compose.monitoring.yaml --profile monitoring config --quiet
docker --context desktop-linux compose -f compose.yaml -f compose.monitoring.yaml --profile monitoring up -d app alloy
```

This retains the existing data volume and the only host-published application port, `127.0.0.1:3002`. Alloy 1.19.2 reads rotated logs from a read-only dedicated volume and scrapes the app over the private monitoring network. Its diagnostics listener is container-loopback only, with no host port. No privileged access or Docker socket is used. Buffers are bounded by sample limits, small remote-write queues, a one-hour metrics WAL retention window, and limited log retries. Monitor the collector volume's disk usage and cloud ingestion quotas; time retention is not a hard byte quota.

Import [ops/monitoring/dashboard.json](../ops/monitoring/dashboard.json) through Grafana's dashboard import, selecting your Prometheus and Loki data sources. The dashboard includes request-rate/latency peaks, CPU cores used by the app, memory, volume space, active members, dependency outcomes, observed restarts and sanitized logs. Add deployment annotations when releasing.

[ops/monitoring/alerts.yaml](../ops/monitoring/alerts.yaml) contains Prometheus-compatible starter rules for Grafana Cloud Metrics' ruler, or reference expressions for Grafana-managed alerts. These are not automatically activated by Alloy or by importing the dashboard. Configure a notification contact point and policy, enable recovery notifications, and test the actual delivery. Treat no data as unknown or an alert, not zero traffic. Tune thresholds after measuring the workload; normal wrong-password errors should not page you individually.

### Private Scrape Boundary

`/internal/metrics` is disabled when `METRICS_TOKEN` is empty. It requires GET, the exact internal host `metrics.focustube.internal` (optionally with the internal app port), a trusted socket IP and its independent bearer token. Browser Origin and forwarding headers are rejected. App sessions, including administrator sessions, grant no scrape permission. A missing/incorrect credential returns 404.

Exclude `/internal/*` from public Cloudflare Tunnel ingress and any public reverse proxy. Keep the ordinary public Host header at the gateway; do not rewrite public traffic to the internal metrics host. The scraper does not bypass or weaken the existing API origin/session guards. A container's read-only Docker socket mount would still grant powerful API access, which is why this setup avoids one.

### Actual Host Monitoring

The app reports its process and the filesystem containing SQLite. On macOS/Windows Docker Desktop this is the Linux VM, not all physical-host resources. Whole-host CPU/RAM/network, Windows services, VM availability and detailed container OOM/restart events require an OS-appropriate Alloy host integration or your hosting provider's monitoring agent. Install that separately on the actual host with the minimum permissions; do not label the app's RSS or CPU as total server usage. The dashboard's process-start changes are observed restarts only and cannot reconstruct restarts during collector downtime.

## Independent Availability

Set up an off-server monitor such as UptimeRobot after the intended public HTTPS hostname is reachable. Hosting DNS on Cloudflare alone does not publish the app or provide website request analytics. The current local setup is not itself a public deployment.

- Monitor both the actual public sign-in page (expected page content) and `/api/health` (200 plus expected healthy response). Ensure Cloudflare and the proxy do not cache the health result or redirect failures to a login/challenge page.
- Choose a 1-5 minute interval available on your plan, with confirmation from multiple attempts/locations before alerting. Record failure and recovery times, incident duration, SSL expiry and maintenance windows. Times are estimates within the sampling interval.
- Use a notification channel independent of the app's SMTP, such as provider push or a chat integration. A monitoring service on the same machine cannot reliably notify you after that machine, its internet connection or power is lost.
- A container healthcheck is included using Node fetch, every 30 seconds, with a 5-second timeout and three failures. `restart: unless-stopped` does not restart a still-running unhealthy process; alerts and operator intervention remain required.
- UptimeRobot account creation and alerts cannot be activated without your public URL, provider account and notification destination. The admin view says "not configured" until you supply the dashboard link; a supplied link is not evidence that the monitor is running.

## Public Launch Checks

The separate production Compose file still needs a deliberate deployment review: approved HTTPS origins, exact trusted proxy boundary, private mail settings, monitoring environment, and collector network must match the real host. Do not blindly reuse local HTTP exceptions or deploy a second local app port. Keep data volumes separate and back up SQLite before a schema upgrade. Verify backup restoration, not just backup creation.

Update your privacy notice to disclose coarse activity metadata and retention. Identifiable account-use information stays in the admin API/database, not Grafana metric labels. Administrators should not gain access to other members' learning content. Session replay, keystroke tracking, broad browsing history, OAuth, and Sentry integration are not included in this phase.

## Verify Before Enabling Alerts

Run the automated checks without touching live user data:

```bash
npm test
node --check observability.js
node --check server.js
docker --context desktop-linux compose -f compose.yaml -f compose.monitoring.yaml --profile monitoring config --quiet
```

Use a disposable/staging deployment for outage/load drills. Stop its app, break its private scrape credentials and simulate 5xx/slow requests; verify the external alert, graph gaps, incident timestamp and recovery notification. Use a bounded k6 test against stubbed staging APIs, never real mail sends, YouTube scraping or media downloads. No staging/provider credentials were supplied, so external notification delivery and production overhead must be verified during provider activation. Do not intentionally stop the user's live site to demonstrate monitoring without approval.

Implementation checks exercised 60 concurrent-batched HTTP requests with injected 503 responses, exact counter totals, private scrape authorization and exclusion of secret-bearing query/body/header values. A disposable internal Docker network also verified actual Alloy metric and log forwarding to a local receiver, rejected a different source IP, and confirmed secret query text was absent from the log files. No host ports were published and no external telemetry was sent. The collector configuration and all dashboard/alert expressions passed the Alloy and Prometheus validators. These checks do not replace public-uptime notification tests or a workload-specific capacity test.

On an incident, check the external availability result first, then `docker compose ps`, recent sanitized `docker compose logs --tail=100 app`, disk space, request IDs and deployment annotations. Preserve the active SQLite database and WAL. Never paste private environment values, raw verification payloads or SMTP debug logs into incident reports.