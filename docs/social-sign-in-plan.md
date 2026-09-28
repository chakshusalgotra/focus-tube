# Google and GitHub Sign-In Plan

Status: **Proposed, not implemented or enabled.** Prepared 2026-09-28 against the current working tree. No provider applications, credentials, live accounts, deployment settings, or running services have been changed.

## Recommendation

Add Google and GitHub as alternative sign-in methods on the existing FocusTube accounts. Keep password login, invitation-only admission, member limits, existing account IDs, and current session/privacy protections. This is consumer social sign-in, not enterprise SAML/organization SSO.

Use the existing Node/Express/SQLite stack. Evaluate a maintained standards library such as `openid-client` for Google OIDC and GitHub's authorization-code OAuth flow; verify the selected version's Node/CommonJS interoperability and both provider adapters before installing/pinning it. Do not implement JWT verification or an OAuth protocol client from scratch, introduce another session framework, or migrate the account database to an external auth service for this feature.

First useful outcome: an admitted learner returns to their intended workspace and can save/open a lesson. A provider callback alone is not a completed signup or successful activation.

## Current Boundaries

- [auth.js](../auth.js) owns password/email verification, invitation-only signup/upgrade, normalization, rate budgets, and session cookies. Social buttons in [public/index.html](../public/index.html) are disabled placeholders.
- [db.js](../db.js) owns `redeemInvitation`, `passwordSession`, account updates, and atomic invitation/session/profile writes. `redeemInvitation` currently consumes an application email-code proof, not a provider proof. Never fabricate a code or skip its validation by an unchecked boolean.
- [public/auth-entry.js](../public/auth-entry.js) scrubs the invitation fragment and keeps the raw token in memory. Leaving for a provider loses that memory, so the invitation must be bound to a short-lived server-side flow before redirecting.
- [server.js](../server.js) validates public origins/hosts and enforces exact Origin on mutations. Existing GET callbacks can fit the origin/host boundary; no blanket cross-site or CORS bypass is needed.
- The main session cookie uses SameSite=Strict. It cannot be assumed present on the initial cross-site provider callback. Preserve it and use a separate short-lived OAuth correlation cookie.
- Profile username changes, email enrollment, and password settings currently assume password proof. Social-only accounts need explicit credential-aware behavior and provider reauthentication, not a fake local password.
- Existing extension grants are session-bound. New social sign-ins and credential changes must preserve the session-replacement/revocation contracts.

## Product Rules

1. Existing linked identities may sign in without a new invitation. Disabled/deleted accounts remain blocked regardless of provider success.
2. New users need a valid member invitation. Recheck expiry, revocation, remaining uses, and workspace capacity at final commit; starting OAuth must not spend a signup slot.
3. Provider identity keys are Google issuer + `sub`, and GitHub's stable numeric `id` represented as a string. Names, handles, avatars, and email addresses are not identity keys.
4. Never auto-link because provider email matches an existing FocusTube account. Require an authenticated, freshly reauthenticated existing account and explicit linking. A collision produces a generic existing-account/sign-in path, not an automatic merge or takeover.
5. New SSO accounts do not have to create a password. Existing password accounts retain theirs. Require a unique FocusTube username and display name before admission; provider suggestions remain editable and must pass existing validators.
6. Keep About-you questions in signup completion, optional and unchecked. SSO consent is not product-analytics consent. Provider choice must not populate discovery source, role, or learning goal: signing in with GitHub does not establish that GitHub referred the user or that they are a developer.
7. No new social path to create administrators. Initial administrator bootstrap remains the existing operator/password-invitation flow. Existing administrators may explicitly link providers under the same protections as other accounts.
8. No Gmail, Drive, YouTube, repository, organization, contacts, birthday, or location permissions. No session replay or new automatic tracking.

## Provider Contract

| Provider | Proposed flow and scopes | Proof and minimum data |
| --- | --- | --- |
| Google | Authorization code + S256 PKCE + OIDC nonce; `openid email profile` | Verify signature/JWKS, issuer, audience/authorized party, expiry/issued time, and nonce; key by issuer + subject. Use name only as an editable suggestion; do not fetch remote avatars in v1. |
| GitHub | Authorization code + S256 PKCE; `read:user user:email` | Fetch authenticated `/user` on every flow; key by stable ID. Read `/user/emails` for verified primary email, since the public profile email can be null. Bound pagination/timeouts and never guess an address from a handle. |

Email verification is a separate policy from identity authentication. Proposed default: accept Google's verified Gmail/Workspace address and GitHub's verified primary address for new-account email proof. For missing/unverified email, a different user-entered email, or a Google third-party address whose current mailbox ownership is not authoritative, require the existing FocusTube email-code flow bound to the pending social identity. Never mark an address verified solely because the browser supplies it. Finalize this policy before implementation; linked-account login uses the stable provider subject and does not silently rewrite the local email if the provider later changes it.

Use access tokens only server-side to validate identity/fetch necessary profile details, then discard them. Do not request offline access or retain refresh tokens. The provider grant may still exist at the provider after tokens are discarded; document provider-side revocation separately from disconnecting a FocusTube link.

## Journey and Screen Contracts

| State | Screen/action | Required behavior |
| --- | --- | --- |
| Signed out | Continue with Google / Continue with GitHub, plus password login | User-initiated same-tab redirect; no auto-prompt or One Tap in v1. Hide or clearly disable unconfigured providers. |
| Provider pending | Real provider authorization page | Cancel/back/restart returns to usable account access; no invite consumption. |
| Linked identity | Clean same-origin return and completion | Recheck active local account and browser/session binding; mint a fresh FocusTube session, then resume a validated local destination. |
| New identity with invitation | Complete your FocusTube account | Verified email or bound email-code fallback, display name, unique username, optional About-you sharing. No password required for SSO-only signup. |
| New identity without invitation | Invitation required | No full account/session. Expire the pending proof and offer the existing password/invitation path. Do not silently open public signup. |
| Existing local email, unlinked provider | Sign in to your existing account | Do not consume invitation or merge. User signs in with their existing method, then starts explicit provider linking in Account. |
| Guest upgrade | Complete membership | Bind to the exact originating guest session, retain ID/learning data, apply the normal member invite/verification/capacity rules atomically. |
| Linking | Account > Sign-in methods | Fresh proof of the current account, provider authentication, and explicit confirmation of the provider account being linked. |
| Interrupted/expired/error | Inline status with restart/cancel | Clear secrets, preserve only safe intended destination, avoid repeated token exchanges and duplicate registrations. |

Collect the About-you answers after the provider round trip in the signup-completion form, rather than send them to providers or store pre-redirect password/form drafts. Returning members bypass onboarding; existing users are not asked to repeat surveys. Browser Back/refresh must reconcile server flow state, not infer success from a client flag.

## Redirect and Session Design

1. A same-origin, rate-limited `POST /api/auth/sso/:provider/start` validates the allowlisted provider and intent (`login`, `signup`, `link`, `reauth`, or `upgrade`). It binds the invitation hash, exact configured callback URI, original session/account where applicable, and a validated local return destination. Signup/upgrade validates the invitation before leaving.
2. Store a random one-time state hash, protected PKCE verifier, nonce/hash, creation/expiry, intent, browser-binding hash, and initiating account/session in a bounded SQLite flow table. Proposed lifetime: ten minutes, capped outstanding flows per browser/source and globally. Do not include invitation tokens, emails, return URLs, or account IDs in OAuth `state`.
3. Set a separate host-only HttpOnly, Secure, SameSite=Lax correlation cookie scoped to the SSO routes. Approved loopback development is the only HTTP exception and uses a distinct development cookie name. Keep the main session SameSite=Strict. No shared cookie Domain across dev/production.
4. Return an allowlisted authorization URL as JSON; frontend navigates with `location.assign`. Do not return an external 302 to a fetch request and expect it to navigate the browser. Keep provider credentials/token exchange on the server.
5. Exact `GET /api/auth/sso/:provider/callback` validates provider, state, cookie, expiry and one-time claim before token exchange. Use provider-specific endpoints and fixed registered redirect URI; reject mix-up, replay, forged callback, and duplicate relevant query parameters. Ignore permitted unrelated provider response parameters per protocol. Validate proofs through the library.
6. Callback stores only a short-lived normalized identity proof and clears token material. It does not immediately link an account or grant a workspace session. Redirect to a fixed clean local completion page/route, removing code/state from visible history and preventing referrer leakage. Callback responses have no-store/no-referrer and no third-party page assets. Configure reverse-proxy logs to omit callback queries as well as application logs.
7. On the clean same-origin page, a completion request receives the normal Strict session cookie again. Recheck the current browser account/session against the original intent, including absence of a session for a signed-out flow. If another tab signed in/out, a guest was upgraded, or the initiating session was revoked, invalidate the stale flow instead of switching or linking accounts unexpectedly.
8. Final same-origin POST atomically consumes the pending proof and, as applicable, creates the identity/account/profile, consumes one invitation use, records explicitly chosen onboarding consent, and creates/rotates the app session. Recheck identity/email/username uniqueness and roles under the same write lock. Concurrent completions must not create two users or consume twice.
9. A lost final response must reconcile the established session and consumed-flow receipt. Never blindly retry provider code exchange or create a second account. Use bounded idempotent completion behavior and clear partial proof/flow cookies after completion, cancellation or expiry.

The new provider flow proves identity; it does not authorize reading another account's notes or changing existing session/extension scopes. No `SameSite=None` main session, wildcard CORS, permissive return URLs, or global mutation-origin exemption.

## Account Linking and Recovery

- Add Account > Sign-in methods: Password configured/not configured, Google connected/not connected, GitHub connected/not connected. Show a minimal provider account label and Connected date; never display tokens.
- Linking requires fresh proof of the existing account (current password or fresh authentication with an already-linked provider) plus fresh authentication with the new provider. Bind both proofs to the current session, exact action and expiry.
- A provider identity may belong to exactly one FocusTube account. Do not transfer it from another account, overwrite a link, or merge learning data implicitly.
- Unlink requires recent authentication and an atomic check that another configured sign-in method remains. Prevent races that remove both remaining providers. Keep a last usable method; explain the recovery prerequisite instead of locking the user out.
- SSO-only users can add a local password only after action-bound reauthentication and verified local email. Update sensitive username/email operations to accept equivalent scoped proof rather than an arbitrary provider token. Existing password-change rules remain for password users.
- Provider link/unlink and password setup should revoke superseded sessions/extension grants according to an explicit shared credential-change policy, leaving the current browser on a fresh session. Ordinary social login must preserve the existing policy for other devices rather than unexpectedly logging every device out.
- If the only provider becomes inaccessible, use a documented, verified operator-assisted recovery process or a previously configured alternative. Do not add an email-match bypass. Full forgotten-password recovery and enterprise account recovery are separate scope decisions.
- Provider-side revocation does not automatically invalidate a FocusTube session when no provider token is retained. State that limitation, keep normal app-session expiry/revocation, and consider provider security-event integration as a later project.

## Proposed Storage and API

New tables should live in a small auth-owned module or alongside existing auth tables, following current transactional patterns:

- `user_identities`: account FK, allowlisted provider, issuer where applicable, stable subject, minimal display label, created/last-used timestamps. Unique `(provider, issuer, subject)`; initially at most one identity per provider/account. Nullable password credentials are explicit for social-only members, not guests.
- `oauth_flows`: hashed state/browser proof, server-protected verifier, nonce, intent, originating session/account, invite hash, fixed callback origin, safe local return target, expiry and processing state. Delete verifier/code/token material promptly; never keep raw provider responses.
- Pending normalized identity and scoped reauthentication receipts may share the flow table if their purposes/states are unambiguous. Final proof consumption and account changes must share the transaction.

Proposed routes (not implemented): `POST /api/auth/sso/:provider/start`, `GET /api/auth/sso/:provider/callback`, `GET /api/auth/sso/pending`, `POST /api/auth/sso/complete`, `POST /api/auth/sso/cancel`, `GET /api/auth/identities`, and guarded link/unlink/password-setup operations. Final route names and schemas are frozen before implementation; avoid duplicate versions of the current auth API.

Affected implementation surfaces: [auth.js](../auth.js), [db.js](../db.js), [server.js](../server.js), [public/auth-entry.js](../public/auth-entry.js), [public/app.js](../public/app.js), [public/index.html](../public/index.html), [public/styles.css](../public/styles.css), and existing auth/extension/settings tests. Add small provider protocol/store modules only when they keep the current auth module understandable. Extend existing signup/profile/session abstractions with validated proof types rather than copy entire signup handlers.

Provider credentials are deployment configuration, not editable text boxes in Administration. The admin UI may show provider availability and aggregate outcome counts without secrets. Do not allow manual edits to provider subject IDs or account links in v1.

## Provider Setup and Environments

Create separate Google Web application clients and separate GitHub OAuth Apps for local, dev, and production. A GitHub App is worth reconsidering if repository integration becomes a real requirement; do not request repository installation/access for simple sign-in.

Proposed explicit callback paths:

| Environment | Google callback | GitHub callback |
| --- | --- | --- |
| Local | `http://127.0.0.1:3002/api/auth/sso/google/callback` | `http://127.0.0.1:3002/api/auth/sso/github/callback` |
| Dev | `https://dev-ft.neuralnest.co.in/api/auth/sso/google/callback` | `https://dev-ft.neuralnest.co.in/api/auth/sso/github/callback` |
| Production | `https://focustube.neuralnest.co.in/api/auth/sso/google/callback` | `https://focustube.neuralnest.co.in/api/auth/sso/github/callback` |

These are proposed registrations, not verified deployed endpoints. Use one canonical hostname per environment; localhost and 127.0.0.1 are not interchangeable callback origins. Disable GitHub callback wildcard matching; pin exact application redirects even where the provider allows more flexibility. Use separate stable test callback ports rather than registering whichever random preview port happens to be running.

Required configuration: provider enable flags default off; Google client ID/secret; GitHub client ID/secret; canonical callback origin; protection key for short-lived server flow secrets if persistent encryption is used. Keep all secrets in deployment-secret configuration, never in the browser, repository, screenshots, logs or chat. Publish only provider enabled/disabled capability flags and necessary public client information. Configure app name/logo, support contact, privacy/terms URLs, Google test users/publishing status, domain ownership and provider branding requirements before public activation.

## Phased Work

The shared foundation is broken into pickup-ready tasks in [SSO Phase 2: Shared Foundation Tasks](sso-phase-2-tasks.md). All checklist items are planned, not completed.

| Phase | Deliverable | Exit gate |
| --- | --- | --- |
| 1. Contracts | Confirm email-proof policy, account linking/recovery, canonical origins, scopes and callback routing; select/pin maintained library | Written API/state/security contract; no live provider activation |
| 2. Shared foundation | Identity/flow tables, secure start/callback/completion, replay/rate limits, proof-aware atomic signup and session handling | Synthetic provider integration tests, migration/rollback/data preservation, concurrent completion tests |
| 3. Google | Verified OIDC sign-in, invited signup, existing-account collision handling, settings linking and reauthentication | Real configured test-account acceptance and no invite bypass |
| 4. GitHub | PKCE code flow, stable user ID, verified/private email handling, same linking/completion path | Same security matrix plus hidden/unverified email cases |
| 5. Product and release | Replace placeholders with compliant branded controls, finish signup/guest-upgrade/linked-method settings, recovery states, docs and safe operational counters | Full tests/image/browser checks, reviewed backup, explicit rollout approval per environment |

Google can be delivered first, but do not call the feature complete until the requested GitHub path and social-only account-management flows work. Do not enable a provider in production merely because its local happy-path test passed.

## Acceptance Gates

- Current password users, IDs, roles, invitations, sessions, notes, courses, analytics choices and extension behavior survive migration. No existing accounts are auto-linked or auto-verified.
- Existing provider login, invited new signup, no-invite rejection, guest conversion, duplicate email/username, disabled/deleted account, revoked/exhausted/expired invite, and last workspace slot behave correctly.
- Invalid/missing/mismatched state, nonce, PKCE, issuer/audience/signature, cookie, provider and callback URI all fail closed. Test callback replay, concurrent state claims and concurrent final completion across SQLite connections.
- Provider cancellation, wrong account, unavailable provider, timeout after code exchange, expired pending proof, committed-but-lost response, back/refresh, and another-tab sign-in/sign-out recover without duplicated admission or unexpected linking.
- SameSite=Strict sessions remain usable after returning; linking checks the original current session on same-origin completion. SSO-only password setup, sensitive profile changes, last-method unlink races, provider removal and normal session/extension revocation are verified.
- Optional onboarding remains skippable/unchecked and bound to the final selected identity. Choosing Google/GitHub does not populate discovery-source analytics. No raw codes, tokens, identities, callback queries, emails, survey answers or credentials appear in logs/metrics.
- Browser acceptance: desktop Chrome/Edge, mobile Safari/Chrome, keyboard-only navigation, real provider redirects, account chooser/cancel/back, password-manager fallback, 320/375/768/1440 layouts and zoom. Automated emulation is not physical-device or screen-reader certification; record any gaps explicitly. Do not authenticate inside embedded webviews or require third-party cookies/popups.
- Use disposable provider apps/test accounts for integration and real-provider tests. Never use demo/mock authentication as production proof. Provider app/domain setup and credentials remain owner actions; no secret values are requested through chat.
- Before any requested rollout: freeze reviewed source, run full tests and the exact image, back up SQLite, rehearse migration with populated data, preserve runtime configuration/data volumes, verify origin/callback behavior on that environment, and keep provider-specific kill switches plus a migration-safe recovery path.

## Decisions to Confirm Before Coding

Recommended defaults are invite-only social signup, no automatic email linking, no forced local password, explicit Account linking, same-tab redirects, no offline/provider API access, and unchanged optional audience sharing.

Confirm the provider-email verification policy, recovery approach for social-only accounts, final canonical URLs, and Google-then-GitHub implementation order. Register credentials privately when real integration testing is ready. No Google/GitHub login should infer demographics, occupation, referral source or authorization roles.

## Official References Reviewed

- [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect): server code flow, nonce, ID-token validation and stable subject IDs.
- [GitHub OAuth authorization](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps): code flow, current S256 PKCE support, identity revalidation and callback matching. Current documentation supports multiple callback configuration; do not assume the historical single-callback limitation.
- [GitHub authenticated email API](https://docs.github.com/en/rest/users/emails): private/primary/verified email fields and `user:email` scope.

Recheck provider behavior, branding, chosen library APIs and console settings at implementation time. This plan is not a security certification or a completed provider integration.