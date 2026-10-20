# HTTP API Reference

Reviewed **2026-09-28** against the current working tree. This is a route and contract reference, not a separate API implementation or a claim that every deployment runs these files. Source owners: [server.js](../server.js), [auth.js](../auth.js), [feedback.js](../feedback.js), [video-chat.js](../video-chat.js), [extension.js](../extension.js), [downloads.js](../downloads.js).

## Shared Rules

- Browser requests use the same-origin HttpOnly session cookie. Ordinary writes require an exact approved `Origin`; missing/null/cross-site origins are rejected. Approved Host and scheme checks precede ordinary feature routes.
- **Session** means a currently valid session for an active account, including a retained legacy guest where explicitly allowed. **Member** excludes guests. **Admin** additionally requires the current administrator role. Ownership always comes from server-side identity.
- `GET`/`PUT /api/data` require `X-Profile-Account: <current member ID>`. Notebook, chat, feedback and invite clients respectively send `X-Notebook-Account`, `X-Video-Chat-Account`, `X-Feedback-Account` and `X-Invite-Account`; supplied mismatches are rejected. Invitation responses echo the verified account. Headers are not credentials.
- Most APIs return JSON. Errors generally contain `error`; feature routers also provide a stable `code`. Parser/general handlers are not guaranteed to use the same code shape. Expected failures include 400 invalid input, 401 missing session, 403 forbidden/origin, 404 missing or concealed private resource, 409 stale state, 413 limit, 415 content type, 429 rate budget and 5xx unavailable/upstream.
- Do not log request bodies, cookies, authorization headers, email codes, invitation links, prompts or transcripts. Do not put secrets in query strings.

| Parser surface | Maximum body |
| --- | --- |
| Auth, invitations, extension | 8 KiB JSON |
| Notebook PUT | 300 KiB JSON; stricter document limits also apply |
| Video chat | 2 MiB JSON; stricter source/question/context limits apply |
| Learning import | 25 MiB JSON |
| Forum, ordinary | 64 KiB JSON |
| Forum screenshot POST with `X-Feedback-Screenshots: 1` | 21 MiB after member/account guards; non-image payload remains bounded |
| Other JSON | 3 MiB |

## Public and Discovery

| Method | Path | Access and result |
| --- | --- | --- |
| GET | `/api/health` | Allowed host; process/database readiness, `status`, `database`, `uptimeSeconds` |
| GET | `/api/playlist?url=...` | Public metadata under approved API origin; resolves a supported playlist/video into course metadata |
| GET | `/api/video/:id` | Public metadata; description, duration and chapters for an 11-character video ID |
| GET | `/api/search?q=...&type=...` | Member; 1-200 character query, `all|video|playlist|course`, at most 24 results |

Search may return 502/504 for upstream failures and has a 15-second upstream timeout. Metadata GET does not itself create a library record. The browser persists selected courses through `/api/data`; capture has its own additive endpoint. Details: [youtube-search.md](youtube-search.md).

## Authentication

| Method | Path | Input and behavior |
| --- | --- | --- |
| GET | `/api/auth/status` | Public status, invite-only mode, email/CAPTCHA availability; no secret values |
| GET | `/api/auth/me` | Session; `{user}` with safe account fields |
| POST | `/api/auth/username/check` | `{username,inviteToken?}`; usable invite for visitor/guest or member session; `{username,available}` does not reserve the name |
| POST | `/api/auth/verification/request` | `{email,inviteToken?,captchaToken?}`; 202 with verification token/expiry/resend information, never the emailed code |
| POST | `/api/auth/register` | `{inviteToken,email,username,displayName,password,passwordConfirmation,verificationToken,verificationCode,captchaToken?}`; 201 user and cookie after atomic admission |
| POST | `/api/auth/upgrade` | Legacy guest session and registration fields; preserves the account identity while converting through a member invitation |
| POST | `/api/auth/login` | Password plus exactly one of `identifier`, `email`, `username`; optional configured CAPTCHA; safe user and replacement cookie |
| POST | `/api/auth/guest` | Disabled; rejects creation without creating an account/session |
| POST | `/api/auth/email` | Member; `{email,password,verificationToken,verificationCode,captchaToken?}` for initial email/enrollment verification, not arbitrary verified-email changes |
| POST | `/api/auth/profile` | Member; `{displayName,username,password?}`; current password required when changing username |
| POST | `/api/auth/password` | Member; `{currentPassword,newPassword,passwordConfirmation}`; rotates credentials and sessions transactionally |
| POST | `/api/auth/logout` | Invalidates current session and clears its cookie; 204 |

New registration requires SMTP availability, a usable invitation and email proof. Turnstile is enforced when configured. Member login requires no invitation. Usernames are unique and required for new registration/conversion; old account compatibility is preserved. There is no `/api/me`, `PUT /api/auth/me`, forgotten-password endpoint, or `/api/v1` alias. Detailed budgets/errors: [authentication specification](invite-only-auth-spec.md#current-release).

## Invitations

All routes require an active admin; the client uses `X-Invite-Account`. Raw links are returned only at creation.

| Method | Path | Contract |
| --- | --- | --- |
| GET | `/api/invites` | `before`, `limit` up to 50, `status=all|active|expired|exhausted|revoked`; safe metadata and next cursor |
| POST | `/api/invites` | `{maxUses?,expiresAt?}`; default 1 signup/7 days, maximum 1,000 signups/365 days; 201 with one-time `inviteUrl` |
| PATCH | `/api/invites/:id` | `{expiresAt,revision,reactivate?}`; explicit reactivation for eligible expired links, no count reset |
| DELETE | `/api/invites/:id` | `{revision}`; revoke remaining signup rights and associated unused email proofs, not existing member accounts |

Bootstrap is a local operator command, not an HTTP route. Revoked or exhausted invitations cannot be revived. Unknown query/body fields are rejected. See [current invitation lifecycle](invite-only-auth-spec.md#17-member-invitation-lifecycle-v1).

## Profile and Notebooks

| Method | Path | Contract |
| --- | --- | --- |
| GET | `/api/data` | Member plus mandatory account header; own profile and current revisions |
| PUT | `/api/data` | Same guard; `{courses,stats,settings,workspace,revision,importLegacy?}`; conflict is 409 rather than blind replacement |
| GET | `/api/notebooks` | Member; notebook index and revision information |
| GET | `/api/notebooks/:courseId` | Member; own course notebook and records |
| PUT | `/api/notebooks/:courseId/videos/:videoId` | Member; `{document,revision}`; validates document/ownership, returns acknowledgement or 409 with current record |
| DELETE | `/api/notebooks/:courseId?notesRevision=...` | Member; revision-checked clear retaining tombstone revisions |
| GET | `/api/export` | Session, including retained guest export; schema-4 attachment; 409 while a chat request is pending |
| POST | `/api/import?revision=...&notesRevision=...&chatRevision=...` | Member; supported schema 1-4 learning export; all ownership/revision/pending/quota checks precede replacement |
| PUT | `/api/profile/download-quality` | Member; `{quality}` in `1080|720|480|360|audio` |

Profile JSON does not own notebook text. Notebook limits and format validation come from [notebook-model.js](../public/notebook-model.js). Imports do not replace identity, security grants, billing records or shared feedback. See [Notes flow](flows.md#notes-and-recovery) and [export/recovery](flows.md#export-restore-and-operations).

## Activity and Administration

| Method | Path | Contract |
| --- | --- | --- |
| POST | `/api/track` | Member; bounded `{batchId,date,siteSeconds,watch}` activity, duplicate batch protection; 204 |
| GET | `/api/stats/summary` | Member; optional `today` date, personal learning totals/streaks |
| GET | `/api/stats/daily` | Member; `days` bounded 7-365, optional `today` |
| GET | `/api/stats/courses` | Member; `days=all` or bounded range, optional `today` |
| GET | `/api/stats/history` | Member; `page`, 50 history items per page |
| POST | `/api/presence` | Member; `{tabId}` returns a short-lived activity challenge |
| PUT | `/api/presence` | Member; `{tabId,challenge}` confirms current activity; 204 |
| DELETE | `/api/presence` | Member; `{tabId}` withdraws this tab's presence; 204 |
| GET | `/api/admin/monitoring` | Admin; `page,query,role,activity,sort,event,days`; current snapshot and filtered bounded member/event data |
| GET | `/internal/metrics` | Separate private host/source/bearer guard, not member/admin session authorization; missing/wrong access concealed as 404 |

Monitoring choices: `role=all|admin|member`, `activity=all|active|idle|disabled`, `sort=activity|name|newest`, `event=all|login|register|upgrade|email|logout`, `days=1|7|30`. Member pages contain 25 matches; events contain the latest 30 matches. See [monitoring.md](monitoring.md) for stale-state behavior, source limitations and retention.

## Feedback

The forum response uses safe usernames, not account emails. Every private/hidden read and screenshot fetch checks the current viewer. Missing and inaccessible private threads both return 404.

| Method | Path | Contract |
| --- | --- | --- |
| GET | `/api/feedback/viewer` | Public; minimal current-member identity or null |
| GET | `/api/feedback` | Public visible threads only; `page,q,category,status` filters |
| GET | `/api/feedback/mine` | Member; own reports with the same filters |
| GET | `/api/feedback/:id` | Parent access check; detail including screenshot metadata |
| GET | `/api/feedback/:id/replies` | Parent access check; `page`; hidden replies excluded except for admins |
| GET | `/api/feedback/:id/screenshots/:screenshotId` | Parent/reply access check; normalized PNG, generic filename, no-store and nosniff |
| POST | `/api/feedback` | Member; report fields and stable submission UUID; 201 new or 200 identical replay |
| POST | `/api/feedback/:id/replies` | Member plus parent reply permission; `{submissionId,body,screenshots?}` |
| GET | `/api/admin/feedback` | Admin; all visible/private/hidden reports with filters |
| PATCH | `/api/admin/feedback/:id` | Admin; `{revision,status?,hidden?,locked?}`; visibility cannot be changed after submission |
| PATCH | `/api/admin/feedback/:id/replies/:replyId` | Admin; `{revision,hidden}` bound to the same parent thread |

Report body: `{submissionId,category,visibility,publicConsent?,title,body,steps?,expected?,actual?,context?,screenshots?}`. Public visibility requires `publicConsent:true`. Categories are `bug|usability|request`; status is `open|in_progress|resolved|closed`. Pages contain 25 results. Screenshot arrays contain canonical base64 bytes, not data URLs or attachment IDs. Use `X-Feedback-Screenshots: 1` on image-bearing POSTs. Full image limits, rate budgets, retries and retention: [forum contract](../README.md#feedback-forum-v1).

## Video Chat

Let `C = /api/video-chat/:courseId/videos/:videoId`. All routes require a member session and enforce supplied `X-Video-Chat-Account` binding. Generation/source preparation additionally require configured/enabled chat and an active registered account; there is no pilot-ID gate. Retained-history reads and deletion have separate rules, so disabled generation is not equivalent to deleting stored conversations. Exhausted request allowance does not change the `available` capability flag.

| Method | Path | Contract |
| --- | --- | --- |
| GET | `/api/video-chat/config` | Availability, model/limit metadata, automatic-caption flag, safe unavailability reason and own-account `quota` |
| GET | `C?conversationId=...` | Snapshot: revision/generation, selected history, histories, completed messages and source metadata |
| POST | `C/conversations` | `{id,revision,title?}` creates a named history under the video's shared transcript |
| PATCH | `C/conversations/:conversationId` | `{title,revision}` with consistent conversation binding |
| DELETE | `C/conversations/:conversationId` | `{revision}` deletes that history, not other histories or appended notes |
| PUT | `C/transcript` | `{revision,conversationId?,source,rightsConfirmed,language?,replace?,text?}`; YouTube acquisition or compatibility SRT/VTT upload |
| POST | `C/messages` | `{requestId,revision,conversationId?,question,consent,playhead?,sourceHash?,scope?,mode?,messageIds?}`; bounded request and cost reservation |
| POST | `C/cancel` | `{requestId,conversationId?}`; cancel matching active work where available; 204 does not promise a refund |
| POST | `C/notes/validate` | `{conversationId?,sourceHash,generation,proposalId,texts,document,noteRevision}`; validates explicit append intent/destination without saving the notebook itself |
| DELETE | `C` | `{revision,conversationId?,removeTranscript?}`; clear selected history or remove shared source/all histories according to the request |

For `C/messages`, `Accept: application/x-ndjson` requests streamed `start`, `text`, heartbeat and final/error events; the default final-JSON path remains compatible. Provisional text is not a validated answer. Scope is `moment|video|discussion`, default `video`; mode is `answer|note_draft`, default `answer`. The simplified website exposes whole-video conversation, starters and follow-ups rather than the legacy upload/scope controls. No tools or automatic billable retry are enabled. Source/current-account/history checks run again before committing an answer.

`quota` in config and snapshot config contains `{limit,used,remaining,windowSeconds:21600,windowStartedAt,resetAt,serverNow}`. Dates are UTC ISO strings; a missing/expired window reports full remaining allowance and null start/reset until a new request is admitted. Default limit is 30; `VIDEO_CHAT_REQUESTS_PER_WINDOW` accepts 1-1,000. Reading status does not start a window. The stored counter and usage reservation commit in one immediate transaction; later failure/cancellation retains the request slot, while rejected admission and completed-ID replay consume none.

An exhausted window returns HTTP `429` / `CHAT_WINDOW_LIMIT`, the own-account `quota`, `retryAfterSeconds`, and `Retry-After` seconds before any NDJSON headers or provider call. The existing five-per-minute limit returns `RATE_LIMITED` with retry seconds; concurrency and monthly cost use `CHAT_BUSY` and `CHAT_BUDGET`. A six-hour reset does not clear monthly spending or provider throttling. The old `CHAT_DAILY_LIMIT` check is removed. See the [quota implementation plan](video-chat-quota-plan.md) for reset and recovery cases.

Limits, note proposal binding, shared transcript consequences, usage reservation and source timing tolerance are defined in [v1-release.md](v1-release.md#chat-and-confirmed-notes), [video-chat.js](../video-chat.js) and [video-chat-store.js](../video-chat-store.js). Citation validation verifies references exist, not that every generated claim is correct.

## Extension Capture

All routes are under `/api/extension`; disabled integration returns 404. Only configured exact extension origins may use the enumerated cross-origin paths, and credentials plus account/destination binding are still required. `/authorize` is first-party consent, not part of that cross-origin exception.

| Method | Path | Contract |
| --- | --- | --- |
| POST | `/session` | Empty JSON; verify cookie/grant principal, destination and expiry |
| POST | `/authorize` | `{extensionId,redirectUri,codeChallenge,codeChallengeMethod,state,expectedAccount,consent}`; first-party session and S256 consent, one-time redirect code |
| POST | `/token` | `{code,codeVerifier,state,extensionId,redirectUri}`; redeem once for an opaque parent-session-bound grant |
| POST | `/disconnect` | `{expectedAccount}`; revoke current connection; 204 |
| POST | `/videos` | `{videoId,requestId,expectedAccount}`; canonical video, additive transaction and duplicate-safe receipt |
| OPTIONS | `/session`, `/videos`, `/token`, `/disconnect` | Exact enabled origin/path and requested POST/header allowlist only |

Allowed destinations, temporary Local restrictions, grant lifetimes, permissions and pending-operation limits: [Chrome Capture](v1-release.md#chrome-capture). Never add extension origins to the ordinary web-origin allowlist or treat an extension ID as authentication.

## Optional Downloads

These member-only backend routes are not exposed as an ordinary website download button. They require installed `yt-dlp` and `ffmpeg`, explicit rights confirmation and resource limits. The current Dockerfile does not install those tools.

| Method | Path | Contract |
| --- | --- | --- |
| GET | `/api/downloads/status` | Tool readiness and prerequisites |
| GET | `/api/downloads/current` | The current member's process-local job or null |
| POST | `/api/downloads` | `{courseId,authorized:true,quality?}`; 202 job if source/limits allow |
| GET | `/api/downloads/:id/events` | Owner-only server-sent job progress |
| DELETE | `/api/downloads/:id` | Owner-only cancellation; 204 |
| GET | `/api/downloads/:id/file` | Owner-only ZIP stream for a ready job |

Jobs are not a durable distributed queue. One global job per process, per-user checks, duration/disk/video-count bounds and temporary-output cleanup apply. See [download safeguards](../README.md#download-safeguards).