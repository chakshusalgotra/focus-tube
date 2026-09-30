# FocusTube Documentation

Reviewed **2026-09-28** against the working-tree source. This includes local changes beyond the recorded Git base; it is not a claim that the same version is deployed on every environment. The source fingerprints and diagram receipts are in [diagrams/source-inventory.json](diagrams/source-inventory.json) and [diagrams/receipts.json](diagrams/receipts.json).

## Start Here

| Reader | Start with | Continue with |
| --- | --- | --- |
| Learner | [Website flows](flows.md) | [Search](youtube-search.md), [main feature guide](../README.md#features) |
| Developer | [Architecture and data ownership](architecture.md) | [HTTP API reference](api.md), [interactive atlas](diagrams/index.html) |
| Administrator | [Account and invitation flow](flows.md#accounts-and-invitations) | [Authentication contract](invite-only-auth-spec.md#current-release), [Monitoring](monitoring.md) |
| Operator | [Deployment boundaries](architecture.md#deployment-and-operations) | [Configuration](../README.md#configuration), [release and recovery gates](v1-release.md#rollout-backup-and-rollback) |
| Diagram editor | [Archify workflow](architecture.md#maintaining-the-diagrams) | [Catalog and evidence anchors](diagrams/catalog.json) |

## Interactive Flowcharts

Open [the Architecture Atlas](diagrams/index.html) directly in a browser. Each linked diagram is a standalone HTML file with embedded SVG and viewer code: light/dark appearance, pan/zoom, node focus, path exploration, reader-started trace motion and export. No sign-in, application server, API key, external diagram service, or live database is needed.

| Diagram | Editable source | Meaning |
| --- | --- | --- |
| [System map](diagrams/system.html) | [Architecture JSON](diagrams/system.architecture.json) | Browser, service, storage and external boundaries |
| [Invitation and sign-up](diagrams/account.html) | [Workflow JSON](diagrams/account.workflow.json) | Email proof and atomic account admission |
| [Learning workspace](diagrams/learning.html) | [Workflow JSON](diagrams/learning.workflow.json) | Discovery, course creation, playback and progress |
| [Notes and recovery](diagrams/notes.html) | [Workflow JSON](diagrams/notes.workflow.json) | Drafts, revision checks, save acknowledgement and conflicts |
| [Video chat](diagrams/chat.html) | [Workflow JSON](diagrams/chat.workflow.json) | Consent, captions, cost reservation, generation and validated output |
| [Extension capture](diagrams/capture.html) | [Workflow JSON](diagrams/capture.workflow.json) | Environment-bound capture and duplicate-safe receipts |
| [Feedback and screenshots](diagrams/feedback.html) | [Workflow JSON](diagrams/feedback.workflow.json) | Posting, visibility, image access and moderation |
| [Deployment configuration](diagrams/deployment.html) | [Workflow JSON](diagrams/deployment.workflow.json) | What the checked-in deployment workflows actually do |
| [Draft release gates](diagrams/release-draft.html) | [Workflow JSON](diagrams/release-draft.workflow.json) | Proposed safeguards, explicitly not implemented automation |

**Live means interactive visualization, not live telemetry.** Animated packets represent authored relationships. They do not inspect traffic, measure latency, prove hosted reachability, or infer a security boundary from proximity. The draft chart is a proposal, not an operational guarantee.

## Documentation Ownership

- [architecture.md](architecture.md) owns the code structure, state ownership, storage map, security boundaries and diagram maintenance procedure.
- [flows.md](flows.md) owns the end-to-end user journeys and their recovery/permission behavior.
- [api.md](api.md) indexes the implemented HTTP routes, account bindings, body limits and response contracts.
- [invite-only-auth-spec.md](invite-only-auth-spec.md) owns the detailed account/invitation contract. Its early numbered sections are explicitly historical; use Current Release and the current lifecycle section first.
- [social-sign-in-plan.md](social-sign-in-plan.md) is the proposed Google/GitHub sign-in plan, including invitation preservation, explicit account linking, provider setup, and release gates; it is not implemented behavior.
- [v1-release.md](v1-release.md) owns chat/capture/invitation release evidence, limitations, feature activation and migration-safe recovery. Dated records remain historical when newer entries supersede them.
- [monitoring.md](monitoring.md) owns current account/admin organization, filters, telemetry semantics and external monitoring setup.
- [youtube-search.md](youtube-search.md) owns input recognition, result filtering and YouTube failure behavior.
- [timeline.md](timeline.md) explains the generated [change timeline](../timeline.html), which is separate from the architecture atlas.
- [policies-draft.md](policies-draft.md) is an operator checklist, not the published [Terms and Privacy](../public/policies.html).

## Keep It Current

```bash
npm run docs:check
npm run docs:build
npm run docs:preview -- notes
```

`docs:check` is offline and does not require Archify: it checks the source fingerprints, evidence anchors, diagram byte receipts, index and local Markdown links. `docs:build` requires the global skill and refuses unreviewed source drift. After reviewing code changes and updating the relevant docs/specifications, use `npm run docs:build -- --refresh-evidence`. This refresh is a human review acknowledgement, not an automatic semantic proof.

`docs:preview -- notes` explicitly starts Archify's loopback-only watcher for that source. It keeps the last valid output while a JSON edit is incomplete. Stop the watcher after editing, then run the build to refresh receipts. The static atlas itself needs no server. See [maintenance details](architecture.md#maintaining-the-diagrams).

## Evidence Limits

Source-backed documentation is not a deployment audit. No private environment values, database rows, session tokens, API keys, customer screenshots, or prompts were read to create this atlas. Browser validation of a diagram is not a fresh end-to-end application, provider, physical-device, or hosted-proxy test. The [verification register](v1-release.md#verification-record) retains the exact scope of those separate checks.