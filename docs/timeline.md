# Maintaining the Change Timeline

[../timeline.html](../timeline.html) is a standalone, newest-first engineering record. Open it directly in a browser from the repository checkout; it does not need a server, sign-in, or an API key. The HTML contains its styles, renderer, and generated data. The historical library screenshot is loaded from the checkout's existing screenshot directory.

## What It Records

- Feature or integration title and the reason for the change.
- Exact commit membership with GitHub links, plus changed or affected files.
- Git committer dates for committed milestones; explicitly date-only records for observations or uncommitted work.
- Branch stage, open bugs, and pending release work.
- The snapshot time, source branch, included HEAD, and the exact `origin/main` and `origin/dev` revisions used to determine stage.

The HTML offers keyword matching across titles, rationale, files, and commits; stage filters; native expandable file lists; and links to individual records.

## Stage Definitions

| Stage | Evidence |
| --- | --- |
| Prod branch | Every commit in the milestone is reachable from the recorded `origin/main`. This does not prove a production deployment succeeded. |
| Dev branch | Every commit is reachable from `origin/dev` or main, with at least one not yet in main. This does not prove a dev deployment succeeded. |
| Feature branch | At least one commit has not reached either recorded target branch. |
| Bugs | A dated issue observation entered in the source notes. Related commits provide context; they are not necessarily fixes. |
| Pending | A dated follow-up, or a milestone with no recorded commit yet. |

Stages indicate the furthest verified branch membership at snapshot time. For example, if all dev commits are already in main, there may be no Dev-only records. Actual runtime versions and workflow outcomes must be verified separately before claiming an environment is deployed.

## Sources

- [timeline-notes.json](timeline-notes.json) owns feature grouping, rationale, descriptions, and dated observations.
- [../scripts/update-timeline.js](../scripts/update-timeline.js) reads local Git history and embeds the resulting snapshot in the HTML.
- [../test/timeline.test.js](../test/timeline.test.js) checks sorting, stages, grouping, validation, and safe HTML embedding.

The generator includes commits reachable from HEAD, `origin/main`, and `origin/dev`. It excludes unrelated worktrees, stash history, and unrelated feature branches. Historical commits not assigned to a milestone remain visible as their own records, including merges. File lists for merge commits show changes relative to the first parent.

Git dates are real commit dates, not claimed feature-development start dates. An observation such as the older Docker image check keeps its recorded date and is not silently treated as a fresh check when the HTML is regenerated.

## Update Procedure

1. Commit the implementation being recorded so its actual hash exists.
2. Add or update a milestone in the notes. Set a unique `id`, `title`, `why`, a `changes` array, and its actual `commits`. Commit prefixes must resolve uniquely within the included history. Use `recordedDate` and an empty commit list only for work that is genuinely uncommitted.
3. For bug or release follow-ups, add an observation with a date, stage (`bugs` or `pending`), affected files, and optional `relatedMilestones`. Record evidence and next action without inventing deployment status or rationale.
4. Fetch target branch updates, regenerate, and validate:

```bash
git fetch origin
npm run timeline:update
npm test
```

5. Open the HTML and inspect the changed records, then commit the notes and generated snapshot.

The generator reads the existing checkout and does not fetch, commit, push, or deploy anything. If target refs are missing, they are marked unavailable; commits are not assumed to be in dev or prod.

A snapshot cannot contain the hash of the commit that will store that same snapshot. The header therefore states the exact HEAD covered at generation time. The snapshot-recording commit becomes visible on the next refresh; the complete current history remains available on GitHub. This avoids fabricated hashes and an endless chain of self-updating commits.

## Rationale and Open Work

Use feature notes for known intent. When a change's reason was not recorded, say so and flag it for review instead of inferring a requirement. For observations, distinguish an editor scanner report, a runtime check, a code limitation, and an unverified concern.

When a pending item is completed, preserve its historical observation and add the dated outcome and relevant commit, or move it into a committed milestone with clear evidence. Do not replace a historical production deployment claim merely because a branch advanced.

No credentials, local database contents, private session tokens, or raw third-party payloads belong in the timeline.