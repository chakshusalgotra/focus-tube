# SSO Phase 2: Shared Foundation Tasks

Status: **Planned; all implementation tasks below are open.**

Prepared: 2026-09-28. Parent specification: [Google and GitHub sign-in plan](social-sign-in-plan.md).

## Goal

Build the shared identity, authorization-flow, and session foundations needed by Google and GitHub sign-in. Demonstrate them with isolated provider fixtures before enabling either real provider.

This checklist does not claim Phase 1 decisions are complete or that any SSO implementation has shipped. The latest request is documentation only.

## Scope and Guardrails

- Preserve password login, invitation-only signup, member limits, user IDs, existing learning data, and extension session bindings.
- Never merge or link accounts automatically because their email addresses match.
- Use stable provider identity keys: Google issuer plus subject; GitHub numeric user ID.
- Keep the main session cookie SameSite=Strict and retain exact-origin protection on mutations.
- Do not consume invitations, create accounts, or grant workspace sessions merely because a callback arrived.
- Keep optional audience questions and analytics consent independent of provider authorization.
- Keep both providers disabled by default. No real credentials, provider app creation, outbound verification email, or live-account tests in this phase.
- Do not commit, push, deploy, or change port 3002 as part of this checklist.

## Prerequisites

- [ ] Confirm the Phase 1 email-proof policy, including the application email-code fallback for missing or insufficient provider proof.
- [ ] Confirm social-only account recovery, password setup, and the policy for session revocation after credential changes.
- [ ] Confirm canonical local/dev/production origins and exact callback paths from the parent plan.
- [ ] Select a maintained OAuth/OIDC library and verify its Node version, CommonJS interoperability, PKCE, and provider support. Record the chosen pinned version before installing it.
- [ ] Record the current source baseline and pending unrelated changes. Use the active `Local-course-touch-text-pr` checkout, not the older `Local-course` checkout or a live database.

Unresolved policy decisions block the affected implementation tasks; they are not permission to bypass existing security checks.

## Implementation Checklist

### SSO2-01: Freeze Flow and API Contracts

- [ ] Define intents: login, invited signup, guest upgrade, explicit linking, and scoped reauthentication.
- [ ] Define pending, exchanging, identity-verified, completed, canceled, failed, and expired states; document valid transitions.
- [ ] Freeze request/response schemas for start, callback, pending, complete, and cancel operations.
- [ ] Define one-time consumption, retry reconciliation, error codes, and validated local return destinations.
- [ ] Specify lifetime and capacity limits, provisionally ten-minute flows with per-browser/source and global caps.

**Depends on:** prerequisite decisions.

**Done when:** fixtures can describe every transition and failure without assuming a trusted client flag, email match, or callback query.

### SSO2-02: Add Identity and Flow Storage

- [ ] Add a user-linked identity table with provider/issuer/subject uniqueness and an initial one-identity-per-provider/account limit.
- [ ] Add short-lived flow storage for hashed state/browser binding, protected PKCE verifier, nonce, intent, origin, initiating session/account, invitation hash, and expiry.
- [ ] Store only the minimal normalized identity proof needed for completion; never retain full provider responses or long-lived access/refresh tokens.
- [ ] Implement atomic flow claim, proof consumption, cancellation, and expiry cleanup.
- [ ] Add migration, reopen, rollback, foreign-key, and uniqueness tests on populated disposable databases.

**Depends on:** SSO2-01.

**Done when:** existing accounts and sessions are unchanged, and competing workers cannot claim the same flow or attach the same identity twice.

### SSO2-03: Add Provider Configuration and Browser Binding

- [ ] Add disabled-by-default provider flags and validated server-only configuration with blank example secrets.
- [ ] Use exact configured callback origins and an allowlist of providers; reject untrusted host/return parameters.
- [ ] Add a separate host-only HttpOnly, Secure, SameSite=Lax flow cookie while retaining the Strict application cookie.
- [ ] Limit any development HTTP exception to explicitly approved loopback origins and distinct development cookie settings.
- [ ] Bind each flow to the initiating browser, intent, and current session/account, including the signed-out state.

**Depends on:** SSO2-01 and SSO2-02.

**Done when:** a callback from another browser, provider, origin, or expired session cannot continue the flow.

### SSO2-04: Implement Secure Start and Cancel

- [ ] Accept same-origin POST initiation with bounded JSON and existing durable rate-limit patterns.
- [ ] Validate invitation eligibility for signup/upgrade without consuming a use or reserving membership indefinitely.
- [ ] Generate cryptographically random state, S256 PKCE, and OIDC nonce where applicable through the selected library's supported APIs.
- [ ] Return an allowlisted authorization URL for same-tab navigation, not an external fetch redirect.
- [ ] Cancel pending work and clear the flow cookie without altering existing accounts or invitations.

**Depends on:** SSO2-02 and SSO2-03.

**Done when:** forged or repeated starts are bounded, and canceled flows leave no admitted account or consumed invitation.

### SSO2-05: Implement Callback and Provider-Proof Boundary

- [ ] Define the provider adapter contract and isolated fixtures for verified identities, missing email, denial, and provider failures.
- [ ] Validate state, browser binding, provider, expiry, and atomic claim before code exchange.
- [ ] Use the maintained library for protocol/token validation; do not hand-write JWT signature verification.
- [ ] Enforce nonce, PKCE, issuer, audience, expiry, and provider-specific stable identity checks where applicable.
- [ ] Stage a short-lived normalized proof, then redirect to a fixed clean same-origin completion location.
- [ ] Apply no-store/no-referrer, omit third-party callback assets, and ensure neither application nor proxy logging retains callback secrets.

**Depends on:** SSO2-03 and SSO2-04.

**Done when:** invalid, replayed, mismatched, canceled, or timed-out callbacks grant no application session and reveal no credentials.

### SSO2-06: Implement Atomic Signup and Session Completion

- [ ] Recheck the originating browser/session after returning to the same-origin page; reject intervening account changes.
- [ ] Resolve an existing identity by stable subject, never by an email-only join.
- [ ] Introduce explicitly validated proof types for social identity and email proof instead of fabricating the existing email-code verification or adding a client-controlled bypass.
- [ ] For new members, recheck invitation state, member capacity, email/username uniqueness, and required profile fields inside the final transaction.
- [ ] Atomically create/upgrade the account, attach the identity, consume one invitation use and pending proof, store explicit onboarding choices, and issue the app session.
- [ ] Preserve guest IDs and learning data during upgrade; keep administrator bootstrap on the existing path.
- [ ] Reconcile committed-but-lost responses without reusing an authorization code, creating a second user, or consuming another signup slot.

**Depends on:** SSO2-02 and SSO2-05.

**Done when:** rollback and concurrent-completion tests prove all-or-nothing admission, and ordinary password signup/login still pass.

### SSO2-07: Add Credential-Change Safety Primitives

- [ ] Bind fresh reauthentication proofs to the existing account, session, permitted action, and expiry.
- [ ] Enforce identity ownership and explicit linking; reject cross-account identity transfers.
- [ ] Add an atomic last-sign-in-method check so concurrent unlink attempts cannot lock out an account.
- [ ] Define safe password-setup and sensitive-profile proof handling for social-only accounts without assigning dummy passwords.
- [ ] Reuse the existing session-replacement and extension-grant revocation contracts under the agreed credential-change policy.

**Depends on:** SSO2-02 and SSO2-06, plus confirmed recovery policy.

**Done when:** storage/service tests cover linking, replayed reauthentication, last-method races, and session/grant revocation. Public linking/settings UI remains a later-phase task.

### SSO2-08: Add Cleanup, Operational Signals, and Documentation

- [ ] Expire abandoned flows and promptly remove verifier/token/proof material after terminal states.
- [ ] Limit pending-record volume and provider calls; handle database/provider failure without exposing raw errors or secrets.
- [ ] Add allowlisted aggregate outcome/error categories only; never log emails, provider subjects, state, codes, tokens, full URLs, or onboarding answers.
- [ ] Document configuration, cookie behavior, data retention, backup handling, and recovery limitations.
- [ ] Keep capability flags separate from proof that real Google/GitHub integration has passed acceptance.

**Depends on:** SSO2-03 through SSO2-07.

**Done when:** privacy/logging tests pass, cleanup is bounded, and operators can distinguish disabled, configured, and verified states.

### SSO2-09: Complete the Security and Regression Matrix

- [ ] Invalid/missing state, nonce, PKCE, cookie, issuer, audience, signature, provider, and redirect URI.
- [ ] Replayed callbacks, concurrent claims/completions, expired pending proof, duplicate identity/email/username, and last invitation/workspace slot races.
- [ ] Revoked/exhausted/expired invitations and disabled/deleted accounts before start and before final commit.
- [ ] Wrong browser, another-tab login/logout, guest-session replacement, cancellation, back/refresh, and lost completion response.
- [ ] Email-code fallback remains bound to the pending social identity and cannot authorize another account or purpose.
- [ ] Social-only credential handling and linking/unlinking cannot bypass reauthentication or last-method checks.
- [ ] Existing password auth, onboarding choices, account data, and extension authorization remain intact.
- [ ] No secret-bearing response, callback query, raw provider error, or personal data leaks into logs/metrics.

**Depends on:** tests should accompany each task; this is the combined exit gate.

**Done when:** focused tests, the full suite, exact-image tests, and a synthetic browser redirect/completion test pass with explicit receipts. Real-provider and physical-device coverage must not be claimed from fixtures.

### SSO2-10: Prepare the Phase 3 Handoff

- [ ] Record implemented interfaces, migration steps, disabled defaults, test receipts, and remaining limitations.
- [ ] List the exact Google test-app configuration and private credential prerequisites.
- [ ] Confirm that no provider button can initiate an unconfigured or unreviewed flow.
- [ ] Update the parent plan with actual completion status; do not mark tasks complete merely because code exists.

**Depends on:** SSO2-09.

**Done when:** Google integration can use the tested foundation without changing invitation, identity-linking, or session rules.

## Expected Code Areas

| Area | Existing entry points |
| --- | --- |
| Auth and admission | [auth.js](../auth.js), [db.js](../db.js): `redeemInvitation`, `passwordSession`, account/verification helpers |
| Middleware and callbacks | [server.js](../server.js): host/origin validation, request parsing, auth routing |
| Browser flow integration | [public/auth-entry.js](../public/auth-entry.js), [public/app.js](../public/app.js): invitation capture, safe return, account transitions |
| Extension sessions | [extension.js](../extension.js), [extension-store.js](../extension-store.js): session-bound grants and revocation |
| Diagnostics | [observability.js](../observability.js): allowlisted outcomes and private logs |
| Regression coverage | [test/auth.test.js](../test/auth.test.js), [test/extension.test.js](../test/extension.test.js), [test/observability.test.js](../test/observability.test.js) |

Small dedicated flow-store/provider modules may be introduced during implementation if they keep these boundaries clear. Reuse the existing test fixtures and avoid duplicating whole account handlers or session systems.

## Not Part of Phase 2

- Real Google/GitHub application registration or credential activation.
- Production provider acceptance, branded sign-in controls, and complete account-management UI.
- Public signup, automatic email linking, administrator bootstrap via social login, or enterprise SAML/SCIM.
- Repository/Gmail/YouTube access, offline provider access, refresh-token storage, or demographic inference.
- New analytics consent, live-user migration, port 3002 replacement, Git publication, or hosted deployment.

## Pickup Order

Resolve prerequisites, then SSO2-01 through SSO2-06. Follow with SSO2-07 and SSO2-08, complete SSO2-09, and record SSO2-10. Write each task's tests alongside the implementation rather than deferring all verification to the end.

Phase 2 is complete only when its exit gates pass. It does **not** mean Google or GitHub sign-in is ready for users.